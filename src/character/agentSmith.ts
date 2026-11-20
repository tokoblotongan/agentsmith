import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig';

// ─────────────────────────────────────────────────────────────────────────────
// AgentSmith: articulated, procedurally-animated spy character.
// Fully decoupled from input/network. Drive it ONLY through:
//   setTransform(position, rotationY)
//   setAnimationState('idle' | 'walk' | 'run' [, direction])
//   update(dt)
// The exact same class renders the local player AND future remote players.
// Model faces +Z at rotationY = 0. Origin (y = 0) is at the shoe soles.
// ─────────────────────────────────────────────────────────────────────────────

export type AgentAnimationState = 'idle' | 'walk' | 'run';

interface PoseParams {
  swing: number;
  arm: number;
  knee: number;
  bob: number;
  lean: number;
  freq: number;
  elbow: number;
}

const POSE_TARGETS: Record<AgentAnimationState, PoseParams> = {
  idle: { swing: 0,    arm: 0,   knee: 0,    bob: 0,     lean: 0.015, freq: 0,                                elbow: 0.16 },
  walk: { swing: 0.55, arm: 0.4, knee: 0.7,  bob: 0.03,  lean: 0.06,  freq: GAME_CONFIG.animation.walkFrequency, elbow: 0.30 },
  run:  { swing: 0.95, arm: 0.8, knee: 1.25, bob: 0.055, lean: 0.16,  freq: GAME_CONFIG.animation.runFrequency,  elbow: 1.05 },
};

interface AgentJoints {
  pelvis: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  shoulderL: THREE.Group;
  shoulderR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  hipL: THREE.Group;
  hipR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  footL: THREE.Group;
  footR: THREE.Group;
}

// ── Procedural Textures (zero external dependencies) ─────────────────────────

function createWoolSuitTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#202229';
  ctx.fillRect(0, 0, size, size);

  // Subtle diagonal charcoal wool twill weave
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x += 2) {
      const twill = ((x + y) % 8 === 0) ? 10 : ((x + y) % 4 === 0 ? 4 : -4);
      const grain = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) * 6 - 3;
      const v = Math.max(18, Math.min(48, 32 + twill + grain));
      ctx.fillStyle = `rgb(${v}, ${v + 1}, ${v + 5})`;
      ctx.fillRect(x, y, 2, 2);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

function createFaceTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  // Base warm olive-tan complexion
  ctx.fillStyle = '#d39c7d';
  ctx.fillRect(0, 0, w, h);

  // Front of SphereGeometry (phi = PI/2) maps to u = 0.25 -> cx = w * 0.25
  const cx = w * 0.25;

  // Subtle cheek/temple warmth and nose-bridge highlight
  const cheekGrad = ctx.createRadialGradient(cx, h * 0.48, 6, cx, h * 0.5, 95);
  cheekGrad.addColorStop(0, 'rgba(226, 174, 145, 0.45)');
  cheekGrad.addColorStop(0.55, 'rgba(202, 142, 112, 0.22)');
  cheekGrad.addColorStop(1, 'rgba(176, 118, 92, 0)');
  ctx.fillStyle = cheekGrad;
  ctx.fillRect(0, 0, w, h);

  // Slight natural shadow under cheekbones
  for (const dir of [-1, 1]) {
    const g = ctx.createRadialGradient(cx + dir * 42, h * 0.58, 2, cx + dir * 42, h * 0.58, 26);
    g.addColorStop(0, 'rgba(135, 86, 65, 0.28)');
    g.addColorStop(1, 'rgba(135, 86, 65, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // Light 5-o'clock stubble around lower jaw, chin, and upper lip
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - 72, h * 0.52);
  ctx.quadraticCurveTo(cx - 56, h * 0.72, cx - 22, h * 0.66);
  ctx.quadraticCurveTo(cx, h * 0.61, cx + 22, h * 0.66);
  ctx.quadraticCurveTo(cx + 56, h * 0.72, cx + 72, h * 0.52);
  ctx.lineTo(cx + 82, h * 0.88);
  ctx.quadraticCurveTo(cx, h * 0.98, cx - 82, h * 0.88);
  ctx.closePath();

  const beardWash = ctx.createLinearGradient(0, h * 0.56, 0, h * 0.94);
  beardWash.addColorStop(0, 'rgba(65, 48, 38, 0.08)');
  beardWash.addColorStop(0.35, 'rgba(54, 40, 32, 0.30)');
  beardWash.addColorStop(1, 'rgba(42, 32, 26, 0.36)');
  ctx.fillStyle = beardWash;
  ctx.fill();

  ctx.clip();
  for (let i = 0; i < 2400; i++) {
    const rx = cx + (Math.sin(i * 19.31) * 0.5 + Math.cos(i * 7.17) * 0.5) * 80;
    const ry = h * (0.56 + ((i * 0.6180339) % 1) * 0.38);
    const alpha = 0.14 + ((i * 13) % 7) * 0.035;
    ctx.fillStyle = `rgba(28, 22, 18, ${alpha})`;
    ctx.fillRect(rx, ry, 1.3, 1.3);
  }
  ctx.restore();

  // Mustache stubble band (above upper lip)
  const stache = ctx.createRadialGradient(cx, h * 0.68, 2, cx, h * 0.68, 22);
  stache.addColorStop(0, 'rgba(52, 38, 30, 0.32)');
  stache.addColorStop(1, 'rgba(52, 38, 30, 0)');
  ctx.fillStyle = stache;
  ctx.fillRect(cx - 26, h * 0.63, 52, 16);

  // Subtle mouth shadow line
  ctx.strokeStyle = 'rgba(110, 62, 52, 0.65)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 14, h * 0.73);
  ctx.quadraticCurveTo(cx, h * 0.745, cx + 14, h * 0.73);
  ctx.stroke();

  // Subtle sideburn/nape hair-fade tint on sides & back
  ctx.fillStyle = 'rgba(24, 19, 16, 0.25)';
  ctx.fillRect(w * 0.52, 0, w * 0.48, h * 0.65);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createWatchDialTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#090d14';
  ctx.fillRect(0, 0, size, size);

  const c = size / 2;
  ctx.strokeStyle = '#c5ccd6';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(c, c, 54, 0, Math.PI * 2);
  ctx.stroke();

  // Hour ticks
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r0 = i % 3 === 0 ? 40 : 45;
    ctx.strokeStyle = i % 3 === 0 ? '#eef2f6' : '#8d97a6';
    ctx.lineWidth = i % 3 === 0 ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
    ctx.lineTo(c + Math.cos(a) * 51, c + Math.sin(a) * 51);
    ctx.stroke();
  }

  // Hands
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.lineTo(c + 24, c - 14);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.lineTo(c - 10, c - 34);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── Sculpted Procedural Geometry Helpers ─────────────────────────────────────

/** Tapered, organically-proportioned limb tube with top-at-origin (+Y down to -length). */
function makeTaperedLimb(
  rTopX: number,
  rTopZ: number,
  rBotX: number,
  rBotZ: number,
  length: number,
  midBulge = 1.0,
  radialSegs = 18,
  heightSegs = 8,
): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(1, 1, length, radialSegs, heightSegs, false);
  geo.translate(0, -length / 2, 0);

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = Math.max(0, Math.min(1, -y / length)); // 0 at top, 1 at bottom
    const contour = 1 + Math.sin(t * Math.PI) * (midBulge - 1);
    const rx = THREE.MathUtils.lerp(rTopX, rBotX, t) * contour;
    const rz = THREE.MathUtils.lerp(rTopZ, rBotZ, t) * contour;
    pos.setXYZ(i, x * rx, y, z * rz);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Tailored jacket shell with broad chest, nipped waist, and smooth hem flare. */
