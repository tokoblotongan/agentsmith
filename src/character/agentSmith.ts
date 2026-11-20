import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GAME_CONFIG } from '../config/gameConfig';

// ─────────────────────────────────────────────────────────────────────────────
// AgentSmith — one class, three interchangeable rigs:
//   'procedural' : sculpted articulated body (always-available fallback)
//   'static'     : external GLB scan, made limber by GPU vertex-shader deformation
//   'clips'      : rigged model with idle/walk/run animation clips
// Public API is identical for local and future remote players.
// ─────────────────────────────────────────────────────────────────────────────

export type AgentAnimationState = 'idle' | 'walk' | 'run';
export type AgentRigMode = 'procedural' | 'static' | 'clips';

const CHAR = GAME_CONFIG.character;
const DEF = CHAR.deform;

interface PoseParams {
  swing: number;
  arm: number;
  knee: number;
  bob: number;
  lean: number;
  freq: number;
  elbow: number;
  sway: number;
}

// Note: elbow rotation around +X is NEGATIVE to bend forearm forward (+Z) in procedural rig.
const POSE_TARGETS: Record<AgentAnimationState, PoseParams> = {
  idle: { swing: 0,    arm: 0,    knee: 0,    bob: 0,     lean: 0.015, freq: 0,                                   elbow: -0.18, sway: 0 },
  walk: { swing: 0.55, arm: 0.40, knee: 0.70, bob: 0.030, lean: 0.060, freq: GAME_CONFIG.animation.walkFrequency, elbow: -0.34, sway: 0.035 },
  run:  { swing: 0.95, arm: 0.80, knee: 1.25, bob: 0.055, lean: 0.160, freq: GAME_CONFIG.animation.runFrequency,  elbow: -1.08, sway: 0.060 },
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

interface DeformUniforms {
  uPhase: { value: number };
  uSwing: { value: number };
  uArm: { value: number };
  uKnee: { value: number };
  uBob: { value: number };
  uLean: { value: number };
  uSway: { value: number };
  uTwist: { value: number };
  uMove: { value: number };
  uIdle: { value: number };
  uTime: { value: number };
  uTurn: { value: number };
  uMinY: { value: number };
  uHeight: { value: number };
  uCX: { value: number };
  uHalfW: { value: number };
}

// ── GPU limb deformation for unrigged GLB scans ──────────────────────────────
const DEFORM_GLSL = `
uniform float uPhase,uSwing,uArm,uKnee,uBob,uLean,uSway,uTwist,uMove,uIdle,uTime,uTurn,uMinY,uHeight,uCX,uHalfW;
mat3 smRotX(float a){float s=sin(a),c=cos(a);return mat3(1.0,0.0,0.0, 0.0,c,s, 0.0,-s,c);}
mat3 smRotY(float a){float s=sin(a),c=cos(a);return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c);}
mat3 smRotZ(float a){float s=sin(a),c=cos(a);return mat3(c,s,0.0, -s,c,0.0, 0.0,0.0,1.0);}
vec3 smDeform(vec3 p, out mat3 R){
  float H=max(uHeight,1e-4);
  float h=clamp((p.y-uMinY)/H,0.0,1.0);
  float dx=p.x-uCX;
  float hw=max(uHalfW,1e-4);
  float sideF=clamp(dx/(hw*0.22),-1.0,1.0);
  float ax=abs(dx)/hw;
  float s=sin(uPhase), c=cos(uPhase);
  float legW=1.0-smoothstep(0.42,0.53,h);
  float kneeW=(1.0-smoothstep(0.19,0.30,h))*legW;
  float torsoW=smoothstep(0.44,0.58,h)*(1.0-smoothstep(0.84,0.93,h));
  float armW=smoothstep(0.60,0.80,ax)*smoothstep(0.32,0.44,h)*(1.0-smoothstep(0.79,0.88,h));
  float lowArmW=armW*(1.0-smoothstep(0.50,0.62,h));
  float headW=smoothstep(0.83,0.92,h);
  float humpL=0.5*(1.0-cos(uPhase-0.9));
  float humpR=0.5*(1.0-cos(uPhase+2.2416));
  float hump=mix(humpR,humpL,(sideF+1.0)*0.5);
  R=mat3(1.0);
  vec3 q=p;
  vec3 pHip=vec3(uCX+sideF*hw*0.30,uMinY+H*0.48,0.0);
  mat3 RH=smRotX(s*uSwing*sideF*legW);
  q=pHip+RH*(q-pHip); R=RH*R;
  vec3 pKneeRaw=vec3(uCX+sideF*hw*0.30,uMinY+H*0.26,0.0);
  vec3 pKnee=pHip+RH*(pKneeRaw-pHip);
  mat3 RK=smRotX(-hump*uKnee*kneeW);
  q=pKnee+RK*(q-pKnee); R=RK*R;
  vec3 pWaist=vec3(uCX,uMinY+H*0.50,0.0);
  float aLean=uLean*torsoW;
  mat3 RS=smRotZ((s*uSway+sin(uTime*0.7)*0.012*uIdle)*torsoW)*smRotY(s*uTwist*torsoW)*smRotX(aLean);
  q=pWaist+RS*(q-pWaist); R=RS*R;
  vec3 pSh=vec3(uCX+sideF*hw*0.74,uMinY+H*0.80,0.0);
  mat3 RA=smRotZ(sideF*(0.05+0.05*uMove)*armW)*smRotX(-s*uArm*sideF*armW);
  q=pSh+RA*(q-pSh); R=RA*R;
  vec3 pElbRaw=vec3(uCX+sideF*hw*0.80,uMinY+H*0.62,0.0);
  vec3 pElb=pSh+RA*(pElbRaw-pSh);
  mat3 RE=smRotX(-(0.16+0.5*uMove)*lowArmW);
  q=pElb+RE*(q-pElb); R=RE*R;
  vec3 pNeck=vec3(uCX,uMinY+H*0.86,0.0);
  mat3 RN=smRotY((-s*uTwist*0.6+sin(uTime*0.55)*0.10*uIdle)*headW)*smRotX(-aLean*0.5*headW);
  q=pNeck+RN*(q-pNeck); R=RN*R;
  q.y+=(abs(c)*uBob*0.55+sin(uTime*1.6)*0.004*uIdle)*H;
  vec3 pFoot=vec3(uCX,uMinY,0.0);
  mat3 RB=smRotZ(clamp(-uTurn*0.10,-0.17,0.17));
  q=pFoot+RB*(q-pFoot); R=RB*R;
  return q;
}`;

function injectDeform(mat: THREE.Material, U: DeformUniforms, positionOnly: boolean): void {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      '#include <common>\n' + DEFORM_GLSL,
    );
    if (positionOnly) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        'mat3 smR; vec3 transformed = smDeform(position, smR);',
      );
    } else {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `mat3 smR; vec3 smP = smDeform(position, smR);
         vec3 objectNormal = smR * vec3(normal);
         #ifdef USE_TANGENT
           vec3 objectTangent = vec3(tangent.xyz);
         #endif`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        'vec3 transformed = smP;',
      );
    }
  };
  mat.customProgramCacheKey = () => 'smithDeform' + (positionOnly ? 'P' : 'N');
  mat.needsUpdate = true;
}

