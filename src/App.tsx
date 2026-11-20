import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GAME_CONFIG } from './config/gameConfig';
import { createOfficeRoom } from './scene/officeRoom';
import { AgentSmith, type AgentAnimationState } from './character/agentSmith';
import { InputController } from './controls/inputController';
import { NetworkSync } from './network/networkSync';

interface RemoteAgentEntry {
  agent: AgentSmith;
  current: THREE.Vector3;
  currentRot: number;
  target: THREE.Vector3;
  targetRot: number;
}

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
  const cx = Math.max(b.min.x, Math.min(pos.x, b.max.x));
  const cz = Math.max(b.min.z, Math.min(pos.z, b.max.z));
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
  const [animStateLabel, setAnimStateLabel] = useState<string>('IDLE');
  const [netLabel, setNetLabel] = useState<string>('offline (stub)');

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareGl();

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(
      isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, GAME_CONFIG.render.maxPixelRatio),
    );
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0f1a);

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
    const input = new InputController(window);
    const network = new NetworkSync(GAME_CONFIG.network);
    network.connect();
    setNetLabel(network.enabled ? 'online' : 'offline (stub)');

    const spawn = GAME_CONFIG.player.spawn;
    const position = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
    let rotationY: number = spawn.rotationY;

    const localPlayer = new AgentSmith();
    scene.add(localPlayer.group);
    localPlayer.setTransform(position, rotationY);

    const remotes = new Map<string, RemoteAgentEntry>();
    const unsubscribeNet = network.onRemotePlayerUpdate((msg) => {
      if (!msg || !msg.id || msg.id === network.playerId) return;
      let r = remotes.get(msg.id);
      if (!r) {
        const agent = new AgentSmith();
        scene.add(agent.group);
        r = {
          agent,
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
      pos.x = Math.max(minX + r, Math.min(pos.x, maxX - r));
      pos.z = Math.max(minZ + r, Math.min(pos.z, maxZ - r));
      for (const b of room.colliders) resolveCircleBox(pos, r, b);
    };

    const camCfg = GAME_CONFIG.camera;
    const camTargetPos = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();

    const computeCameraTarget = () => {
      const fx = Math.sin(rotationY);
      const fz = Math.cos(rotationY);
      camTargetPos.set(
        position.x - fx * camCfg.distance,
        camCfg.height,
        position.z - fz * camCfg.distance,
      );
      const m = camCfg.wallMargin;
      camTargetPos.x = Math.max(room.bounds.minX + m, Math.min(camTargetPos.x, room.bounds.maxX - m));
      camTargetPos.z = Math.max(room.bounds.minZ + m, Math.min(camTargetPos.z, room.bounds.maxZ - m));
      camTargetPos.y = Math.max(0.6, Math.min(camTargetPos.y, GAME_CONFIG.room.height - 0.25));
    };

    computeCameraTarget();
    camera.position.copy(camTargetPos);
    lookTarget.set(position.x, camCfg.lookAtHeight, position.z);
    camera.lookAt(lookTarget);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    const clock = new THREE.Clock();
    let lastAnimState: AgentAnimationState = 'idle';
    let netAccumulator = 0;
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
      const P = GAME_CONFIG.player;

      const intent = input.getIntent();
      rotationY += intent.turn * P.turnSpeed * dt;

      let speed = intent.sprint ? P.runSpeed : P.walkSpeed;
      if (intent.forward < 0) speed *= P.backwardFactor;
      position.x += Math.sin(rotationY) * intent.forward * speed * dt;
      position.z += Math.cos(rotationY) * intent.forward * speed * dt;
      resolveCollisions(position);

      const animState: AgentAnimationState =
        intent.forward !== 0 ? (intent.sprint ? 'run' : 'walk') : 'idle';
      localPlayer.setTransform(position, rotationY);
      localPlayer.setAnimationState(animState, intent.forward < 0 ? -1 : 1);
      localPlayer.update(dt);
      if (animState !== lastAnimState) {
        lastAnimState = animState;
        setAnimStateLabel(animState.toUpperCase());
      }

      computeCameraTarget();
      camera.position.lerp(camTargetPos, 1 - Math.exp(-camCfg.followSmoothing * dt));
      lookTarget.set(position.x, camCfg.lookAtHeight, position.z);
      camera.lookAt(lookTarget);

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

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    };

    tick();

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(
        isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, GAME_CONFIG.render.maxPixelRatio),
      );
    };
    window.addEventListener('resize', handleResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', handleResize);
      unsubscribeNet();
      input.dispose();
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
  }, []);

  return (
    <div
      className="relative w-screen h-screen overflow-hidden bg-[#0a0f1a] select-none outline-none"
      tabIndex={0}
      onPointerDown={(e) => e.currentTarget.focus()}
    >
      <div ref={mountRef} className="w-full h-full" />

      <div className="fixed top-4 left-4 z-10 pointer-events-none text-[#d7e1ee]">
        <h1 className="m-0 mb-2 text-[15px] font-semibold tracking-[2px] text-white">
          AGENT SMITH &middot; OFFICE PROTOTYPE
        </h1>
        <p className="my-[3px] text-xs opacity-85">
          <kbd className="rounded border border-b-2 border-[#33445c] bg-[#1c2735] px-1.5 py-[1px] text-[11px] font-sans">
            W
          </kbd>
          /
          <kbd className="rounded border border-b-2 border-[#33445c] bg-[#1c2735] px-1.5 py-[1px] text-[11px] font-sans">
            &uarr;
          </kbd>{' '}
          forward &nbsp;&middot;&nbsp;{' '}
          <kbd className="rounded border border-b-2 border-[#33445c] bg-[#1c2735] px-1.5 py-[1px] text-[11px] font-sans">
            S
          </kbd>
          /
          <kbd className="rounded border border-b-2 border-[#33445c] bg-[#1c2735] px-1.5 py-[1px] text-[11px] font-sans">
            &darr;
          </kbd>{' '}
          backward
        </p>
        <p className="my-[3px] text-xs opacity-85">
          <kbd className="rounded border border-b-2 border-[#33445c] bg-[#1c2735] px-1.5 py-[1px] text-[11px] font-sans">
            A
          </kbd>
          /
          <kbd className="rounded border border-b-2 border-[#33445c] bg-[#1c2735] px-1.5 py-[1px] text-[11px] font-sans">
            &larr;
          </kbd>{' '}
          turn left &nbsp;&middot;&nbsp;{' '}
          <kbd className="rounded border border-b-2 border-[#33445c] bg-[#1c2735] px-1.5 py-[1px] text-[11px] font-sans">
            D
          </kbd>
          /
          <kbd className="rounded border border-b-2 border-[#33445c] bg-[#1c2735] px-1.5 py-[1px] text-[11px] font-sans">
            &rarr;
          </kbd>{' '}
          turn right
        </p>
        <p className="my-[3px] text-xs opacity-85">
          <kbd className="rounded border border-b-2 border-[#33445c] bg-[#1c2735] px-1.5 py-[1px] text-[11px] font-sans">
            Shift
          </kbd>{' '}
          + move = sprint
        </p>
      </div>

      <div className="fixed left-4 bottom-3.5 z-10 pointer-events-none text-xs text-[#d7e1ee] opacity-85">
        STATE: <b className="tracking-[1px] text-[#7fd1ff]">{animStateLabel}</b> &nbsp;&middot;&nbsp; NET:{' '}
        <span>{netLabel}</span>
      </div>
    </div>
  );
}
