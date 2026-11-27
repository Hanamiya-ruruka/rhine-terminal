/* ===== rhine-motif.js（240 片固定 ID 并发路径插值 WebGL2 渲染器） ===== */
'use strict';

// 默认套项目原有的错误态材质（主人 11-25 20:5x 指定）；带 ?dnaerr=new 才用账本专用材质
const DNA_ERROR_MODE = (new URLSearchParams(location.search).get('dnaerr') === 'new') ? 1 : 0;

const DEFORM = { push: 52, scaleW: 1.32, scaleH: 1.68, sigma: 3600, tangent: 10, light: 0.18 };
const DNA = { radius: 52, length: 600, sweep: 6 * Math.PI, rungCount: 30, spinRate: 0.6, tilt: 17 * Math.PI / 180 };
const DNA_AXIS = [Math.cos(DNA.tilt), Math.sin(DNA.tilt), 0];

const DNA_STRAND_SPEED = Math.hypot(DNA.length, DNA.radius * DNA.sweep);

const mountRhineMotif = ({
  el: slot = document.getElementById('rhine-motif-slot'),
  boot = true,
  menu = true,
  interactive = true,
  linkage = false,
} = {}) => {
  if (!slot) return;

  const finCount = 240;
  const identities = Array.from({ length: finCount }, (_, id) => ({ id }));
  const halfCount = finCount / 2;
  for (let group = 0; group < halfCount / 6; group++) {
    const left = 6 * group + 3;
    Object.assign(identities[left], { role: 'bridge', slot: { group, side: 'A' } });
    Object.assign(identities[finCount - 1 - left], { role: 'bridge', slot: { group, side: 'B' } });
  }
  let slotA = 0, slotB = 0;
  for (let id = 0; id < halfCount; id++) {
    const a = identities[id], b = identities[finCount - 1 - id];
    if (!a.role) Object.assign(a, { role: 'A', slot: slotA++ });
    if (!b.role) Object.assign(b, { role: 'B', slot: slotB++ });
  }
  const outerCount = 144;   // 240 片硬约束：内环 96 → 外环 144（Gemini 原表同为 144/96）
  const forms = {
    mobius: identities.map(({ role, slot }) => ({ role, slot })),
    turbine: identities.map(({ id }) => id < outerCount
      ? { role: 'outer', slot: id }
      : { role: 'inner', slot: id - outerCount }),
    dna: identities.map(({ id }) => {
      const side = id < halfCount ? 'A' : 'B';
      const index = side === 'A' ? id : finCount - 1 - id;
      const group = Math.floor(index / 4);
      const offset = index % 4;
      return offset === 3
        ? { role: 'bridge', slot: { group, side } }
        : { role: side, slot: group * 3 + offset };
    }),
  };

  const TUNE = Object.assign({
    // 莱茵浑天仪（缩至 0.72× 留足呼吸边距，外环 R=268 严格包裹内环 R=162，整机随 23.5° 极轴对齐）
    outerRadius: 268,
    innerRatio: 0.60448,      // 162 / 268（保持球壳居中不裁切）
    outerLengthRatio: 0.135,  // ~36px（+40% 环带高度，体量更扎实）
    innerLengthRatio: 0.182,  // ~30px（+40% 内环带高度）
    outerChord: 11.0,         // 144 片沿周紧排（周长 1684 / 144 = 11.7，留 ~0.7px 精密细缝）
    innerChord: 10.0,         // 96 片沿周紧排（周长 1018 / 96 = 10.6，留 ~0.6px 精密细缝）
    chordPitchRatio: 1.85,
    outerThick: 6.8,          // +40% 实体环壁厚度
    innerThick: 6.0,
    outerTiltX: -72, outerTiltY: 0, outerTiltZ: 0,   // 赤道主环：法线严格沿主极轴
    innerTiltX: -22, innerTiltY: 38, innerTiltZ: 0,  // 黄道内环：斜交嵌套于主球壳内
    outerAttack: 0,
    innerAttack: 0,
    turbineCamElev: 16,       // 经典 3/4 观测仰角
    turbineDrop: 0.0,         // 与 SVG 中心 (600, 285) 极轴/奇点像素级同心
    turbineRoll: 23.5,        // 与 SVG 23.5° 主极轴严格共线
    attack: 48,
    camPitch: 0,
    camElev: 28,
    camDist: 920,
    zoom: 1.0,
    shiftX: 0, shiftY: 0,
    stagger: 0.22,
    arc: 0.16,
  }, (typeof window !== 'undefined' && window.RHINE_TUNE) || {});

  const turbineOmega = 2 * Math.PI / 22; // 浑天仪内轨公转角速度（22 秒一圈，沉静优雅）
  // 反向共轭公转：外轨按片数比反向（96 : 144 = 2/3）
  const turbineOuterOmega = -turbineOmega * ((finCount - outerCount) / outerCount);
  const turbineRings = {
    outer: {
      count: outerCount, radius: TUNE.outerRadius, tilt: TUNE.outerTiltX,
      tiltX: TUNE.outerTiltX, tiltY: TUNE.outerTiltY ?? 0, tiltZ: TUNE.outerTiltZ ?? 0,
      attack: TUNE.outerAttack ?? TUNE.attack,
      length: TUNE.outerRadius * TUNE.outerLengthRatio,
      chord: TUNE.outerChord ?? 2 * Math.PI * TUNE.outerRadius / outerCount * TUNE.chordPitchRatio,
      thick: TUNE.outerThick
    },
    inner: {
      count: finCount - outerCount, radius: TUNE.outerRadius * TUNE.innerRatio,
      tilt: TUNE.innerTiltX, tiltX: TUNE.innerTiltX, tiltY: TUNE.innerTiltY ?? 0, tiltZ: TUNE.innerTiltZ ?? 0,
      attack: (TUNE.innerAttack ?? TUNE.attack),
      length: TUNE.outerRadius * TUNE.innerRatio * TUNE.innerLengthRatio,
      chord: TUNE.innerChord ?? 2 * Math.PI * TUNE.outerRadius * TUNE.innerRatio / (finCount - outerCount) * TUNE.chordPitchRatio,
      thick: TUNE.innerThick
    },
  };

  function quatFromAxes(xAxis, yAxis, zAxis) {
    const m00 = xAxis[0], m01 = yAxis[0], m02 = zAxis[0];
    const m10 = xAxis[1], m11 = yAxis[1], m12 = zAxis[1];
    const m20 = xAxis[2], m21 = yAxis[2], m22 = zAxis[2];
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
    }
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return q.map(v => v / n);
  }

  const currentForm = () => {
    if (!frozen) return 'mobius';
    if (frozen.staticTurbine) return 'turbine';
    const r = frozen.destination;
    const p = frozen.progress;
    if (r === 'turbine' || r === 'mobius-turbine') return p > 0.5 ? 'turbine' : 'mobius';
    if (r === 'turbine-dna') return p > 0.5 ? 'dna' : 'turbine';
    if (r === 'dna-mobius') return p > 0.5 ? 'mobius' : 'dna';
    return p > 0.5 ? 'dna' : 'mobius';
  };

  const diagnosticSelection = true;
  const entryParams = slot.id === 'rhine-motif-slot' ? [0.25, 0.75] : [];
  const [firstEntryFin, secondEntryFin] = entryParams.map(param => Math.round(param * finCount));
  const radius = 285;
  const curveAspect = 0.88;
  const curveDepth = 45;
  const shadowSize = 1024;
  const menuRows = 7;
  const menuFins = new Float32Array(finCount * 4);
  const menuTargets = new Map();
  const movingMenuFins = new Set();
  let menuRect = null, menuBuffer, lastMenuDepth = 0, lastDissolve = 0;
  let dailyProjection = null;
  let lastCamera = null, lastAngles = null, lastFlow = 0, lastAspect = 1;
  const degrees = Math.PI / 180;
  const cameraHeight = 60;
  const cameraDistance = 920;
  const cameraPitch = 16;
  const focal = 3.7320508;        // 日常 / DNA：30° 视场（基线，不动）
  const focalTurbine = 2.7474774; // 涡轮：40° 视场（Gemini 规格）
  const bootHelix = { turns: 2.25, radius: 24, rise: 284, side: 0.85, scatter: [58, 55, 68] };
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  const svgFallback = interactive ? document.getElementById('mobiusSvg') : null;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none';
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) return;

  function makeFoldedFin(foldDepth = 0.0) {
    const vertices = [];
    const xFront = 0.5, xBack = -0.5;
    const xWingF = xFront - foldDepth, xWingB = xBack - foldDepth;
    const F_LB = [xWingF, -0.5, -0.5], F_LT = [xWingF, -0.5, 0.5];
    const F_MB = [xFront, 0.0, -0.5], F_MT = [xFront, 0.0, 0.5];
    const F_RB = [xWingF, 0.5, -0.5], F_RT = [xWingF, 0.5, 0.5];
    const B_LB = [xWingB, -0.5, -0.5], B_LT = [xWingB, -0.5, 0.5];
    const B_MB = [xBack, 0.0, -0.5], B_MT = [xBack, 0.0, 0.5];
    const B_RB = [xWingB, 0.5, -0.5], B_RT = [xWingB, 0.5, 0.5];
    function pushQuad(p0, p1, p2, p3, hint) {
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const dot = nx * hint[0] + ny * hint[1] + nz * hint[2];
      const quad = dot >= 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2];
      if (dot < 0) { nx = -nx; ny = -ny; nz = -nz; }
      for (const q of quad) vertices.push(q[0], q[1], q[2], nx, ny, nz);
    }
    pushQuad(F_LB, F_MB, F_MT, F_LT, [1, -1, 0]);
    pushQuad(F_MB, F_RB, F_RT, F_MT, [1, 1, 0]);
    pushQuad(B_MB, B_LB, B_LT, B_MT, [-1, -1, 0]);
    pushQuad(B_RB, B_MB, B_MT, B_RT, [-1, 1, 0]);
    pushQuad(F_LT, F_MT, B_MT, B_LT, [0, 0, 1]);
    pushQuad(F_MT, F_RT, B_RT, B_MT, [0, 0, 1]);
    pushQuad(B_LB, B_MB, F_MB, F_LB, [0, 0, -1]);
    pushQuad(B_MB, B_RB, F_RB, F_MB, [0, 0, -1]);
    pushQuad(B_LB, F_LB, F_LT, B_LT, [0, -1, 0]);
    pushQuad(F_RB, B_RB, B_RT, F_RT, [0, 1, 0]);
    return new Float32Array(vertices);
  }

  const materialSource = `
float rl_materialMix(vec3 world, float errorFin) {
    float blend = uDenied;
    if (uDeniedSweep < 1.0) {
        float distanceToCenter = length(world) / 345.0;
        float front = mix(-0.09, 1.09, uDeniedSweep);
        blend *= 1.0 - smoothstep(front - 0.09, front + 0.09, distanceToCenter);
    }
    return max(blend, errorFin);
}
`;

  const vertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPoint;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aSortedIndex;
uniform bool uLayered;
uniform vec2 uErrorFins;
uniform vec3 uCamera, uAngles;
uniform float uFocal;
uniform vec2 uCameraShift;
uniform float uFrameAspect;
uniform float uFlow, uSpin, uAssemble, uAlign, uDisorder, uDissolve;
uniform vec3 uBootPose;
uniform float uSelect, uSelectMix;
uniform float uDeform, uDeformMix;
uniform float uPulseT[16], uPulseO[16];
uniform float uStaticPulse;
layout(std140) uniform MenuFins {
    vec4 uMenuFin[${finCount}];
};
uniform vec2 uCssPixels;
uniform float uMenuDepth, uMenuFinHeight;
const float uCount = ${finCount}.0, uRadius = ${radius}.0, uAspect = ${curveAspect}, uDepth = ${curveDepth}.0, uTwist = 1.5;
const float uWidth = 112.0, uHeight = 60.0, uThickness = 4.2, uLean = 0.62, uHalfTwist = 0.5;
const float uHoleR = 132.0;
const float uCorner = 0.14;
const vec3 keyDirection = vec3(-0.379, 0.788, 0.485);
uniform float uDnaBend;
uniform float uTime, uVerify, uDenied, uDeniedSweep;
uniform bool uPosePath;
uniform bool uMorphPose;
layout(std140) uniform MorphFins {
    vec4 uMorphFins[720];
};
out vec4 tfCenterId, tfOrientation, tfSizeMaterial, tfClip;
${materialSource}
struct FinFrame { vec3 center; vec3 widthAxis; vec3 heightAxis; vec3 size; };
FinFrame finFrame;
uniform bool uShadowPass;
out vec3 vLocal;
out vec3 vNormal;
out vec3 vWorld;
out vec4 vLightSpace;
out float vSeed;
out float vPulse;
out float vParam, vDeform;
out float vTip;
flat out float vErrorFin, vDnaBridge, vFinId, vFinHover;

float rl_hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}
vec3 rl_rotateAxis(vec3 v, vec3 axis, float a) {
    float s = sin(a), c = cos(a);
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}
vec3 rl_toLinear(vec3 c) { return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }

float aIndex;

vec3 rl_curve(float t) {
    float s = sin(t), c = cos(t);
    float lobeRound = 1.0 / (1.0 + 0.15 * s * s);
    float crossGate = exp(-(c * c) * 7.0);
    return vec3(uRadius * c * lobeRound, uRadius * uAspect * s * c * lobeRound,
                uDepth * 0.32 * s * crossGate);
}
float rl_seamLeanWeight(float t) {
    float d = min(t, 6.2831853 - t);
    return smoothstep(0.0, 0.38, d);
}
float rl_rollWave(float t) {
    return sin(2.0 * t - uTime * 0.35) * 0.10 + sin(4.0 * t + uTime * 0.22) * 0.04;
}
float rl_easeOutBack(float x) {
    float c1 = 1.70158, c3 = c1 + 1.0;
    float d = x - 1.0;
    return 1.0 + c3 * d * d * d + c1 * d * d;
}

void rl_blendFrame(inout vec3 W, inout vec3 H, vec3 targetW, vec3 targetH, float weight) {
    mat3 source = mat3(W, H, cross(W, H));
    mat3 target = mat3(targetW, targetH, cross(targetW, targetH));
    mat3 r = target * transpose(source);
    vec3 skew = vec3(r[1][2] - r[2][1], r[2][0] - r[0][2], r[0][1] - r[1][0]);
    float trace = r[0][0] + r[1][1] + r[2][2];
    vec4 q;
    if (trace > 0.0) {
        q = vec4(skew, 1.0 + trace);
    } else {
        int i = r[0][0] > r[1][1] ? 0 : 1;
        if (r[2][2] > r[i][i]) i = 2;
        int j = (i + 1) % 3, k = (i + 2) % 3;
        q[i] = 1.0 + 2.0 * r[i][i] - trace;
        q[j] = r[i][j] + r[j][i];
        q[k] = r[i][k] + r[k][i];
        q.w = skew[i];
    }
    if (q.w < 0.0) q = -q;
    q = normalize(mix(vec4(0, 0, 0, 1), normalize(q), weight));
    W += 2.0 * cross(q.xyz, cross(q.xyz, W) + q.w * W);
    H += 2.0 * cross(q.xyz, cross(q.xyz, H) + q.w * H);
}

