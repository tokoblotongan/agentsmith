import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig';
import type { OfficeRoomResult } from '../scene/officeRoom';

const MC = GAME_CONFIG.mission;

export interface MissionParams {
  name: string;
  intel: number;
  time: number;
  sweep: number;
  detect: number;
}

export interface MissionWinSummary {
  score: number;
  rank: 'S' | 'A' | 'B' | 'C';
  timeLeft: number;
  detection: number;
  level: number;
  intel: number;
}

export interface MissionLoseSummary {
  reason: 'BUSTED' | 'TIME';
  collected: number;
  total: number;
  score: number;
  level: number;
}

export interface MissionHooks {
  onIntel?: (collected: number, total: number) => void;
  onExit?: () => void;
  onAlert?: (intensity: number) => void;
  onAlertState?: (alerted: boolean) => void;
  onWin?: (summary: MissionWinSummary) => void;
  onLose?: (summary: MissionLoseSummary) => void;
}

export interface IntelSpotItem {
  group: THREE.Group;
  ring: THREE.Mesh;
  label: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  x: number;
  z: number;
  active: boolean;
  phase: number;
}

function glowTexture(): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function segBlocked(ax: number, az: number, bx: number, bz: number, b: THREE.Box3): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  const axes: Array<[number, number, number, number]> = [
    [ax, dx, b.min.x, b.max.x],
    [az, dz, b.min.z, b.max.z],
  ];
  for (const [p, d, mn, mx] of axes) {
    if (Math.abs(d) < 1e-8) {
      if (p < mn || p > mx) return false;
    } else {
      let ta = (mn - p) / d;
      let tb = (mx - p) / d;
      if (ta > tb) {
        const tmp = ta;
        ta = tb;
        tb = tmp;
      }
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
  }
  return true;
}

export class Mission {
  private hooks: MissionHooks;
  private blockers: THREE.Box3[];
  private glow: THREE.CanvasTexture;

  public level = 1;
  public state: 'idle' | 'playing' | 'won' | 'lost' = 'idle';
  public collected = 0;
  public total = 4;
  public detection = 0;
  public timeLeft = 120;
  public exitActive = false;
  public score = 0;
  public alerted = false;
  public spotted = false;
  public params_!: MissionParams;