// ── Procedural Textures (zero external dependencies) ─────────────────────────

function createWoolSuitTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#1f2128';
  ctx.fillRect(0, 0, size, size);

  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x += 2) {
      const twill = ((x + y) % 8 === 0) ? 9 : ((x + y) % 4 === 0 ? 3 : -4);
      const grain = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) * 5 - 2.5;
      const v = Math.max(18, Math.min(46, 31 + twill + grain));
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

  ctx.fillStyle = '#d39c7d';
  ctx.fillRect(0, 0, w, h);

  const cx = w * 0.25;

  const cheekGrad = ctx.createRadialGradient(cx, h * 0.48, 6, cx, h * 0.5, 95);
  cheekGrad.addColorStop(0, 'rgba(226, 174, 145, 0.45)');
  cheekGrad.addColorStop(0.55, 'rgba(202, 142, 112, 0.22)');
  cheekGrad.addColorStop(1, 'rgba(176, 118, 92, 0)');
  ctx.fillStyle = cheekGrad;
  ctx.fillRect(0, 0, w, h);

  for (const dir of [-1, 1]) {
    const g = ctx.createRadialGradient(cx + dir * 42, h * 0.58, 2, cx + dir * 42, h * 0.58, 26);
    g.addColorStop(0, 'rgba(135, 86, 65, 0.28)');
    g.addColorStop(1, 'rgba(135, 86, 65, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

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

  const stache = ctx.createRadialGradient(cx, h * 0.68, 2, cx, h * 0.68, 22);
  stache.addColorStop(0, 'rgba(52, 38, 30, 0.32)');
  stache.addColorStop(1, 'rgba(52, 38, 30, 0)');
  ctx.fillStyle = stache;
  ctx.fillRect(cx - 26, h * 0.63, 52, 16);

  ctx.strokeStyle = 'rgba(110, 62, 52, 0.65)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 14, h * 0.73);
  ctx.quadraticCurveTo(cx, h * 0.745, cx + 14, h * 0.73);
  ctx.stroke();

  const napeFade = ctx.createLinearGradient(0, h * 0.45, 0, h * 0.85);
  napeFade.addColorStop(0, 'rgba(24, 19, 16, 0.40)');
  napeFade.addColorStop(1, 'rgba(24, 19, 16, 0.0)');
  ctx.fillStyle = napeFade;
  ctx.fillRect(w * 0.56, h * 0.42, w * 0.38, h * 0.45);

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

function makeTaperedLimb(
  rTopX: number,
  rTopZ: number,
  rBotX: number,
  rBotZ: number,
  length: number,
  midBulge = 1.0,
  radialSegs = 20,
  heightSegs = 8,
): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(1, 1, length, radialSegs, heightSegs, false);
  geo.translate(0, -length / 2, 0);

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = Math.max(0, Math.min(1, -y / length));
    const contour = 1 + Math.sin(t * Math.PI) * (midBulge - 1);
    const rx = THREE.MathUtils.lerp(rTopX, rBotX, t) * contour;
    const rz = THREE.MathUtils.lerp(rTopZ, rBotZ, t) * contour;
    pos.setXYZ(i, x * rx, y, z * rz);
  }
  geo.computeVertexNormals();
  return geo;
}

function makeTailoredUpperSleeveGeo(length = 0.285): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(1, 1, length + 0.032, 20, 10, false);
  geo.translate(0, -length / 2 + 0.016, 0);

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = Math.max(0, Math.min(1, (0.032 - y) / (length + 0.032)));

    let rx: number;
    let rz: number;
    if (t < 0.14) {
      const k = t / 0.14;
      const dome = Math.sin(k * (Math.PI / 2));
      rx = THREE.MathUtils.lerp(0.022, 0.049, dome);
      rz = THREE.MathUtils.lerp(0.026, 0.055, dome);
    } else {
      const k = (t - 0.14) / 0.86;
      const muscle = 1 + Math.sin(k * Math.PI) * 0.04;
      rx = THREE.MathUtils.lerp(0.049, 0.041, k) * muscle;
      rz = THREE.MathUtils.lerp(0.055, 0.044, k) * muscle;
    }
    pos.setXYZ(i, x * rx, y, z * rz);
  }
  geo.computeVertexNormals();
  return geo;
}