function makeTailoredJacketGeo(): THREE.BufferGeometry {
  const h = 0.60;
  const radialSegs = 28;
  const heightSegs = 14;
  const geo = new THREE.CylinderGeometry(1, 1, h, radialSegs, heightSegs, false);
  geo.translate(0, h / 2 - 0.06, 0); // spans y = -0.06 to +0.54 relative to waist pivot

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = Math.max(0, Math.min(1, (y + 0.06) / h)); // 0 = hem, 1 = shoulder top

    // Width profile: hip flare -> nipped waist (~0.32) -> broad chest/shoulders (~0.92)
    let rx: number;
    let rz: number;
    if (t < 0.34) {
      const k = t / 0.34;
      rx = THREE.MathUtils.lerp(0.202, 0.168, Math.sin(k * (Math.PI / 2)));
      rz = THREE.MathUtils.lerp(0.118, 0.104, Math.sin(k * (Math.PI / 2)));
    } else if (t < 0.86) {
      const k = (t - 0.34) / 0.52;
      const smooth = k * k * (3 - 2 * k);
      rx = THREE.MathUtils.lerp(0.168, 0.228, smooth);
      rz = THREE.MathUtils.lerp(0.104, 0.128, smooth);
    } else {
      // Shoulder slope curving cleanly inward toward collar
      const k = (t - 0.86) / 0.14;
      rx = THREE.MathUtils.lerp(0.228, 0.125, k * k);
      rz = THREE.MathUtils.lerp(0.128, 0.095, k * k);
    }

    // Subtle chest fullness in front (+Z) and spine hollow in back (-Z)
    let chestShift = z > 0 ? 0.012 * Math.sin(t * Math.PI) : 0;
    // Carve clean tailored V-neck opening in front above the top button
    if (z > 0.25 && t > 0.40) {
      const vWidth = 0.48 * ((t - 0.40) / 0.60);
      const ax = Math.abs(x);
      if (ax < vWidth) {
        const edge = 1 - ax / Math.max(0.001, vWidth);
        chestShift -= 0.034 * Math.min(1, edge * 1.6);
      }
    }
    // Slight front-cutaway open curve near bottom hem
    const hemY = (t < 0.05 && z > 0.35 && Math.abs(x) < 0.4) ? y + 0.016 : y;
    pos.setXYZ(i, x * rx, hemY, z * rz + chestShift);
  }

  geo.computeVertexNormals();
  return geo;
}

/** Anatomically sculpted male skull + chiseled jaw + defined cheekbones. */
function makeSculptedHeadGeo(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.112, 36, 28);
  const pos = geo.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    // Tall cranial proportion
    y *= 1.18;

    // Slight temple narrow & cranium depth
    if (y > 0.01) {
      x *= 0.90;
      z *= 1.04;
    } else {
      // Lower face: chiseled angular jawline & forward chin
      const down = Math.min(1, -y / 0.125);
      const jawSquare = 1 + 0.16 * Math.sin(down * Math.PI) * (Math.abs(x) > 0.03 ? 1 : 0.4);
      x *= 0.84 * jawSquare;
      if (z > 0) {
        z *= 1.02 + 0.14 * Math.sin(down * Math.PI * 0.85);
      } else {
        // Taper neck/occiput smoothly in back
        z *= 0.86;
      }
    }

    // Defined brow ridge above subtle eye sockets
    if (y >= 0.022 && y < 0.048 && z > 0.05) {
      z += 0.007;
    } else if (y > 0.002 && y < 0.022 && z > 0.06 && Math.abs(x) > 0.014 && Math.abs(x) < 0.065) {
      z -= 0.004;
    }

    pos.setXYZ(i, x, y, z);
  }

  geo.computeVertexNormals();
  return geo;
}

/** Sculpted Oxford dress shoe (sole + rounded toe vamp + heel, bottom at y = 0). */
function makeOxfordShoe(shoeMat: THREE.Material, soleMat: THREE.Material): THREE.Group {
  const shoe = new THREE.Group();

  // Outer silhouette in XZ (toe points +Z)
  const soleShape = new THREE.Shape();
  soleShape.moveTo(-0.042, -0.058);
  soleShape.quadraticCurveTo(-0.048, 0.02, -0.049, 0.095);
  soleShape.quadraticCurveTo(-0.042, 0.175, 0, 0.195);
  soleShape.quadraticCurveTo(0.042, 0.175, 0.049, 0.095);
  soleShape.quadraticCurveTo(0.048, 0.02, 0.042, -0.058);
  soleShape.quadraticCurveTo(0, -0.072, -0.042, -0.058);

  const soleGeo = new THREE.ExtrudeGeometry(soleShape, {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.002,
    bevelSegments: 2,
  });
  soleGeo.rotateX(Math.PI / 2);
  const sole = new THREE.Mesh(soleGeo, soleMat);
  sole.position.y = 0.015;
  sole.castShadow = true;
  shoe.add(sole);

  // Stacked dress heel
  const heel = new THREE.Mesh(new THREE.CylinderGeometry(0.041, 0.039, 0.024, 16), soleMat);
  heel.position.set(0, 0.012, -0.026);
  heel.scale.set(1, 1, 1.35);
  heel.castShadow = true;
  shoe.add(heel);

  // Sculpted upper vamp + ankle collar
  const vampGeo = new THREE.SphereGeometry(0.052, 20, 14);
  const vPos = vampGeo.attributes.position;
  for (let i = 0; i < vPos.count; i++) {
    let x = vPos.getX(i);
    let y = vPos.getY(i);
    let z = vPos.getZ(i);
    if (y < 0) y *= 0.25;
    x *= 0.92;
    z *= 2.35;
    // Taper toe gently downward
    if (z > 0.04 && y > 0) y *= Math.max(0.35, 1 - (z - 0.04) * 5.2);
    vPos.setXYZ(i, x, y, z);
  }
  vampGeo.computeVertexNormals();
  const vamp = new THREE.Mesh(vampGeo, shoeMat);
  vamp.position.set(0, 0.026, 0.055);
  vamp.castShadow = true;
  shoe.add(vamp);

  // Ankle collar cup
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.048, 0.068, 18), shoeMat);
  collar.position.set(0, 0.052, -0.006);
  collar.scale.set(0.95, 1, 1.25);
  collar.castShadow = true;
  shoe.add(collar);

  return shoe;
}