void rl_bootFin(float idx, inout vec3 centre, inout vec3 W, inout vec3 H, inout vec3 size) {
    // 方案1：水平工程条码切片墙 -> 随光刃从左向右波浪扭转展开为莫比乌斯环
    float u = idx / max(1.0, uCount - 1.0);
    vec3 back = normalize(uCamera);
    vec3 right = normalize(cross(vec3(0, 1, 0), back));
    vec3 up = cross(back, right);
    // 左→右波浪错峰权重：光刃扫过哪里，哪里的条码切片就开始向 3D 莫比乌斯舒展
    float wave = clamp(uBootPose.y * 1.38 - (1.0 - u) * 0.38, 0.0, 1.0);
    wave = wave * wave * (3.0 - 2.0 * wave);
    float bar = 0.42 + 0.58 * rl_hash11(idx * 3.17 + 1.3);
    float spread = 1.0 - uBootPose.x;
    vec3 scatter = (rl_hash11(idx * 5.71) - 0.5) * 90.0 * up
        + (rl_hash11(idx * 9.13) - 0.5) * 140.0 * back;
    vec3 wallCentre = (u - 0.5) * 600.0 * right + spread * scatter;
    vec3 wallW = rl_rotateAxis(back, up, spread * (rl_hash11(idx * 2.13) - 0.5) * 1.6);
    vec3 wallH = up;
    centre = mix(centre, wallCentre, wave);
    size = mix(size, vec3(1.8, 18.0, 56.0 * bar), wave);
    if (wave >= 0.999) {
        W = wallW;
        H = wallH;
    } else if (wave > 0.001) {
        rl_blendFrame(W, H, wallW, wallH, wave);
    }
}

vec3 rl_displayPose(vec3 v) {
    v = rl_rotateAxis(v, vec3(0, 0, 1), uAngles.z);
    v = rl_rotateAxis(v, vec3(1, 0, 0), uAngles.x);
    return rl_rotateAxis(v, vec3(0, 1, 0), uAngles.y);
}

void rl_finTransform(in vec3 lp, in vec3 nrm, out vec3 worldPos, out vec3 worldNrm) {
    float idx = aIndex;
    float seed = rl_hash11(idx * 1.618 + 4.7);
    float t = 6.2831853 * fract((idx + uFlow) / uCount);

    vec3 p = rl_curve(t);
    vec3 T = normalize(rl_curve(t + 0.002) - rl_curve(t - 0.002));
    vec3 ref = vec3(0.0, 0.0, 1.0);
    vec3 N0 = normalize(ref - dot(ref, T) * T);
    vec3 B0 = cross(T, N0);

    float pulse = 0.0;
    for (int i = 0; i < 16; ++i) {
        float age = uTime - uPulseT[i];
        if (age >= 0.0 && age < 3.7) {
            float front = fract(uPulseO[i] + age * 0.32);
            float d = abs(fract(t / 6.2831853 - front + 0.5) - 0.5);
            float life = smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(3.05, 3.45, age));
            pulse += exp(-d * d * 900.0) * life;
        }
    }
    pulse = min(pulse, 1.4);

    float roll = uHalfTwist * t + rl_rollWave(t);
    float phi = roll + uSpin + pulse * 1.3;
    phi = mix(phi, 1.5707963, uAlign);
    phi += (seed - 0.5) * uDisorder * 3.0 + sin(uTime * 9.0 + seed * 40.0) * uDisorder * 0.2;

    vec3 W = cos(phi) * N0 + sin(phi) * B0;
    vec3 H = cross(T, W);
    float lean = uLean + sin(t * 2.0 + uTime * 0.4) * 0.06;
    lean *= rl_seamLeanWeight(t);
    vec3 Tl = cos(lean) * T + sin(lean) * H;
    H = cross(Tl, W);
    T = Tl;

    float along = fract(t / 6.2831853 - 0.25);
    float window = 0.085;
    float local = clamp((uAssemble * (1.0 + window) - along) / window, 0.0, 1.0);
    float settle = 1.0 - pow(1.0 - local, 3.0);
    float grow = local > 0.0 ? rl_easeOutBack(local) : 0.0;
    float swing = (1.0 - settle) * 1.1;
    W = rl_rotateAxis(W, T, swing);
    H = rl_rotateAxis(H, T, swing);

    float peel = clamp(uDissolve * 1.9 - seed * 0.12, 0.0, 1.0);
    float peelE = peel * peel * (3.0 - 2.0 * peel);
    vec3 axis = normalize(vec3(seed - 0.5, 0.6, 0.3 + seed));
    W = rl_rotateAxis(W, axis, peelE * (2.0 + seed * 4.0));
    H = rl_rotateAxis(H, axis, peelE * (2.0 + seed * 4.0));

    float widthScale = 1.0;
    {
        float lobeX = (p.x >= 0.0 ? 1.0 : -1.0) * 0.52 * uRadius;
        float dToCenter = length(p.xy - vec2(lobeX, 0.0));
        float proj = max(0.62, abs(cos(phi)));
        float wantHalf = max(uWidth * 0.18, (dToCenter - uHoleR) / proj);
        widthScale = clamp(wantHalf / (uWidth * 0.5), 0.26, 1.32);
    }
    vec3 size = vec3(uThickness, uWidth * widthScale * (1.0 + pulse * 0.35), uHeight * (1.0 + pulse * 0.9)) * grow;
    size *= 1.0 - peelE * 0.55;

    vec3 radial = normalize(vec3(p.x, p.y * 1.4, p.z + 120.0));
    vec3 centre = p + H * (pulse * 7.0 + (1.0 - settle) * 16.0)
                + (radial * 268.0 + vec3(0.0, 0.0, 172.0)) * peelE * (0.6 + seed);

    float selDelta = abs(fract(t / 6.2831853) - uSelect);
    selDelta = min(selDelta, 1.0 - selDelta);
    float selMaskV = clamp(uSelectMix * exp(-selDelta * selDelta * 9000.0), 0.0, 1.0);
    size *= 1.0 + selMaskV * 0.10;
    vDeform = 0.0;
    if (uDeformMix > 0.0) {
        float delta = fract(t / 6.2831853 - uDeform + 0.5) - 0.5;
        float offset = delta * sqrt(${DEFORM.sigma.toFixed(1)});
        vDeform = uDeformMix * exp(-offset * offset);
        centre += vDeform * (H * ${DEFORM.push.toFixed(1)} + T * (offset * ${DEFORM.tangent.toFixed(1)}));
        size.yz *= mix(vec2(1.0), vec2(${DEFORM.scaleW}, ${DEFORM.scaleH}), vDeform);
    }
    centre = rl_displayPose(centre + H * (selMaskV * 26.0));
    W = rl_displayPose(W);
    H = rl_displayPose(H);
    if (uBootPose.y > 0.0) rl_bootFin(idx, centre, W, H, size);
    finFrame = FinFrame(centre, W, H, size);
    vec3 Tt = cross(W, H);
    worldPos = centre + Tt * lp.x * size.x + W * lp.y * size.y + H * lp.z * size.z;
    worldNrm = normalize(Tt * nrm.x + W * nrm.y + H * nrm.z);

    float dt = along - uAssemble * (1.0 + window) + window * 0.5;
    vTip = exp(-dt * dt * 2600.0) * (1.0 - smoothstep(0.9, 1.0, uAssemble));
    vLocal = lp;
    vSeed = seed;
    float staticDistance = abs(fract(t / 6.2831853 - 0.25 + 0.5) - 0.5);
    vPulse = max(pulse, uStaticPulse * exp(-staticDistance * staticDistance * 900.0));
    vParam = t / 6.2831853;
}

vec4 rl_orientation(FinFrame frame) {
    vec3 y = normalize(frame.widthAxis);
    vec3 x = normalize(cross(y, frame.heightAxis));
    vec3 z = cross(x, y);
    vec4 d = vec4(1.0 + x.x - y.y - z.z, 1.0 - x.x + y.y - z.z,
        1.0 - x.x - y.y + z.z, 1.0 + x.x + y.y + z.z);
    if (d.w >= max(d.x, max(d.y, d.z))) {
        return normalize(vec4(y.z - z.y, z.x - x.z, x.y - y.x, d.w));
    }
    if (d.x >= max(d.y, d.z)) {
        return normalize(vec4(d.x, x.y + y.x, x.z + z.x, y.z - z.y));
    }
    if (d.y >= d.z) {
        return normalize(vec4(x.y + y.x, d.y, y.z + z.y, z.x - x.z));
    }
    return normalize(vec4(x.z + z.x, y.z + z.y, d.z, x.y - y.x));
}

