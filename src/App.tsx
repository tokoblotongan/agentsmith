import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GAME_CONFIG } from './config/gameConfig';
import { createOfficeRoom } from './scene/officeRoom';
import {
  AgentSmith,
  type AgentAnimationState,
  type AgentRigMode,
} from './character/agentSmith';
import { InputController } from './controls/inputController';
import { NetworkSync } from './network/networkSync';
import {
  Mission,
  type MissionWinSummary,
  type MissionLoseSummary,
} from './game/mission';
import { SpyAudio } from './game/audio';

interface RemoteAgentEntry {
  agent: AgentSmith;
  current: THREE.Vector3;
  currentRot: number;
  target: THREE.Vector3;
  targetRot: number;
}

type GamePhase = 'briefing' | 'playing' | 'inspect' | 'won' | 'lost';
type StatusKind = '' | 'alert' | 'good';

interface HudSnapshot {
  level: number;
  levelName: string;
  objective: string;
  timeLeft: number;
  collected: number;
  total: number;
  score: number;
  detection: number;
  rigMode: AgentRigMode;
  isDeformed: boolean;
  hasExternal: boolean;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // ignore storage errors
    }
  },
};

function detectSoftwareGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

function resolveCircleBox(pos: THREE.Vector3, radius: number, b: THREE.Box3): void {
  const cx = clamp(pos.x, b.min.x, b.max.x);
  const cz = clamp(pos.z, b.min.z, b.max.z);
  const dx = pos.x - cx;
  const dz = pos.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= radius * radius) return;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    const push = (radius - d) / d;
    pos.x += dx * push;
    pos.z += dz * push;
  } else {
    const exits = [
      pos.x - b.min.x + radius,
      b.max.x - pos.x + radius,
      pos.z - b.min.z + radius,
      b.max.z - pos.z + radius,
    ];
    const m = Math.min(...exits);
    if (m === exits[0]) pos.x = b.min.x - radius;
    else if (m === exits[1]) pos.x = b.max.x + radius;
    else if (m === exits[2]) pos.z = b.min.z - radius;
    else pos.z = b.max.z + radius;
  }
}

function dampAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const radarRef = useRef<HTMLCanvasElement | null>(null);

  const [gameState, setGameState] = useState<GamePhase>('briefing');
  const [difficultyLevel, setDifficultyLevel] = useState<number>(1);
  const [bestScore, setBestScore] = useState<number>(() => store.get('smith.best', 0));
  const [facingDeg, setFacingDeg] = useState<number>(() =>
    clamp(Math.round(store.get('smith.facing', GAME_CONFIG.character.modelYawOffset || 0)), -180, 180),
  );
  const [muted, setMuted] = useState<boolean>(false);
  const [isTouchDevice, setIsTouchDevice] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; kind: StatusKind }>({
    text: 'Standing by.',
    kind: '',
  });
  const [toastState, setToastState] = useState<{ text: string; bad: boolean; visible: boolean }>({
    text: '',
    bad: false,
    visible: false,
  });
  const [winSummary, setWinSummary] = useState<MissionWinSummary | null>(null);
  const [loseSummary, setLoseSummary] = useState<MissionLoseSummary | null>(null);

  const [hud, setHud] = useState<HudSnapshot>({
    level: 1,
    levelName: 'RECRUIT',
    objective: 'Awaiting deployment…',
    timeLeft: GAME_CONFIG.mission.levels[0].time,
    collected: 0,
    total: GAME_CONFIG.mission.levels[0].intel,
    score: 0,
    detection: 0,
    rigMode: 'procedural',
    isDeformed: false,
    hasExternal: false,
  });

  const engineRef = useRef<{
    startMission: (lv: number) => void;
    toggleAudio: () => void;
    toggleInspect: () => void;
    enterInspect: () => void;
    exitInspect: () => void;
    applyFacing: (deg: number, announce?: boolean) => void;
    swapRig: () => void;
    showBriefing: () => void;
    loadGlbFile: (file: File) => void;
    touch: { f: number; b: number; l: number; r: number; s: number };
  } | null>(null);

  const toastTimerRef = useRef<number>(0);
  const showToast = useCallback((text: string, bad = false) => {
    window.clearTimeout(toastTimerRef.current);
    setToastState({ text, bad, visible: true });
    toastTimerRef.current = window.setTimeout(() => {
      setToastState((prev) => ({ ...prev, visible: false }));
    }, 2600);
  }, []);

  useEffect(() => {
    const touchCapable =
      window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    setIsTouchDevice(touchCapable);
  }, []);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareGl();

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(
      isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, GAME_CONFIG.render.maxPixelRatio),
    );
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080d16);
    scene.fog = new THREE.FogExp2(0x0a1220, 0.026);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    pmremGenerator.dispose();

    const camera = new THREE.PerspectiveCamera(
      GAME_CONFIG.camera.fov,
      window.innerWidth / window.innerHeight,
      0.1,
      100,
    );

    const room = createOfficeRoom(scene);

    // Cinematic grade over the built room: cool moon key, warm amber rim, cyan fill
    scene.traverse((o) => {
      if ((o as THREE.HemisphereLight).isHemisphereLight) {
        (o as THREE.HemisphereLight).intensity = 0.30;
      } else if ((o as THREE.AmbientLight).isAmbientLight) {
        (o as THREE.AmbientLight).intensity = 0.13;
      } else if ((o as THREE.DirectionalLight).isDirectionalLight) {
        const dl = o as THREE.DirectionalLight;
        dl.intensity = 2.5;
        dl.color.setHex(0xcfe0ff);
      }
    });

    const rimLight = new THREE.DirectionalLight(0xff8a4c, 1.15);
    rimLight.position.set(-6.5, 3.2, -6);
    scene.add(rimLight);

    const fillLight = new THREE.PointLight(0x38c6ff, 9, 15, 2);
    fillLight.position.set(5.2, 2.4, 4.2);
    scene.add(fillLight);

    // Window god rays
    const rayMat = new THREE.MeshBasicMaterial({
      color: 0xbfd6ff,
      transparent: true,
      opacity: 0.055,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const rays = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const h = 7.4;
      const g = new THREE.ConeGeometry(0.85 + i * 0.35, h, 20, 1, true);
      g.translate(0, -h / 2, 0);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, rayMat);
      m.position.set(-1.1 + i * 1.1, 2.35, -5.7);
      m.rotation.set(0.42, 0.12 - i * 0.1, 0);
      rays.add(m);
    }
    scene.add(rays);

    // Drifting dust motes
    const DUST = 300;
    const dustGeo = new THREE.BufferGeometry();
    const dustPos = new Float32Array(DUST * 3);
    const dustSpd = new Float32Array(DUST);
    for (let i = 0; i < DUST; i++) {
      dustPos[i * 3] = (Math.random() - 0.5) * 15;
      dustPos[i * 3 + 1] = Math.random() * 3.6;
      dustPos[i * 3 + 2] = (Math.random() - 0.5) * 11;
      dustSpd[i] = 0.04 + Math.random() * 0.1;
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    const dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({
        color: 0xffd9a0,
        size: 0.022,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    dust.frustumCulled = false;
    scene.add(dust);

    const input = new InputController(window);
    const audio = new SpyAudio();
    const network = new NetworkSync(GAME_CONFIG.network);
    network.connect();

    const spawn = GAME_CONFIG.player.spawn;
    const position = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
    let rotationY: number = spawn.rotationY;

    let currentPhase: GamePhase = 'briefing';
    let currentLevel = 1;
    let currentBest = store.get('smith.best', 0);
    let shake = 0;
    let latestWin: MissionWinSummary | null = null;

    const agent = new AgentSmith({
      loadExternal: true,
      onRigLoaded: (mode) => {
        showToast(
          mode === 'clips'
            ? 'GLB ANIMATED RIG LOADED'
            : 'GLB LIMBER RIG LOADED (agentsmith.glb)',
        );
      },
    });
    scene.add(agent.group);
    agent.setTransform(position, rotationY);
    agent.setFacingDegrees(
      store.get('smith.facing', GAME_CONFIG.character.modelYawOffset || 0),
    );

    let mission!: Mission;
    const contextualStatus = () => {
      if (currentPhase === 'inspect') {
        setStatusMsg({
          text: 'Inspect mode — calibrate FACING, then RESUME.',
          kind: 'good',
        });
        return;
      }
      if (mission.collected >= mission.total) {
        setStatusMsg({
          text: 'Extraction live — reach the green zone by the east door.',
          kind: 'good',
        });
      } else {
        setStatusMsg({
          text: `${mission.total - mission.collected} dossier(s) left. Stay out of the beam.`,
          kind: '',
        });
      }
    };

    mission = new Mission(scene, room, {
      onIntel: (c, t) => {
        audio.pickup();
        shake = Math.max(shake, 0.12);
        showToast(`INTEL SECURED ${c}/${t}`);
        contextualStatus();
      },
      onExit: () => {
        audio.unlock();
        showToast('EXTRACTION POINT ACTIVE');
        contextualStatus();
      },
      onAlert: (i) => {
        audio.alert(i);
        shake = Math.max(shake, 0.05 + i * 0.12);
      },
      onAlertState: (on) => {
        if (on) {
          setStatusMsg({
            text: 'CAMERA LOCK — break line of sight or hide behind cabinets.',
            kind: 'alert',
          });
        } else {
          contextualStatus();
        }
      },
      onWin: (summary) => {
        currentPhase = 'won';
        latestWin = summary;
        setGameState('won');
        setWinSummary(summary);
        audio.win();
        shake = 0.35;
        if (summary.score > currentBest) {
          currentBest = summary.score;
          store.set('smith.best', currentBest);
          setBestScore(currentBest);
        }
      },
      onLose: (summary) => {
        currentPhase = 'lost';
        setGameState('lost');
        setLoseSummary(summary);
        audio.lose();
        shake = 0.5;
      },
    });

    const remotes = new Map<string, RemoteAgentEntry>();
    const unsubscribeNet = network.onRemotePlayerUpdate((msg) => {
      if (!msg || !msg.id || msg.id === network.playerId) return;
      let r = remotes.get(msg.id);
      if (!r) {
        const a = new AgentSmith({ loadExternal: false });
        a.setFacingDegrees(agent.getFacingDegrees());
        scene.add(a.group);
        r = {
          agent: a,
          current: new THREE.Vector3(msg.position.x, msg.position.y, msg.position.z),
          currentRot: msg.rotationY,
          target: new THREE.Vector3(),
          targetRot: msg.rotationY,
        };
        remotes.set(msg.id, r);
      }
      r.target.set(msg.position.x, msg.position.y, msg.position.z);
      r.targetRot = msg.rotationY;
      r.agent.setAnimationState(msg.animationState ?? 'idle');
    });

    const resolveCollisions = (pos: THREE.Vector3) => {
      const r = GAME_CONFIG.player.radius;
      const { minX, maxX, minZ, maxZ } = room.bounds;
      pos.x = clamp(pos.x, minX + r, maxX - r);
      pos.z = clamp(pos.z, minZ + r, maxZ - r);
      for (const b of room.colliders) resolveCircleBox(pos, r, b);
    };

    const CC = GAME_CONFIG.camera;
    const camTargetPos = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();
    let inspectAngle = 0;
    let inspectR = 2.9;
    let inspectY = 1.5;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const clampCam = (v: THREE.Vector3) => {
      const m = CC.wallMargin;
      v.x = clamp(v.x, room.bounds.minX + m, room.bounds.maxX - m);
      v.z = clamp(v.z, room.bounds.minZ + m, room.bounds.maxZ - m);
      v.y = clamp(v.y, 0.5, GAME_CONFIG.room.height - 0.25);
    };

    const computeCameraTarget = () => {
      if (currentPhase === 'inspect') {
        camTargetPos.set(
          position.x + Math.sin(inspectAngle) * inspectR,
          inspectY,
          position.z + Math.cos(inspectAngle) * inspectR,
        );
      } else {
        const fx = Math.sin(rotationY);
        const fz = Math.cos(rotationY);
        camTargetPos.set(
          position.x - fx * CC.distance,
          CC.height,
          position.z - fz * CC.distance,
        );
      }
      clampCam(camTargetPos);
    };

    computeCameraTarget();
    camera.position.copy(camTargetPos);
    lookTarget.set(position.x, CC.lookAtHeight, position.z);
    camera.lookAt(lookTarget);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    const drawRadar = () => {
      const canvas = radarRef.current;
      if (!canvas) return;
      const c = canvas.getContext('2d');
      if (!c) return;
      const W = 150;
      const H = 150;
      const B = room.bounds;
      const sx = (x: number) => ((x - B.minX) / (B.maxX - B.minX)) * (W - 12) + 6;
      const sz = (z: number) => ((z - B.minZ) / (B.maxZ - B.minZ)) * (H - 12) + 6;

      c.clearRect(0, 0, W, H);
      c.fillStyle = '#0b1220';
      c.fillRect(0, 0, W, H);
      c.strokeStyle = '#2a3c56';
      c.lineWidth = 1;
      c.strokeRect(6, 6, W - 12, H - 12);

      c.fillStyle = '#182437';
      for (const b of room.colliders) {
        c.fillRect(
          sx(b.min.x),
          sz(b.min.z),
          sx(b.max.x) - sx(b.min.x),
          sz(b.max.z) - sz(b.min.z),
        );
      }

      const cm = mission.cam;
      const ang = Math.PI / 2 - cm.yaw;
      const rPx = (cm.reach / (B.maxX - B.minX)) * (W - 12);
      c.beginPath();
      c.moveTo(sx(cm.x), sz(cm.z));
      c.arc(sx(cm.x), sz(cm.z), rPx, ang - cm.half, ang + cm.half);
      c.closePath();
      c.fillStyle = mission.spotted ? 'rgba(255,59,92,.32)' : 'rgba(255,180,84,.18)';
      c.fill();
      c.beginPath();
      c.arc(sx(cm.x), sz(cm.z), 3, 0, Math.PI * 2);
      c.fillStyle = '#ffb454';
      c.fill();

      for (const it of mission.intel) {
        if (!it.active) continue;
        c.beginPath();
        c.arc(sx(it.x), sz(it.z), 3.2, 0, Math.PI * 2);
        c.fillStyle = '#38c6ff';
        c.fill();
      }

      const E = mission.exitPos;
      c.beginPath();
      c.arc(sx(E.x), sz(E.z), 5, 0, Math.PI * 2);
      c.strokeStyle = mission.exitActive ? '#a4f45c' : '#5f7089';
      c.lineWidth = 2;
      c.stroke();

      c.save();
      c.translate(sx(position.x), sz(position.z));
      c.rotate(Math.PI - rotationY);
      c.beginPath();
      c.moveTo(0, -6);
      c.lineTo(4.5, 5);
      c.lineTo(-4.5, 5);
      c.closePath();
      c.fillStyle = '#ece7db';
      c.fill();
      c.restore();
    };

    const syncHudSnapshot = () => {
      const m = mission;
      const objective =
        currentPhase === 'inspect'
          ? 'Inspect mode. Calibrate FACING so his nose matches his walking direction.'
          : currentPhase !== 'playing'
            ? 'Mission paused.'
            : m.collected < m.total
              ? `Secure ${m.total - m.collected} intel dossier(s). Avoid the camera sweep.`
              : 'Reach the EXTRACTION zone by the east door.';

      setHud({
        level: m.level,
        levelName: m.params_.name,
        objective,
        timeLeft: Math.max(0, Math.ceil(m.timeLeft)),
        collected: m.collected,
        total: m.total,
        score:
          currentPhase === 'playing' || currentPhase === 'inspect' ? m.collected * 1000 : m.score,
        detection: Math.round(m.detection),
        rigMode: agent.getRigMode(),
        isDeformed: agent.isDeformed(),
        hasExternal: agent.hasExternal(),
      });
    };

    const touch = { f: 0, b: 0, l: 0, r: 0, s: 0 };

    const startMission = (lv: number) => {
      currentLevel = Math.max(1, lv);
      setDifficultyLevel(Math.min(3, currentLevel));
      mission.reset(currentLevel);
      position.set(spawn.x, spawn.y, spawn.z);
      rotationY = spawn.rotationY;
      agent.setTransform(position, rotationY);
      agent.setAnimationState('idle');
      currentPhase = 'playing';
      latestWin = null;
      setGameState('playing');
      setWinSummary(null);
      setLoseSummary(null);
      computeCameraTarget();
      camera.position.copy(camTargetPos);
      contextualStatus();
      showToast(`LEVEL ${currentLevel} · ${mission.params_.name}`);
      audio.ensure();
      syncHudSnapshot();
      drawRadar();
    };

    const enterInspect = () => {
      if (currentPhase === 'won' || currentPhase === 'lost' || currentPhase === 'briefing') {
        mission.reset(currentLevel);
      }
      currentPhase = 'inspect';
      setGameState('inspect');
      inspectAngle = rotationY;
      inspectR = 2.9;
      inspectY = 1.5;
      contextualStatus();
      showToast('INSPECT — DRAG TO ORBIT, WHEEL TO ZOOM');
      audio.ensure();
      audio.ui();
      syncHudSnapshot();
    };

    const exitInspect = () => {
      currentPhase = 'playing';
      setGameState('playing');
      contextualStatus();
      audio.ui();
      syncHudSnapshot();
    };

    const toggleInspect = () => {
      if (currentPhase === 'inspect') exitInspect();
      else enterInspect();
    };

    const applyFacing = (deg: number, announce = false) => {
      const d = clamp(Math.round(deg), -180, 180);
      setFacingDeg(d);
      agent.setFacingDegrees(d);
      for (const r of remotes.values()) r.agent.setFacingDegrees(d);
      store.set('smith.facing', d);
      if (announce) {
        audio.ensure();
        audio.ui();
        showToast(`FACING SAVED · ${d}°`);
      }
    };

    const toggleAudio = () => {
      audio.ensure();
      audio.setMuted(!audio.muted);
      setMuted(audio.muted);
      if (!audio.muted) audio.ui();
    };

    const swapRig = () => {
      audio.ensure();
      audio.ui();
      if (!agent.hasExternal()) {
        showToast('NO GLB LOADED — assets/agentsmith.glb (or drop .glb here)', true);
        return;
      }
      const useProc = agent.getRigMode() !== 'procedural';
      agent.useExternal(!useProc);
      syncHudSnapshot();
      showToast(useProc ? 'PROCEDURAL BODY' : 'YOUR GLB MODEL');
    };

    const showBriefing = () => {
      currentPhase = 'briefing';
      setGameState('briefing');
      syncHudSnapshot();
    };

    const loadGlbFile = (file: File) => {
      void file.arrayBuffer().then(async (buf) => {
        const ok = await agent.loadGLTFBuffer(buf);
        syncHudSnapshot();
        showToast(ok ? `LOADED ${file.name}` : `FAILED TO LOAD ${file.name}`, !ok);
      });
    };

    engineRef.current = {
      startMission,
      toggleAudio,
      toggleInspect,
      enterInspect,
      exitInspect,
      applyFacing,
      swapRig,
      showBriefing,
      loadGlbFile,
      touch,
    };

    // Inspect orbit pointer + wheel handlers on WebGL canvas
    const onPointerDownCanvas = (e: PointerEvent) => {
      if (currentPhase !== 'inspect') return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      inspectAngle -= (e.clientX - lastX) * 0.008;
      inspectY = clamp(inspectY + (e.clientY - lastY) * 0.006, 0.5, 2.7);
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onPointerUp = () => {
      dragging = false;
    };
    const onWheelCanvas = (e: WheelEvent) => {
      if (currentPhase !== 'inspect') return;
      e.preventDefault();
      inspectR = clamp(inspectR + e.deltaY * 0.0022, 1.4, 5.5);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDownCanvas);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheelCanvas, { passive: false });

    const onKeyDown = (e: KeyboardEvent) => {
      audio.ensure();
      if (e.code === 'KeyR') {
        startMission(currentLevel);
      } else if (e.code === 'KeyM') {
        toggleAudio();
      } else if (e.code === 'KeyI') {
        toggleInspect();
      } else if (e.code === 'Escape' && currentPhase === 'inspect') {
        exitInspect();
      } else if (e.code === 'Enter' || e.code === 'Space') {
        if (currentPhase === 'inspect') {
          e.preventDefault();
          exitInspect();
        } else if (currentPhase !== 'playing') {
          e.preventDefault();
          if (currentPhase === 'won' && latestWin) {
            startMission(latestWin.level + 1);
          } else {
            startMission(currentLevel);
          }
        }
      }
    };
    const onFirstPointer = () => audio.ensure();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onFirstPointer, { once: true });

    const clock = new THREE.Clock();
    let netAccumulator = 0;
    let hudAccumulator = 0;
    const netInterval = 1 / GAME_CONFIG.network.tickRate;
    let frameId = 0;
    let disposed = false;

    const afterDraw = (cb: () => void) => {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (typeof gl.fenceSync !== 'function') {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    };

    const tick = () => {
      if (disposed) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const P = GAME_CONFIG.player;
      const playing = currentPhase === 'playing';

      const k = input.getIntent();
      const intent = playing
        ? {
            forward: clamp(k.forward + touch.f - touch.b, -1, 1),
            turn: clamp(k.turn + touch.l - touch.r, -1, 1),
            sprint: k.sprint || touch.s === 1,
          }
        : { forward: 0, turn: 0, sprint: false };

      if (playing) {
        rotationY += intent.turn * P.turnSpeed * dt;
        let speed = intent.sprint ? P.runSpeed : P.walkSpeed;
        if (intent.forward < 0) speed *= P.backwardFactor;
        position.x += Math.sin(rotationY) * intent.forward * speed * dt;
        position.z += Math.cos(rotationY) * intent.forward * speed * dt;
        resolveCollisions(position);
      }

      const moving = intent.forward !== 0;
      const animState: AgentAnimationState = moving ? (intent.sprint ? 'run' : 'walk') : 'idle';
      agent.setTransform(position, rotationY);
      agent.setAnimationState(animState, intent.forward < 0 ? -1 : 1);
      agent.update(dt);
      if (playing && agent.consumeFootstep()) {
        audio.footstep(intent.sprint);
      }

      mission.update(dt, position, moving, intent.sprint, playing);

      if (currentPhase === 'inspect' && !dragging) {
        inspectAngle += dt * 0.18;
      }
      computeCameraTarget();
      camera.position.lerp(
        camTargetPos,
        1 - Math.exp(-(currentPhase === 'inspect' ? 9 : CC.followSmoothing) * dt),
      );
      if (shake > 0.001) {
        shake = Math.max(0, shake - dt * 1.6);
        camera.position.x += (Math.random() - 0.5) * shake * 0.5;
        camera.position.y += (Math.random() - 0.5) * shake * 0.4;
      }
      lookTarget.set(position.x, currentPhase === 'inspect' ? 1.32 : CC.lookAtHeight, position.z);
      camera.lookAt(lookTarget);

      // Drifting dust + god rays + fill pulse
      const dp = dustGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < DUST; i++) {
        let y = dp.getY(i) + dustSpd[i] * dt;
        if (y > 3.7) y = 0.05;
        dp.setY(i, y);
        dp.setX(i, dp.getX(i) + Math.sin(t * 0.35 + i) * 0.0007);
      }
      dp.needsUpdate = true;
      rays.rotation.y = Math.sin(t * 0.1) * 0.04;
      rayMat.opacity = 0.045 + Math.sin(t * 0.7) * 0.012;
      fillLight.intensity = 8 + Math.sin(t * 0.9) * 1.4;

      const rk = 1 - Math.exp(-12 * dt);
      for (const r of remotes.values()) {
        r.current.lerp(r.target, rk);
        r.currentRot = dampAngle(r.currentRot, r.targetRot, rk);
        r.agent.setTransform(r.current, r.currentRot);
        r.agent.update(dt);
      }

      netAccumulator += dt;
      if (netAccumulator >= netInterval) {
        netAccumulator = 0;
        network.broadcastState({
          position: { x: position.x, y: position.y, z: position.z },
          rotationY,
          animationState: animState,
          sentAt: Date.now(),
        });
      }

      hudAccumulator += dt;
      if (hudAccumulator >= 0.08) {
        hudAccumulator = 0;
        syncHudSnapshot();
        drawRadar();
      }

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    };

    syncHudSnapshot();
    drawRadar();
    tick();

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(
        isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, GAME_CONFIG.render.maxPixelRatio),
      );
    };
    window.addEventListener('resize', handleResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.clearTimeout(toastTimerRef.current);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onFirstPointer);
      renderer.domElement.removeEventListener('pointerdown', onPointerDownCanvas);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheelCanvas);
      unsubscribeNet();
      input.dispose();
      audio.dispose();
      mission.dispose();
      network.disconnect();
      envTarget.dispose();

      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => m.dispose());
          } else {
            mesh.material.dispose();
          }
        }
      });

      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [showToast]);

  const briefParams = (() => {
    const L = GAME_CONFIG.mission.levels[Math.min(hud.level, 3) - 1];
    const extra = Math.max(0, hud.level - 3);
    return {
      name: L.name + (extra ? ' +' + extra : ''),
      intel: Math.min(GAME_CONFIG.mission.intelSpots.length, L.intel + extra),
      time: Math.max(70, L.time - extra * 4),
    };
  })();

  const timeFormatted = `${String(Math.floor(hud.timeLeft / 60)).padStart(2, '0')}:${String(
    hud.timeLeft % 60,
  ).padStart(2, '0')}`;

  const rigLabel =
    hud.rigMode === 'static'
      ? hud.isDeformed
        ? 'GLB · LIMBER'
        : 'GLB · RIGID'
      : hud.rigMode === 'clips'
        ? 'ANIMATED'
        : 'PROCEDURAL';

  const setTouchKey = (k: 'f' | 'b' | 'l' | 'r' | 's', val: number) => {
    if (engineRef.current) {
      engineRef.current.touch[k] = val;
    }
  };

  const showOverlay = gameState === 'briefing' || gameState === 'won' || gameState === 'lost';

  return (
    <div
      className="relative w-screen h-screen overflow-hidden bg-[#080d16] text-[#ece7db] select-none outline-none font-sans"
      tabIndex={0}
      onPointerDown={(e) => e.currentTarget.focus()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f && /\.(glb|gltf)$/i.test(f.name)) {
          engineRef.current?.loadGlbFile(f);
        }
      }}
    >
      <div ref={mountRef} className="fixed inset-0" />

      {/* Danger Vignette */}
      <div
        className="fixed inset-0 pointer-events-none z-[3] transition-opacity duration-200"
        style={{
          opacity: Math.min(0.85, hud.detection / 110),
          background:
            'radial-gradient(ellipse at center, transparent 42%, rgba(255,59,92,0.55) 100%)',
        }}
      />

      {/* Top-Left Mission Panel */}
      <div className="fixed top-3.5 left-3.5 z-[5] pointer-events-none rounded-[11px] border border-[#2a3c56] bg-[#0e1726]/95 px-4 py-3 min-w-[250px] max-w-[calc(100vw-28px)] shadow-[0_10px_34px_rgba(0,0,0,0.5)]">
        <h1 className="m-0 mb-0.5 text-[13px] font-extrabold tracking-[2.6px]">
          AGENT <b className="text-[#ffb454]">SMITH</b>
        </h1>
        <div className="font-mono text-[9.5px] tracking-[1.6px] text-[#5f7089] mb-2">
          OPERATION NIGHTDESK &middot; LEVEL {hud.level} &middot; {hud.levelName}
        </div>
        <div className="text-[11.5px] text-[#38c6ff] tracking-[0.4px] mb-2 leading-[1.45] min-h-[32px]">
          {hud.objective}
        </div>
        <div className="flex gap-3.5 items-center">
          <div className="font-mono">
            <div className="text-[8.5px] tracking-[1.6px] text-[#5f7089]">TIME</div>
            <div
              className={`text-[19px] font-bold tracking-[1px] ${
                hud.timeLeft <= 15
                  ? 'text-[#ff3b5c]'
                  : hud.timeLeft <= 35
                    ? 'text-[#ffb454]'
                    : 'text-[#ece7db]'
              }`}
            >
              {timeFormatted}
            </div>
          </div>
          <div className="font-mono">
            <div className="text-[8.5px] tracking-[1.6px] text-[#5f7089]">INTEL</div>
            <div className="text-[19px] font-bold tracking-[1px]">
              {hud.collected}/{hud.total}
            </div>
            <div className="flex gap-1 mt-0.5">
              {Array.from({ length: hud.total }).map((_, idx) => (
                <div
                  key={idx}
                  className={`w-[13px] h-[5px] rounded-[2px] border ${
                    idx < hud.collected
                      ? 'bg-gradient-to-r from-[#38c6ff] to-[#a4f45c] border-transparent shadow-[0_0_8px_rgba(56,198,255,0.6)]'
                      : 'bg-[#1a2637] border-[#2a3c56]'
                  }`}
                />
              ))}
            </div>
          </div>
          <div className="font-mono">
            <div className="text-[8.5px] tracking-[1.6px] text-[#5f7089]">SCORE</div>
            <div className="text-[19px] font-bold tracking-[1px]">{hud.score}</div>
          </div>
        </div>
      </div>

      {/* Top-Right Controls + Inspect + Facing Calibration */}
      <div className="fixed top-3.5 right-3.5 z-[5] flex flex-col gap-2 items-end pointer-events-auto">
        <div className="flex gap-1.5 px-2.5 py-2 items-center rounded-[11px] border border-[#2a3c56] bg-[#0e1726]/95 shadow-[0_10px_34px_rgba(0,0,0,0.5)]">
          <button
            type="button"
            onClick={() => engineRef.current?.toggleAudio()}
            className={`font-mono text-[10px] tracking-[1.1px] cursor-pointer rounded-[7px] px-2.5 py-1.5 border transition-colors ${
              muted
                ? 'bg-[#1a2637] text-[#ece7db] border-[#2a3c56] hover:border-[#ffb454] hover:text-[#ffb454]'
                : 'bg-gradient-to-r from-[#ffb454] to-[#38c6ff] text-[#080d16] border-transparent font-bold'
            }`}
          >
            {muted ? 'AUDIO OFF' : 'AUDIO ON'}
          </button>
          <select
            value={difficultyLevel}
            onChange={(e) => engineRef.current?.startMission(Number(e.target.value))}
            className="font-mono text-[10px] tracking-[1.1px] cursor-pointer bg-[#1a2637] text-[#ece7db] border border-[#2a3c56] rounded-[7px] px-2.5 py-1.5 hover:border-[#ffb454]"
          >
            <option value={1}>RECRUIT</option>
            <option value={2}>AGENT</option>
            <option value={3}>PHANTOM</option>
          </select>
          <button
            type="button"
            onClick={() => engineRef.current?.startMission(hud.level)}
            className="font-mono text-[10px] tracking-[1.1px] cursor-pointer bg-[#1a2637] text-[#ff3b5c] border border-[#ff3b5c]/50 rounded-[7px] px-2.5 py-1.5 hover:border-[#ff3b5c]"
          >
            RESTART
          </button>
        </div>

        <div className="flex gap-1.5 px-2.5 py-2 items-center rounded-[11px] border border-[#2a3c56] bg-[#0e1726]/95 shadow-[0_10px_34px_rgba(0,0,0,0.5)]">
          <span className="font-mono text-[9.5px] tracking-[1.1px] text-[#5f7089] px-1.5">
            RIG <b className="text-[#a4f45c]">{rigLabel}</b>
          </span>
          <button
            type="button"
            onClick={() => engineRef.current?.toggleInspect()}
            className={`font-mono text-[10px] tracking-[1.1px] cursor-pointer rounded-[7px] px-2.5 py-1.5 border transition-colors ${
              gameState === 'inspect'
                ? 'bg-gradient-to-r from-[#a4f45c] to-[#38c6ff] text-[#080d16] border-transparent font-bold'
                : 'bg-[#1a2637] text-[#ece7db] border-[#2a3c56] hover:border-[#ffb454] hover:text-[#ffb454]'
            }`}
          >
            {gameState === 'inspect' ? 'RESUME' : 'INSPECT'}
          </button>
          <button
            type="button"
            onClick={() => engineRef.current?.swapRig()}
            className="font-mono text-[10px] tracking-[1.1px] cursor-pointer bg-[#1a2637] text-[#ece7db] border border-[#2a3c56] rounded-[7px] px-2.5 py-1.5 hover:border-[#ffb454] hover:text-[#ffb454]"
          >
            SWAP
          </button>
        </div>

        <div className="flex flex-col gap-1.5 px-3 py-2.5 w-[262px] rounded-[11px] border border-[#2a3c56] bg-[#0e1726]/95 shadow-[0_10px_34px_rgba(0,0,0,0.5)]">
          <div className="flex justify-between items-center font-mono text-[9px] tracking-[1.5px] text-[#5f7089]">
            <span>FACING CALIBRATION</span>
            <span className="text-[#38c6ff] text-[11px] font-bold">{facingDeg}&deg;</span>
          </div>
          <input
            type="range"
            min={-180}
            max={180}
            step={1}
            value={facingDeg}
            onChange={(e) => engineRef.current?.applyFacing(Number(e.target.value), false)}
            onMouseUp={(e) =>
              engineRef.current?.applyFacing(Number((e.target as HTMLInputElement).value), true)
            }
            onTouchEnd={(e) =>
              engineRef.current?.applyFacing(Number((e.target as HTMLInputElement).value), true)
            }
            className="w-full h-1.5 rounded cursor-pointer accent-[#ffb454]"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => engineRef.current?.applyFacing(facingDeg - 15, true)}
              className="flex-1 font-mono text-[9.5px] cursor-pointer bg-[#1a2637] text-[#ece7db] border border-[#2a3c56] rounded-[6px] py-1 hover:border-[#ffb454] hover:text-[#ffb454]"
            >
              &minus;15&deg;
            </button>
            <button
              type="button"
              onClick={() => engineRef.current?.applyFacing(facingDeg + 15, true)}
              className="flex-1 font-mono text-[9.5px] cursor-pointer bg-[#1a2637] text-[#ece7db] border border-[#2a3c56] rounded-[6px] py-1 hover:border-[#ffb454] hover:text-[#ffb454]"
            >
              +15&deg;
            </button>
            <button
              type="button"
              onClick={() => engineRef.current?.applyFacing(180, true)}
              className="flex-1 font-mono text-[9.5px] cursor-pointer bg-[#1a2637] text-[#ece7db] border border-[#2a3c56] rounded-[6px] py-1 hover:border-[#ffb454] hover:text-[#ffb454]"
            >
              180&deg;
            </button>
            <button
              type="button"
              onClick={() => engineRef.current?.applyFacing(0, true)}
              className="flex-1 font-mono text-[9.5px] cursor-pointer bg-[#1a2637] text-[#ece7db] border border-[#2a3c56] rounded-[6px] py-1 hover:border-[#ffb454] hover:text-[#ffb454]"
            >
              0&deg;
            </button>
          </div>
        </div>
      </div>

      {/* Inspect Banner */}
      {gameState === 'inspect' && (
        <div className="fixed left-1/2 top-3.5 -translate-x-1/2 z-[6] pointer-events-none rounded-[11px] border border-[#2a3c56] bg-[#0e1726]/95 px-4 py-2 font-mono text-[10.5px] tracking-[1.3px] text-[#a4f45c] text-center leading-[1.6] max-w-[92vw] shadow-[0_10px_34px_rgba(0,0,0,0.5)]">
          INSPECT MODE &mdash; mission paused &middot; <b className="text-[#ece7db]">DRAG</b> orbit
          &middot; <b className="text-[#ece7db]">WHEEL</b> zoom &middot; slide{' '}
          <b className="text-[#ece7db]">FACING</b> until his nose points where he walks
        </div>
      )}

      {/* Bottom-Left Detection Meter */}
      <div className="fixed bottom-3.5 left-3.5 z-[5] pointer-events-none rounded-[11px] border border-[#2a3c56] bg-[#0e1726]/95 px-3.5 py-2.5 w-[262px] max-w-[calc(100vw-28px)] shadow-[0_10px_34px_rgba(0,0,0,0.5)]">
        <div className="font-mono text-[8.5px] tracking-[1.8px] text-[#5f7089] flex justify-between">
          <span>DETECTION</span>
          <span>{hud.detection}%</span>
        </div>
        <div className="h-[7px] rounded-[4px] bg-[#1a2637] border border-[#2a3c56] my-1.5 overflow-hidden">
          <div
            className={`h-full rounded-[3px] transition-all duration-150 ${
              hud.detection > 70
                ? 'bg-gradient-to-r from-[#ff3b5c] to-[#ff4fd8] shadow-[0_0_12px_rgba(255,59,92,0.7)]'
                : hud.detection > 35
                  ? 'bg-gradient-to-r from-[#ffb454] to-[#ff4fd8]'
                  : 'bg-gradient-to-r from-[#38c6ff] to-[#a4f45c]'
            }`}
            style={{ width: `${hud.detection}%` }}
          />
        </div>
        <div
          className={`text-[11px] tracking-[0.3px] min-h-[30px] leading-[1.45] ${
            statusMsg.kind === 'alert'
              ? 'text-[#ff3b5c] font-semibold'
              : statusMsg.kind === 'good'
                ? 'text-[#a4f45c]'
                : 'text-[#93a3b8]'
          }`}
        >
          {statusMsg.text}
        </div>
      </div>

      {/* Bottom-Right Radar Minimap */}
      <div className="fixed bottom-3.5 right-3.5 z-[5] pointer-events-none hidden md:block rounded-[11px] border border-[#2a3c56] bg-[#0e1726]/95 p-[9px] shadow-[0_10px_34px_rgba(0,0,0,0.5)]">
        <canvas ref={radarRef} width={150} height={150} className="block rounded-[7px]" />
      </div>

      {/* Toast Notification */}
      <div
        className={`fixed left-1/2 top-[84px] -translate-x-1/2 z-[8] pointer-events-none font-mono text-[11.5px] tracking-[1.2px] px-4 py-2 rounded-lg bg-[#121c2b]/95 border text-center max-w-[86vw] transition-all duration-200 ${
          toastState.visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3'
        } ${
          toastState.bad ? 'border-[#ff3b5c] text-[#ff3b5c]' : 'border-[#a4f45c] text-[#a4f45c]'
        }`}
      >
        {toastState.text}
      </div>

      {/* Mobile Touch Controls */}
      {isTouchDevice && gameState === 'playing' && (
        <div className="fixed inset-x-0 bottom-0 z-[7] flex justify-between px-4 pb-24 pointer-events-none">
          <div className="grid grid-cols-3 grid-rows-2 gap-1.5 pointer-events-auto">
            <span />
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                setTouchKey('f', 1);
              }}
              onPointerUp={() => setTouchKey('f', 0)}
              onPointerLeave={() => setTouchKey('f', 0)}
              onPointerCancel={() => setTouchKey('f', 0)}
              className="w-[54px] h-[54px] rounded-xl border border-[#2a3c56] bg-[#1a2637]/90 text-[#ece7db] text-lg font-mono"
            >
              ▲
            </button>
            <span />
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                setTouchKey('l', 1);
              }}
              onPointerUp={() => setTouchKey('l', 0)}
              onPointerLeave={() => setTouchKey('l', 0)}
              onPointerCancel={() => setTouchKey('l', 0)}
              className="w-[54px] h-[54px] rounded-xl border border-[#2a3c56] bg-[#1a2637]/90 text-[#ece7db] text-lg font-mono"
            >
              ◀
            </button>
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                setTouchKey('b', 1);
              }}
              onPointerUp={() => setTouchKey('b', 0)}
              onPointerLeave={() => setTouchKey('b', 0)}
              onPointerCancel={() => setTouchKey('b', 0)}
              className="w-[54px] h-[54px] rounded-xl border border-[#2a3c56] bg-[#1a2637]/90 text-[#ece7db] text-lg font-mono"
            >
              ▼
            </button>
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                setTouchKey('r', 1);
              }}
              onPointerUp={() => setTouchKey('r', 0)}
              onPointerLeave={() => setTouchKey('r', 0)}
              onPointerCancel={() => setTouchKey('r', 0)}
              className="w-[54px] h-[54px] rounded-xl border border-[#2a3c56] bg-[#1a2637]/90 text-[#ece7db] text-lg font-mono"
            >
              ▶
            </button>
          </div>
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              setTouchKey('s', 1);
            }}
            onPointerUp={() => setTouchKey('s', 0)}
            onPointerLeave={() => setTouchKey('s', 0)}
            onPointerCancel={() => setTouchKey('s', 0)}
            className="pointer-events-auto w-[82px] h-[82px] self-end rounded-xl border border-[#2a3c56] bg-[#1a2637]/90 text-[#ece7db] text-[11px] tracking-[1.4px] font-bold font-mono"
          >
            SPRINT
          </button>
        </div>
      )}

      {/* Briefing / Win / Lose Overlay */}
      {showOverlay && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center p-5"
          style={{
            background:
              'radial-gradient(ellipse at 50% 40%, rgba(13,21,34,0.88), rgba(6,10,17,0.96))',
          }}
        >
          <div className="w-[min(580px,94vw)] max-h-[88vh] overflow-y-auto rounded-[11px] border border-[#2a3c56] bg-[#101927] p-6 sm:p-7 shadow-[0_18px_48px_rgba(0,0,0,0.65)]">
            {gameState === 'briefing' && (
              <>
                <div className="font-mono text-[9.5px] tracking-[3px] text-[#ffb454] mb-2">
                  CLASSIFIED &middot; MISSION BRIEF
                </div>
                <h2 className="m-0 mb-2.5 text-[26px] font-bold tracking-[1.4px] leading-[1.15]">
                  Operation Nightdesk
                </h2>
                <p className="m-0 mb-3 text-[13px] leading-[1.75] text-[#93a3b8]">
                  You are <b className="text-[#ece7db]">Agent Smith</b>. Infiltrate the executive
                  office, secure <b className="text-[#ece7db]">{briefParams.intel} intel dossiers</b>,
                  then reach the <b className="text-[#ece7db]">extraction zone</b> by the east door
                  before the clock runs out.
                </p>
                <p className="m-0 mb-3 text-[13px] leading-[1.75] text-[#93a3b8]">
                  A ceiling camera sweeps the room. Standing in its beam raises{' '}
                  <b className="text-[#ece7db]">detection</b> &mdash; sprinting is loud and raises
                  it <b className="text-[#ece7db]">{GAME_CONFIG.mission.sprintNoise}&times; faster</b>
                  . Break line of sight behind the filing cabinets, or stand still to cool down.
                </p>
                <p className="m-0 mb-3.5 text-[13px] leading-[1.75] text-[#93a3b8]">
                  First time with your own scanned agent? Press{' '}
                  <b className="text-[#ece7db]">INSPECT</b> to orbit his face, then slide{' '}
                  <b className="text-[#ece7db]">FACING</b> until his nose points the way he walks.
                  The setting is remembered.
                </p>
                <div className="flex gap-1.5 flex-wrap mb-4">
                  {[
                    'W',
                    'A',
                    'S',
                    'D',
                    '↑↓←→',
                    'SHIFT sprint',
                    'I inspect',
                    'R restart',
                    'M mute',
                  ].map((keyLabel) => (
                    <kbd
                      key={keyLabel}
                      className="font-mono text-[10px] bg-[#1a2637] border border-b-2 border-[#2a3c56] rounded-[5px] px-2 py-0.5 text-[#93a3b8]"
                    >
                      {keyLabel}
                    </kbd>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-2.5 mb-4">
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      DIFFICULTY
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#38c6ff]">
                      {briefParams.name}
                    </div>
                  </div>
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      TIME LIMIT
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#38c6ff]">
                      {briefParams.time}s
                    </div>
                  </div>
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      BEST SCORE
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#ffb454]">
                      {bestScore}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => engineRef.current?.startMission(hud.level)}
                    className="flex-1 min-w-[140px] font-mono text-[11.5px] tracking-[1.4px] font-bold cursor-pointer py-3 px-4 rounded-[9px] bg-gradient-to-r from-[#ffb454] to-[#38c6ff] text-[#080d16] shadow-[0_0_22px_rgba(255,180,84,0.3)] hover:shadow-[0_0_32px_rgba(56,198,255,0.5)] transition-shadow"
                  >
                    DEPLOY AGENT
                  </button>
                  <button
                    type="button"
                    onClick={() => engineRef.current?.enterInspect()}
                    className="flex-1 min-w-[140px] font-mono text-[11.5px] tracking-[1.4px] font-bold cursor-pointer py-3 px-4 rounded-[9px] border border-[#2a3c56] bg-[#1a2637] text-[#ece7db] hover:border-[#38c6ff] hover:text-[#38c6ff]"
                  >
                    INSPECT AGENT
                  </button>
                </div>
              </>
            )}

            {gameState === 'won' && winSummary && (
              <>
                <div className="font-mono text-[9.5px] tracking-[3px] text-[#ffb454] mb-2">
                  EXTRACTION CONFIRMED
                </div>
                <h2 className="m-0 mb-2.5 text-[26px] font-bold tracking-[1.4px] leading-[1.15] text-[#a4f45c]">
                  Mission Complete
                </h2>
                <p className="m-0 mb-4 text-[13px] leading-[1.75] text-[#93a3b8]">
                  All <b className="text-[#ece7db]">{winSummary.intel} dossiers</b> recovered and
                  delivered. Handler is pleased, Agent.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-4">
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      RANK
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#a4f45c]">
                      {winSummary.rank}
                    </div>
                  </div>
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      SCORE
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#ffb454]">
                      {winSummary.score}
                    </div>
                  </div>
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      TIME LEFT
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#38c6ff]">
                      {winSummary.timeLeft}s
                    </div>
                  </div>
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      DETECTION
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#38c6ff]">
                      {winSummary.detection}%
                    </div>
                  </div>
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      BEST
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#ffb454]">
                      {bestScore}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => engineRef.current?.startMission(winSummary.level + 1)}
                    className="flex-1 min-w-[140px] font-mono text-[11.5px] tracking-[1.4px] font-bold cursor-pointer py-3 px-4 rounded-[9px] bg-gradient-to-r from-[#ffb454] to-[#38c6ff] text-[#080d16]"
                  >
                    NEXT MISSION &middot; LEVEL {winSummary.level + 1}
                  </button>
                  <button
                    type="button"
                    onClick={() => engineRef.current?.startMission(winSummary.level)}
                    className="flex-1 min-w-[140px] font-mono text-[11.5px] tracking-[1.4px] font-bold cursor-pointer py-3 px-4 rounded-[9px] border border-[#2a3c56] bg-[#1a2637] text-[#ece7db] hover:border-[#38c6ff] hover:text-[#38c6ff]"
                  >
                    REPLAY LEVEL {winSummary.level}
                  </button>
                </div>
              </>
            )}

            {gameState === 'lost' && loseSummary && (
              <>
                <div className="font-mono text-[9.5px] tracking-[3px] text-[#ffb454] mb-2">
                  MISSION ABORTED
                </div>
                <h2 className="m-0 mb-2.5 text-[26px] font-bold tracking-[1.4px] leading-[1.15] text-[#ff3b5c]">
                  {loseSummary.reason === 'BUSTED' ? 'Cover Blown' : 'Time Expired'}
                </h2>
                <p className="m-0 mb-4 text-[13px] leading-[1.75] text-[#93a3b8]">
                  {loseSummary.reason === 'BUSTED'
                    ? 'Security locked onto you. Break the beam earlier — cabinets block its line of sight, and standing still cools detection fastest.'
                    : 'The window closed before extraction. Sprint between dossiers, but remember sprinting is loud inside the beam.'}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      INTEL
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#38c6ff]">
                      {loseSummary.collected}/{loseSummary.total}
                    </div>
                  </div>
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      SCORE
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#ffb454]">
                      {loseSummary.score}
                    </div>
                  </div>
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      LEVEL
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#38c6ff]">
                      {loseSummary.level}
                    </div>
                  </div>
                  <div className="border border-[#2a3c56] rounded-[9px] p-2.5 bg-[#1a2637]">
                    <div className="font-mono text-[8.5px] tracking-[1.5px] text-[#5f7089]">
                      BEST
                    </div>
                    <div className="font-mono text-[18px] font-bold text-[#ffb454]">
                      {bestScore}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => engineRef.current?.startMission(loseSummary.level)}
                    className="flex-1 min-w-[140px] font-mono text-[11.5px] tracking-[1.4px] font-bold cursor-pointer py-3 px-4 rounded-[9px] bg-gradient-to-r from-[#ffb454] to-[#38c6ff] text-[#080d16]"
                  >
                    RETRY MISSION
                  </button>
                  <button
                    type="button"
                    onClick={() => engineRef.current?.showBriefing()}
                    className="flex-1 min-w-[140px] font-mono text-[11.5px] tracking-[1.4px] font-bold cursor-pointer py-3 px-4 rounded-[9px] border border-[#2a3c56] bg-[#1a2637] text-[#ece7db] hover:border-[#38c6ff] hover:text-[#38c6ff]"
                  >
                    CHANGE DIFFICULTY
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