/** Sculpted hand with palm, thumb, and subtly curled fingers. */
function makeSculptedHand(skinMat: THREE.Material, sideSign: number): THREE.Group {
  const hand = new THREE.Group();

  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.036, 14, 12), skinMat);
  palm.scale.set(0.55, 1.15, 0.88);
  palm.position.set(0, -0.032, 0.004);
  palm.castShadow = true;
  hand.add(palm);

  // Four tapered fingers grouped with natural relaxed curve
  for (let i = 0; i < 4; i++) {
    const zOff = (1.5 - i) * 0.0155;
    const len = i === 1 || i === 2 ? 0.058 : i === 0 ? 0.052 : 0.046;
    const finger = new THREE.Mesh(
      makeTaperedLimb(0.0085, 0.0085, 0.0062, 0.0062, len, 1.0, 8, 2),
      skinMat,
    );
    finger.position.set(0, -0.062, zOff);
    finger.rotation.z = sideSign * -0.14;
    finger.castShadow = true;
    hand.add(finger);
  }

  // Thumb angled naturally forward
  const thumb = new THREE.Mesh(
    makeTaperedLimb(0.01, 0.01, 0.0072, 0.0072, 0.046, 1.0, 8, 2),
    skinMat,
  );
  thumb.position.set(-sideSign * 0.01, -0.025, 0.030);
  thumb.rotation.x = 0.42;
  thumb.rotation.z = sideSign * -0.22;
  thumb.castShadow = true;
  hand.add(thumb);

  return hand;
}

function makeMaterials() {
  const woolTex = createWoolSuitTexture();
  const faceTex = createFaceTexture();
  const dialTex = createWatchDialTexture();

  const std = (color: number, roughness: number, metalness = 0) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness });

  return {
    suit: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: woolTex,
      roughness: 0.86,
      metalness: 0.04,
    }),
    suitLapel: std(0x1b1d24, 0.78, 0.05),
    trouser: new THREE.MeshStandardMaterial({
      color: 0xf4f5f8,
      map: woolTex,
      roughness: 0.88,
      metalness: 0.03,
    }),
    shirt:     std(0xf4f6f9, 0.58),
    tie:       std(0x0b0c10, 0.48, 0.05),
    button:    std(0x0d0e12, 0.30, 0.15),
    face:      new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: faceTex,
      roughness: 0.64,
      metalness: 0.0,
    }),
    skin:      std(0xd39c7d, 0.64),
    hair:      std(0x161210, 0.82),
    sclera:    std(0xeef1f4, 0.35),
    iris:      std(0x2d1e15, 0.25),
    shoe:      std(0x0a0a0d, 0.24, 0.14),
    sole:      std(0x070709, 0.60, 0.05),
    watchCase: std(0xbac2cc, 0.18, 0.92),
    watchDial: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: dialTex,
      roughness: 0.22,
      metalness: 0.25,
    }),
    watchBand: std(0x141518, 0.45, 0.10),
  };
}