vec3 rl_quaternionRotate(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
    aIndex = uLayered ? aSortedIndex : float(gl_InstanceID);
    vFinId = aIndex;
    vec2 errorDistance = abs(vec2(aIndex) - uErrorFins);
    vDnaBridge = 0.0;
    vErrorFin = float(min(errorDistance.x, errorDistance.y) <= 1.0);
    vec3 position, normal;
    rl_finTransform(aPoint, aNormal, position, normal);
    tfCenterId = vec4(0.0, 0.0, 0.0, aIndex);
    tfSizeMaterial = vec4(0.0);
    tfOrientation = vec4(0.0);
    if (uPosePath || uMorphPose) {
        tfCenterId.xyz = finFrame.center;
        tfSizeMaterial = vec4(finFrame.size, rl_materialMix(finFrame.center, vErrorFin));
        tfOrientation = rl_orientation(finFrame);
        if (uMorphPose) {
            int address = 3 * int(aIndex);
            tfCenterId.xyz = uMorphFins[address].xyz;
            vDnaBridge = uMorphFins[address].w;
            tfOrientation = uMorphFins[address + 1];
            tfSizeMaterial = uMorphFins[address + 2];
        }
        vFinHover = tfSizeMaterial.w;
        position = tfCenterId.xyz + rl_quaternionRotate(tfOrientation, aPoint * tfSizeMaterial.xyz);
        normal = normalize(rl_quaternionRotate(tfOrientation, aNormal));
        if (uDnaBend > 0.0 && vDnaBridge < 0.5) {
            // Follow the helical surface around its tilted axis.
            const vec3 axis = vec3(${DNA_AXIS[0]}, ${DNA_AXIS[1]}, 0.0);
            float t = aPoint.z * tfSizeMaterial.z / ${DNA_STRAND_SPEED};
            vec3 crossSection = tfCenterId.xyz +
                rl_quaternionRotate(tfOrientation, vec3(aPoint.xy * tfSizeMaterial.xy, 0));
            vec3 bent = rl_rotateAxis(crossSection, axis, t * ${DNA.sweep});
            bent -= axis * t * ${DNA.length.toFixed(1)};
            position = mix(position, bent, uDnaBend);
            normal = rl_rotateAxis(normal, axis, uDnaBend * t * ${DNA.sweep});
        }
    }
    vec3 back = normalize(uCamera);
    vec3 right = normalize(cross(vec3(0, 1, 0), back));
    vec3 up = cross(back, right);
    float focal = uFocal;
    vec4 menu = uMenuFin[int(aIndex)];
    if (!uMorphPose && menu.z > 0.0) {
        float side = sign(menu.w);
        vec2 ndc = (menu.xy / uCssPixels * 2.0 - 1.0) * vec2(1.0, -1.0);
        float unitsPerPixel = 2.0 * uMenuDepth / (focal * uCssPixels.y);
        vec3 centre = uCamera - back * uMenuDepth
            + (right * ndc.x * uFrameAspect + up * ndc.y) * (uMenuDepth / focal);
        vec3 W = normalize(right + up * side * 0.20 + back * side * 0.28);
        vec3 T = normalize(cross(W, up));
        vec3 H = cross(T, W);
        vec3 target = centre + unitsPerPixel * (T * aPoint.x * 5.0
            + W * aPoint.y * abs(menu.w) + H * aPoint.z * uMenuFinHeight);
        position = mix(position, target, menu.z);
        normal = normalize(mix(normal, T * aNormal.x + W * aNormal.y + H * aNormal.z, menu.z));
    }
    vWorld = position;
    vNormal = normal;
    vec3 lightBack = normalize(keyDirection);
    vec3 lightRight = normalize(cross(vec3(0, 1, 0), lightBack));
    vec3 lightUp = cross(lightBack, lightRight);
    vLightSpace = vec4(dot(position, lightRight) / 520.0, dot(position, lightUp) / 420.0,
        -dot(position, lightBack) / 700.0, 1.0);
    if (uShadowPass) {
        gl_Position = vLightSpace;
        tfClip = gl_Position;
        return;
    }

    vec3 relative = position - uCamera;
    float depth = -dot(relative, back);
    const float near = 20.0, far = 6000.0;
    gl_Position = vec4(dot(relative, right) * focal / uFrameAspect, dot(relative, up) * focal,
        ((far + near) * depth - 2.0 * far * near) / (far - near), depth);
    gl_Position.xy += uCameraShift * depth;
    tfClip = gl_Position;
}`;

  const fragmentSource = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
uniform vec3 uCamera;
uniform float uFocal;
uniform vec2 uFramePixels, uCssPixels, uGridOrigin;
uniform bool uLayered;
uniform float uTurbineBlend;
uniform float uDnaShareA, uDnaShareB;   // 买断 / 抽卡 支出占比（0..1）
uniform float uDnaHold;   // 账本页：强制走原版错误态材质
uniform sampler2DShadow uShadow;
out vec4 outColor;
const float uCorner = 0.14;
const vec3 keyDirection = vec3(-0.379, 0.788, 0.485);
uniform float uTime, uVerify, uDenied, uDeniedSweep;
${materialSource}
uniform float uFocus, uFocusMix;
uniform float uSelect, uSelectMix;
uniform float uRingPulse;
uniform bool uDnaError;
uniform bool uShadowPass;
in vec3 vLocal;
in vec3 vNormal;
in vec3 vWorld;
in vec4 vLightSpace;
in float vSeed;
in float vPulse;
in float vParam, vDeform;
in float vTip;
flat in float vErrorFin, vDnaBridge, vFinId, vFinHover;

float rl_hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}
vec3 rl_toLinear(vec3 c) { return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }

vec3 displayColor(vec3 rgb) {
    rgb = clamp(rgb, 0.0, 1.0);
    return mix(rgb * 12.92, 1.055 * pow(rgb, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, rgb));
}

float blurredGridLine(float coordinate, float spread) {
    float distanceToLine = abs(mod(coordinate + 23.5, 48.0) - 24.0);
    float normalized = distanceToLine / spread;
    return exp(-0.5 * normalized * normalized) * (0.39894228 / spread);
}

vec3 transmittedBackdrop(vec2 point, float spread, float localDenied) {
    vec3 paper = mix(vec3(231.0, 229.0, 225.0), vec3(11.0, 11.0, 12.0), localDenied) / 255.0;
    vec3 ink = mix(vec3(17.0, 18.0, 20.0), vec3(242.0, 240.0, 235.0), localDenied) / 255.0;
    vec2 viewport = uGridOrigin + vec2(point.x, -point.y);
    float lineX = blurredGridLine(viewport.x, spread);
    float lineY = blurredGridLine(viewport.y, spread);
    return mix(paper, ink, 0.045 * (lineX + lineY - lineX * lineY));
}

vec3 neutralGrade(vec3 color) {
    const float startCompression = 0.76;
    float x = min(color.r, min(color.g, color.b));
    color -= x < 0.08 ? x - 6.25 * x * x : 0.04;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) return color;
    float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    color *= newPeak / peak;
    float gray = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), gray);
}

float keyVisibility(float incidence) {
    vec3 coord = vLightSpace.xyz * 0.5 + 0.5;
    if (any(lessThan(coord, vec3(0))) || any(greaterThan(coord, vec3(1)))) return 1.0;
    float texel = 1.0 / float(textureSize(uShadow, 0).x);
    float bias = mix(0.0032, 0.0008, incidence);
    float visible = 0.0;
    for (int y = -1; y <= 1; ++y) {
        for (int x = -1; x <= 1; ++x) {
            visible += texture(uShadow, vec3(coord.xy + vec2(x, y) * texel, coord.z - bias));
        }
    }
    return mix(0.36, 1.0, visible / 9.0);
}

vec3 directional(vec3 n, vec3 v, vec3 l, vec3 light, vec3 body, float roughness) {
    float nl = max(dot(n, l), 0.0);
    float nv = max(dot(n, v), 0.001);
    vec3 h = normalize(l + v);
    float nh = max(dot(n, h), 0.0);
    float vh = max(dot(v, h), 0.0);
    float a = roughness * roughness;
    float a2 = a * a;
    float den = nh * nh * (a2 - 1.0) + 1.0;
    float distribution = a2 / (3.14159265 * den * den);
    float k = (roughness + 1.0) * (roughness + 1.0) * 0.125;
    float geometry = (nl / mix(nl, 1.0, k)) * (nv / mix(nv, 1.0, k));
    float fresnel = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
    return light * nl * (body * (0.96 / 3.14159265) +
        vec3(distribution * geometry * fresnel / max(4.0 * nl * nv, 0.001)));
}

void main() {
    vec2 rc = max(abs(vLocal.yz) - vec2(0.5 - uCorner), 0.0);
    if (length(rc) > uCorner) discard;
    if (uShadowPass) {
        outColor = vec4(0.0);
        return;
    }
    vec2 rq = abs(vLocal.yz) * 2.0;
    float rm = max(rq.x, rq.y);
    float onFace = step(0.49, abs(vLocal.x));
    float bevel = smoothstep(0.86, 1.0, rm);
    float rim = onFace * smoothstep(0.90, 0.94, rm) * (1.0 - smoothstep(0.97, 0.995, rm));

    vec3 smoke = rl_toLinear(vec3(0.13, 0.17, 0.18));
    vec2 grainUv = vLocal.yz * 84.0;
    vec2 cell = floor(grainUv);
    float grainWeight = 1.0 - smoothstep(0.6, 1.7, max(fwidth(grainUv.x), fwidth(grainUv.y)));
    float grain = (rl_hash11(dot(cell, vec2(0.103, 0.137)) + vSeed * 53.0) - 0.5) * grainWeight;
    float cutEdge = max(1.0 - onFace, bevel * 0.72);
    if (uDnaError) {
        vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        float lit = max(dot(n, normalize(keyDirection)), 0.0);
        vec3 graphite = vec3(0.075, 0.081, 0.090) +
            vec3(0.11 * lit + 0.018 * cutEdge + 0.012 * grain);
        // 上链 A = 买断（荧光绿高光），下链 B = 抽卡（信号橙高光）
        float sideB = step(0.5, vFinHover);   // flat varying 走 materialMix 通道：0=A 链，1=B 链
        float share = mix(uDnaShareA, uDnaShareB, sideB);
        vec3 accent = mix(vec3(0.18, 0.91, 0.42), vec3(1.0, 123.0 / 255.0, 0.0), sideB);
        const vec3 axis = vec3(${DNA_AXIS[0]}, ${DNA_AXIS[1]}, 0.0);
        float radial = length(vWorld - axis * dot(vWorld, axis));
        float signal = step(1.5, vDnaBridge) * (1.0 - step(${DNA.radius * 0.94}, radial));
        vec3 color = mix(graphite, accent * (0.62 + 0.5 * share), signal);
        // 占比越高，该链的边缘发光沿叶片伸得越长
        float along = clamp(abs(vLocal.z) * 2.0, 0.0, 1.0);
        float reach = mix(0.12, 1.0, share);
        color += accent * 0.22 * smoothstep(1.0 - reach, 1.0, along) * (0.6 + 0.4 * cutEdge);
        float selectDelta = abs(fract(vParam - uSelect + 0.5) - 0.5);
        float focusDelta = abs(fract(vParam - uFocus + 0.5) - 0.5);
        float selectMask = uSelectMix * exp(-selectDelta * selectDelta * 9000.0);
        color += vec3(0.14 * selectMask * (1.0 - signal));
        color += vec3(0.18 * rim * (1.0 - signal)) * clamp(vPulse +
            uFocusMix * exp(-focusDelta * focusDelta * 900.0) + uRingPulse, 0.0, 1.0);
        outColor = vec4(color, 1.0);
        return;
    }
    float localDenied = max(rl_materialMix(vWorld, vErrorFin), clamp(uDnaHold, 0.0, 1.0));
    vec3 body = mix(rl_toLinear(vec3(0.855, 0.795, 0.725)), smoke, localDenied)
        * (0.96 + vSeed * 0.07 + grain * 0.075);

    vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 v = normalize(uCamera - vWorld);
    vec3 key = normalize(keyDirection);
    vec3 fill = normalize(vec3(0.853, 0.174, -0.4925));
    float roughness = mix(mix(0.62, 0.36, bevel), mix(0.78, 0.5, bevel), localDenied);

    float visibility = keyVisibility(max(dot(n, key), 0.0));
    vec3 radiance = directional(n, v, key, rl_toLinear(vec3(1.0, 0.965, 0.918)) * 3.4,
        body, roughness) * mix(0.66, 1.0, visibility);
    radiance += directional(n, v, fill, rl_toLinear(vec3(0.875, 0.91, 1.0)) * 0.55,
        body, roughness);
    float environment = 0.8 * (1.0 - localDenied * 0.72);
    vec3 studio = mix(vec3(0.26, 0.28, 0.31), vec3(0.53, 0.49, 0.43), n.y * 0.5 + 0.5);
    float reflected = smoothstep(-0.12, 0.98, reflect(-v, n).y);
    float facing = clamp(dot(n, v), 0.0, 1.0);
    float grazing = pow(1.0 - facing, 3.0);
    vec3 orange = rl_toLinear(vec3(1.0, 0.482, 0.0));
    float breath = 0.5 + 0.5 * sin(vParam * 6.2831853 - uTime * 1.55);

    // 莱茵浑天仪：暗态哑光碳黑 + 极细冷白边光 + 内环信号橙 (#ff7b00) 指示弧段
    vec4 turbineOut = vec4(0.0);
    if (uTurbineBlend > 0.001) {
        float edge = max(cutEdge, 0.36 * grazing);
        float light = max(dot(n, key), 0.0) * visibility;
        // 哑光碳黑陶瓷底色 + 细腻建筑漫反射
        vec3 ceramic = mix(vec3(0.050, 0.054, 0.062), vec3(0.23, 0.245, 0.27), light);
        vec3 tColor = mix(ceramic, vec3(0.60, 0.62, 0.65), 0.36 * edge * (0.45 + 0.55 * visibility));
        tColor += vec3(grain * 0.018);
        const float ringSplit = ${outerCount / finCount};
        float isInner = step(ringSplit, vParam);
        float ringParam = vParam < ringSplit ? vParam / ringSplit : (vParam - ringSplit) / (1.0 - ringSplit);
        // 极细 1px 冷白精密边光
        float lineW = max(0.008, fwidth(rm) * 1.65);
        float perimeter = 1.0 - smoothstep(lineW * 0.35, lineW, 1.0 - rm);
        perimeter *= 1.0 - smoothstep(0.02, 0.065, 1.0 - 2.0 * abs(vLocal.x));
        float hoverMix = clamp(vFinHover, 0.0, 1.0);
        // 外环：冷白子午线扫光；内环：纤细克制的 1px 信号橙 (#ff7b00) 边缘校准游标
        float outerSweep = fract(ringParam - uTime * 0.024);
        float outerMeridian = smoothstep(0.0, 0.08, outerSweep) * (1.0 - smoothstep(0.14, 0.28, outerSweep));
        float innerSweep = fract(ringParam - uTime * 0.075);
        float orangeArc = smoothstep(0.0, 0.015, innerSweep) * (1.0 - smoothstep(0.055, 0.09, innerSweep));
        vec3 coldWhite = vec3(0.90, 0.90, 0.88);
        vec3 signalOrange = vec3(1.0, 123.0 / 255.0, 0.0);
        // 常态冷白边缘高光
        tColor = mix(tColor, coldWhite, perimeter * mix(0.28 + 0.38 * outerMeridian, 0.26, isInner));
        // 内环仅在 1px 边缘亮起纤细的信号橙游标（不再给整块面染色，避免像卡住的选中态）
        tColor = mix(tColor, signalOrange, isInner * orangeArc * perimeter * 0.92);
        // 悬停/聚焦游戏扇区时整段亮起信号橙
        tColor = mix(tColor, signalOrange, perimeter * hoverMix * 1.35);
        // 实心实体遮挡（tOpacity = 1.0，配合硬件 Z-Buffer 杜绝 X 光穿模）
        // 背向镜头的远半圈按 Z 深度向深黑底色 (#0b0b0c) 雾化压暗，拉开立体景深
        float behind = 1.0 - smoothstep(-0.22, 0.18, dot(normalize(vWorld), normalize(uCamera)));
        vec3 fogCol = vec3(0.043, 0.043, 0.047);
        tColor = mix(tColor, fogCol, 0.68 * behind);
        turbineOut = vec4(tColor, 1.0);
    }
    if (uTurbineBlend >= 0.999) {
        outColor = turbineOut;
        return;
    }

    float backlight = pow(max(dot(-n, key), 0.0), 0.65);
    float broadReflection = mix(0.15, 0.08, localDenied) * reflected;
    radiance += environment * (body * studio + vec3(broadReflection + 0.025));
    radiance += body * backlight * (0.14 * localDenied) * (1.0 - 0.55 * cutEdge);
    radiance += rl_toLinear(vec3(0.95, 0.93, 0.89)) *
        (0.020 * grazing + cutEdge * (0.018 + 0.075 * reflected));
    vec3 emerald = rl_toLinear(vec3(0.0, 0.73, 0.35));
    vec3 signal = mix(emerald, orange, localDenied);
    float scan = smoothstep(0.55, 1.0, sin(vParam * 6.2831853 * 3.0 - uTime * 2.4));
    radiance *= 1.0 - 0.78 * rim * clamp(vPulse, 0.0, 1.0) * (1.0 - localDenied);
    radiance += rim * orange * (0.25 + 1.6 * scan) * localDenied;
    radiance += vPulse * rim * signal * mix(1.1, 1.4, localDenied);
    float focusDelta = abs(vParam - uFocus);
    focusDelta = min(focusDelta, 1.0 - focusDelta);
    radiance += uFocusMix * exp(-focusDelta * focusDelta * 900.0) * rim * signal * 1.35;
    radiance += vDeform * rim * signal * ${DEFORM.light};
    float ringGlow = uRingPulse * (0.30 + rim * 1.30);
    radiance += ringGlow * signal * 1.8;

    float selectDelta = abs(vParam - uSelect);
    selectDelta = min(selectDelta, 1.0 - selectDelta);
    float selectBand = exp(-selectDelta * selectDelta * 9000.0);
    float selectMask = clamp(uSelectMix * selectBand, 0.0, 1.0);
    vec3 selectGreen = rl_toLinear(vec3(0.56, 0.95, 0.16));
    radiance = mix(radiance, selectGreen * 0.86, selectMask);
    radiance += uVerify * rim * orange * 0.8 * step(0.55, fract(vParam * 18.0 - uTime * 1.2));
    radiance += vTip * rim * vec3(1.0, 0.92, 0.8) * 1.4;

    radiance = neutralGrade(radiance * 1.66);
    radiance = mix(vec3(dot(radiance, vec3(0.2126, 0.7152, 0.0722))), radiance, 0.7);
    float depth = dot(vWorld, normalize(uCamera));
    float distanceFade = 1.0 - smoothstep(-90.0, 40.0, depth);
    vec2 screen = (gl_FragCoord.xy / uFramePixels - 0.5) * uCssPixels;
    float refraction = 2.0 + 2.0 * distanceFade;
    vec2 displacement = n.xy * refraction + vec2(grain, -grain) * 1.1;
    float spread = mix(4.1, 1.65, cutEdge) + 0.95 * distanceFade;
    vec3 behindGlass = transmittedBackdrop(screen + displacement, spread, localDenied);
    float density = 0.70 - 0.09 * distanceFade + 0.10 * grazing;
    density = mix(density, 0.88, cutEdge * 0.82);
    density = min(0.98, density + rim * (0.27 * vPulse + 0.18 * localDenied * scan));
    vec3 surface = displayColor(radiance);
    vec4 baseOut;
    if (uLayered) {
        float frontLight = max(dot(n, key), 0.0);
        float softLight = clamp(0.74 * backlight + 0.42 * frontLight + 0.1 * reflected, 0.0, 1.0);
        float polishedEdge = max(cutEdge, 0.48 * grazing);
        vec3 core = mix(vec3(0.612, 0.532, 0.458), vec3(1.0, 0.975, 0.928), softLight);
        vec3 warmPlate = mix(core, vec3(1.0, 0.978, 0.925), polishedEdge * 0.58);
        warmPlate += vec3(grain * 0.032 + (vSeed - 0.5) * 0.019);
        warmPlate = mix(warmPlate, vec3(0.31, 0.88, 0.57), min(1.0, vPulse * (0.35 + rim * 0.9)) * 0.85);
        warmPlate = mix(warmPlate, vec3(1.0, 0.97, 0.88), min(1.0, rim * vTip));
        warmPlate = mix(warmPlate, selectGreen * 0.86, selectMask);
        warmPlate = mix(warmPlate, mix(warmPlate, vec3(0.31, 0.88, 0.57), 0.55), clamp(uRingPulse, 0.0, 1.0));
        float breathGlow = pow(breath, 6.0) * 0.55 * (1.0 - localDenied);
        float opacity = mix(0.52 + 0.30 * facing, 0.88, polishedEdge);
        opacity = mix(opacity, 1.0, selectMask);
        opacity = max(opacity, min(0.96, rim * (0.65 * vPulse + 0.58 * vTip)));
        opacity = mix(opacity, 1.0, smoothstep(0.06, 0.98, localDenied));
        warmPlate = mix(warmPlate, vec3(0.31, 0.88, 0.57), clamp(rim * breathGlow, 0.0, 0.85));
        vec3 color = mix(warmPlate, mix(behindGlass, surface, density), localDenied);
        baseOut = vec4(color * opacity, opacity);
    } else {
        baseOut = vec4(mix(surface, mix(behindGlass, surface, density), localDenied), 1.0);
    }
    // 账本页（DNA 双螺旋）：按链分色 —— 上链买断=荧光绿、下链抽卡=信号橙；
    // 该链消费占比越高，边缘发光沿叶片伸得越长、亮度越高
    if (uDnaHold > 0.5) {
        float sideB = step(0.5, mod(vFinHover, 2.0));
        float focusMix = step(1.5, vFinHover);
        float share = mix(uDnaShareA, uDnaShareB, sideB);
        vec3 accent = mix(vec3(0.18, 0.91, 0.42), vec3(1.0, 123.0 / 255.0, 0.0), sideB);
        float along = clamp(abs(vLocal.z) * 2.0, 0.0, 1.0);
        float reach = mix(0.35, 1.0, share);
        float glow = smoothstep(1.0 - reach, 1.0, along) * (0.30 + 0.70 * rim);
        float slice = step(0.5, vDnaBridge);
        // 买断链（单机）呼吸绿光：口径与时长页抽卡链的橙色边光一致
        // （边光本身就是亮线，只做 0.72~1.00 的呼吸调制，周期约 4 秒）
        float breathA = 0.5 + 0.5 * sin(uTime * 1.5707963);
        float greenBreath = (1.0 - sideB) * rim * (0.72 + 0.28 * breathA);
        baseOut.rgb = mix(baseOut.rgb, vec3(0.18, 0.91, 0.42), clamp(greenBreath, 0.0, 0.94));
        // 点选游戏后，对应横档亮绿/橙
        float amount = focusMix * clamp(0.55 + 0.45 * glow, 0.0, 1.0) * (0.75 + 0.35 * share);
        baseOut.rgb = mix(baseOut.rgb, accent, clamp(amount, 0.0, 0.96));
    }
    outColor = mix(baseOut, turbineOut, uTurbineBlend);
}`;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  const box = makeFoldedFin(0.0);
  let shadowMap;
  let shadowFramebuffer;
  let orderBuffer, meshVAO, sceneProgram, frozen, morphBuffer;
  const sortedFins = Array.from({ length: finCount }, (_, index) => ({ index, depth: 0 }));
  const orderData = new Float32Array(finCount);

  function setup() {
    const program = gl.createProgram();
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.transformFeedbackVaryings(program,
      ['tfCenterId', 'tfOrientation', 'tfSizeMaterial', 'tfClip'], gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    sceneProgram = program;
    gl.useProgram(program);
    menuBuffer = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, menuBuffer);
    gl.bufferData(gl.UNIFORM_BUFFER, menuFins, gl.DYNAMIC_DRAW);
    gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program, 'MenuFins'), 0);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, menuBuffer);
    morphBuffer = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, morphBuffer);
    gl.bufferData(gl.UNIFORM_BUFFER, finCount * 12 * 4, gl.DYNAMIC_DRAW);
    gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program, 'MorphFins'), 1);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, morphBuffer);
    meshVAO = gl.createVertexArray();
    gl.bindVertexArray(meshVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, box, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    orderBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, orderBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, orderData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 4, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);

    shadowMap = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shadowMap);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, shadowSize, shadowSize);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    shadowFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowMap, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) throw new Error('Could not initialize the shadow map');

    const names = ['uCamera', 'uCameraShift', 'uAngles', 'uFrameAspect', 'uFramePixels', 'uCssPixels', 'uGridOrigin', 'uTime', 'uDenied', 'uDeniedSweep', 'uVerify', 'uDisorder',
      'uAlign', 'uDissolve', 'uBootPose', 'uAssemble', 'uSpin', 'uFlow', 'uPulseT[0]', 'uPulseO[0]',
      'uFocus', 'uFocusMix', 'uDeform', 'uDeformMix', 'uSelect', 'uSelectMix', 'uRingPulse', 'uDnaError', 'uDnaBend',
      'uPosePath', 'uMorphPose', 'uFocal', 'uTurbineBlend', 'uDnaHold', 'uDnaShareA', 'uDnaShareB', 'uLayered', 'uErrorFins', 'uStaticPulse', 'uShadowPass', 'uShadow', 'uMenuDepth', 'uMenuFinHeight'];
    return Object.fromEntries(names.map(name => [name, gl.getUniformLocation(program, name)]));
  }

  let uniforms;
  function initialize() {
    try {
      uniforms = setup();
      if (!canvas.isConnected) slot.append(canvas);
    } catch (error) {
      window.__motifError = String((error && error.message) || error);
      console.warn('Rhine 3D:', error);
      return false;
    }
    return true;
  }

  const svgLayers = ['mobiusRingGhost', 'mobiusRingMain', 'mobiusOrbitTrack']
    .map(id => svgFallback?.querySelector('#' + id))
    .filter(Boolean);
  const previousVisibility = svgLayers.map(layer => layer.style.visibility);
  function showModel(ready) {
    canvas.style.visibility = ready ? 'visible' : 'hidden';
    svgLayers.forEach((layer, index) => {
      layer.style.visibility = ready ? 'hidden' : previousVisibility[index];
    });
    slot.dataset.rhine3d = ready ? 'ready' : 'fallback';
  }

  if (!initialize()) return;
  let frame = 0;
  let previousTime = 0;
  let lastPointer = -Infinity;
  let pointerX = 0;
  let pointerY = 0;
  let parallaxX = 0;
  let parallaxY = 0;
  let resized = true;
  let deniedOverride = null;
  let deniedSweep = 1;
  let deniedTween = null;
  let trembleMotion = null;
  let styleState = '';
  let lost = false;
  let visible = true;
  let phase = boot ? 0 : 1.35;
  let dissolveSmooth = 0;
  let flow = 0;
  let spin = 0;
  let disorder = 0;
  let dolly = 0;
  const pulseTimes = new Float32Array(16).fill(-99);
  const pulseOrigins = new Float32Array(16).fill(0.25);
  let focusParam = 0.25;
  let focusMix = 0;
  let focusTargetMix = 0;
  let selectParam = 0;
  let selectMix = 0;
  let selectTargetMix = 0;
  let ringPulse = 0;
  let pulseSlot = 0;
  let deformParam = 0, deformMix = 0;
  let staticPulse = 0;
  let staticPulseTimeout;

  function requestDraw() {
    if (!frozen && !frame && !lost && visible && !document.hidden) frame = requestAnimationFrame(draw);
  }

  function amount(source) {
    const value = Number(source);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }

  function readDenied() {
    return amount(slot.dataset.denied ?? getComputedStyle(slot).getPropertyValue('--denied'));
  }

  function tremble({ duration = 420, amplitude = 6, cycles = 3 } = {}) {
    if (motionPreference.matches || duration <= 0) return;
    trembleMotion = { duration, amplitude, cycles, start: performance.now() };
    requestDraw();
  }

  function setDenied(target, { duration = 0, sweep = 0, delay = 0, hold = 0, release = 0, start = performance.now() } = {}) {
    if (target === null) {
      deniedOverride = deniedTween = null;
      deniedSweep = 1;
    } else if ((motionPreference.matches && !release) || !Math.max(duration, sweep, delay, hold, release)) {
      deniedOverride = amount(target);
      deniedTween = null;
      deniedSweep = 1;
    } else {
      deniedTween = {
        from: deniedOverride, target: amount(target), duration, sweep, start: start + delay,
        sweepFrom: deniedTween ? deniedSweep : null,
        hold, release, restore: deniedTween?.release ? deniedTween.restore : deniedOverride,
      };
    }
    requestDraw();
  }

  function updateDenied(time) {
    if (!deniedTween || time < deniedTween.start) return;
    deniedTween.from ??= readDenied();
    const { from, target, duration, sweep, start, sweepFrom, hold, release, restore } = deniedTween;
    if (target === from && sweepFrom === null && !release) {
      deniedOverride = target;
      deniedSweep = 1;
      deniedTween = null;
      return;
    }
    const elapsed = time - start;
    const progress = duration ? amount(elapsed / duration) : 1;
    deniedOverride = from + (target - from) * progress;
    const end = Number(target > from);
    const initialSweep = sweepFrom ?? (1 - end);
    deniedSweep = sweep ? initialSweep + (end - initialSweep) * amount(elapsed / sweep) : 1;
    const releaseStart = Math.max(duration, sweep) + hold;
    if (release && elapsed >= releaseStart) {
      const recovery = amount((elapsed - releaseStart) / release);
      deniedOverride = target + ((restore ?? readDenied()) - target) * recovery;
      if (recovery === 1) {
        deniedOverride = restore;
        deniedTween = null;
      }
    } else if (!release && elapsed >= releaseStart) {
      deniedTween = null;
      deniedSweep = 1;
    }
  }

  function renderScene(shadows) {
    gl.uniform1i(uniforms.uShadowPass, Number(shadows));
    gl.drawArraysInstanced(gl.TRIANGLES, 0, box.length / 6, finCount);
  }

  function setMenuFrame(param, boundParams, rect) {
    menuTargets.clear();
    if (param != null) {
      menuRect = rect;
      const index = Math.round(param * finCount) % finCount;
      const quarter = finCount / 4;
      const isLeftLobe = fin => fin >= quarter && fin < 3 * quarter;
      const bound = new Set(boundParams.map(value => Math.round(value * finCount) % finCount));
      const leftLobe = isLeftLobe(index);
      const side = leftLobe ? -1 : 1;
      const segment = [0];
      for (let distance = 1; distance < quarter && segment.length < menuRows; distance++) {
        for (const offset of [-distance, distance]) {
          const fin = (index + offset + finCount) % finCount;
          if (isLeftLobe(fin) === leftLobe && !bound.has(fin)) segment.push(offset);
          if (segment.length === menuRows) break;
        }
      }
      const nearRows = Math.ceil(segment.length / 2);
      segment.sort((a, b) => a - b).forEach((offset, row) => {
        const fin = (index + offset + finCount) % finCount;
        const near = row < nearRows;
        const edgeRow = near ? row : row - nearRows;
        const edgeRows = near ? nearRows : segment.length - nearRows;
        const rowOffset = edgeRow - (edgeRows - 1) / 2;
        menuTargets.set(fin, { side: near ? side : -side, rowOffset });
      });
      for (const fin of menuTargets.keys()) movingMenuFins.add(fin);
    }
    requestDraw();
  }

  function updateMenuFins(bounds, camera, dt, reduce) {
    if (!movingMenuFins.size) return;
    const { left, top, width, height } = menuRect;
    const pitch = Math.min(50, height / (menuRows + 1));
    const finWidth = Math.min(56, Math.max(12, (bounds.width - width) / 2 - 22));
    const step = reduce ? 1 : 1 - Math.exp(-7 * dt);
    const ease = (from, to) => Math.abs(from - to) < 0.002 ? to : from + (to - from) * step;
    let changed = false;
    for (const index of movingMenuFins) {
      const i = index * 4;
      const target = menuTargets.get(index);
      const mix = menuFins[i + 2];
      if (target) {
        const { side, rowOffset } = target;
        const x = left + width / 2 + side * (width / 2 + 8 + finWidth / 2) - bounds.left;
        const y = top + height / 2 + rowOffset * pitch - bounds.top;
        const nextX = Math.fround(mix ? ease(menuFins[i], x) : x);
        const nextY = Math.fround(mix ? ease(menuFins[i + 1], y) : y);
        const signedWidth = Math.fround(side * finWidth);
        changed ||= nextX !== menuFins[i] || nextY !== menuFins[i + 1] || signedWidth !== menuFins[i + 3];
        menuFins[i] = nextX;
        menuFins[i + 1] = nextY;
        menuFins[i + 3] = signedWidth;
      }
      menuFins[i + 2] = ease(mix, target ? 1 : 0);
      changed ||= menuFins[i + 2] !== mix;
      if (!target && !menuFins[i + 2]) movingMenuFins.delete(index);
    }
    lastMenuDepth = Math.hypot(...camera) - 145;
    gl.uniform1f(uniforms.uMenuDepth, lastMenuDepth);
    gl.uniform1f(uniforms.uMenuFinHeight, pitch * 0.58);
    if (changed) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, menuBuffer);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, menuFins);
    }
  }

  function sortFins(currentFlow, camera, angles, helixWeight, gather) {
    const [cx, cy, cz] = angles.map(Math.cos);
    const [sx, sy, sz] = angles.map(Math.sin);
    const [cameraX, cameraY, cameraZ] = camera;
    const distance = Math.hypot(cameraX, cameraY, cameraZ);
    const menuDepth = distance * (distance - lastMenuDepth);
    for (const fin of sortedFins) {
      if (frozen && frozen.final) {
        fin.depth = dot3(camera, frozen.final[fin.index].center);
        continue;
      }
      const t = ((fin.index + currentFlow) / finCount) * 2 * Math.PI;
      const sin = Math.sin(t);
      const cos = Math.cos(t);
      const [x, y, z] = helixWeight > 0 ? curvePointJS(t)
        : [radius * cos, radius * curveAspect * sin * cos, curveDepth * sin];
      const rolledX = cz * x - sz * y;
      const rolledY = sz * x + cz * y;
      const pitchedY = cx * rolledY - sx * z;
      const pitchedZ = sx * rolledY + cx * z;
      fin.depth = cameraX * (cy * rolledX + sy * pitchedZ) + cameraY * pitchedY
        + cameraZ * (cy * pitchedZ - sy * rolledX);
      if (helixWeight > 0) {
        const pair = (fin.index + finCount / 4) % (finCount / 2);
        const height = Math.floor(pair / 2) / (finCount / 4 - 1);
        const angle = height * (2 * Math.PI * bootHelix.turns) + (pair % 2) * Math.PI;
        const helixDepth = distance * (Math.sin(angle) * bootHelix.radius
          + (1 - gather) * Math.sin(pair * 1.29) * bootHelix.scatter[2]);
        fin.depth += (helixDepth - fin.depth) * helixWeight;
      }
      const mix = menuFins[fin.index * 4 + 2];
      if (mix) fin.depth += (menuDepth - fin.depth) * mix;
    }
    sortedFins.sort((left, right) => left.depth - right.depth || left.index - right.index);
    if (entryParams.length && helixWeight === 0 && currentForm() === 'mobius') {
      const first = sortedFins.findIndex(fin => fin.index === firstEntryFin);
      const second = sortedFins.findIndex(fin => fin.index === secondEntryFin);
      if (first < second && sortedFins[second].depth - sortedFins[first].depth < 40 * distance) {
        [sortedFins[first], sortedFins[second]] = [sortedFins[second], sortedFins[first]];
      }
    }
    sortedFins.forEach((fin, index) => { orderData[index] = fin.index; });
    gl.bindBuffer(gl.ARRAY_BUFFER, orderBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, orderData);
  }

  function paintFrame(currentFlow, camera, angles, helixWeight, gather, layered) {
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFramebuffer);
    gl.uniform1i(uniforms.uLayered, 0);
    gl.viewport(0, 0, shadowSize, shadowSize);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    renderScene(true);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, shadowMap);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (layered) {
      sortFins(currentFlow, camera, angles, helixWeight, gather);
      gl.uniform1i(uniforms.uLayered, 1);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      renderScene(false);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.DEPTH_TEST);
    } else {
      renderScene(false);
    }
  }

  const referencePoints = [
    ['center', [0, 0, 0]],
    ['faceA', [0.5, -0.35, -0.35]],
    ['faceB', [0.5, -0.10, 0.35]],
    ['faceC', [0.5, -0.35, 0.35]],
  ];

  const turbinePoints = [
    ...referencePoints,
    ...[-0.5, 0.5].flatMap(x => [-0.5, 0.5].flatMap(y =>
      [-0.5, 0.5].map(z => ['corner', [x, y, z]]))),
  ];
  const colorProbePoints = () => currentForm() === 'turbine' ? turbinePoints : referencePoints;

  function captureProbes({ shadow = false, compare = true, probes = referencePoints } = {}) {
    const vao = gl.createVertexArray();
    const points = gl.createBuffer();
    const feedback = gl.createTransformFeedback();
    const output = gl.createBuffer();
    const count = probes.length;
    const stride = 16;
    const oldData = new Float32Array(finCount * count * stride);
    const newData = new Float32Array(oldData.length);
    const layered = gl.getUniform(sceneProgram, uniforms.uLayered);
    const posePathBefore = gl.getUniform(sceneProgram, uniforms.uPosePath);
    try {
      if (shadow) {
        gl.uniform1i(uniforms.uLayered, 0);
        gl.uniform1i(uniforms.uShadowPass, 1);
      }
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, points);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(probes.flatMap(([, point]) => point)), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, orderBuffer);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(2, 1);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
      gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, newData.byteLength, gl.STREAM_READ);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
      gl.enable(gl.RASTERIZER_DISCARD);
      for (const [posePath, data] of compare ? [[false, oldData], [true, newData]] : [[true, newData]]) {
        gl.uniform1i(uniforms.uPosePath, Number(posePath));
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArraysInstanced(gl.POINTS, 0, count, finCount);
        gl.endTransformFeedback();
        gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, data);
      }
    } finally {
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.uniform1i(uniforms.uPosePath, Number(posePathBefore));
      gl.uniform1i(uniforms.uLayered, Number(layered));
      gl.uniform1i(uniforms.uShadowPass, 0);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
      gl.bindVertexArray(meshVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, orderBuffer);
      gl.deleteTransformFeedback(feedback);
      gl.deleteBuffer(output);
      gl.deleteBuffer(points);
      gl.deleteVertexArray(vao);
    }
    return { oldData, newData, stride };
  }

  function readFrozenFrame(rect, previousRecords) {
    const probes = colorProbePoints();
    const { oldData, newData, stride } = captureProbes({ probes });
    const count = probes.length;
    const records = new Array(finCount);
    const projection = [];
    const order = [];
    const css = (data, offset) => {
      const [x, y, , w] = data.subarray(offset + 12, offset + 16);
      return [(1 + x / w) * rect.width / 2, (1 - y / w) * rect.height / 2];
    };
    for (let drawIndex = 0; drawIndex < finCount; drawIndex++) {
      const offset = drawIndex * count * stride;
      const id = newData[offset + 3];
      if (!identities[id] || records[id]) throw new Error('Invalid physical ID in transform feedback');
      order.push(id);
      records[id] = {
        id, ...forms[currentForm()][id],
        center: Array.from(newData.subarray(offset, offset + 3)),
        orientation: Array.from(newData.subarray(offset + 4, offset + 8)),
        size: Array.from(newData.subarray(offset + 8, offset + 11)),
        materialMix: newData[offset + 11],
      };
      for (let point = 0; point < count; point++) {
        const start = offset + point * stride;
        if (oldData[start + 3] !== id || newData[start + 3] !== id) {
          throw new Error('Probe paths disagree on physical ID');
        }
        const oldCss = css(oldData, start), newCss = css(newData, start);
        const distance = Math.hypot(oldCss[0] - newCss[0], oldCss[1] - newCss[1]);
        if (!Number.isFinite(distance)) throw new Error('Non-finite projection for ID ' + id);
        projection.push({ id, point: probes[point][0], oldCss, newCss, distance });
      }
    }
    let previous = previousRecords?.[0].orientation;
    for (const record of records) {
      const q = record.orientation;
      const dot = previous && q.reduce((sum, value, index) => sum + value * previous[index], 0);
      if (dot < 0) record.orientation = q.map(value => -value);
      previous = record.orientation;
    }
    return { records, order, projection };
  }

  /* ======================================================================
   * 三大标准终态几何生成器（240 固定物理 ID 映射）
   *   1. Mobius 莫比乌斯 ∞（frozen.base）
   *   2. Turbine 双层同心反向涡轮（turbineRecords）
   *   3. DNA 双螺旋 + 横向碱基桥接（dnaTargetRecords）
   * ====================================================================== */
  const morphDuration = 1700;
  const morphFrameMs = 1000 / 60;
  const mixNumber = (a, b, t) => a + (b - a) * t;
  const segment = (p, a, b) => Math.max(0, Math.min(1, (p - a) / (b - a)));
  const smoothstep01 = t => t * t * (3 - 2 * t);

  // 标准 DNA 双螺旋终态（240 片独立分布于双链骨架与横档桥接）
  function dnaTargetRecords(spinPhase = 0) {
    const { radius, length, sweep, rungCount } = DNA;
    const strandIntervals = rungCount * 3 - 1;
    const sliceLength = 0.95 * DNA_STRAND_SPEED / strandIntervals;
    const halfGap = radius * 0.04;
    const bridgeLength = radius - halfGap - 4;
    const [c, s] = DNA_AXIS;

    return forms.dna.map(({ role, slot }, id) => {
      const bridge = role === 'bridge';
      const t = (bridge ? slot.group * 3 + 1 : slot) / strandIntervals;
      const side = bridge ? slot.side : role;
      const phase = (t - 0.5) * sweep + spinPhase + (side === 'B' ? Math.PI : 0);
      const radial = [s * Math.sin(phase), -c * Math.sin(phase), Math.cos(phase)];
      const angular = cross3(DNA_AXIS, radial);
      const tangent = angular.map((value, i) =>
        (radius * sweep * value - length * DNA_AXIS[i]) / DNA_STRAND_SPEED);
      // The mesh uses local X for thickness, Y for width and Z for length.
      const orientation = bridge
        ? quatFromAxes(angular, DNA_AXIS, radial)
        : quatFromAxes(radial, cross3(tangent, radial), tangent);
      const sideShare = side === 'A' ? dnaShare.a : dnaShare.b;
      const shareWidth = 0.62 + 0.95 * sideShare;   // 宽度 0.62x ~ 1.57x
      const shareThick = 0.80 + 0.45 * sideShare;
      // 横档按 group 命中；主链片按所属 group（每 3 片一组）一起点亮
      const focusKey = `${side}:${bridge ? slot.group : Math.floor(slot / 3)}`;
      const rungWeight = bridge ? (dnaRungAmount.get(`${side}:${slot.group}`) ?? 0) : 0;
      const rungScale = 0.62 + 1.15 * rungWeight;   // 0.62x ~ 1.77x
      const focused = dnaFocus.on && dnaFocus.keys.has(focusKey);
      const distance = (bridge ? halfGap + bridgeLength / 2 : radius) + (focused ? 6 : 0);
      return {
        id, role, slot,
        center: DNA_AXIS.map((value, i) => Math.fround(length * (0.5 - t) * value + radial[i] * distance)),
        orientation,
        size: bridge
          ? [12 * shareThick * rungScale, 2.2 * shareWidth * rungScale, bridgeLength]
          : [9 * shareThick, 18 * shareWidth, sliceLength],
        materialMix: (side === 'A' ? 0 : 1) + (focused ? 2 : 0),   // 0/1 = 链 A/B；+2 = 选中高光
      };
    });
  }

  // 双层同心反向涡轮终态（外环顺时针、内环逆时针自转，倾角反向交错）
  let turbineHighlight = [0, 0];
  let dnaShare = { a: 0.5, b: 0.5 };
  let dnaFocus = { on: false, keys: new Set() };   // 选中的游戏对应横档（'A:3' 形式）
  let dnaRungAmount = new Map();                    // 'A:3' -> 0..1（该横档对应账单金额的相对大小）

  function turbineSectorBoundary(index, count, sectors) {
    return Math.round(index * count / sectors);
  }

  const defaultTurbineScales = [1.15, 1.075, 1, 0.925, 0.85];

  function turbineFinLengths(role, scales = defaultTurbineScales) {
    const { count, length } = turbineRings[role];
    if (!scales.length) scales = defaultTurbineScales;
    return Float32Array.from({ length: count }, (_, slot) => {
      const sector = scales.findIndex((_, index) =>
        slot < turbineSectorBoundary(index + 1, count, scales.length));
      return length * scales[sector];
    });
  }

  const turbineLengths = {
    outer: turbineFinLengths('outer'),
    inner: turbineFinLengths('inner'),
  };

  function turbineSectorLengths() {
    const readRing = role => {
      const lengths = turbineLengths[role];
      return Array.from({ length: 5 }, (_, sector) => {
        const slot = turbineSectorBoundary(sector, lengths.length, 5);
        return lengths[slot];
      });
    };
    return { outer: readRing('outer'), inner: readRing('inner') };
  }

  function turbineRecords(elapsed = 0, deformHover = false) {
    return forms.turbine.map(({ role, slot }, id) => {
      const ring = turbineRings[role];
      const { count, radius, chord, thick } = ring;
      const phase = (role === 'outer' ? turbineOuterOmega : turbineOmega) * elapsed;
      // 外环多错开半个齿距，视觉上和外环齿槽咬合
      const meshOffset = role === 'outer' ? 0.5 : 0;
      const angle = (slot + 0.5 + meshOffset) * 2 * Math.PI / count - phase;

      // 浑天仪外环锁定主极轴不偏移，内环带 ±4° 极轻章动
      const nutation = role === 'inner' ? Math.sin(elapsed * 0.22) * 4 * degrees : 0;
      const tX = ring.tiltX * degrees, tY = (ring.tiltY ?? 0) * degrees + nutation, tZ = (ring.tiltZ ?? 0) * degrees;
      const rotX = v => [v[0], v[1] * Math.cos(tX) - v[2] * Math.sin(tX), v[1] * Math.sin(tX) + v[2] * Math.cos(tX)];
      const rotY = v => [v[0] * Math.cos(tY) + v[2] * Math.sin(tY), v[1], -v[0] * Math.sin(tY) + v[2] * Math.cos(tY)];
      const pose = v => rotY(rotX(v));
      let r = pose([Math.cos(angle), Math.sin(angle), 0]);
      let t = pose([-Math.sin(angle), Math.cos(angle), 0]);
      let ax = pose([0, 0, 1]);
      const cZ = Math.cos(tZ), sZ = Math.sin(tZ);
      const rotAxis = v => {
        const d = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
        const cr = [ax[1] * v[2] - ax[2] * v[1], ax[2] * v[0] - ax[0] * v[2], ax[0] * v[1] - ax[1] * v[0]];
        return [0, 1, 2].map(i => v[i] * cZ + cr[i] * sZ + ax[i] * d * (1 - cZ));
      };
      r = rotAxis(r); t = rotAxis(t); ax = rotAxis(ax);

      // 圆柱立面环带朝向：W 沿切线（环周密排），H 沿环面法线（直立仪象环带），T 沿径向（实体壁厚）
      // 彻底告别平躺的"铁轨枕木"，呈现真正的浑天仪立面球壳环带
      const hovered = deformHover && id >= turbineHighlight[0] && id < turbineHighlight[1];
      const center = r.map(v => v * (radius + (hovered ? 2.5 : 0)));
      const W = t, H = ax;
      const T = [W[1] * H[2] - W[2] * H[1], W[2] * H[0] - W[0] * H[2], W[0] * H[1] - W[1] * H[0]];
      const orientation = quatFromAxes(T, W, H);
      return {
        id, role, slot,
        center: center.map(Math.fround),
        orientation,
        size: [Math.fround(thick), Math.fround(chord * (hovered ? 1.025 : 1)),
          Math.fround(turbineLengths[role][slot] * (hovered ? 1.05 : 1))],
        materialMix: hovered ? 1 : 0,
      };
    });
  }

  function slerp(a, b, t) {
    const product = a.reduce((sum, value, i) => sum + value * b[i], 0);
    const sign = product < 0 ? -1 : 1;
    const angle = Math.acos(Math.min(1, Math.abs(product)));
    const w = Math.sin(angle);
    const start = w > 1e-6 ? Math.sin((1 - t) * angle) / w : 1 - t;
    const end = w > 1e-6 ? Math.sin(t * angle) / w : t;
    const q = a.map((value, i) => start * value + end * sign * b[i]);
    const norm = Math.hypot(...q);
    return q.map(value => value / norm);
  }

  /* ======================================================================
   * 通用全员独立并发路径插值器（240 片独立解体 -> 空间弧线平移 -> 稳态咬合）
   * ====================================================================== */
  const morphBeats = { moveEnd: 0.56, holdEnd: 0.68 }; // 950ms 位移 + 200ms 停顿咬合 + 550ms 叶片尺寸重塑

  function concurrentMorph(sourceRecords, targetRecords, p, options = {}) {
    if (p <= 0) return sourceRecords;
    if (p >= 1) return targetRecords;

    const stagger = TUNE.stagger ?? 0.22;
    const arc = options.arc ?? (TUNE.arc ?? 0.16);
    const swirl = options.swirl ?? 0.18;
    const shape = segment(p, morphBeats.holdEnd, 1);
    const shapeEase = smoothstep01(shape);

    return targetRecords.map((tgt, id) => {
      const src = sourceRecords[id];
      // 依据物理 ID 分配独立错时相位，全员同时独立起飞无需排队
      const phase = ((id * 0.6180339887) % 1) * 0.45 + (id / finCount) * 0.55;
      const win = Math.max(0.25, 1 - stagger);
      const moveLocal = segment(p, stagger * phase, stagger * phase + morphBeats.moveEnd * win);
      const moveEase = smoothstep01(moveLocal);

      // 线性基底位移 + 空间螺旋弧线偏置，避免穿模与机械直线僵硬感
      const dx = tgt.center[0] - src.center[0];
      const dy = tgt.center[1] - src.center[1];
      const dz = tgt.center[2] - src.center[2];
      const dist = Math.hypot(dx, dy, dz);
      const bow = Math.sin(Math.PI * moveEase);

      const angleOffset = (id / finCount) * Math.PI * 2;
      const perpX = -dy;
      const perpY = dx;
      const perpLen = Math.hypot(perpX, perpY) || 1;
      const radialSign = (id % 2 === 0 ? 1 : -1);

      const cx = mixNumber(src.center[0], tgt.center[0], moveEase)
        + (perpX / perpLen) * dist * arc * 0.38 * bow * radialSign;
      const cy = mixNumber(src.center[1], tgt.center[1], moveEase)
        + (perpY / perpLen) * dist * arc * 0.38 * bow * radialSign
        + Math.sin(angleOffset) * dist * swirl * 0.18 * bow;
      const cz = mixNumber(src.center[2], tgt.center[2], moveEase)
        + Math.cos(angleOffset) * dist * arc * 0.42 * bow;

      return {
        ...src,
        role: tgt.role,
        slot: tgt.slot,
        center: [cx, cy, cz].map(Math.fround),
        orientation: slerp(src.orientation, tgt.orientation, moveEase).map(Math.fround),
        size: src.size.map((v, i) => Math.fround(mixNumber(v, tgt.size[i], shapeEase))),
      };
    });
  }

  // 路由 1：日常莫比乌斯 ∞ → 双层同心反向涡轮（抵达后外顺内逆持续咬合旋转）
  function mobiusToTurbineRecords(p) {
    const spinElapsed = (frozen.turbineElapsed || 0) + smoothstep01(segment(p, morphBeats.holdEnd, 1)) * 0.85;
    const target = turbineRecords(spinElapsed);
    if (p <= 0) return frozen.base;
    if (p >= 1) return target;
    return concurrentMorph(frozen.base, target, p, { arc: TUNE.arc, swirl: 0.22 });
  }

  // 路由 2：双涡轮 → DNA 双螺旋（起飞前涡轮带余速惯性，随后 240 片独立收敛为双螺旋）
  function turbineToDnaRecords(p) {
    if (p >= 1) return dnaTargetRecords(frozen.dnaSpin || 0);
    const idleSpin = (frozen.turbineElapsed || 0) + (1 - smoothstep01(segment(p, 0, 0.35))) * 0.35;
    const source = turbineRecords(idleSpin);
    const target = dnaTargetRecords(frozen.dnaSpin || 0);
    if (p <= 0) return source;
    return concurrentMorph(source, target, p, { arc: (TUNE.arc || 0.16) * 1.15, swirl: 0.28 });
  }

  // 路由 3：DNA 双螺旋 → 日常莫比乌斯 ∞（双螺旋解旋退化，240 片回归无穷大扭转闭环）
  function dnaToMobiusRecords(p) {
    const source = dnaTargetRecords(frozen.dnaSpin || 0);
    const target = frozen.base;
    if (p <= 0) return source;
    if (p >= 1) return target;
    return concurrentMorph(source, target, p, { arc: (TUNE.arc || 0.16) * 1.1, swirl: -0.24 });
  }

  function turbineDiagnostics() {
    const { outer, inner } = turbineRings;
    return {
      outer: forms.turbine.flatMap(({ role }, id) => role === 'outer' ? [id] : []),
      inner: forms.turbine.flatMap(({ role }, id) => role === 'inner' ? [id] : []),
      elapsed: frozen?.turbineElapsed ?? 0,
      outerPhase: turbineOuterOmega * (frozen?.turbineElapsed ?? 0),
      innerPhase: turbineOmega * (frozen?.turbineElapsed ?? 0),
      omegaOuter: turbineOuterOmega, omegaInner: turbineOmega,
      tiltOuter: outer.tilt, tiltInner: inner.tilt,
      radiusOuter: outer.radius, radiusInner: inner.radius,
    };
  }

  function computeTurbineBlend(dest, p) {
    if (frozen?.staticTurbine) return 1.0;
    // 相机先压平（仰角/视场提前到位），风扇再散开，避免过渡中段低仰角把环拉高撑出画框
    if (dest === 'mobius-turbine' || dest === 'turbine') return smoothstep01(segment(p, 0.02, 0.42));
    if (dest === 'turbine-dna') return 1.0 - smoothstep01(segment(p, 0, 0.65));
    return 0.0;
  }

  function dnaBend() {
    const { destination, progress } = frozen;
    if (destination === 'dna-mobius') return 1 - smoothstep01(segment(progress, 0, 0.5));
    return smoothstep01(segment(progress, 0.5, 1));
  }

  function drawMorphFrame() {
    const { flow, view, angles, bootPose, layered, progress, control } = frozen;
    const dest = frozen.destination;
    const turbine = frozen.staticTurbine;

    if (turbine) {
      frozen.final = turbineRecords(frozen.turbineElapsed || 0, true);
    } else if (dest === 'dna') {
      frozen.final = concurrentMorph(frozen.base, dnaTargetRecords(frozen.dnaSpin), progress);
    } else if (dest === 'turbine-dna') {
      frozen.final = turbineToDnaRecords(progress);
    } else if (dest === 'dna-mobius') {
      frozen.final = dnaToMobiusRecords(progress);
    } else {
      frozen.final = mobiusToTurbineRecords(progress);
    }

    if (control && progress > 0) {
      const [a, b] = control;
      frozen.final[b] = { ...frozen.final[b], center: frozen.final[a].center.slice() };
    }

    // ?dnaerr=old 用项目原来的错误态材质；默认用账本专用材质
    const dnaError = currentForm() === 'dna' && DNA_ERROR_MODE !== 0;
    const data = new Float32Array(finCount * 12);
    for (const record of frozen.final) {
      const { role, slot } = forms.dna[record.id];
      // Distribute sixteen signal pairs among the rungs (32 of 240 slices).
      const signalPairs = 16;
      const bridge = role === 'bridge' ? 1 + Number(
        ((slot.group + 1) * signalPairs) % DNA.rungCount < signalPairs
      ) : 0;
      data.set([...record.center, bridge, ...record.orientation, ...record.size, record.materialMix], 12 * record.id);
    }
    gl.bindBuffer(gl.UNIFORM_BUFFER, morphBuffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, data);

    gl.uniform1i(uniforms.uMorphPose, 1);
    gl.uniform1f(uniforms.uTurbineBlend, computeTurbineBlend(dest, progress));
    const now = performance.now();
    const reduce = motionPreference.matches;
    updateDenied(now);
    gl.uniform1i(uniforms.uDnaError, Number(dnaError));
    // 时长页与账本页都是错误态：这两个形态强制走 denied；日常页为 0
    const errorForm = currentForm() === 'turbine' || currentForm() === 'dna';
    gl.uniform1f(uniforms.uDnaHold, errorForm ? 1 : 0);
    gl.uniform1f(uniforms.uDnaBend, dnaError ? dnaBend() : 0);
    gl.uniform1f(uniforms.uDnaShareA, dnaShare.a);
    gl.uniform1f(uniforms.uDnaShareB, dnaShare.b);
    gl.uniform1f(uniforms.uDenied, deniedOverride ?? readDenied());
    gl.uniform1f(uniforms.uDeniedSweep, deniedSweep);
    gl.uniform1f(uniforms.uTime, reduce ? 0 : frozenSceneTime(now));
    gl.uniform1fv(uniforms['uPulseT[0]'], pulseTimes);
    gl.uniform1fv(uniforms['uPulseO[0]'], pulseOrigins);
    gl.uniform1f(uniforms.uStaticPulse, reduce ? staticPulse : 0);
    const pulseAge = now - (frozen.pulseStart ?? -Infinity);
    gl.uniform1f(uniforms.uRingPulse, Math.max(0, 1 - pulseAge / 700) ** 2);
    const turbo = computeTurbineBlend(dest, progress);
    // 涡轮取景：|camera| 不变，仰角 28°→67°、滚转 0→−8°、视场 30°→40°（Gemini 规格）
    const camRadius = Math.hypot(view[0], view[1], view[2]) || 1;
    const elevNow = Math.asin(Math.max(-1, Math.min(1, view[1] / camRadius)));
    const azimuth = Math.atan2(view[0], view[2]);
    const elev = elevNow + ((TUNE.turbineCamElev ?? 67) * degrees - elevNow) * turbo;
    const roll = angles[2] + ((TUNE.turbineRoll ?? -8) * degrees - angles[2]) * turbo;
    const camNow = [
      camRadius * Math.cos(elev) * Math.sin(azimuth),
      camRadius * Math.sin(elev) * (dnaFocus.on ? 0.92 : 1),
      camRadius * Math.cos(elev) * Math.cos(azimuth) * (dnaFocus.on ? 0.92 : 1),
    ];
    gl.uniform3f(uniforms.uCamera, ...camNow);
    // 涡轮包围盒因两环倾斜而上移，按画布高比例下压回视觉中心
    gl.uniform2f(uniforms.uCameraShift, 2 * (frozen.shift?.[0] ?? 0) / frozen.rect.width,
      -2 * (frozen.shift?.[1] ?? 0) / frozen.rect.height - 2 * (TUNE.turbineDrop ?? 0) * turbo);
    gl.uniform3f(uniforms.uAngles, angles[0], angles[1], roll);
    gl.uniform1f(uniforms.uFocal, focal + (focalTurbine - focal) * turbo);
    // 浑天仪态关闭无深度测试的 layered 混合，启用真实硬件 Z-Buffer 实体遮挡
    paintFrame(flow, camNow, angles, bootPose[1], bootPose[0], layered && !dnaError && turbo < 0.05);
    syncMorphControls();
    if (currentForm() === 'mobius') slot.dispatchEvent(new Event('rhine-fin-projection'));
  }

  function frozenSceneTime(now) {
    return phase + (now - frozen.clockStart) / 1000;
  }

  function scrub(progress) {
    if (!frozen) diagnostics().freeze();
    if (!Number.isFinite(progress)) throw new TypeError('Progress must be finite');
    pauseMorph();
    return seekMorph(progress);
  }

  function seekMorph(progress) {
    frozen.staticTurbine = false;
    frozen.progress = segment(progress, 0, 1);
    drawMorphFrame();
    return frozen.progress;
  }

  function pauseMorph() {
    if (!frozen) return;
    cancelAnimationFrame(frozen.animation);
    frozen.animation = 0;
  }

  function playMorph() {
    if (!frozen) diagnostics().freeze();
    if (frozen.animation) return;
    if (frozen.staticTurbine) {
      const origin = performance.now() - (frozen.turbineElapsed || 0) * 1000;
      function spin(now) {
        frozen.turbineElapsed = Math.max(frozen.turbineElapsed || 0, (now - origin) / 1000);
        drawMorphFrame();
        frozen.animation = requestAnimationFrame(spin);
      }
      frozen.animation = requestAnimationFrame(spin);
      return;
    }
    let previous = performance.now();
    function advance(now) {
      const elapsed = Math.max(0, Math.min(morphFrameMs, now - previous));
      previous = now;
      const p = seekMorph(frozen.progress + frozen.direction * elapsed / morphDuration);
      const hasDistance = frozen.direction > 0 ? p < 1 : p > 0;
      frozen.animation = hasDistance ? requestAnimationFrame(advance) : 0;
    }
    frozen.animation = requestAnimationFrame(advance);
  }

  function rotateByQuaternion(q, v) {
    const t = cross3(q, v).map(value => 2 * value);
    const u = cross3(q, t);
    return v.map((value, i) => value + q[3] * t[i] + u[i]);
  }

  function morphPoint(id, local) {
    const record = frozen?.final[id];
    if (!record) return null;
    const scaled = local.map((value, i) => value * record.size[i]);
    const offset = rotateByQuaternion(record.orientation, scaled);
    const point = record.center.map((value, i) => value + offset[i]);
    if (currentForm() !== 'dna' || forms.dna[id].role === 'bridge') return point;
    const t = scaled[2] / DNA_STRAND_SPEED;
    const section = rotateByQuaternion(record.orientation, [scaled[0], scaled[1], 0]);
    const bent = rotAxis(record.center.map((value, i) => value + section[i]), DNA_AXIS, t * DNA.sweep)
      .map((value, i) => value - DNA_AXIS[i] * t * DNA.length);
    const bend = dnaBend();
    return point.map((value, i) => mixNumber(value, bent[i], bend));
  }

  function activeAnchor(id) {
    const point = frozen?.final[id]?.center;
    if (!point) return null;
    const { view, shift, aspect } = frozen;
    return projectFinCenter(point, view, shift, aspect, canvas.getBoundingClientRect());
  }

  function projectFinCenter(point, camera, shift, aspect, rect) {
    if (!rect.width || !rect.height) return null;
    const back = norm3(camera);
    const right = norm3(cross3([0, 1, 0], back));
    const up = cross3(back, right);
    const depth = Math.hypot(...camera) - dot3(point, back);
    if (depth < 20 || depth > 6000) return null;
    return {
      x: rect.left + (1 + shift[0] + dot3(point, right) * focal / aspect / depth) * rect.width / 2,
      y: rect.top + (1 - shift[1] - dot3(point, up) * focal / depth) * rect.height / 2,
      depth,
    };
  }

  function measureMorph() {
    const { records, projection: color } = readFrozenFrame(frozen.rect);
    const { newData, stride } = captureProbes({ shadow: true, compare: false });
    const shadow = [];
    for (let id = 0; id < finCount; id++) {
      const offset = id * referencePoints.length * stride;
      shadow.push({
        id: newData[offset + 3],
        center: Array.from(newData.subarray(offset, offset + 3)),
        orientation: Array.from(newData.subarray(offset + 4, offset + 8)),
        size: Array.from(newData.subarray(offset + 8, offset + 11)),
      });
    }
    return { color, records, shadow, order: frozen.layered ? Array.from(orderData) : identities.map(({ id }) => id) };
  }

  function penetrationDepth(a, b) {
    const delta = b.center.map((value, i) => value - a.center[i]);
    const support = (box, axis) =>
      box.axes.reduce((sum, v, i) => sum + box.half[i] * Math.abs(dot3(v, axis)), 0);
    const axes = [...a.axes, ...b.axes, ...a.axes.flatMap(x => b.axes.map(y => cross3(x, y)))];
    let depth = Infinity;
    for (const axis of axes) {
      const length = Math.hypot(...axis);
      if (length <= 1e-8) continue;
      const overlap = (support(a, axis) + support(b, axis) - Math.abs(dot3(delta, axis))) / length;
      if (overlap <= 0) return 0;
      depth = Math.min(depth, overlap);
    }
    return depth;
  }

  function collisionReport(records = frozen.final, details = false) {
    const epsilon = 0.0001;
    const boxes = records.map(({ center, orientation, size }) => {
      const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(axis => rotateByQuaternion(orientation, axis));
      const half = size.map(value => value / 2);
      const extent = center.map((_, i) => axes.reduce((sum, axis, j) => sum + half[j] * Math.abs(axis[i]), 0));
      return { center, axes, half, extent };
    });
    const hits = [];
    const critical = [];
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const A = boxes[a], B = boxes[b];
        if (A.center.some((value, i) => A.extent[i] + B.extent[i] -
            Math.abs(value - B.center[i]) <= 0)) continue;
        const margin = penetrationDepth(A, B);
        if (margin <= 0) continue;
        const hit = { a, b, depth: margin, progress: frozen.progress, direction: frozen.direction };
        if (details && Math.abs(margin - epsilon) <= epsilon) critical.push({ a, b, margin });
        if (margin > epsilon) hits.push(hit);
      }
    }
    return details ? { hits, critical } : hits;
  }

  let morphSlider;
  let completedMobiusRotation = null;
  function syncMorphControls() {
    if (!morphSlider) return;
    morphSlider.value = frozen.progress;
    morphSlider.setAttribute('aria-valuetext', frozen.progress.toFixed(4));
  }

  function diagnostics() {
    const readUniform = name => uniforms[name] === null ? null : gl.getUniform(sceneProgram, uniforms[name]);
    const resume = () => {
      if (!frozen) return;
      pauseMorph();
      phase = frozenSceneTime(performance.now());
      frozen = null;
      gl.uniform1i(uniforms.uPosePath, 0);
      gl.uniform1i(uniforms.uMorphPose, 0);
      gl.uniform1f(uniforms.uTurbineBlend, 0.0);
      resized = true;
      previousTime = performance.now();
      requestDraw();
    };
    function freeze({ yaw = frozen?.yaw ?? 0 } = {}) {
      if (!Number.isFinite(yaw)) throw new TypeError('yaw must be finite (degrees)');
      if (!lastCamera || lost || !visible || document.hidden || resized) {
        throw new Error('Wait for a visible daily frame with stable canvas dimensions');
      }
      const rect = canvas.getBoundingClientRect().toJSON();
      if (frozen && (rect.width !== frozen.rect.width || rect.height !== frozen.rect.height)) {
        throw new Error('Canvas resized during capture; resume before freezing again');
      }
      if (!frozen) {
        const bootPose = readUniform('uBootPose');
        if (readUniform('uAssemble') !== 1 || bootPose[1] !== 0 ||
            menuFins.some((value, index) => index % 4 === 2 && value !== 0)) {
          throw new Error('Wait for full assembly and close the ring menu before freezing');
        }
        completedMobiusRotation = null;
        frozen = {
          rect, camera: Array.from(readUniform('uCamera')), destination: 'mobius-turbine',
          angles: Array.from(readUniform('uAngles')), bootPose: Array.from(bootPose),
          flow: readUniform('uFlow'), layered: readUniform('uLayered'),
          shift: Array.from(readUniform('uCameraShift')), aspect: readUniform('uFrameAspect'),
          progress: 0, yaw, direction: 1, animation: 0, turbineElapsed: 0, dnaSpin: 0,
          clockStart: performance.now(),
        };
        cancelAnimationFrame(frame);
        frame = 0;
      }

      try {
        const { camera: base, angles, bootPose, flow, layered } = frozen;
        const camera = rotAxis(base, [0, 1, 0], yaw * degrees);
        gl.uniform3f(uniforms.uCamera, ...camera);
        frozen.yaw = yaw;
        frozen.view = camera;
        gl.uniform1i(uniforms.uPosePath, 1);
        if (!frozen.base) {
          if (layered) sortFins(flow, camera, angles, bootPose[1], bootPose[0]);
          gl.uniform1i(uniforms.uLayered, Number(layered));
          frozen.base = readFrozenFrame(rect).records;
        }
        drawMorphFrame();
        const { records, order, projection } = readFrozenFrame(rect, frozen.records);
        frozen.records = records;
        return { rect, phase, yaw, progress: frozen.progress, order, records, projection };
      } catch (error) {
        resume();
        throw error;
      }
    }
    return {
      freeze,
      forms: () => structuredClone(forms),
      route: name => {
        const valid = ['turbine', 'mobius-turbine', 'turbine-dna', 'dna-mobius', 'dna'];
        if (!valid.includes(name)) throw new RangeError('Unknown motif route: ' + name);
        if (!frozen) freeze();
        frozen.staticTurbine = false;
        frozen.destination = name;
        scrub(0);
        return name;
      },
      spinTurbine: (active = true) => {
        if (!frozen) freeze();
        pauseMorph();
        frozen.staticTurbine = Boolean(active);
        if (frozen.staticTurbine) {
          frozen.destination = 'mobius-turbine';
          frozen.progress = 1;
          playMorph();
        }
      },
      advanceTurbine: dt => {
        if (!frozen) freeze();
        frozen.turbineElapsed = (frozen.turbineElapsed || 0) + dt;
        drawMorphFrame();
      },
      advanceDna: dSpin => {
        if (!frozen) freeze();
        frozen.dnaSpin = (frozen.dnaSpin || 0) + dSpin;
        drawMorphFrame();
      },
      timing: () => ({ durationMs: morphDuration, maxFrameMs: morphFrameMs }),
      pose: id => structuredClone(frozen?.final?.[id] ?? frozen?.records?.[id]),
      scrub,
      step: (delta = 1 / 120) => scrub(frozen.progress + frozen.direction * delta),
      reverse: () => (frozen.direction *= -1),
      play: playMorph,
      pause: pauseMorph,
      reset: () => scrub(0),
      point: (id, local = [0, 0, 0]) => morphPoint(id, local),
      measure: measureMorph,
      collisions: () => collisionReport(),
      collisionDetails: records => collisionReport(records, true),
      state: () => {
        const pose = frozen ?? completedMobiusRotation;
        return pose && ({ destination: pose.destination, progress: pose.progress, direction: pose.direction });
      },
      turbine: turbineDiagnostics,
      resume,
    };
  }

  function draw(time) {
    frame = 0;
    if (!visible || lost || document.hidden) return;
    const reduce = motionPreference.matches;
    const clock = boot ? slot.dataset.bootClock : null;
    const [bootStart, assembleStart, assembleEnd] = clock ? clock.split(',').map(Number) : [0, 0, 0];
    const bootTime = (time - bootStart) / 1000;
    const smooth = p => p * p * (3 - 2 * p);
    const gather = clock ? 1 - (1 - smooth(amount(bootTime / 1.2))) ** 2 : 1;
    const helixWeight = clock && !reduce ? 1 - smooth(amount((bootTime - assembleStart) / (assembleEnd - assembleStart))) : 0;
    if (reduce || document.documentElement.dataset.transition || slot.dataset.transition) {
      trembleMotion = null;
    }
    const moving = !reduce && !helixWeight && time - lastPointer < 650;
    const elapsed = previousTime ? time - previousTime : 34;
    if (interactive && !reduce && !moving && !resized && !deniedTween && !trembleMotion && elapsed < 1000 / 30 - 0.8) {
      requestDraw();
      return;
    }

    const dt = Math.min(elapsed, 100) / 1000;
    const motionDt = helixWeight ? 0 : clock && !reduce
      ? Math.min(dt, Math.max(0, bootTime - assembleEnd)) : dt;
    previousTime = time;
    const animatingDenied = Boolean(deniedTween);
    updateDenied(time);
    if (deniedTween) requestDraw();
    const denied = deniedOverride ?? readDenied();
    const verify = amount(slot.dataset.verify);
    const dissolveTarget = amount(slot.dataset.dissolve);
    dissolveSmooth += (dissolveTarget - dissolveSmooth) * (1 - Math.exp(-2.6 * dt));
    focusMix += (focusTargetMix - focusMix) * (reduce ? 1 : 1 - Math.exp(-7.0 * dt));
    selectMix += (selectTargetMix - selectMix) * (reduce ? 1 : 1 - Math.exp(-4.2 * dt));
    ringPulse *= Math.exp(-1.7 * dt);
    if (ringPulse < 0.002) ringPulse = 0;
    if (Math.abs(focusTargetMix - focusMix) > 0.004) requestDraw();
    const dissolve = reduce || Math.abs(dissolveTarget - dissolveSmooth) < 0.002 ? dissolveTarget : dissolveSmooth;
    const nextState = [denied.toFixed(3), deniedSweep.toFixed(3), verify.toFixed(3), dissolveTarget.toFixed(3), staticPulse,
      focusParam, focusTargetMix, selectParam, selectTargetMix, deformParam, deformMix].join('/');
    if (reduce && !resized && !animatingDenied && styleState === nextState && !movingMenuFins.size) return;

    if (resized) {
      const ratio = Math.min(devicePixelRatio || 1, 2);
      const width = slot.clientWidth;
      const height = slot.clientHeight;
      if (!width || !height) return;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      gl.uniform2f(uniforms.uFramePixels, canvas.width, canvas.height);
      gl.uniform2f(uniforms.uCssPixels, width, height);
      resized = false;
    }

    if (reduce) {
      parallaxX = 0;
      parallaxY = 0;
      pulseTimes.fill(-99);
      phase = Math.max(phase, 1.35);
      disorder = denied * 0.12;
      dolly = verify * 70;
    } else {
      if (clock) phase = Math.max(phase, 1.35);
      phase += motionDt;
      flow = 0;
      spin += motionDt * (0.55 + verify * 1.4);
      const damping = 1 - Math.exp(-(moving ? 3 : 2.2) * dt);
      parallaxX += ((moving ? pointerX : 0) - parallaxX) * damping;
      parallaxY += ((moving ? -pointerY : 0) - parallaxY) * damping;
      disorder += (denied * 0.12 - disorder) * (1 - Math.exp(-dt * 3.2));
      dolly += (verify * 70 - dolly) * (1 - Math.exp(-dt * 2));
    }

    const intro = (1 - Math.cos(Math.PI * Math.min(1, phase / 1.35))) / 2;
    const frameAspect = canvas.width / canvas.height;
    const fit = interactive ? Math.min(1, (16 / 9) / frameAspect) : (16 / 9) / frameAspect;
    const sceneTime = reduce ? 0 : phase;
    const bounds = canvas.getBoundingClientRect();
    gl.uniform2f(uniforms.uGridOrigin, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    gl.uniform1f(uniforms.uFrameAspect, frameAspect);
    const camDist = (TUNE.camDist ?? cameraDistance) * (TUNE.zoom ?? 1);
    const camElev = (TUNE.camElev ?? 0) * degrees;
    const camera = [parallaxX * 40 * fit,
      (camDist * Math.tan(camElev) + (TUNE.camElev ? 0 : cameraHeight) + parallaxY * 24) * fit,
      (camDist + (1 - intro) * 300 - dolly) * fit];
    camera.shiftX = TUNE.shiftX || 0;
    camera.shiftY = TUNE.shiftY || 0;
    if (trembleMotion) {
      const { start, duration, amplitude, cycles } = trembleMotion;
      const progress = Math.max(0, (time - start) / duration);
      if (progress >= 1) {
        trembleMotion = null;
      } else {
        const decay = amplitude * Math.exp(-1.5 * progress);
        const angle = 2 * Math.PI * cycles * progress;
        camera.shiftX += decay * Math.sin(angle);
        camera.shiftY += 0.4 * decay * Math.sin(angle + 0.35) * Math.min(1, progress * 20, (1 - progress) * 20);
      }
    }
    const columnOffset = bootHelix.side * frameAspect * Math.hypot(...camera) / focal
      * (0.82 + 0.18 * gather);
    const angles = [((TUNE.camPitch ?? cameraPitch) + Math.sin(sceneTime * 0.11) * 3) * degrees,
      (-(1 - intro) * 32) * degrees, 0 * degrees];
    const currentFlow = reduce ? 0 : flow;
    lastCamera = camera; lastAngles = angles; lastFlow = currentFlow; lastAspect = frameAspect;
    lastDissolve = dissolve;
    if (menu) updateMenuFins(bounds, camera, dt, reduce);
    gl.uniform3f(uniforms.uCamera, ...camera);
    gl.uniform2f(uniforms.uCameraShift, 2 * camera.shiftX / bounds.width, -2 * camera.shiftY / bounds.height);
    gl.uniform3f(uniforms.uAngles, ...angles);
    gl.uniform1f(uniforms.uFocal, focal);
    gl.uniform1f(uniforms.uTime, sceneTime);
    gl.uniform1f(uniforms.uSpin, reduce ? 0 : spin);
    gl.uniform1f(uniforms.uFlow, currentFlow);
    gl.uniform1f(uniforms.uAssemble, intro);
    gl.uniform1f(uniforms.uDenied, denied);
    gl.uniform2f(uniforms.uErrorFins, -2, -2);
    gl.uniform1f(uniforms.uDeniedSweep, deniedSweep);
    gl.uniform1f(uniforms.uVerify, verify);
    gl.uniform1f(uniforms.uAlign, verify * 0.5);
    gl.uniform1f(uniforms.uDisorder, disorder);
    gl.uniform1f(uniforms.uDissolve, dissolve);
    gl.uniform3f(uniforms.uBootPose, gather, helixWeight, columnOffset);
    gl.uniform1fv(uniforms['uPulseT[0]'], pulseTimes);
    gl.uniform1fv(uniforms['uPulseO[0]'], pulseOrigins);
    gl.uniform1f(uniforms.uStaticPulse, reduce ? staticPulse : 0);
    gl.uniform1f(uniforms.uFocus, focusParam);
    gl.uniform1f(uniforms.uFocusMix, focusMix);
    gl.uniform1f(uniforms.uDeform, deformParam);
    gl.uniform1f(uniforms.uDeformMix, deformMix);
    gl.uniform1f(uniforms.uSelect, selectParam);
    gl.uniform1f(uniforms.uSelectMix, selectMix);
    gl.uniform1f(uniforms.uRingPulse, ringPulse);
    gl.uniform1i(uniforms.uDnaError, 0);
    gl.uniform1i(uniforms.uShadow, 0);
    gl.uniform1f(uniforms.uTurbineBlend, 0.0);
    gl.uniform1f(uniforms.uDnaShareA, dnaShare.a);
    gl.uniform1f(uniforms.uDnaShareB, dnaShare.b);

    paintFrame(currentFlow, camera, angles, helixWeight, gather, denied < 0.98 || deniedSweep < 1);
    dailyProjection = intro === 1 && helixWeight === 0 && lastDissolve === 0 ? {
      bounds, sceneTime, spin: reduce ? 0 : spin, align: verify * 0.5, disorder,
      selectParam, selectMix, deformParam, deformMix,
      pulseTimes: pulseTimes.slice(), pulseOrigins: pulseOrigins.slice(),
    } : null;
    if (interactive) slot.dispatchEvent(new Event('rhine-fin-projection'));
    styleState = nextState;
    if (slot.dataset.rhine3d !== 'ready') showModel(true);
    if (!reduce) requestDraw();
  }

  if (interactive) window.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || motionPreference.matches) return;
    pointerX = 2 * event.clientX / window.innerWidth - 1;
    pointerY = 2 * event.clientY / window.innerHeight - 1;
    lastPointer = performance.now();
  }, { passive: true });

  function triggerPulse() {
    if (!visible || lost || document.hidden || slot.dataset.bootClock) return;
    if (frozen) frozen.pulseStart = performance.now();
    if (motionPreference.matches) {
      staticPulse = 1;
      clearTimeout(staticPulseTimeout);
      staticPulseTimeout = setTimeout(() => {
        staticPulse = 0;
        requestDraw();
      }, 700);
    } else {
      pulseOrigins[pulseSlot] = 0.25;
      pulseTimes[pulseSlot] = frozen ? frozenSceneTime(performance.now()) : phase;
      pulseSlot = (pulseSlot + 1) % pulseTimes.length;
    }
    requestDraw();
  }

  if (interactive) slot.addEventListener('rhine-pulse', triggerPulse);
  new ResizeObserver(() => {
    resized = true;
    requestDraw();
  }).observe(slot);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    requestDraw();
  }).observe(slot);

  function rotAxis(v, axis, a) {
    const sN = Math.sin(a), cN = Math.cos(a);
    const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
    return [
      v[0] * cN + (axis[1] * v[2] - axis[2] * v[1]) * sN + axis[0] * d * (1 - cN),
      v[1] * cN + (axis[2] * v[0] - axis[0] * v[2]) * sN + axis[1] * d * (1 - cN),
      v[2] * cN + (axis[0] * v[1] - axis[1] * v[0]) * sN + axis[2] * d * (1 - cN)
    ];
  }
  const norm3 = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
  const dot3 = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const cross3 = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

  function curvePointJS(t) {
    const s = Math.sin(t), c = Math.cos(t);
    const lobeRound = 1.0 / (1.0 + 0.15 * s * s);
    const crossGate = Math.exp(-(c * c) * 7.0);
    return [
      radius * c * lobeRound,
      radius * curveAspect * s * c * lobeRound,
      curveDepth * 0.32 * s * crossGate
    ];
  }

  const fract = x => x - Math.floor(x);
  function hash11(v) {
    const f = Math.fround;
    let p = fract(f(v * f(0.1031)));
    p = f(p * f(p + f(33.33)));
    return fract(f(p * f(p + p)));
  }

  // Match the center offsets in rl_finTransform for an assembled daily fin.
  function dailyFinCenter(id, t, pose) {
    const p = curvePointJS(t);
    const { sceneTime, selectParam, selectMix, deformParam, deformMix } = pose;
    const param = t / (2 * Math.PI);
    let pulse = 0;
    for (let i = 0; i < pose.pulseTimes.length; i++) {
      const age = sceneTime - pose.pulseTimes[i];
      if (age < 0 || age >= 3.7) continue;
      const front = fract(pose.pulseOrigins[i] + age * 0.32);
      const distance = fract(param - front + 0.5) - 0.5;
      const life = smoothstep01(Math.min(1, age / 0.05))
        * (1 - smoothstep01(Math.max(0, Math.min(1, (age - 3.05) / 0.4))));
      pulse += Math.exp(-distance * distance * 900) * life;
    }
    pulse = Math.min(pulse, 1.4);
    const selected = Math.min(Math.abs(param - selectParam), 1 - Math.abs(param - selectParam));
    const lift = pulse * 7 + selectMix * Math.exp(-selected * selected * 9000) * 26;
    if (!lift && !deformMix) return p;

    const ahead = curvePointJS(t + 0.002), behind = curvePointJS(t - 0.002);
    const tangent = norm3(ahead.map((value, i) => value - behind[i]));
    const normal = norm3(tangent.map((value, i) => Number(i === 2) - tangent[2] * value));
    const binormal = cross3(tangent, normal);
    const roll = t * 0.5 + Math.sin(t * 2 - sceneTime * 0.35) * 0.10
      + Math.sin(t * 4 + sceneTime * 0.22) * 0.04;
    const seed = hash11(Math.fround(Math.fround(id * Math.fround(1.618)) + Math.fround(4.7)));
    const phi = mixNumber(roll + pose.spin + pulse * 1.3, Math.PI / 2, pose.align)
      + (seed - 0.5) * pose.disorder * 3 + Math.sin(sceneTime * 9 + seed * 40) * pose.disorder * 0.2;
    const w = normal.map((value, i) => Math.cos(phi) * value + Math.sin(phi) * binormal[i]);
    const h = cross3(tangent, w);
    const lean = (0.62 + Math.sin(t * 2 + sceneTime * 0.4) * 0.06)
      * smoothstep01(Math.min(1, Math.min(t, 2 * Math.PI - t) / 0.38));
    const tilted = tangent.map((value, i) => Math.cos(lean) * value + Math.sin(lean) * h[i]);
    const height = cross3(tilted, w);
    const offset = (fract(param - deformParam + 0.5) - 0.5) * Math.sqrt(DEFORM.sigma);
    const deform = deformMix * Math.exp(-offset * offset);
    return p.map((value, i) =>
      value + height[i] * (lift + deform * DEFORM.push) + tilted[i] * deform * offset * DEFORM.tangent);
  }

  function paramScreen(param, atRest = false) {
    if (!Number.isFinite(param) || lost || !visible || document.hidden || resized) return null;
    const id = Math.round(fract(param) * finCount) % finCount;
    if (!atRest && frozen) return activeAnchor(id);
    if (!dailyProjection) return null;

    const { bounds } = dailyProjection;
    const t = 2 * Math.PI * fract((id + lastFlow) / finCount);
    let point = atRest ? curvePointJS(t) : dailyFinCenter(id, t, dailyProjection);
    point = rotAxis(point, [0, 0, 1], lastAngles[2]);
    point = rotAxis(point, [1, 0, 0], lastAngles[0]);
    point = rotAxis(point, [0, 1, 0], lastAngles[1]);
    const shift = [2 * lastCamera.shiftX / bounds.width, -2 * lastCamera.shiftY / bounds.height];
    const projected = projectFinCenter(point, lastCamera, shift, lastAspect, bounds);
    const i = id * 4;
    const menuMix = atRest ? 0 : menuFins[i + 2];
    if (!projected || !menuMix) return projected;

    // The shader mixes world positions before perspective division.
    const depth = mixNumber(projected.depth, lastMenuDepth, menuMix);
    const weight = menuMix * lastMenuDepth / depth;
    return {
      x: mixNumber(projected.x, bounds.left + menuFins[i] + lastCamera.shiftX, weight),
      y: mixNumber(projected.y, bounds.top + menuFins[i + 1] + lastCamera.shiftY, weight),
      depth,
    };
  }

  function setFocusParam(param, on) {
    focusParam = ((param % 1) + 1) % 1;
    focusTargetMix = on === false ? 0 : 1;
    requestDraw();
  }

  function pulseParam(param) {
    if (!visible || lost || slot.dataset.bootClock) return;
    pulseOrigins[pulseSlot] = ((param % 1) + 1) % 1;
    pulseTimes[pulseSlot] = frozen ? frozenSceneTime(performance.now()) : phase;
    pulseSlot = (pulseSlot + 1) % pulseTimes.length;
    requestDraw();
  }

  function paramFor(index, total) {
    const n = Math.max(1, Number(total) || 1);
    const i = Math.max(0, Math.min(n - 1, Number(index) || 0));
    return ((i + 0.5) / n + 0.25) % 1;
  }

  let rotating = false;

  function rotate() {
    if (rotating || !lastCamera || lost || !visible || document.hidden ||
        document.documentElement.hasAttribute('data-startup') || slot.dataset.bootClock ||
        (!frozen && (phase < 1.35 || resized ||
          menuFins.some((value, index) => index % 4 === 2 && value !== 0)))) return null;

    const next = {
      mobius: ['mobius-turbine', 'turbine'],
      turbine: ['turbine-dna', 'dna'],
      dna: ['dna-mobius', 'mobius'],
    };
    const [route, target] = next[currentForm()];
    const controls = diagnostics();
    const start = performance.now();
    rotating = true;
    try {
      // Route scrubbing cancels the outgoing idle frame before queuing this route.
      controls.route(route);
    } catch (error) {
      rotating = false;
      throw error;
    }
    const pose = frozen;
    const spinStart = pose.turbineElapsed + 0.85;
    slot.setAttribute('data-rhine-rotating', '');
    let lastForm = currentForm();
    let lastSelection = selectParam;
    let lastFocus = focusParam;
    let lastPaint = start;
    const deadline = start + morphDuration;
    // Complete at the same deadline even when the browser stops delivering frames.
    const completion = setTimeout(finish, Math.ceil(Math.max(0, deadline - performance.now())));

    function endRotation() {
      clearTimeout(completion);
      rotating = false;
      slot.removeAttribute('data-rhine-rotating');
    }

    function finish() {
      if (pose.progress === 1) return;
      cancelAnimationFrame(pose.animation);
      advance(deadline);
    }

    function advance(frameTime) {
      if (frozen !== pose) {
        endRotation();
        return;
      }
      const now = Math.max(frameTime, performance.now());
      const progress = now >= deadline ? 1 : segment(now - start, 0, morphDuration);
      const finishing = pose.progress < 1 && progress === 1;
      if (!finishing && now - lastPaint < 1000 / 30 - 0.8) {
        pose.animation = requestAnimationFrame(advance);
        return;
      }
      const dt = (now - lastPaint) / 1000;
      lastPaint = now;
      const sizeChanged = resized;
      if (sizeChanged) {
        const rect = canvas.getBoundingClientRect();
        if (rect.width && rect.height) {
          const ratio = Math.min(devicePixelRatio || 1, 2);
          canvas.width = Math.round(rect.width * ratio);
          canvas.height = Math.round(rect.height * ratio);
          gl.uniform2f(uniforms.uFramePixels, canvas.width, canvas.height);
          gl.uniform2f(uniforms.uCssPixels, rect.width, rect.height);
          pose.rect = rect.toJSON();
          pose.aspect = canvas.width / canvas.height;
          gl.uniform1f(uniforms.uFrameAspect, pose.aspect);
          resized = false;
        }
      }
      const selectionChanged = lastSelection !== selectParam || selectMix !== selectTargetMix ||
        lastFocus !== focusParam || focusMix !== focusTargetMix;
      if (selectionChanged) {
        lastSelection = selectParam;
        lastFocus = focusParam;
        selectMix = selectTargetMix;
        focusMix = focusTargetMix;
        gl.uniform1f(uniforms.uSelect, selectParam);
        gl.uniform1f(uniforms.uSelectMix, selectMix);
        gl.uniform1f(uniforms.uFocus, focusParam);
        gl.uniform1f(uniforms.uFocusMix, focusMix);
      }
      if (pose.progress < 1) {
        seekMorph(progress);
        if (progress === 1) {
          endRotation();
          if (target === 'mobius') {
            completedMobiusRotation = { destination: pose.destination, progress: pose.progress, direction: pose.direction };
            controls.resume();
          }
          if (target === 'turbine') {
            // Continue from the spin phase used by the final morph frame.
            pose.turbineElapsed = spinStart;
            pose.staticTurbine = true;
          }
        }
      } else {
        if (pose.staticTurbine) pose.turbineElapsed = spinStart + (now - start - morphDuration) / 1000;
        if (target === 'dna' && !motionPreference.matches) {
          pose.dnaSpin += DNA.spinRate * dt * (dnaFocus.on ? 0.12 : 1);   // 选中游戏时降到 12% 慢巡航，不停死
        }
        drawMorphFrame();
      }
      const form = currentForm();
      if (lastForm !== form) {
        lastForm = form;
        slot.dispatchEvent(new Event('rhine-form-change'));
      }
      if (frozen === pose) pose.animation = requestAnimationFrame(advance);
    }
    pose.animation = requestAnimationFrame(advance);
    return target;
  }

  requestDraw();
  return {
    canvas, setDenied, tremble, form: currentForm,
    ...(interactive && entryParams.length ? { rotate } : {}),
    param: paramFor,
    paramScreen,
    focusAt: setFocusParam,
    anchor: activeAnchor,
    finCount,
    pulse: triggerPulse,
    // 项目页面（rhine-orbit.js / app.js）在用的入口，Gemini 那版没带过来
    selectAt: function (param, on) {
      selectParam = ((Number(param) || 0) % 1 + 1) % 1;
      selectTargetMix = on === false ? 0 : 1;
      requestDraw();
    },
    clearSelect: function () { selectTargetMix = 0; requestDraw(); },
    focus: function (index, total, on) { setFocusParam(paramFor(index, total), on); },
    clearFocus: function () { focusTargetMix = 0; requestDraw(); },
    pulseAt: function (index, total) { pulseParam(paramFor(index, total)); },
    turbineSectorLengths,
    setLedgerFocus(items) {
      const keys = new Set((items || []).map(item => `${item.side}:${item.group}`));
      dnaFocus = { on: keys.size > 0, keys };
      requestDraw();
    },
    getLedgerFocus() { return { on: dnaFocus.on, keys: [...dnaFocus.keys] }; },
    setLedgerRungs(items) {
      const list = (items || []).filter(item => item && Number.isFinite(item.group));
      const max = list.reduce((m, item) => Math.max(m, Number(item.amount) || 0), 0) || 1;
      dnaRungAmount = new Map(list.map(item =>
        [`${item.side}:${item.group}`, Math.min(1, (Number(item.amount) || 0) / max)]));
      requestDraw();
    },
    getLedgerRungs() { return [...dnaRungAmount.entries()]; },
    setLedgerShare(a, b) {
      const total = Math.max(1e-6, (Number(a) || 0) + (Number(b) || 0));
      dnaShare = { a: (Number(a) || 0) / total, b: (Number(b) || 0) / total };
      resized = true;
      requestDraw();
    },
    setTurbineScales(outer, inner) {
      turbineLengths.outer = turbineFinLengths('outer', outer);
      turbineLengths.inner = turbineFinLengths('inner', inner);
    },
    highlightTurbineSector(role, index, sectors) {
      const ring = turbineRings[role];
      if (!ring) {
        turbineHighlight = [0, 0];
        return;
      }
      const offset = role === 'inner' ? outerCount : 0;
      turbineHighlight = [index, index + 1].map(boundary =>
        offset + turbineSectorBoundary(boundary, ring.count, sectors));
    },
    ...(menu ? { setMenuFrame } : {}),
    ...(interactive && entryParams.length ? { diagnostics } : {}),
  };
};

window.RhineMotif = {
  mount: mountRhineMotif,
  ...mountRhineMotif({ boot: true }),
};