function makeTailoredJacketGeo(): THREE.BufferGeometry {
  const h = 0.60;
  const geo = new THREE.CylinderGeometry(1, 1, h, 32, 16, false);
  geo.translate(0, h / 2 - 0.06, 0);

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = Math.max(0, Math.min(1, (y + 0.06) / h));

    let rx: number;
    let rz: number;
    if (t < 0.34) {
      const k = t / 0.34;
      rx = THREE.MathUtils.lerp(0.196, 0.164, Math.sin(k * (Math.PI / 2)));
      rz = THREE.MathUtils.lerp(0.116, 0.102, Math.sin(k * (Math.PI / 2)));
    } else if (t < 0.88) {
      const k = (t - 0.34) / 0.54;
      const smooth = k * k * (3 - 2 * k);
      rx = THREE.MathUtils.lerp(0.164, 0.214, smooth);
      rz = THREE.MathUtils.lerp(0.102, 0.122, smooth);
    } else {
      const k = (t - 0.88) / 0.12;
      rx = THREE.MathUtils.lerp(0.214, 0.088, k * k);
      rz = THREE.MathUtils.lerp(0.122, 0.078, k * k);
    }

    let zShift = z > 0 ? 0.012 * Math.sin(t * Math.PI) : 0;
    if (z < -0.55 && Math.abs(x) < 0.18 && t > 0.12 && t < 0.82) {
      zShift += 0.005 * (1 - Math.abs(x) / 0.18);
    }

    if (z > 0.25 && t > 0.40) {
      const vWidth = 0.48 * ((t - 0.40) / 0.60);
      const ax = Math.abs(x);
      if (ax < vWidth) {
        const edge = 1 - ax / Math.max(0.001, vWidth);
        zShift -= 0.034 * Math.min(1, edge * 1.6);
      }
    }

    const hemY = (t < 0.05 && z > 0.35 && Math.abs(x) < 0.4) ? y + 0.016 : y;
    pos.setXYZ(i, x * rx, hemY, z * rz + zShift);
  }

  geo.computeVertexNormals();
  return geo;
}

function makeSculptedHeadGeo(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.110, 36, 28);
  const pos = geo.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i) * 1.18;
    let z = pos.getZ(i);

    if (y > 0.01) {
      x *= 0.90;
      z *= 1.04;
    } else {
      const down = Math.min(1, -y / 0.125);
      const jawSquare = 1 + 0.16 * Math.sin(down * Math.PI) * (Math.abs(x) > 0.03 ? 1 : 0.4);
      x *= 0.84 * jawSquare;
      z *= z > 0 ? 1.02 + 0.14 * Math.sin(down * Math.PI * 0.85) : 0.85;
    }

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

function makeSculptedHairGeo(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.115, 34, 24);
  const pos = geo.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i) * 1.16;
    let z = pos.getZ(i);

    x *= 0.93;
    z *= 1.05;

    if (y < 0.015) {
      const down = Math.min(1, (0.015 - y) / 0.13);
      if (z < 0) {
        const centerBack = Math.max(0, 1 - Math.abs(x) / 0.085);
        const tuck = 1 - down * (0.28 + 0.08 * centerBack);
        x *= tuck;
        z *= tuck;
        y += down * 0.028 * (1 - centerBack * 0.35);
      } else {
        z -= down * 0.045;
      }
    }

    if (z > 0.035 && y > -0.02 && y < 0.095) {
      z -= 0.018;
    }

    pos.setXYZ(i, x, y, z);
  }

  geo.computeVertexNormals();
  return geo;
}

function makeOxfordShoe(shoeMat: THREE.Material, soleMat: THREE.Material): THREE.Group {
  const shoe = new THREE.Group();

  const soleShape = new THREE.Shape();
  soleShape.moveTo(-0.040, -0.056);
  soleShape.quadraticCurveTo(-0.046, 0.02, -0.047, 0.095);
  soleShape.quadraticCurveTo(-0.040, 0.172, 0, 0.192);
  soleShape.quadraticCurveTo(0.040, 0.172, 0.047, 0.095);
  soleShape.quadraticCurveTo(0.046, 0.02, 0.040, -0.056);
  soleShape.quadraticCurveTo(0, -0.070, -0.040, -0.056);

  const soleGeo = new THREE.ExtrudeGeometry(soleShape, {
    depth: 0.011,
    bevelEnabled: true,
    bevelThickness: 0.0025,
    bevelSize: 0.002,
    bevelSegments: 2,
  });
  soleGeo.rotateX(Math.PI / 2);
  const sole = new THREE.Mesh(soleGeo, soleMat);
  sole.position.y = 0.014;
  shoe.add(sole);

  const heel = new THREE.Mesh(new THREE.CylinderGeometry(0.039, 0.037, 0.022, 16), soleMat);
  heel.position.set(0, 0.011, -0.026);
  heel.scale.set(1, 1, 1.32);
  shoe.add(heel);

  const vampGeo = new THREE.SphereGeometry(0.050, 22, 16);
  const vPos = vampGeo.attributes.position;
  for (let i = 0; i < vPos.count; i++) {
    let x = vPos.getX(i);
    let y = vPos.getY(i);
    let z = vPos.getZ(i);
    if (y < 0) y *= 0.25;
    x *= 0.90;
    z *= 2.32;
    if (z > 0.04 && y > 0) y *= Math.max(0.35, 1 - (z - 0.04) * 5.2);
    vPos.setXYZ(i, x, y, z);
  }
  vampGeo.computeVertexNormals();
  const vamp = new THREE.Mesh(vampGeo, shoeMat);
  vamp.position.set(0, 0.025, 0.054);
  shoe.add(vamp);

  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.046, 0.064, 18), shoeMat);
  collar.position.set(0, 0.050, -0.006);
  collar.scale.set(0.95, 1, 1.24);
  shoe.add(collar);

  shoe.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return shoe;
}