function part(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

export class AgentSmith {
  public readonly group: THREE.Group;
  private _state: AgentAnimationState = 'idle';
  private _direction = 1; // 1 forward, -1 backward (reverses gait phase)
  private _phase = 0;
  private _time = 0;
  private _pelvisBaseY = 0.96;
  private _pose: PoseParams = { ...POSE_TARGETS.idle };
  private _j!: AgentJoints;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'AgentSmith';
    this._build();
  }

  // ── Public, network-friendly API ──────────────────────────────────────────
  setTransform(position: THREE.Vector3, rotationY: number): void {
    this.group.position.copy(position);
    this.group.rotation.y = rotationY;
  }

  getTransform(): { position: THREE.Vector3; rotationY: number } {
    return { position: this.group.position.clone(), rotationY: this.group.rotation.y };
  }

  setAnimationState(state: AgentAnimationState, direction = 1): void {
    if (POSE_TARGETS[state]) this._state = state;
    this._direction = direction >= 0 ? 1 : -1;
  }

  // ── Procedural animation (call once per frame) ────────────────────────────
  update(dt: number): void {
    const target = POSE_TARGETS[this._state];
    const k = 1 - Math.exp(-GAME_CONFIG.animation.blendSpeed * dt);
    (Object.keys(this._pose) as Array<keyof PoseParams>).forEach((key) => {
      this._pose[key] += (target[key] - this._pose[key]) * k;
    });

    this._time += dt;
    this._phase += this._pose.freq * dt * this._direction;

    const p = this._pose;
    const s = Math.sin(this._phase);
    const c = Math.cos(this._phase);
    const move = Math.min(1, p.swing / 0.55); // 0 = idle, 1 = moving
    const idleW = 1 - move;
    const j = this._j;

    // Legs: thighs swing, knees bend on the swing phase, shoes stay level-ish.
    j.hipL.rotation.x = s * p.swing;
    j.hipR.rotation.x = -s * p.swing;
    j.kneeL.rotation.x = Math.max(0, -Math.sin(this._phase - 0.6)) * p.knee + 0.05;
    j.kneeR.rotation.x = Math.max(0, -Math.sin(this._phase + Math.PI - 0.6)) * p.knee + 0.05;
    j.footL.rotation.x = -(j.hipL.rotation.x + j.kneeL.rotation.x) * 0.45;
    j.footR.rotation.x = -(j.hipR.rotation.x + j.kneeR.rotation.x) * 0.45;

    // Arms counter-swing; elbows bend more when running.
    j.shoulderL.rotation.x = -s * p.arm + Math.sin(this._time * 1.8) * 0.02 * idleW;
    j.shoulderR.rotation.x =  s * p.arm + Math.sin(this._time * 1.8 + 1) * 0.02 * idleW;
    j.shoulderL.rotation.z = 0.075;
    j.shoulderR.rotation.z = -0.075;
    j.elbowL.rotation.x = p.elbow + Math.max(0, s) * 0.3 * move;
    j.elbowR.rotation.x = p.elbow + Math.max(0, -s) * 0.3 * move;

    // Torso lean + counter-twist; head stabilizes and idly scans the room.
    j.torso.rotation.x = p.lean;
    j.torso.rotation.y = s * 0.07 * move;
    j.head.rotation.y = -s * 0.05 * move + Math.sin(this._time * 0.6) * 0.08 * idleW;
    j.head.rotation.x = -p.lean * 0.5 + Math.sin(this._time * 0.9) * 0.02 * idleW;

    // Pelvis bob while moving + subtle breathing while idle.
    j.pelvis.position.y = this._pelvisBaseY
      + Math.abs(c) * p.bob
      + Math.sin(this._time * 1.8) * 0.008 * idleW;
  }

  // ── Mesh construction (tailored silhouette, ~1.85 m tall) ──────────────────
  private _build(): void {
    const M = makeMaterials();
    const j: Partial<AgentJoints> = {};

    // 1) Pelvis & tailored trouser hips (overlap smoothly with jacket skirt)
    j.pelvis = new THREE.Group();
    j.pelvis.position.y = this._pelvisBaseY;
    this.group.add(j.pelvis);

    const hipGeo = makeTaperedLimb(0.165, 0.102, 0.172, 0.108, 0.16, 1.04, 24, 4);
    j.pelvis.add(part(hipGeo, M.trouser, 0, 0.06, 0));

    // 2) Sculpted Torso, Crisp Dress Shirt, Black Tie & Tailored Jacket
    j.torso = new THREE.Group();
    j.torso.position.set(0, 0.03, 0);
    j.pelvis.add(j.torso);

    // Main tailored charcoal jacket shell
    const jacketMesh = part(makeTailoredJacketGeo(), M.suit, 0, 0, 0);
    j.torso.add(jacketMesh);

    // Crisp white dress shirt front V-placket (sculpted wedge fitting inside lapels)
    const shirtShape = new THREE.Shape();
    shirtShape.moveTo(-0.085, 0.25);
    shirtShape.lineTo(0.085, 0.25);
    shirtShape.lineTo(0.016, -0.02);
    shirtShape.lineTo(-0.016, -0.02);
    shirtShape.closePath();
    const shirtGeo = new THREE.ExtrudeGeometry(shirtShape, {
      depth: 0.03,
      bevelEnabled: true,
      bevelThickness: 0.006,
      bevelSize: 0.005,
      bevelSegments: 2,
    });
    const shirtPlacket = part(shirtGeo, M.shirt, 0, 0.245, 0.084);
    shirtPlacket.rotation.x = -0.18;
    j.torso.add(shirtPlacket);

    // Spread dress-shirt collar wrapping neck cleanly
    const collarBand = part(new THREE.CylinderGeometry(0.056, 0.064, 0.044, 20), M.shirt, 0, 0.538, 0.005);
    j.torso.add(collarBand);

    for (const s of [-1, 1]) {
      const wingShape = new THREE.Shape();
      wingShape.moveTo(0, 0);
      wingShape.lineTo(s * 0.056, 0.014);
      wingShape.lineTo(s * 0.044, -0.030);
      wingShape.lineTo(0, -0.012);
      wingShape.closePath();
      const wingGeo = new THREE.ExtrudeGeometry(wingShape, {
        depth: 0.006,
        bevelEnabled: true,
        bevelThickness: 0.002,
        bevelSize: 0.002,
        bevelSegments: 1,
      });
      const wing = part(wingGeo, M.shirt, s * 0.006, 0.538, 0.060);
      wing.rotation.y = s * -0.35;
      wing.rotation.x = 0.16;
      j.torso.add(wing);
    }

    // Black Tie: sculpted Windsor knot + tapered blade lying flush on shirt chest
    const tieKnot = part(new THREE.CylinderGeometry(0.020, 0.013, 0.032, 6), M.tie, 0, 0.510, 0.072);
    tieKnot.scale.set(1.1, 1, 0.72);
    tieKnot.rotation.x = 0.15;
    j.torso.add(tieKnot);

    const tieShape = new THREE.Shape();
    tieShape.moveTo(-0.014, 0);
    tieShape.lineTo(0.014, 0);
    tieShape.lineTo(0.024, -0.23);
    tieShape.lineTo(0, -0.27);
    tieShape.lineTo(-0.024, -0.23);
    tieShape.closePath();
    const tieGeo = new THREE.ExtrudeGeometry(tieShape, {
      depth: 0.007,
      bevelEnabled: true,
      bevelThickness: 0.002,
      bevelSize: 0.002,
      bevelSegments: 1,
    });
    const tieBlade = part(tieGeo, M.tie, 0, 0.498, 0.073);
    tieBlade.rotation.x = -0.15;
    j.torso.add(tieBlade);

    // Sculpted Notch Lapels framing the V-zone
    for (const s of [-1, 1]) {
      const lapelShape = new THREE.Shape();
      lapelShape.moveTo(0, 0);
      lapelShape.lineTo(s * 0.068, 0.30);
      lapelShape.lineTo(s * 0.095, 0.285);
      lapelShape.lineTo(s * 0.082, 0.250);
      lapelShape.lineTo(s * 0.104, 0.242);
      lapelShape.lineTo(s * 0.032, 0.02);
      lapelShape.closePath();
      const lapelGeo = new THREE.ExtrudeGeometry(lapelShape, {
        depth: 0.012,
        bevelEnabled: true,
        bevelThickness: 0.003,
        bevelSize: 0.002,
        bevelSegments: 2,
      });
      const lapel = part(lapelGeo, M.suitLapel, s * 0.008, 0.215, 0.114);
      lapel.rotation.x = -0.14;
      lapel.rotation.y = s * -0.18;
      j.torso.add(lapel);
    }

    // Two-button tailored closure + welt breast pocket + flap hip pockets
    const btnTop = part(new THREE.CylinderGeometry(0.011, 0.011, 0.008, 12), M.button, 0, 0.19, 0.118);
    const btnBot = part(new THREE.CylinderGeometry(0.011, 0.011, 0.008, 12), M.button, 0, 0.09, 0.117);
    btnTop.rotation.x = Math.PI / 2;
    btnBot.rotation.x = Math.PI / 2;
    j.torso.add(btnTop, btnBot);

    // Left breast welt pocket (character left = +X)
    const welt = part(new THREE.BoxGeometry(0.082, 0.012, 0.010), M.suitLapel, 0.105, 0.375, 0.129);
    welt.rotation.z = 0.08;
    welt.rotation.y = 0.22;
    j.torso.add(welt);

    // Side pocket flaps
    for (const s of [-1, 1]) {
      const flap = part(new THREE.BoxGeometry(0.11, 0.028, 0.012), M.suitLapel, s * 0.125, 0.075, 0.108);
      flap.rotation.y = s * 0.35;
      j.torso.add(flap);
    }

    // Neck (smoothly joining collar to jaw)
    const neck = part(makeTaperedLimb(0.046, 0.048, 0.054, 0.056, 0.11, 1.0, 18, 3), M.skin, 0, 0.625, 0);
    j.torso.add(neck);

    // 3) Sculpted Head, Facial Features, Light Stubble & Dark Styled Hair
    j.head = new THREE.Group();
    j.head.position.set(0, 0.615, 0.004);
    j.torso.add(j.head);

    const headMesh = part(makeSculptedHeadGeo(), M.face, 0, 0.112, 0);
    j.head.add(headMesh);

    // Sculpted Nose bridge + tip
    const noseBridge = part(new THREE.BoxGeometry(0.017, 0.044, 0.024), M.skin, 0, 0.105, 0.116);
    noseBridge.rotation.x = -0.22;
    const noseTip = part(new THREE.SphereGeometry(0.0115, 12, 10), M.skin, 0, 0.086, 0.126);
    noseTip.scale.set(1.05, 0.85, 1.0);
    j.head.add(noseBridge, noseTip);

    // Expressive eyes (sclera + dark iris) and defined dark eyebrows
    for (const s of [-1, 1]) {
      const eyeWhite = part(new THREE.SphereGeometry(0.013, 12, 10), M.sclera, s * 0.036, 0.124, 0.104);
      eyeWhite.scale.set(1.25, 0.72, 0.65);
      const pupil = part(new THREE.SphereGeometry(0.0075, 10, 8), M.iris, s * 0.036, 0.124, 0.109);
      pupil.scale.set(1, 1, 0.65);

      const brow = part(new THREE.BoxGeometry(0.038, 0.0075, 0.013), M.hair, s * 0.037, 0.144, 0.112);
      brow.rotation.z = s * -0.07;
      brow.rotation.y = s * -0.18;

      // Sculpted ears
      const ear = part(new THREE.SphereGeometry(0.020, 12, 10), M.skin, s * 0.098, 0.108, -0.006);
      ear.scale.set(0.36, 1.35, 0.72);
      ear.rotation.y = s * 0.18;

      j.head.add(eyeWhite, pupil, brow, ear);
    }

    // Dark styled hair: fitted cranial cap + nape taper + sideburns + swept-back quiff
    const hairCrown = part(new THREE.SphereGeometry(0.117, 28, 20), M.hair, 0, 0.146, -0.014);
    hairCrown.scale.set(0.95, 1.02, 1.06);

    const hairBack = part(new THREE.CylinderGeometry(0.102, 0.078, 0.11, 20), M.hair, 0, 0.095, -0.032);
    hairBack.scale.set(0.94, 1, 0.92);

    // Layered swept front quiff matching reference hairstyle
    const quiffMain = part(new THREE.SphereGeometry(0.088, 22, 16), M.hair, -0.012, 0.214, 0.028);
    quiffMain.scale.set(1.06, 0.44, 0.98);
    quiffMain.rotation.x = -0.22;
    quiffMain.rotation.z = 0.08;

    const quiffWave = part(new THREE.SphereGeometry(0.062, 18, 14), M.hair, 0.022, 0.224, 0.048);
    quiffWave.scale.set(1.12, 0.40, 0.86);
    quiffWave.rotation.x = -0.32;
    quiffWave.rotation.z = -0.14;

    j.head.add(hairCrown, hairBack, quiffMain, quiffWave);

    for (const s of [-1, 1]) {
      const sideHair = part(new THREE.BoxGeometry(0.018, 0.068, 0.045), M.hair, s * 0.094, 0.138, 0.010);
      sideHair.rotation.z = s * -0.08;
      const sideburn = part(new THREE.BoxGeometry(0.010, 0.042, 0.016), M.hair, s * 0.092, 0.095, 0.020);
      j.head.add(sideHair, sideburn);
    }

    // 4) Tailored Sleeves, White Shirt Cuffs, Wristwatch (Left), and Sculpted Hands
    for (const side of [{ s: 1, n: 'L' as const }, { s: -1, n: 'R' as const }]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side.s * 0.232, 0.468, 0.002);
      j.torso.add(shoulder);

      // Tailored shoulder cap + smoothly tapered upper sleeve
      const cap = part(new THREE.SphereGeometry(0.062, 18, 14), M.suit, 0, -0.006, 0);
      cap.scale.set(0.95, 1.05, 1.02);
      shoulder.add(cap);
      shoulder.add(part(makeTaperedLimb(0.056, 0.060, 0.047, 0.050, 0.285, 1.04, 18, 5), M.suit));

      const elbow = new THREE.Group();
      elbow.position.set(0, -0.285, 0);
      shoulder.add(elbow);

      // Rounded elbow overlap + tapered forearm sleeve
      elbow.add(part(new THREE.SphereGeometry(0.046, 14, 12), M.suit));
      elbow.add(part(makeTaperedLimb(0.047, 0.050, 0.039, 0.041, 0.252, 1.02, 18, 5), M.suit));

      // Three small dark cuff buttons along outer wrist (matching reference Image 1)
      for (let b = 0; b < 3; b++) {
        const cBtn = part(
          new THREE.SphereGeometry(0.0045, 8, 6),
          M.button,
          side.s * 0.038,
          -0.215 - b * 0.013,
          -0.014,
        );
        elbow.add(cBtn);
      }

      // Crisp white dress-shirt cuff peeking below jacket sleeve
      const cuff = part(new THREE.CylinderGeometry(0.036, 0.035, 0.032, 18), M.shirt, 0, -0.258, 0);
      cuff.scale.set(0.94, 1, 1.08);
      elbow.add(cuff);

      // Wrist + sculpted anatomical hand
      const wrist = part(makeTaperedLimb(0.028, 0.032, 0.024, 0.029, 0.035, 1.0, 12, 2), M.skin, 0, -0.268, 0);
      elbow.add(wrist);
      const hand = makeSculptedHand(M.skin, side.s);
      hand.position.set(0, -0.292, 0);
      elbow.add(hand);

      // Detailed wristwatch on the LEFT wrist (stainless case + dark dial + strap)
      if (side.n === 'L') {
        const strap = part(new THREE.TorusGeometry(0.036, 0.0065, 10, 22), M.watchBand, 0, -0.278, 0);
        strap.rotation.x = Math.PI / 2;
        strap.scale.set(0.92, 1.08, 1);

        const bezel = part(new THREE.CylinderGeometry(0.0185, 0.0185, 0.009, 20), M.watchCase, side.s * 0.034, -0.278, 0.006);
        bezel.rotation.z = Math.PI / 2;

        const dial = part(new THREE.CylinderGeometry(0.0155, 0.0155, 0.0096, 20), M.watchDial, side.s * 0.034, -0.278, 0.006);
        dial.rotation.z = Math.PI / 2;
        dial.rotation.x = -Math.PI / 2;

        elbow.add(strap, bezel, dial);
      }

      j[`shoulder${side.n}`] = shoulder;
      j[`elbow${side.n}`] = elbow;
    }

    // 5) Tailored Trousers & Sculpted Black Oxford Dress Shoes (soles at y = 0)
    for (const side of [{ s: 1, n: 'L' as const }, { s: -1, n: 'R' as const }]) {
      const hip = new THREE.Group();
      hip.position.set(side.s * 0.095, -0.02, 0);
      j.pelvis.add(hip);

      // Upper trouser leg (thigh) with smooth hip joint sphere
      const hipJoint = part(new THREE.SphereGeometry(0.074, 16, 12), M.trouser);
      hipJoint.scale.set(0.95, 1, 1.02);
      hip.add(hipJoint);
      hip.add(part(makeTaperedLimb(0.075, 0.080, 0.056, 0.060, 0.44, 1.03, 20, 6), M.trouser));

      const knee = new THREE.Group();
      knee.position.set(0, -0.44, 0);
      hip.add(knee);

      // Knee overlap + slim tapered lower trouser leg
      knee.add(part(new THREE.SphereGeometry(0.056, 14, 12), M.trouser));
      knee.add(part(makeTaperedLimb(0.056, 0.060, 0.047, 0.051, 0.44, 1.02, 20, 6), M.trouser));

      const foot = new THREE.Group();
      foot.position.set(0, -0.44, 0);
      knee.add(foot);

      // Oxford dress shoe resting flush at local y = -0.06 -> world y = 0
      const shoe = makeOxfordShoe(M.shoe, M.sole);
      shoe.position.set(0, -0.06, 0);
      foot.add(shoe);

      j[`hip${side.n}`] = hip;
      j[`knee${side.n}`] = knee;
      j[`foot${side.n}`] = foot;
    }

    this._j = j as AgentJoints;
  }
}