  public intel: IntelSpotItem[] = [];
  public cam!: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    half: number;
    reach: number;
    speed: number;
  };
  public exitPos!: THREE.Vector3;

  private _t = 0;
  private _alertClock = 0;
  private head!: THREE.Group;
  private lens!: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  private beamMat!: THREE.MeshBasicMaterial;
  private beam!: THREE.Mesh;
  private spot!: THREE.SpotLight;
  private spotTarget!: THREE.Object3D;

  private exitRing!: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private exitColumn!: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private exitGlow!: THREE.Sprite;
  private exitGroup!: THREE.Group;

  private N = 150;
  private pPos!: Float32Array;
  private pVel!: Float32Array;
  private pLife!: Float32Array;
  private points!: THREE.Points;
  private pCursor = 0;

  constructor(scene: THREE.Scene, room: OfficeRoomResult, hooks: MissionHooks = {}) {
    this.hooks = hooks;
    this.blockers = room.colliders.filter((b) => b.max.y >= 1.1);
    this.glow = glowTexture();
    this._buildIntel(scene);
    this._buildCamera(scene);
    this._buildExit(scene);
    this._buildParticles(scene);
    this.reset(1);
    this.state = 'idle';
  }

  private _buildIntel(scene: THREE.Scene): void {
    this.intel = MC.intelSpots.map(([x, z]) => {
      const g = new THREE.Group();
      g.position.set(x, 0.95, z);
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.30, 0.035, 0.22),
        new THREE.MeshStandardMaterial({ color: 0x14202f, roughness: 0.5, metalness: 0.3 }),
      );
      body.castShadow = true;
      g.add(body);

      const label = new THREE.Mesh(
        new THREE.BoxGeometry(0.20, 0.006, 0.12),
        new THREE.MeshStandardMaterial({
          color: 0x0a1a26,
          emissive: 0x38c6ff,
          emissiveIntensity: 2.2,
          roughness: 0.3,
        }),
      );
      label.position.set(0, 0.022, 0);
      g.add(label);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.26, 0.008, 8, 28),
        new THREE.MeshBasicMaterial({ color: 0x38c6ff, transparent: true, opacity: 0.55 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -0.10;
      g.add(ring);

      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glow,
          color: 0x38c6ff,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      sp.scale.set(1.1, 1.1, 1);
      g.add(sp);
      scene.add(g);

      return { group: g, ring, label, x, z, active: true, phase: Math.random() * 6.28 };
    });
  }

  private _buildCamera(scene: THREE.Scene): void {
    const C = MC.camera;
    this.cam = { x: C.x, y: C.y, z: C.z, yaw: 0, half: C.halfAngle, reach: C.reach, speed: 0.34 };
    const rig = new THREE.Group();
    rig.position.set(C.x, C.y, C.z);
    scene.add(rig);

    const mount = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x1a2230, roughness: 0.6, metalness: 0.5 }),
    );
    rig.add(mount);

    this.head = new THREE.Group();
    rig.add(this.head);

    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(0.20, 0.16, 0.30),
      new THREE.MeshStandardMaterial({ color: 0x222c3c, roughness: 0.45, metalness: 0.6 }),
    );
    shell.position.z = 0.16;
    shell.castShadow = true;
    this.head.add(shell);

    this.lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.065, 0.06, 16),
      new THREE.MeshStandardMaterial({
        color: 0x0a0f16,
        emissive: 0xffb454,
        emissiveIntensity: 2.4,
        roughness: 0.2,
      }),
    );
    this.lens.rotation.x = Math.PI / 2;
    this.lens.position.z = 0.33;
    this.head.add(this.lens);

    const h = C.reach;
    const r = Math.tan(C.halfAngle) * h;
    const cg = new THREE.ConeGeometry(r, h, 26, 1, true);
    cg.translate(0, -h / 2, 0);
    cg.rotateX(-Math.PI / 2);
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xffb454,
      transparent: true,
      opacity: 0.085,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.beam = new THREE.Mesh(cg, this.beamMat);
    this.head.add(this.beam);

    this.spot = new THREE.SpotLight(0xffb454, 26, C.reach + 2, C.halfAngle, 0.45, 2);
    this.spot.position.set(0, 0, 0.3);
    this.spotTarget = new THREE.Object3D();
    this.spotTarget.position.set(0, -1.6, C.reach);
    this.head.add(this.spot, this.spotTarget);
    this.spot.target = this.spotTarget;
  }

  private _buildExit(scene: THREE.Scene): void {
    const E = MC.exit;
    this.exitPos = new THREE.Vector3(E.x, 0, E.z);
    const g = new THREE.Group();
    g.position.set(E.x, 0, E.z);
    scene.add(g);

    this.exitRing = new THREE.Mesh(
      new THREE.RingGeometry(E.radius - 0.12, E.radius, 40),
      new THREE.MeshBasicMaterial({
        color: 0x5f7089,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      }),
    );
    this.exitRing.rotation.x = -Math.PI / 2;
    this.exitRing.position.y = 0.02;
    g.add(this.exitRing);

    this.exitColumn = new THREE.Mesh(
      new THREE.CylinderGeometry(E.radius - 0.18, E.radius - 0.18, 2.4, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x5f7089,
        transparent: true,
        opacity: 0.07,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.exitColumn.position.y = 1.2;
    g.add(this.exitColumn);

    this.exitGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glow,
        color: 0x5f7089,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.exitGlow.scale.set(2.2, 2.2, 1);
    this.exitGlow.position.y = 0.3;
    g.add(this.exitGlow);
    this.exitGroup = g;
  }

  private _buildParticles(scene: THREE.Scene): void {
    const N = this.N;
    this.pPos = new Float32Array(N * 3);
    this.pVel = new Float32Array(N * 3);
    this.pLife = new Float32Array(N);
    for (let i = 0; i < N; i++) this.pPos[i * 3 + 1] = -999;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    this.points = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: 0x9be9ff,
        size: 0.075,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        map: this.glow,
      }),
    );
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.pCursor = 0;
  }

  burst(x: number, y: number, z: number, count = 26): void {
    for (let k = 0; k < count; k++) {
      const i = (this.pCursor = (this.pCursor + 1) % this.N);
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * Math.PI * 0.5;
      const sp = 1.2 + Math.random() * 2.2;
      this.pPos[i * 3] = x;
      this.pPos[i * 3 + 1] = y;
      this.pPos[i * 3 + 2] = z;
      this.pVel[i * 3] = Math.cos(a) * Math.cos(e) * sp;
      this.pVel[i * 3 + 1] = Math.sin(e) * sp + 0.8;
      this.pVel[i * 3 + 2] = Math.sin(a) * Math.cos(e) * sp;
      this.pLife[i] = 0.7 + Math.random() * 0.5;
    }
  }

  params(level: number): MissionParams {
    const L = MC.levels[Math.min(level, 3) - 1];
    const extra = Math.max(0, level - 3);
    return {
      name: L.name + (extra ? ' +' + extra : ''),
      intel: Math.min(MC.intelSpots.length, L.intel + extra),
      time: Math.max(70, L.time - extra * 4),
      sweep: L.sweep * Math.pow(1.08, extra),
      detect: L.detect + extra * 3,
    };
  }

  reset(level: number): void {
    this.level = level;
    const P = this.params(level);
    this.params_ = P;
    this.total = P.intel;
    this.collected = 0;
    this.detection = 0;
    this.timeLeft = P.time;
    this.exitActive = false;
    this.score = 0;
    this.alerted = false;
    this.spotted = false;
    this._alertClock = 0;
    this.cam.speed = P.sweep;

    const order = this.intel.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    this.intel.forEach((it, i) => {
      it.active = order.indexOf(i) < this.total;
      it.group.visible = it.active;
    });

    this._setExit(false);
    for (let i = 0; i < this.N; i++) {
      this.pLife[i] = 0;
      this.pPos[i * 3 + 1] = -999;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.state = 'playing';
  }

  private _setExit(on: boolean): void {
    this.exitActive = on;
    const c = on ? 0xa4f45c : 0x5f7089;
    this.exitRing.material.color.setHex(c);
    this.exitColumn.material.color.setHex(c);
    this.exitGlow.material.color.setHex(c);
    this.exitRing.material.opacity = on ? 0.85 : 0.4;
    this.exitColumn.material.opacity = on ? 0.16 : 0.05;
    this.exitGlow.material.opacity = on ? 0.6 : 0.25;
  }

  update(
    dt: number,
    player: THREE.Vector3,
    moving: boolean,
    sprinting: boolean,
    active: boolean,
  ): void {
    this._t += dt;

    // Visuals always run so the scene stays alive behind overlays
    for (const it of this.intel) {
      if (!it.active) continue;
      it.group.position.y = 0.95 + Math.sin(this._t * 1.8 + it.phase) * 0.07;
      it.group.rotation.y += dt * 0.9;
      it.ring.rotation.z += dt * 1.4;
      it.label.material.emissiveIntensity = 1.8 + Math.sin(this._t * 3 + it.phase) * 0.6;
    }
    this.cam.yaw = Math.sin(this._t * this.cam.speed) * MC.camera.range;
    this.head.rotation.y = this.cam.yaw;
    this.exitRing.rotation.z += dt * (this.exitActive ? 1.1 : 0.25);
    this.exitGlow.material.opacity =
      (this.exitActive ? 0.55 : 0.22) + Math.sin(this._t * 2.4) * 0.12;

    for (let i = 0; i < this.N; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      if (this.pLife[i] <= 0) {
        this.pPos[i * 3 + 1] = -999;
        continue;
      }
      this.pVel[i * 3 + 1] -= 5.2 * dt;
      this.pPos[i * 3] += this.pVel[i * 3] * dt;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    if (!active || this.state !== 'playing') {
      this._paintBeam(0);
      return;
    }

    this.timeLeft -= dt;

    // Intel pickups
    for (const it of this.intel) {
      if (!it.active) continue;
      const dx = player.x - it.x;
      const dz = player.z - it.z;
      if (dx * dx + dz * dz < MC.pickupRadius * MC.pickupRadius) {
        it.active = false;
        it.group.visible = false;
        this.collected++;
        this.burst(it.x, 1.0, it.z, 30);
        this.hooks.onIntel?.(this.collected, this.total);
        if (this.collected >= this.total) {
          this._setExit(true);
          this.hooks.onExit?.();
        }
      }
    }

    // Detection cone + line-of-sight occlusion
    const fx = Math.sin(this.cam.yaw);
    const fz = Math.cos(this.cam.yaw);
    const dx = player.x - this.cam.x;
    const dz = player.z - this.cam.z;
    const dist = Math.hypot(dx, dz);
    let inside = false;
    if (dist < this.cam.reach && dist > 0.001) {
      const dot = (dx / dist) * fx + (dz / dist) * fz;
      if (Math.acos(Math.max(-1, Math.min(1, dot))) < this.cam.half) {
        inside = !this.blockers.some((b) =>
          segBlocked(this.cam.x, this.cam.z, player.x, player.z, b),
        );
      }
    }

    this.spotted = inside;
    const rate =
      this.params_.detect * (sprinting && moving ? MC.sprintNoise : moving ? 1 : MC.stillFactor);
    this.detection = Math.max(0, Math.min(100, this.detection + (inside ? rate : -MC.decay) * dt));
    this._paintBeam(this.detection / 100);

    if (inside) {
      this._alertClock -= dt;
      if (this._alertClock <= 0) {
        this._alertClock = this.detection > 70 ? 0.28 : 0.6;
        this.hooks.onAlert?.(this.detection / 100);
      }
    }

    const nowAlert = this.detection > 35;
    if (nowAlert !== this.alerted) {
      this.alerted = nowAlert;
      this.hooks.onAlertState?.(nowAlert);
    }

    if (this.detection >= 100) {
      this._lose('BUSTED');
      return;
    }
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this._lose('TIME');
      return;
    }

    if (this.exitActive) {
      const ex = player.x - this.exitPos.x;
      const ez = player.z - this.exitPos.z;
      if (ex * ex + ez * ez < MC.exit.radius * MC.exit.radius) {
        this._win();
      }
    }
  }

  private _paintBeam(t: number): void {
    const c = new THREE.Color().setHSL(
      THREE.MathUtils.lerp(0.11, 0.98, Math.min(1, t * 1.2)),
      0.95,
      0.58,
    );
    this.beamMat.color.copy(c);
    this.beamMat.opacity = 0.07 + t * 0.16 + (this.spotted ? 0.05 : 0);
    this.lens.material.emissive.copy(c);
    this.spot.color.copy(c);
    this.spot.intensity = 22 + t * 26;
  }

  private _win(): void {
    this.state = 'won';
    const timeBonus = Math.floor(this.timeLeft) * 12;
    const stealth = Math.round((100 - this.detection) * 8);
    this.score = this.total * 1000 + timeBonus + stealth + (this.level - 1) * 500;
    const rank: 'S' | 'A' | 'B' | 'C' =
      this.score > this.total * 1000 + 1400
        ? 'S'
        : this.score > this.total * 1000 + 900
          ? 'A'
          : this.score > this.total * 1000 + 400
            ? 'B'
            : 'C';
    this.burst(this.exitPos.x, 1.2, this.exitPos.z, 60);
    this.hooks.onWin?.({
      score: this.score,
      rank,
      timeLeft: Math.floor(this.timeLeft),
      detection: Math.round(this.detection),
      level: this.level,
      intel: this.total,
    });
  }

  private _lose(reason: 'BUSTED' | 'TIME'): void {
    this.state = 'lost';
    this.score = this.collected * 400;
    this.hooks.onLose?.({
      reason,
      collected: this.collected,
      total: this.total,
      score: this.score,
      level: this.level,
    });
  }

  dispose(): void {
    this.glow.dispose();
  }
}