function makeSculptedHand(skinMat: THREE.Material, sideSign: number): THREE.Group {
  const hand = new THREE.Group();

  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.035, 14, 12), skinMat);
  palm.scale.set(0.54, 1.12, 0.86);
  palm.position.set(0, -0.031, 0.004);
  hand.add(palm);

  for (let i = 0; i < 4; i++) {
    const zOff = (1.5 - i) * 0.015;
    const len = i === 1 || i === 2 ? 0.056 : i === 0 ? 0.050 : 0.044;
    const finger = new THREE.Mesh(
      makeTaperedLimb(0.0082, 0.0082, 0.0060, 0.0060, len, 1.0, 8, 2),
      skinMat,
    );
    finger.position.set(0, -0.060, zOff);
    finger.rotation.z = sideSign * -0.14;
    hand.add(finger);
  }

  const thumb = new THREE.Mesh(
    makeTaperedLimb(0.0096, 0.0096, 0.0070, 0.0070, 0.045, 1.0, 8, 2),
    skinMat,
  );
  thumb.position.set(-sideSign * 0.01, -0.025, 0.029);
  thumb.rotation.x = -0.35;
  thumb.rotation.z = sideSign * -0.22;
  hand.add(thumb);

  hand.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return hand;
}

function makeMaterials() {
  const woolTex = createWoolSuitTexture();
  const faceTex = createFaceTexture();
  const dialTex = createWatchDialTexture();

  const P = (o: THREE.MeshPhysicalMaterialParameters) => new THREE.MeshPhysicalMaterial(o);

  return {
    suit: P({ color: 0xffffff, map: woolTex, roughness: 0.86, metalness: 0.02, sheen: 0.6, sheenRoughness: 0.55, sheenColor: new THREE.Color(0x3a4152) }),
    suitLapel: P({ color: 0x1b1d24, roughness: 0.72, metalness: 0.05, sheen: 0.45, sheenColor: new THREE.Color(0x2c3340) }),
    trouser: P({ color: 0xf4f5f8, map: woolTex, roughness: 0.88, metalness: 0.02, sheen: 0.5, sheenColor: new THREE.Color(0x343b48) }),
    shirt: P({ color: 0xf4f6f9, roughness: 0.55, sheen: 0.4, sheenColor: new THREE.Color(0xffffff) }),
    tie: P({ color: 0x0b0c10, roughness: 0.42, sheen: 0.8, sheenRoughness: 0.3, sheenColor: new THREE.Color(0x2a3140) }),
    button: P({ color: 0x0d0e12, roughness: 0.3, clearcoat: 0.5 }),
    face: P({ color: 0xffffff, map: faceTex, roughness: 0.5, sheen: 0.25, sheenColor: new THREE.Color(0xff9d7a), clearcoat: 0.06 }),
    skin: P({ color: 0xd39c7d, roughness: 0.5, sheen: 0.25, sheenColor: new THREE.Color(0xff9d7a), clearcoat: 0.06 }),
    hair: P({ color: 0x161210, roughness: 0.62, clearcoat: 0.35, sheen: 0.5, sheenColor: new THREE.Color(0x4a3a2c) }),
    sclera: P({ color: 0xeef1f4, roughness: 0.25, clearcoat: 0.8 }),
    iris: P({ color: 0x2d1e15, roughness: 0.2, clearcoat: 0.9 }),
    shoe: P({ color: 0x0a0a0d, roughness: 0.3, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.12 }),
    sole: P({ color: 0x070709, roughness: 0.6 }),
    watchCase: P({ color: 0xbac2cc, roughness: 0.15, metalness: 1 }),
    watchDial: P({ color: 0xffffff, map: dialTex, roughness: 0.22, clearcoat: 0.9 }),
    watchBand: P({ color: 0x141518, roughness: 0.45, sheen: 0.3 }),
  };
}

function part(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export class AgentSmith {
  public readonly group: THREE.Group;
  private _state: AgentAnimationState = 'idle';
  private _direction = 1;
  private _phase = 0;
  private _turnPhase = 0;
  private _time = 0;
  private _prevRotY: number | null = null;
  private _turnRate = 0;
  private _pelvisBaseY = 0.96;
  private _pose: PoseParams = { ...POSE_TARGETS.idle };
  private _j!: AgentJoints;

  private _body: THREE.Group;
  private _source: AgentRigMode = 'procedural';
  private _external: THREE.Object3D | null = null;
  private _hasClips = false;
  private _mixer: THREE.AnimationMixer | null = null;
  private _actions: Partial<Record<AgentAnimationState, THREE.AnimationAction>> = {};
  private _weights: Record<AgentAnimationState, number> = { idle: 1, walk: 0, run: 0 };
  private _yaw = ((CHAR.modelYawOffset || 0) * Math.PI) / 180;
  private _staticBaseY = 0;
  private _stepIdx = 0;
  private _stepPending = false;
  private _deformed = false;
  private _U: DeformUniforms;
  private _onRigLoaded?: (mode: AgentRigMode) => void;

  constructor(options?: { loadExternal?: boolean; onRigLoaded?: (mode: AgentRigMode) => void }) {
    this.group = new THREE.Group();
    this.group.name = 'AgentSmith';
    this._onRigLoaded = options?.onRigLoaded;

    const u = (v: number) => ({ value: v });
    this._U = {
      uPhase: u(0),
      uSwing: u(0),
      uArm: u(0),
      uKnee: u(0),
      uBob: u(0),
      uLean: u(0),
      uSway: u(0),
      uTwist: u(0),
      uMove: u(0),
      uIdle: u(1),
      uTime: u(0),
      uTurn: u(0),
      uMinY: u(0),
      uHeight: u(1.87),
      uCX: u(0),
      uHalfW: u(0.3),
    };

    this._body = new THREE.Group();
    this.group.add(this._body);
    this._build();

    const shouldLoad = options?.loadExternal ?? true;
    if (shouldLoad && CHAR.modelUrl) {
      void this._loadGLTF(CHAR.modelUrl);
    }
  }

  // ── Public, network-friendly & calibration API ────────────────────────────
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

  getRigMode(): AgentRigMode {
    return this._source;
  }

  isDeformed(): boolean {
    return this._deformed;
  }

  hasExternal(): boolean {
    return !!this._external;
  }

  setFacingDegrees(deg: number): void {
    this._yaw = (deg * Math.PI) / 180;
    if (this._external) this._external.rotation.y = this._yaw;
  }

  getFacingDegrees(): number {
    return Math.round((this._yaw * 180) / Math.PI);
  }

  useExternal(on: boolean): boolean {
    if (!this._external) return false;
    this._external.visible = on;
    this._body.visible = !on;
    this._source = on ? (this._hasClips ? 'clips' : 'static') : 'procedural';
    return true;
  }

  consumeFootstep(): boolean {
    const v = this._stepPending;
    this._stepPending = false;
    return v;
  }

  // ── Animation & Locomotion Update (call once per frame) ───────────────────
  update(dt: number): void {
    if (this._prevRotY === null) {
      this._prevRotY = this.group.rotation.y;
    }
    let dRot = (this.group.rotation.y - this._prevRotY) % (Math.PI * 2);
    if (dRot > Math.PI) dRot -= Math.PI * 2;
    if (dRot < -Math.PI) dRot += Math.PI * 2;
    this._prevRotY = this.group.rotation.y;

    const rawTurnRate = dt > 1e-4 ? THREE.MathUtils.clamp(dRot / dt, -4, 4) : 0;
    this._turnRate += (rawTurnRate - this._turnRate) * (1 - Math.exp(-10 * dt));
    this._time += dt;

    if (this._mixer && this._source === 'clips') {
      const kb = 1 - Math.exp(-8 * dt);
      for (const k of ['idle', 'walk', 'run'] as const) {
        this._weights[k] += ((k === this._state ? 1 : 0) - this._weights[k]) * kb;
        const action = this._actions[k];
        if (action) action.setEffectiveWeight(this._weights[k]);
      }
      if (this._actions.walk) {
        this._actions.walk.timeScale = this._direction < 0 ? -0.7 : 1;
      }
      this._mixer.update(dt);
      this._trackFootsteps(this._state === 'idle' ? 0 : 1);
      return;
    }

    const target = POSE_TARGETS[this._state];
    const k = 1 - Math.exp(-GAME_CONFIG.animation.blendSpeed * dt);
    (Object.keys(this._pose) as Array<keyof PoseParams>).forEach((key) => {
      this._pose[key] += (target[key] - this._pose[key]) * k;
    });

    this._phase += this._pose.freq * dt * this._direction;
    const p = this._pose;
    const s = Math.sin(this._phase);
    const c = Math.cos(this._phase);
    const move = Math.min(1, p.swing / 0.55);
    const idleW = 1 - move;
    this._trackFootsteps(move);

    if (this._source === 'static' && this._external) {
      const U = this._U;
      U.uPhase.value = this._phase;
      U.uSwing.value = p.swing * DEF.swing;
      U.uArm.value = p.arm * DEF.arm;
      U.uKnee.value = p.knee * DEF.knee;
      U.uBob.value = p.bob * DEF.bob;
      U.uLean.value = p.lean * DEF.lean;
      U.uSway.value = p.sway * DEF.sway;
      U.uTwist.value = DEF.twist * move;
      U.uMove.value = move;
      U.uIdle.value = idleW;
      U.uTime.value = this._time;
      U.uTurn.value = this._turnRate;
      if (!this._deformed) {
        const r = this._external;
        r.position.y = this._staticBaseY + Math.abs(s) * p.bob * 1.2;
        r.rotation.z = s * 0.05 * move - THREE.MathUtils.clamp(this._turnRate * 0.1, -0.17, 0.17);
        r.rotation.x = p.lean * 0.75;
      }
      return;
    }

    const turnIntensity = Math.min(1, Math.abs(this._turnRate) / 1.6);
    const turnIdle = turnIntensity * idleW;
    this._turnPhase += 7.2 * dt * turnIdle;
    const ts = Math.sin(this._turnPhase);
    const tc = Math.cos(this._turnPhase);

    const j = this._j;

    const hipSwingL = s * p.swing + ts * 0.14 * turnIdle;
    const hipSwingR = -s * p.swing - ts * 0.14 * turnIdle;
    j.hipL.rotation.x = hipSwingL;
    j.hipR.rotation.x = hipSwingR;

    const kneeLiftL = Math.max(0, -Math.sin(this._phase - 0.6)) * p.knee;
    const kneeLiftR = Math.max(0, -Math.sin(this._phase + Math.PI - 0.6)) * p.knee;
    const turnKneeL = Math.max(0, -ts) * 0.24 * turnIdle;
    const turnKneeR = Math.max(0, ts) * 0.24 * turnIdle;

    j.kneeL.rotation.x = kneeLiftL + turnKneeL + 0.04;
    j.kneeR.rotation.x = kneeLiftR + turnKneeR + 0.04;
    j.footL.rotation.x = -(j.hipL.rotation.x + j.kneeL.rotation.x) * 0.45;
    j.footR.rotation.x = -(j.hipR.rotation.x + j.kneeR.rotation.x) * 0.45;

    const idleBreathe = Math.sin(this._time * 1.8) * 0.015 * idleW;
    j.shoulderL.rotation.x = -s * p.arm - ts * 0.09 * turnIdle - 0.03 * idleW + idleBreathe;
    j.shoulderR.rotation.x =  s * p.arm + ts * 0.09 * turnIdle - 0.03 * idleW - idleBreathe;
    j.shoulderL.rotation.z = 0.045;
    j.shoulderR.rotation.z = -0.045;

    j.elbowL.rotation.x = p.elbow - Math.max(0, s) * 0.26 * move - 0.04 * turnIdle;
    j.elbowR.rotation.x = p.elbow - Math.max(0, -s) * 0.26 * move - 0.04 * turnIdle;
    j.elbowL.rotation.y = -0.05 * idleW;
    j.elbowR.rotation.y = 0.05 * idleW;

    const turnHeadLead = THREE.MathUtils.clamp(this._turnRate * 0.075, -0.20, 0.20);
    const turnTorsoFollow = THREE.MathUtils.clamp(-this._turnRate * 0.035, -0.10, 0.10);

    j.torso.rotation.x = p.lean;
    j.torso.rotation.y = s * 0.065 * move + turnTorsoFollow * (1 - move * 0.5);
    j.torso.rotation.z = 0;

    j.head.rotation.y =
      -s * 0.045 * move +
      turnHeadLead +
      Math.sin(this._time * 0.55) * 0.06 * idleW * (1 - turnIntensity);
    j.head.rotation.x = -p.lean * 0.45 + Math.sin(this._time * 0.85) * 0.015 * idleW;

    j.pelvis.position.y =
      this._pelvisBaseY +
      Math.abs(c) * p.bob +
      Math.abs(tc) * 0.010 * turnIdle +
      Math.sin(this._time * 1.8) * 0.006 * idleW * (1 - turnIntensity);
  }

  private _trackFootsteps(move: number): void {
    if (move < 0.2) {
      this._stepIdx = Math.floor(this._phase / Math.PI);
      return;
    }
    const i = Math.floor(this._phase / Math.PI);
    if (i !== this._stepIdx) {
      this._stepIdx = i;
      this._stepPending = true;
    }
  }

  // ── External GLB Loading + GPU Limb Deformation ───────────────────────────
  private _createGLTFLoader(): { loader: GLTFLoader; draco: DRACOLoader } {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    loader.setDRACOLoader(draco);
    return { loader, draco };
  }

  private _installLoadedGLTF(gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }): void {
    if (this._external) {
      this.group.remove(this._external);
    }
    if (this._mixer) {
      this._mixer.stopAllAction();
      this._mixer = null;
    }
    this._actions = {};
    this._hasClips = false;
    this._deformed = false;

    const root = gltf.scene;
    const animated = !!(gltf.animations && gltf.animations.length);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) meshes.push(m);
    });
    if (!meshes.length) return;
    const skinned = meshes.some((m) => (m as THREE.SkinnedMesh).isSkinnedMesh);

    root.updateMatrixWorld(true);
    if (!animated && !skinned && DEF.enabled) {
      // Bake every mesh into root space so one shared deformation field fits all.
      const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
      for (const m of meshes) {
        const rel = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
        const g = m.geometry.clone();
        g.applyMatrix4(rel);
        m.geometry = g;
        root.add(m);
        m.position.set(0, 0, 0);
        m.rotation.set(0, 0, 0);
        m.scale.set(1, 1, 1);
        m.updateMatrix();
      }
      root.updateMatrixWorld(true);
    }

    const bb = new THREE.Box3().setFromObject(root);
    const height = Math.max(0.001, bb.max.y - bb.min.y);
    const U = this._U;
    U.uMinY.value = bb.min.y;
    U.uHeight.value = height;
    U.uCX.value = (bb.min.x + bb.max.x) * 0.5;
    U.uHalfW.value = Math.max(0.02, (bb.max.x - bb.min.x) * 0.5);

    const s = (CHAR.modelHeight || 1.87) / height;
    const cz = (bb.min.z + bb.max.z) * 0.5;
    root.scale.setScalar(s);
    root.position.set(-U.uCX.value * s, -bb.min.y * s, -cz * s);
    this._staticBaseY = root.position.y;
    root.rotation.y = this._yaw;

    const seen = new Set<THREE.Material>();
    for (const m of meshes) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      if (animated || skinned || !DEF.enabled) continue;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (!mat || seen.has(mat)) continue;
        seen.add(mat);
        const isLit =
          (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial ||
          (mat as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial;
        injectDeform(mat, U, !isLit);
      }
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      injectDeform(depth, U, true);
      m.customDepthMaterial = depth;
      this._deformed = true;
    }

    this.group.add(root);
    this._external = root;

    if (animated) {
      this._mixer = new THREE.AnimationMixer(root);
      const find = (names: string[]) =>
        gltf.animations.find((c) => names.some((q) => c.name.toLowerCase().includes(q)));
      const clips = {
        idle: find(['idle', 'stand', 'breath']) || gltf.animations[0],
        walk: find(['walk']),
        run: find(['run', 'sprint', 'jog']),
      };
      for (const key of ['idle', 'walk', 'run'] as const) {
        const clip = clips[key];
        if (!clip) continue;
        const a = this._mixer.clipAction(clip);
        a.play();
        a.setEffectiveWeight(key === 'idle' ? 1 : 0);
        this._actions[key] = a;
      }
      this._hasClips = true;
      this._source = 'clips';
    } else {
      this._source = 'static';
    }

    this._body.visible = false;
    this._onRigLoaded?.(this._source);
  }

  async _loadGLTF(url: string): Promise<boolean> {
    const { loader, draco } = this._createGLTFLoader();
    try {
      const gltf = await loader.loadAsync(url);
      this._installLoadedGLTF(gltf);
      return true;
    } catch {
      return false;
    } finally {
      draco.dispose();
    }
  }

  async loadGLTFBuffer(buffer: ArrayBuffer): Promise<boolean> {
    const { loader, draco } = this._createGLTFLoader();
    try {
      const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>(
        (resolve, reject) => {
          loader.parse(buffer, '', resolve, reject);
        },
      );
      this._installLoadedGLTF(gltf);
      return true;
    } catch {
      return false;
    } finally {
      draco.dispose();
    }
  }

  // ── Mesh construction (tailored silhouette, ~1.85 m tall) ──────────────────
  private _build(): void {
    const M = makeMaterials();
    const j: Partial<AgentJoints> = {};

    j.pelvis = new THREE.Group();
    j.pelvis.position.y = this._pelvisBaseY;
    this._body.add(j.pelvis);

    const hipGeo = makeTaperedLimb(0.160, 0.100, 0.168, 0.105, 0.16, 1.04, 24, 4);
    j.pelvis.add(part(hipGeo, M.trouser, 0, 0.06, 0));

    j.torso = new THREE.Group();
    j.torso.position.set(0, 0.03, 0);
    j.pelvis.add(j.torso);

    j.torso.add(part(makeTailoredJacketGeo(), M.suit));

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

    const collarBand = part(
      new THREE.CylinderGeometry(0.055, 0.062, 0.048, 22),
      M.shirt,
      0,
      0.546,
      0.004,
    );
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
      const wing = part(wingGeo, M.shirt, s * 0.006, 0.542, 0.060);
      wing.rotation.y = s * -0.35;
      wing.rotation.x = 0.16;
      j.torso.add(wing);
    }

    const suitCollarRoll = part(
      new THREE.TorusGeometry(0.068, 0.014, 12, 24, Math.PI * 1.32),
      M.suitLapel,
      0,
      0.530,
      0.002,
    );
    suitCollarRoll.rotation.x = Math.PI / 2 + 0.08;
    suitCollarRoll.rotation.z = Math.PI * 0.84;
    j.torso.add(suitCollarRoll);

    const tieKnot = part(new THREE.CylinderGeometry(0.020, 0.013, 0.032, 6), M.tie, 0, 0.512, 0.072);
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
    const tieBlade = part(tieGeo, M.tie, 0, 0.500, 0.073);
    tieBlade.rotation.x = -0.15;
    j.torso.add(tieBlade);

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

    const btnTop = part(new THREE.CylinderGeometry(0.011, 0.011, 0.008, 12), M.button, 0, 0.19, 0.118);
    const btnBot = part(new THREE.CylinderGeometry(0.011, 0.011, 0.008, 12), M.button, 0, 0.09, 0.117);
    btnTop.rotation.x = Math.PI / 2;
    btnBot.rotation.x = Math.PI / 2;
    j.torso.add(btnTop, btnBot);

    const welt = part(new THREE.BoxGeometry(0.082, 0.012, 0.010), M.suitLapel, 0.105, 0.375, 0.118);
    welt.rotation.z = 0.08;
    welt.rotation.y = 0.22;
    j.torso.add(welt);

    for (const s of [-1, 1]) {
      const flap = part(new THREE.BoxGeometry(0.11, 0.028, 0.012), M.suitLapel, s * 0.125, 0.075, 0.108);
      flap.rotation.y = s * 0.35;
      j.torso.add(flap);
    }

    j.torso.add(part(new THREE.BoxGeometry(0.010, 0.20, 0.006), M.suitLapel, 0, 0.045, -0.112));
    j.torso.add(part(makeTaperedLimb(0.044, 0.046, 0.052, 0.054, 0.11, 1.0, 18, 3), M.skin, 0, 0.628, 0));

    j.head = new THREE.Group();
    j.head.position.set(0, 0.618, 0.004);
    j.torso.add(j.head);

    j.head.add(part(makeSculptedHeadGeo(), M.face, 0, 0.112, 0));

    const noseBridge = part(new THREE.BoxGeometry(0.017, 0.044, 0.024), M.skin, 0, 0.105, 0.114);
    noseBridge.rotation.x = -0.22;
    const noseTip = part(new THREE.SphereGeometry(0.0115, 12, 10), M.skin, 0, 0.086, 0.124);
    noseTip.scale.set(1.05, 0.85, 1.0);
    j.head.add(noseBridge, noseTip);

    for (const s of [-1, 1]) {
      const eyeWhite = part(new THREE.SphereGeometry(0.013, 12, 10), M.sclera, s * 0.035, 0.124, 0.102);
      eyeWhite.scale.set(1.25, 0.72, 0.65);
      const pupil = part(new THREE.SphereGeometry(0.0075, 10, 8), M.iris, s * 0.035, 0.124, 0.107);
      pupil.scale.set(1, 1, 0.65);
      const brow = part(new THREE.BoxGeometry(0.037, 0.0075, 0.013), M.hair, s * 0.036, 0.144, 0.110);
      brow.rotation.z = s * -0.07;
      brow.rotation.y = s * -0.18;
      const ear = part(new THREE.SphereGeometry(0.019, 12, 10), M.skin, s * 0.096, 0.108, -0.006);
      ear.scale.set(0.36, 1.35, 0.72);
      ear.rotation.y = s * 0.18;
      j.head.add(eyeWhite, pupil, brow, ear);
    }

    j.head.add(part(makeSculptedHairGeo(), M.hair, 0, 0.132, -0.010));

    const quiffMain = part(new THREE.SphereGeometry(0.084, 22, 16), M.hair, -0.012, 0.214, 0.024);
    quiffMain.scale.set(1.04, 0.42, 0.96);
    quiffMain.rotation.x = -0.22;
    quiffMain.rotation.z = 0.08;
    const quiffWave = part(new THREE.SphereGeometry(0.060, 18, 14), M.hair, 0.022, 0.222, 0.044);
    quiffWave.scale.set(1.08, 0.38, 0.84);
    quiffWave.rotation.x = -0.32;
    quiffWave.rotation.z = -0.14;
    j.head.add(quiffMain, quiffWave);

    for (const s of [-1, 1]) {
      const sideHair = part(new THREE.BoxGeometry(0.015, 0.062, 0.040), M.hair, s * 0.092, 0.136, 0.008);
      sideHair.rotation.z = s * -0.08;
      const sideburn = part(new THREE.BoxGeometry(0.009, 0.040, 0.015), M.hair, s * 0.090, 0.094, 0.018);
      j.head.add(sideHair, sideburn);
    }

    for (const side of [{ s: 1, n: 'L' as const }, { s: -1, n: 'R' as const }]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side.s * 0.194, 0.458, 0.002);
      j.torso.add(shoulder);

      shoulder.add(part(makeTailoredUpperSleeveGeo(0.285), M.suit));

      const elbow = new THREE.Group();
      elbow.position.set(0, -0.285, 0);
      shoulder.add(elbow);

      const elbowCap = part(new THREE.SphereGeometry(0.042, 16, 12), M.suit);
      elbowCap.scale.set(0.98, 1.0, 1.04);
      elbow.add(elbowCap);
      elbow.add(part(makeTaperedLimb(0.041, 0.044, 0.036, 0.039, 0.252, 1.02, 20, 6), M.suit));

      for (let b = 0; b < 3; b++) {
        elbow.add(
          part(
            new THREE.SphereGeometry(0.0042, 8, 6),
            M.button,
            side.s * 0.036,
            -0.215 - b * 0.013,
            -0.012,
          ),
        );
      }

      const cuff = part(new THREE.CylinderGeometry(0.034, 0.033, 0.030, 18), M.shirt, 0, -0.258, 0);
      cuff.scale.set(0.94, 1, 1.08);
      elbow.add(cuff);

      elbow.add(part(makeTaperedLimb(0.027, 0.030, 0.024, 0.028, 0.034, 1.0, 12, 2), M.skin, 0, -0.268, 0));
      const hand = makeSculptedHand(M.skin, side.s);
      hand.position.set(0, -0.291, 0);
      elbow.add(hand);

      if (side.n === 'L') {
        const strap = part(new THREE.TorusGeometry(0.034, 0.006, 10, 22), M.watchBand, 0, -0.277, 0);
        strap.rotation.x = Math.PI / 2;
        strap.scale.set(0.92, 1.08, 1);

        const bezel = part(
          new THREE.CylinderGeometry(0.018, 0.018, 0.009, 20),
          M.watchCase,
          side.s * 0.032,
          -0.277,
          0.006,
        );
        bezel.rotation.z = Math.PI / 2;

        const dial = part(
          new THREE.CylinderGeometry(0.015, 0.015, 0.0096, 20),
          M.watchDial,
          side.s * 0.032,
          -0.277,
          0.006,
        );
        dial.rotation.z = Math.PI / 2;

        elbow.add(strap, bezel, dial);
      }

      j[`shoulder${side.n}`] = shoulder;
      j[`elbow${side.n}`] = elbow;
    }

    for (const side of [{ s: 1, n: 'L' as const }, { s: -1, n: 'R' as const }]) {
      const hip = new THREE.Group();
      hip.position.set(side.s * 0.092, -0.02, 0);
      j.pelvis.add(hip);

      const hipJoint = part(new THREE.SphereGeometry(0.070, 16, 12), M.trouser);
      hipJoint.scale.set(0.95, 1.0, 1.02);
      hip.add(hipJoint);
      hip.add(part(makeTaperedLimb(0.072, 0.077, 0.054, 0.058, 0.44, 1.03, 20, 6), M.trouser));

      const knee = new THREE.Group();
      knee.position.set(0, -0.44, 0);
      hip.add(knee);

      const kneeCap = part(new THREE.SphereGeometry(0.054, 16, 12), M.trouser);
      kneeCap.scale.set(0.98, 1.0, 1.04);
      knee.add(kneeCap);
      knee.add(part(makeTaperedLimb(0.054, 0.058, 0.046, 0.050, 0.452, 1.02, 20, 6), M.trouser));

      const foot = new THREE.Group();
      foot.position.set(0, -0.44, 0);
      knee.add(foot);

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
