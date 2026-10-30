import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import './style.css';

/* =====================================================================
 *  CHIIKAWA CHRISTMAS 3D RUNNER
 *  Vite + Vanilla JS + Three.js
 * ===================================================================== */

// ---------------------------------------------------------------------
// Cấu hình gameplay
// ---------------------------------------------------------------------
const CONFIG = {
  playerX: -4,
  spawnX: 35,
  despawnX: -20,

  gravity: -35,
  jumpVelocity: 13,
  fastFallGravity: -110, // trọng lực khi giữ ↓ trên không (fast fall)

  startSpeed: 12,
  maxSpeed: 30,
  speedPerPoint: 0.012, // tốc độ tăng theo điểm
  scorePerUnit: 0.75, // điểm / đơn vị quãng đường

  hitboxShrink: -0.25,

  worldMinX: -40, // vùng lặp lại cho đạo cụ nền
  worldMaxX: 65,
};

const HISCORE_KEY = 'chiikawa-xmas-hiscore';
const SOUND_KEY = 'chiikawa-xmas-sound';

const rand = (a, b) => a + Math.random() * (b - a);
const damp = (current, target, lambda, dt) => THREE.MathUtils.damp(current, target, lambda, dt);

// =====================================================================
//  TIỆN ÍCH: Chuẩn hoá kích thước + tâm model
// =====================================================================
/**
 * Chuẩn hoá một model GLTF:
 *  - Scale theo chiều cao mục tiêu (targetHeight / size.y)
 *  - Đáy chạm y = 0, tâm X/Z về 0
 *  - Xoay quanh trục Y theo facingAngleY
 *  - Bọc vào THREE.Group (container) và bật đổ bóng cho mọi Mesh
 *
 * Ghi chú: phép xoay được áp lên model TRƯỚC khi đo Box3 lần cuối, để
 * việc căn tâm X/Z luôn đúng kể cả khi pivot gốc của model bị lệch
 * (xoay sau khi đã dịch sẽ làm model "văng" khỏi tâm).
 */
function normalizeAndCenterModel(gltfScene, targetHeight, facingAngleY = 0) {
  const model = gltfScene;

  // Reset transform gốc
  model.position.set(0, 0, 0);
  model.scale.setScalar(1);
  model.rotation.y = facingAngleY;
  model.updateMatrixWorld(true);

  // 1) Đo kích thước gốc
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());

  // 2) Scale theo chiều cao mục tiêu
  const scale = targetHeight / (size.y || 1);
  model.scale.setScalar(scale);
  model.updateMatrixWorld(true);

  // 3) Đo lại sau scale + xoay rồi dịch: đáy -> y=0, tâm X/Z -> 0
  box.setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.set(-center.x, -box.min.y, -center.z);
  model.updateMatrixWorld(true);

  // 4) Bọc vào container
  const container = new THREE.Group();
  container.add(model);

  // 5) Bật đổ bóng
  model.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  const finalSize = new THREE.Box3().setFromObject(container).getSize(new THREE.Vector3());
  container.userData.size = finalSize;
  container.userData.height = targetHeight;
  return container;
}

// =====================================================================
//  ÂM THANH 8-BIT (Web Audio API thuần)
// =====================================================================
class SoundManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = localStorage.getItem(SOUND_KEY) !== 'off';
  }

  /** Phải gọi trong một sự kiện người dùng (click/phím) */
  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? 0.35 : 0;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem(SOUND_KEY, this.enabled ? 'on' : 'off');
    if (this.master) this.master.gain.value = this.enabled ? 0.35 : 0;
    return this.enabled;
  }

  /** Phát 1 nốt có thể trượt tần số */
  tone({ type = 'square', from, to = from, start = 0, duration = 0.15, volume = 0.3, attack = 0.005 }) {
    if (!this.ctx || !this.enabled) return;
    const t0 = this.ctx.currentTime + start;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + duration);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  /** Tiếng chuông: âm cơ bản + các bồi âm không hài hoà */
  bell(freq, start = 0, duration = 0.8, volume = 0.25) {
    this.tone({ type: 'sine', from: freq, start, duration, volume });
    this.tone({ type: 'sine', from: freq * 2.76, start, duration: duration * 0.5, volume: volume * 0.35 });
    this.tone({ type: 'triangle', from: freq * 2, start, duration: duration * 0.7, volume: volume * 0.25 });
    this.tone({ type: 'square', from: freq, start, duration: 0.05, volume: volume * 0.15 });
  }

  jump() {
    this.tone({ type: 'square', from: 260, to: 820, duration: 0.14, volume: 0.18 });
  }

  milestone() {
    // 2 nốt chuông Giáng Sinh: E6 -> A6
    this.bell(1318.5, 0, 0.55, 0.22);
    this.bell(1760, 0.14, 0.85, 0.22);
  }

  land() {
    this.tone({ type: 'triangle', from: 140, to: 70, duration: 0.07, volume: 0.12 });
  }

  gameOver() {
    // Chuỗi nốt trầm đi xuống
    const notes = [392, 311, 247, 196];
    notes.forEach((f, i) => {
      this.tone({ type: 'square', from: f, start: i * 0.13, duration: 0.14, volume: 0.16 });
    });
    this.tone({ type: 'sawtooth', from: 165, to: 55, start: notes.length * 0.13, duration: 0.6, volume: 0.18 });
  }

  playAuroraSound() {
    // Hợp âm arpeggio lung linh huyền ảo: C5, E5, G5, B5, E6 ngân nhẹ
    const notes = [523.25, 659.25, 783.99, 987.77, 1318.51];
    notes.forEach((freq, i) => {
      this.tone({ type: 'sine', from: freq, start: i * 0.11, duration: 1.1, volume: 0.16, attack: 0.02 });
      this.tone({ type: 'triangle', from: freq * 2, start: i * 0.11 + 0.03, duration: 0.55, volume: 0.06, attack: 0.01 });
    });
  }
}

// =====================================================================
//  DOM
// =====================================================================
const $ = (id) => document.getElementById(id);
const ui = {
  app: $('app'),
  score: $('score'),
  hiscore: $('hiscore'),
  loading: $('loading'),
  progressBar: $('progress-bar'),
  loadingText: $('loading-text'),
  start: $('start-screen'),
  gameover: $('gameover-screen'),
  finalScore: $('final-score'),
  newRecord: $('new-record'),
  btnStart: $('btn-start'),
  btnRestart: $('btn-restart'),
  btnCamera: $('btn-camera'),
  cameraLabel: $('camera-label'),
  btnAurora: $('btn-aurora'),
  auroraLabel: $('aurora-label'),
  btnHelp: $('btn-help'),
  helpPanel: $('help-panel'),
  btnSound: $('btn-sound'),
  soundLabel: $('sound-label'),
  touchControls: $('touch-controls'),
  touchJump: $('touch-jump'),
  touchDuck: $('touch-duck'),
};

const pad = (n) => String(Math.floor(n)).padStart(5, '0');

// =====================================================================
//  SCENE / CAMERA / RENDERER
// =====================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdbe9f4);
scene.fog = new THREE.FogExp2(0xdbe9f4, 0.018);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(2, 4.5, 11);
const cameraLook = new THREE.Vector3(3, 1.2, 0);
camera.lookAt(cameraLook);

const CAMERA_PRESETS = [
  { name: '3/4', pos: new THREE.Vector3(2, 4.5, 11), look: new THREE.Vector3(3, 1.2, 0) },
  { name: 'Ngang', pos: new THREE.Vector3(1, 2.2, 13), look: new THREE.Vector3(2, 1.3, 0) },
  { name: 'Sau lưng', pos: new THREE.Vector3(-11, 3.6, 3.5), look: new THREE.Vector3(6, 1.2, 0) },
];
let cameraIndex = 0;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
ui.app.prepend(renderer.domElement);

// ---------- Ánh sáng ----------
const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);

const sun = new THREE.DirectionalLight(0xfff5e6, 1.5);
sun.position.set(8, 18, 10);
sun.target.position.set(8, 0, -4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -28;
sun.shadow.camera.right = 32;
sun.shadow.camera.top = 20;
sun.shadow.camera.bottom = -20;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 60;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// ---------- Mặt đất tuyết (mở rộng sâu ra chân trời để không bị hở mép) ----------
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 400),
  new THREE.MeshStandardMaterial({ color: 0xf8fbff, roughness: 0.95 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.set(0, 0, -80);
ground.receiveShadow = true;
scene.add(ground);

// Đường chạy (vệt tuyết bị nén, hơi xanh)
const track = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 2.6),
  new THREE.MeshStandardMaterial({ color: 0xe6eef8, roughness: 1 })
);
track.rotation.x = -Math.PI / 2;
track.position.set(0, 0.005, 0);
track.receiveShadow = true;
scene.add(track);

// Đồi tuyết xa xa ở đường chân trời
{
  const hillMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  for (let i = 0; i < 9; i++) {
    const r = rand(10, 22);
    const hill = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 12), hillMat);
    hill.scale.y = rand(0.25, 0.45);
    hill.position.set(-50 + i * 16 + rand(-4, 4), 0, rand(-55, -42));
    scene.add(hill);
  }
}

// =====================================================================
//  TUYẾT RƠI (Particle System)
// =====================================================================
function makeSnowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// =====================================================================
//  THỜI TIẾT: ĐÊM CỰC QUANG (AURORA BOREALIS)
// =====================================================================
const COLOR_DAY_BG = new THREE.Color(0xdbe9f4);
const COLOR_AURORA_BG = new THREE.Color(0x090d26);
const COLOR_DAY_FOG = new THREE.Color(0xdbe9f4);
const COLOR_AURORA_FOG = new THREE.Color(0x090d26);
const COLOR_DAY_AMB = new THREE.Color(0xffffff);
const COLOR_AURORA_AMB = new THREE.Color(0x6a7fd4);
const COLOR_DAY_SUN = new THREE.Color(0xfff5e6);
const COLOR_AURORA_SUN = new THREE.Color(0x72f5ff);

let manualAuroraToggle = false;
let auroraFactor = 0.0;
let wasAuroraActive = false;

// ---------- Bầu trời sao (Starfield 360 độ) ----------
const STAR_COUNT = 800;
const starGeo = new THREE.BufferGeometry();
const starPos = new Float32Array(STAR_COUNT * 3);
for (let i = 0; i < STAR_COUNT; i++) {
  const theta = rand(0, Math.PI * 2);
  const r = rand(95, 138);
  starPos[i * 3] = Math.cos(theta) * r;
  starPos[i * 3 + 1] = rand(9, 85);
  starPos[i * 3 + 2] = Math.sin(theta) * r;
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
const starMat = new THREE.PointsMaterial({
  color: 0xffffff,
  size: 1.1,
  map: makeSnowTexture(),
  transparent: true,
  opacity: 0,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
});
const starfield = new THREE.Points(starGeo, starMat);
starfield.frustumCulled = false;
scene.add(starfield);

// ---------- Dải Cực Quang (Aurora Sky Dome) ----------
const auroraVertexShader = `
  varying vec3 vWorldPosition;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const auroraFragmentShader = `
  uniform float uTime;
  uniform float uOpacity;
  varying vec3 vWorldPosition;
  varying vec2 vUv;

  void main() {
    if (uOpacity <= 0.001) {
      discard;
    }
    // Góc phương vị 360 độ (dùng số nguyên để tuần hoàn hoàn hảo không bị nứt/vết cắt)
    float angle = atan(vWorldPosition.z, vWorldPosition.x);
    float y = vWorldPosition.y;
    float h = clamp((y - 2.0) / 85.0, 0.0, 1.0);

    // Fade mượt mà từ mặt đất (2.0) lên đến 28.0, tuyệt đối không bị đường cắt ngang thẳng ở chân trời
    float heightMask = smoothstep(2.0, 28.0, y) * smoothstep(125.0, 65.0, y);

    // Dải lượn cực quang chính: liên tục và mềm mại quanh vòm trời (dùng hàm mũ Gaussian thay vì cắt ngưỡng cứng)
    float curtain1 = sin(angle * 2.0 + uTime * 0.35 + sin(angle * 4.0 - uTime * 0.2) * 0.6);
    float curtain2 = sin(angle * 4.0 - uTime * 0.5 + h * 3.0);
    float curtainWave = curtain1 * 0.65 + curtain2 * 0.35;
    float ribbon1 = exp(-pow(curtainWave * 1.5, 2.0));

    // Lớp cực quang thứ hai lượn sóng tạo chiều sâu nhiều lớp
    float curtain3 = sin(angle * 3.0 + uTime * 0.25 - h * 2.5);
    float ribbon2 = exp(-pow(curtain3 * 1.8, 2.0)) * 0.65;

    // Gợn sóng dọc lung linh nhẹ (vertical ray folds)
    float rayWaves = 0.75 + 0.25 * sin(angle * 48.0 + sin(h * 6.0 + uTime * 0.4) * 2.0);
    // Quầng sáng thiên hà tự nhiên ở nền trời
    float ambientGlow = 0.22 * smoothstep(4.0, 35.0, y) * smoothstep(100.0, 50.0, y);

    float glow = (max(ribbon1, ribbon2) * rayWaves + ambientGlow) * heightMask;

    // 3 tông màu rực rỡ hòa sắc mượt mà không phân đoạn
    vec3 colPink   = vec3(1.0, 0.46, 0.82); // #ff75d1 Hồng đào chân trời
    vec3 colCyan   = vec3(0.0, 1.0, 0.82);  // #00ffd0 Xanh ngọc cực quang
    vec3 colViolet = vec3(0.72, 0.32, 1.0); // #b852ff Tím mộng mơ đỉnh trời

    vec3 col = mix(colPink, colCyan, smoothstep(0.08, 0.38, h));
    col = mix(col, colViolet, smoothstep(0.40, 0.82, h));

    gl_FragColor = vec4(col * (glow * 2.4), glow * uOpacity);
  }
`;

const auroraGeo = new THREE.SphereGeometry(180, 64, 40, 0, Math.PI * 2, 0, Math.PI * 0.54);
const auroraMat = new THREE.ShaderMaterial({
  vertexShader: auroraVertexShader,
  fragmentShader: auroraFragmentShader,
  uniforms: {
    uTime: { value: 0 },
    uOpacity: { value: 0 },
  },
  side: THREE.BackSide,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const auroraDome = new THREE.Mesh(auroraGeo, auroraMat);
auroraDome.position.set(0, -12, 0);
auroraDome.frustumCulled = false;
scene.add(auroraDome);

function toggleAurora() {
  sound.init();
  manualAuroraToggle = !manualAuroraToggle;
  return manualAuroraToggle;
}

function updateWeather(dt, t) {
  // Logic chu kỳ kích hoạt theo điểm số:
  // Kích hoạt khi >= 500 điểm, kéo dài 300 điểm (500->800, 1500->1800,...)
  const isAuroraNight = score >= 500 && ((score - 500) % 1000 < 300);
  const targetAurora = manualAuroraToggle || isAuroraNight ? 1.0 : 0.0;

  // Âm thanh huyền ảo khi bắt đầu vào Đêm Cực quang
  if (targetAurora === 1.0 && !wasAuroraActive) {
    wasAuroraActive = true;
    sound.playAuroraSound();
  } else if (targetAurora === 0.0 && wasAuroraActive) {
    wasAuroraActive = false;
  }

  // Lerp mượt mà (chuyển đổi từ từ trong ~2.5 giây)
  auroraFactor = THREE.MathUtils.lerp(auroraFactor, targetAurora, dt * 0.8);

  // Chuyển màu nền & sương mù
  scene.background.lerpColors(COLOR_DAY_BG, COLOR_AURORA_BG, auroraFactor);
  scene.fog.color.lerpColors(COLOR_DAY_FOG, COLOR_AURORA_FOG, auroraFactor);
  scene.fog.density = THREE.MathUtils.lerp(0.018, 0.007, auroraFactor);

  // Chuyển màu ánh sáng
  ambientLight.color.lerpColors(COLOR_DAY_AMB, COLOR_AURORA_AMB, auroraFactor);
  sun.color.lerpColors(COLOR_DAY_SUN, COLOR_AURORA_SUN, auroraFactor);
  sun.intensity = THREE.MathUtils.lerp(1.5, 0.95, auroraFactor);

  // Vòm cực quang & sao đi theo trục X của người chơi để bao quát 360 độ ở mọi camera
  const centerX = player.root ? player.root.position.x + 10 : 0;
  auroraDome.position.x = centerX;
  starfield.position.x = centerX;

  auroraMat.uniforms.uTime.value = t;
  auroraMat.uniforms.uOpacity.value = auroraFactor;

  // Sao lấp lánh nhẹ
  starMat.opacity = auroraFactor * 0.85 * (0.8 + 0.2 * Math.sin(t * 2.8));

  if (ui.auroraLabel) {
    ui.auroraLabel.textContent = (manualAuroraToggle || isAuroraNight) ? 'Bật' : 'Tắt';
  }
}

const SNOW_COUNT = 1200;
const SNOW_BOUNDS = { minX: -30, maxX: 50, maxY: 22, minZ: -25, maxZ: 12 };
const snowGeo = new THREE.BufferGeometry();
const snowPos = new Float32Array(SNOW_COUNT * 3);
const snowData = [];
for (let i = 0; i < SNOW_COUNT; i++) {
  snowPos[i * 3] = rand(SNOW_BOUNDS.minX, SNOW_BOUNDS.maxX);
  snowPos[i * 3 + 1] = rand(0, SNOW_BOUNDS.maxY);
  snowPos[i * 3 + 2] = rand(SNOW_BOUNDS.minZ, SNOW_BOUNDS.maxZ);
  snowData.push({ fall: rand(1.0, 2.6), phase: rand(0, Math.PI * 2), sway: rand(0.2, 0.6) });
}
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const snow = new THREE.Points(
  snowGeo,
  new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.2,
    map: makeSnowTexture(),
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
  })
);
snow.frustumCulled = false;
scene.add(snow);

function updateSnow(dt, t, worldSpeed) {
  const wind = 1.2 + worldSpeed * 0.12; // gió thổi về -X
  for (let i = 0; i < SNOW_COUNT; i++) {
    const d = snowData[i];
    const ix = i * 3;
    snowPos[ix + 1] -= d.fall * dt;
    snowPos[ix] -= (wind + Math.sin(t * 1.3 + d.phase) * d.sway) * dt;
    snowPos[ix + 2] += Math.cos(t * 0.9 + d.phase) * 0.15 * dt;
    if (snowPos[ix + 1] < 0) {
      snowPos[ix + 1] = SNOW_BOUNDS.maxY;
      snowPos[ix] = rand(SNOW_BOUNDS.minX, SNOW_BOUNDS.maxX);
    }
    if (snowPos[ix] < SNOW_BOUNDS.minX) snowPos[ix] += SNOW_BOUNDS.maxX - SNOW_BOUNDS.minX;
  }
  snowGeo.attributes.position.needsUpdate = true;
}

// =====================================================================
//  HẠT BỤI TUYẾT KHI TIẾP ĐẤT
// =====================================================================
const puffGeo = new THREE.SphereGeometry(0.12, 8, 6);
const puffs = [];
for (let i = 0; i < 24; i++) {
  const m = new THREE.Mesh(puffGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
  m.visible = false;
  scene.add(m);
  puffs.push({ mesh: m, life: 0, vel: new THREE.Vector3() });
}
function spawnPuff(x, count = 8) {
  let spawned = 0;
  for (const p of puffs) {
    if (p.life > 0) continue;
    p.life = 0.5;
    p.mesh.visible = true;
    p.mesh.position.set(x + rand(-0.4, 0.4), 0.08, rand(-0.4, 0.4));
    p.vel.set(rand(-2.5, 0.5), rand(0.8, 2), rand(-1.2, 1.2));
    p.mesh.scale.setScalar(rand(0.6, 1.2));
    if (++spawned >= count) break;
  }
}
function updatePuffs(dt) {
  for (const p of puffs) {
    if (p.life <= 0) continue;
    p.life -= dt;
    p.vel.y -= 4 * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.scale.multiplyScalar(1 + dt * 1.5);
    p.mesh.material.opacity = Math.max(0, p.life / 0.5) * 0.9;
    if (p.life <= 0) p.mesh.visible = false;
  }
}

// =====================================================================
//  ĐẠO CỤ TRANG TRÍ (gậy kẹo, ụ tuyết) – trôi theo tốc độ game
// =====================================================================
const scrollingProps = []; // { obj }

function makeCandyCaneTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#d63031';
  for (let i = -64; i < 128; i += 22) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 11, 0);
    g.lineTo(i + 11 + 32, 64);
    g.lineTo(i + 32, 64);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 3);
  return tex;
}

function buildDecorations() {
  // Gậy kẹo dọc đường chạy (phía trước)
  const caneMat = new THREE.MeshStandardMaterial({ map: makeCandyCaneTexture(), roughness: 0.4 });
  const stickGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.9, 10);
  const hookGeo = new THREE.TorusGeometry(0.14, 0.06, 8, 16, Math.PI);
  for (let x = CONFIG.worldMinX; x < CONFIG.worldMaxX; x += 7.5) {
    const cane = new THREE.Group();
    const stick = new THREE.Mesh(stickGeo, caneMat);
    stick.position.y = 0.45;
    const hook = new THREE.Mesh(hookGeo, caneMat);
    hook.position.set(0.14, 0.9, 0);
    cane.add(stick, hook);
    cane.traverse((c) => c.isMesh && (c.castShadow = true));
    cane.position.set(x, 0, 2.3);
    cane.rotation.y = Math.PI; // móc quay về phía người chơi chạy tới
    scene.add(cane);
    scrollingProps.push({ obj: cane });
  }

  // Ụ tuyết rải rác
  const moundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  const moundGeo = new THREE.SphereGeometry(1, 16, 10);
  for (let i = 0; i < 34; i++) {
    const m = new THREE.Mesh(moundGeo, moundMat);
    const s = rand(0.25, 0.9);
    m.scale.set(s * rand(1.2, 2), s * rand(0.25, 0.45), s);
    let z = rand(-14, 9);
    if (Math.abs(z) < 1.8) z += Math.sign(z || 1) * 2;
    m.position.set(rand(CONFIG.worldMinX, CONFIG.worldMaxX), 0, z);
    m.receiveShadow = true;
    scene.add(m);
    scrollingProps.push({ obj: m });
  }
}
buildDecorations();

function updateScrollingProps(dt, worldSpeed) {
  const span = CONFIG.worldMaxX - CONFIG.worldMinX;
  for (const p of scrollingProps) {
    p.obj.position.x -= worldSpeed * dt;
    if (p.obj.position.x < CONFIG.worldMinX) p.obj.position.x += span;
  }
}

// =====================================================================
//  TẢI MODEL
// =====================================================================
const loader = new GLTFLoader();
const MODEL_FILES = {
  chiikawa: '/models/chiikawa.glb',
  tree: '/models/tree.glb',
  flying: '/models/flying.glb',
};

function loadAllModels() {
  const keys = Object.keys(MODEL_FILES);
  const progress = {};
  const report = () => {
    let loaded = 0;
    let total = 0;
    for (const k of keys) {
      if (progress[k]) {
        loaded += progress[k].loaded;
        total += progress[k].total;
      }
    }
    const pct = total ? Math.min(100, (loaded / total) * 100) : 0;
    ui.progressBar.style.width = pct + '%';
    ui.loadingText.textContent = Math.floor(pct) + '%';
  };

  return Promise.all(
    keys.map(
      (k) =>
        new Promise((resolve, reject) => {
          loader.load(
            MODEL_FILES[k],
            (gltf) => resolve([k, gltf]),
            (xhr) => {
              progress[k] = { loaded: xhr.loaded, total: xhr.total || xhr.loaded };
              report();
            },
            (err) => reject(new Error(`Không tải được ${MODEL_FILES[k]}: ${err?.message || err}`))
          );
        })
    )
  ).then((entries) => Object.fromEntries(entries));
}

// =====================================================================
//  ĐỐI TƯỢNG GAME
// =====================================================================
const templates = {}; // treeSmall, treeBig, usagi
const player = {
  root: new THREE.Group(), // vị trí X + độ cao nhảy
  body: new THREE.Group(), // procedural animation (nhún, lắc, ép dẹp)
  model: null, // container đã chuẩn hoá (dùng cho hitbox)
  y: 0,
  vy: 0,
  grounded: true,
  ducking: false,
  runPhase: 0,
  landSquash: 0,
};

function buildSantaHat() {
  const hat = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xd62828, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });

  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.5, 20), red);
  cone.position.y = 0.27;
  cone.rotation.z = 0.25; // chóp mũ hơi gập ra sau

  const brim = new THREE.Mesh(new THREE.SphereGeometry(0.29, 20, 10), white);
  brim.scale.set(1, 0.32, 1);
  brim.position.y = 0.04;

  const pompom = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), white);
  pompom.position.set(-0.13, 0.52, 0);

  hat.add(cone, brim, pompom);
  hat.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  return hat;
}

function setupWorld(models) {
  // ---------- Chiikawa ----------
  player.model = normalizeAndCenterModel(models.chiikawa.scene, 1.5, -Math.PI / 2);
  const hat = buildSantaHat();
  hat.position.set(-0.05, 1.36, 0);
  hat.rotation.z = 0.18; // nghiêng mũ ra sau (Chiikawa nhìn về +X)
  player.body.add(player.model, hat);
  player.root.add(player.body);
  player.root.position.set(CONFIG.playerX, 0, 0);
  scene.add(player.root);

  // ---------- Template chướng ngại vật ----------
  templates.treeSmall = normalizeAndCenterModel(models.tree.scene.clone(true), 1.8, 0);
  templates.treeBig = normalizeAndCenterModel(models.tree.scene.clone(true), 2.5, 0);
  templates.usagi = buildLyingUsagi(normalizeAndCenterModel(models.flying.scene, 1.4, Math.PI / 2));

  // ---------- Rừng thông nền (Bắc Âu) ----------
  // Đưa ra xa hơn (z = -14 đến -34), làm mờ mềm mại và TẮT ĐỔ BÓNG hoàn toàn
  // để người chơi tập trung tuyệt đối vào chướng ngại vật trên đường chạy
  const count = 26;
  const span = CONFIG.worldMaxX - CONFIG.worldMinX;
  for (let i = 0; i < count; i++) {
    const tree = templates.treeBig.clone(true);
    const s = rand(1.1, 2.5);
    tree.scale.setScalar(s);
    const z = rand(-34, -14);
    tree.position.set(CONFIG.worldMinX + (i / count) * span + rand(-2, 2), 0, z);
    tree.rotation.y = rand(0, Math.PI * 2);

    // Tắt đổ bóng cho TẤT CẢ cây nền & làm mờ nhẹ hòa vào sương mù
    tree.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = false;
        c.receiveShadow = false;
        c.material = c.material.clone();
        c.material.transparent = true;
        c.material.opacity = rand(0.55, 0.72);
        c.material.roughness = 1.0;
        if (c.material.color) {
          c.material.color.lerp(new THREE.Color(0xb0c8dc), 0.3);
        }
      }
    });

    scene.add(tree);
    scrollingProps.push({ obj: tree });
  }
}

// Tư thế "bay nằm" của Usagi:
// - Thân nằm ngang dọc theo trục X (đầu và tai hướng về -X, lao thẳng về Chiikawa)
// - Mặt và mắt hơi ngửa lên và hướng về phía camera (+Z) để người chơi nhìn rõ biểu cảm hài hước
function buildLyingUsagi(standing) {
  const h = standing.userData.height;
  const pivot = new THREE.Group();
  standing.position.y = -h / 2; // xoay quanh tâm thân
  pivot.add(standing);
  pivot.rotation.set(-1.92, 0.09, 1.6); // nằm ngang, đầu hướng -X, mặt hướng chếch camera

  const container = new THREE.Group();
  container.add(pivot);
  container.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(container);
  const center = box.getCenter(new THREE.Vector3());
  pivot.position.set(-center.x, -box.min.y, -center.z);
  container.updateMatrixWorld(true);

  const size = new THREE.Box3().setFromObject(container).getSize(new THREE.Vector3());
  container.userData.size = size;
  container.userData.height = size.y;
  return container;
}

// ---------------------------------------------------------------------
//  Chướng ngại vật
// ---------------------------------------------------------------------
const obstacles = [];
const OBSTACLE_TYPES = {
  treeSmall: { template: 'treeSmall' },
  treeBig: { template: 'treeBig' },
  usagi: { template: 'usagi' },
};

function createObstacle(type) {
  const root = new THREE.Group();
  const o = { type, root, mesh: null, wobble: null, baseY: 0, phase: rand(0, Math.PI * 2) };

  if (type === 'usagi') {
    // Pivot ở giữa thân để xoay hỗn loạn tự nhiên
    const h = templates.usagi.userData.height;
    const wobble = new THREE.Group();
    wobble.position.y = h / 2;
    // flying.glb là SkinnedMesh (có xương) -> phải dùng SkeletonUtils.clone để
    // bản sao có bộ xương riêng. clone() thường vẫn trỏ vào xương của template
    // (không nằm trong scene) khiến Usagi vẽ sai chỗ / nhấp nháy rồi biến mất.
    const mesh = SkeletonUtils.clone(templates.usagi);
    mesh.position.y = -h / 2;
    mesh.traverse((c) => {
      if (c.isMesh) c.frustumCulled = false; // bounding sphere của skinned mesh hay bị sai
    });
    wobble.add(mesh);
    root.add(wobble);
    o.mesh = mesh;
    o.wobble = wobble;
    // Bay nằm: thấp (phải nhảy) hoặc ngang đầu (phải cúi)
    o.baseY = Math.random() < 0.5 ? 0.95 : 0.15;
  } else {
    const mesh = templates[OBSTACLE_TYPES[type].template].clone(true);
    mesh.rotation.y = rand(0, Math.PI * 2);
    root.add(mesh);
    o.mesh = mesh;
  }

  root.position.set(CONFIG.spawnX, o.baseY, 0);
  scene.add(root);
  obstacles.push(o);
  return o;
}

function removeObstacle(index) {
  const o = obstacles[index];
  scene.remove(o.root); // geometry/material dùng chung với template -> không dispose
  obstacles.splice(index, 1);
}

function pickObstacleType(score) {
  const r = Math.random();
  const usagiChance = score < 120 ? 0 : Math.min(0.4, 0.2 + score / 4000);
  const bigChance = score < 60 ? 0.2 : 0.35;
  if (r < usagiChance) return 'usagi';
  if (r < usagiChance + bigChance * (1 - usagiChance)) return 'treeBig';
  return 'treeSmall';
}

function nextSpawnGap(speed) {
  // Khoảng cách đủ để nhảy qua + tiếp đất (thời gian bay ≈ 2*v/g)
  const airTime = (2 * CONFIG.jumpVelocity) / -CONFIG.gravity;
  return speed * airTime + rand(5, 15);
}

function updateObstacle(o, dt, t) {
  if (o.type !== 'usagi') return;
  // Bay nhấp nhô hình sin + rung lắc kiểu Usagi "Ura!"
  const p = o.phase;
  o.root.position.y = o.baseY + Math.sin(t * 6 + p) * 0.08;
  o.wobble.rotation.z = Math.sin(t * 11 + p) * 0.14;
  o.wobble.rotation.x = Math.cos(t * 7.3 + p) * 0.12;
  o.wobble.rotation.y = Math.sin(t * 4.1 + p) * 0.18;
}

// ---------------------------------------------------------------------
//  Va chạm
// ---------------------------------------------------------------------
const playerBox = new THREE.Box3();
const obsBox = new THREE.Box3();
const lowerBox = new THREE.Box3();
const upperBox = new THREE.Box3();
const USAGI_SHRINK = new THREE.Vector3(CONFIG.hitboxShrink, -0.1, CONFIG.hitboxShrink);

function checkCollision(o) {
  if (o.type === 'usagi') {
    // Usagi nằm khá mỏng theo trục Y -> chỉ thu nhỏ ít theo chiều dọc
    obsBox.setFromObject(o.mesh).expandByVector(USAGI_SHRINK);
    return !obsBox.isEmpty() && playerBox.intersectsBox(obsBox);
  }

  obsBox.setFromObject(o.mesh).expandByScalar(CONFIG.hitboxShrink);
  if (obsBox.isEmpty()) return false;

  // Cây thông hình nón: chia hitbox thành phần thân dưới (rộng) + ngọn (hẹp)
  // để góc trống của AABB không "giết oan" người chơi.
  const h = obsBox.max.y - obsBox.min.y;
  lowerBox.copy(obsBox);
  lowerBox.max.y = obsBox.min.y + h * 0.55;
  upperBox.copy(obsBox);
  upperBox.min.y = lowerBox.max.y;
  const cx = (obsBox.min.x + obsBox.max.x) / 2;
  const cz = (obsBox.min.z + obsBox.max.z) / 2;
  const hx = (obsBox.max.x - obsBox.min.x) * 0.25;
  const hz = (obsBox.max.z - obsBox.min.z) * 0.25;
  upperBox.min.x = cx - hx;
  upperBox.max.x = cx + hx;
  upperBox.min.z = cz - hz;
  upperBox.max.z = cz + hz;
  return playerBox.intersectsBox(lowerBox) || playerBox.intersectsBox(upperBox);
}

// =====================================================================
//  TRẠNG THÁI GAME
// =====================================================================
const sound = new SoundManager();
const input = { down: false, jumpQueued: 0 };

let state = 'loading'; // loading | ready | playing | over
let score = 0;
let hiScore = Number(localStorage.getItem(HISCORE_KEY)) || 0;
let gameSpeed = CONFIG.startSpeed;
let lastMilestone = 0;
let distanceSinceSpawn = 0;
let spawnGap = 18;
let overTime = 0;
let shake = 0;

ui.hiscore.textContent = pad(hiScore);
ui.soundLabel.textContent = sound.enabled ? 'Bật' : 'Tắt';

function resetGame() {
  while (obstacles.length) removeObstacle(0);
  score = 0;
  lastMilestone = 0;
  wasAuroraActive = false;
  gameSpeed = CONFIG.startSpeed;
  distanceSinceSpawn = 0;
  spawnGap = 14;
  player.y = 0;
  player.vy = 0;
  player.grounded = true;
  player.ducking = false;
  player.body.rotation.set(0, 0, 0);
  player.root.position.y = 0;
  input.jumpQueued = 0;
  if (ui.touchControls) ui.touchControls.classList.add('hidden');
  ui.score.textContent = pad(0);
}

function startGame() {
  sound.init();
  resetGame();
  state = 'playing';
  ui.start.classList.add('hidden');
  ui.gameover.classList.add('hidden');
  if (ui.touchControls) ui.touchControls.classList.remove('hidden');
}

function gameOver() {
  state = 'over';
  overTime = 0;
  shake = 0.35;
  if (ui.touchControls) ui.touchControls.classList.add('hidden');
  sound.gameOver();
  const final = Math.floor(score);
  const isRecord = final > hiScore;
  if (isRecord) {
    hiScore = final;
    localStorage.setItem(HISCORE_KEY, String(hiScore));
    ui.hiscore.textContent = pad(hiScore);
  }
  ui.finalScore.textContent = final;
  ui.newRecord.classList.toggle('hidden', !isRecord);
  setTimeout(() => state === 'over' && ui.gameover.classList.remove('hidden'), 450);
}

function requestJump() {
  input.jumpQueued = 0.15; // input buffer: bấm sớm một chút trước khi chạm đất vẫn nhảy
}

function doJump() {
  player.vy = CONFIG.jumpVelocity;
  player.grounded = false;
  player.ducking = false;
  input.jumpQueued = 0;
  sound.jump();
}

// =====================================================================
//  CẬP NHẬT GAMEPLAY
// =====================================================================
function updateGame(dt, t) {
  // Tốc độ + điểm
  gameSpeed = Math.min(CONFIG.maxSpeed, CONFIG.startSpeed + score * CONFIG.speedPerPoint);
  score += gameSpeed * dt * CONFIG.scorePerUnit;
  ui.score.textContent = pad(score);

  const milestone = Math.floor(score / 100);
  if (milestone > lastMilestone) {
    lastMilestone = milestone;
    sound.milestone();
    ui.score.classList.remove('flash');
    void ui.score.offsetWidth; // restart CSS animation
    ui.score.classList.add('flash');
  }

  // ---------- Vật lý Chiikawa ----------
  if (input.jumpQueued > 0) {
    input.jumpQueued -= dt;
    if (player.grounded) doJump();
  }

  if (!player.grounded) {
    const g = input.down ? CONFIG.fastFallGravity : CONFIG.gravity;
    player.vy += g * dt;
    player.y += player.vy * dt;
    if (player.y <= 0) {
      player.y = 0;
      player.vy = 0;
      player.grounded = true;
      player.landSquash = 1;
      spawnPuff(CONFIG.playerX);
      sound.land();
    }
  }
  player.ducking = player.grounded && input.down;
  player.root.position.y = player.y;

  // ---------- Chướng ngại vật ----------
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    o.root.position.x -= gameSpeed * dt;
    updateObstacle(o, dt, t);
    if (o.root.position.x < CONFIG.despawnX) removeObstacle(i);
  }

  distanceSinceSpawn += gameSpeed * dt;
  if (distanceSinceSpawn >= spawnGap) {
    distanceSinceSpawn = 0;
    spawnGap = nextSpawnGap(gameSpeed);
    createObstacle(pickObstacleType(score));
  }

  // ---------- Va chạm ----------
  player.root.updateMatrixWorld(true);
  playerBox.setFromObject(player.model).expandByScalar(CONFIG.hitboxShrink);
  for (const o of obstacles) {
    if (Math.abs(o.root.position.x - CONFIG.playerX) > 4) continue; // lọc nhanh
    o.root.updateMatrixWorld(true);
    if (checkCollision(o)) {
      gameOver();
      break;
    }
  }
}

// ---------------------------------------------------------------------
//  Procedural animation của Chiikawa
// ---------------------------------------------------------------------
const targetScale = new THREE.Vector3();

function updatePlayerAnimation(dt, t) {
  const body = player.body;

  if (state === 'playing') {
    if (player.grounded) {
      // Chạy lon ton: nhún trục Y + lắc trục Z
      player.runPhase += dt;
      const time = player.runPhase * (gameSpeed / CONFIG.startSpeed) ** 0.35;
      body.position.y = Math.abs(Math.sin(time * 14)) * 0.15;
      body.rotation.z = Math.sin(time * 14) * 0.08;
      body.rotation.x = 0;
    } else {
      // Trên không: ngả người theo vận tốc + lắc nhẹ
      body.position.y = damp(body.position.y, 0, 12, dt);
      const lean = THREE.MathUtils.clamp(player.vy * 0.025, -0.35, 0.35);
      body.rotation.z = damp(body.rotation.z, lean, 10, dt);
      body.rotation.x = Math.sin(t * 9) * 0.06;
    }
  } else if (state === 'ready' || state === 'loading') {
    // Thở nhẹ khi chờ
    body.position.y = 0;
    body.rotation.z = Math.sin(t * 1.6) * 0.05;
    body.rotation.x = 0;
  } else if (state === 'over') {
    // Ngã ngửa ra sau khi va chạm
    body.rotation.z = damp(body.rotation.z, 0.5, 8, dt);
    body.position.y = damp(body.position.y, 0, 10, dt);
    if (!player.grounded) {
      player.vy += CONFIG.gravity * dt;
      player.y = Math.max(0, player.y + player.vy * dt);
      if (player.y === 0) player.grounded = true;
      player.root.position.y = player.y;
    }
  }

  // Ép dẹp khi cúi / squash khi tiếp đất / thở khi chờ
  if (player.ducking && state === 'playing') {
    targetScale.set(1.2, 0.55, 1.2);
  } else if (state === 'ready') {
    const b = Math.sin(t * 3) * 0.03;
    targetScale.set(1 - b * 0.5, 1 + b, 1 - b * 0.5);
  } else {
    targetScale.set(1, 1, 1);
  }
  if (player.landSquash > 0) {
    const s = player.landSquash * 0.22;
    targetScale.x += s * 0.6;
    targetScale.z += s * 0.6;
    targetScale.y -= s;
    player.landSquash = Math.max(0, player.landSquash - dt * 6);
  }
  if (!player.grounded && state === 'playing') targetScale.set(0.94, 1.08, 0.94); // stretch khi bay

  body.scale.x = damp(body.scale.x, targetScale.x, 25, dt);
  body.scale.y = damp(body.scale.y, targetScale.y, 25, dt);
  body.scale.z = damp(body.scale.z, targetScale.z, 25, dt);
}

// ---------------------------------------------------------------------
//  Camera
// ---------------------------------------------------------------------
const camTargetPos = new THREE.Vector3();
function updateCamera(dt) {
  const preset = CAMERA_PRESETS[cameraIndex];
  camTargetPos.copy(preset.pos);
  const k = 1 - Math.exp(-dt * 4);
  camera.position.lerp(camTargetPos, k);
  cameraLook.lerp(preset.look, k);
  if (shake > 0) {
    shake = Math.max(0, shake - dt);
    const a = shake * 0.6;
    camera.position.x += rand(-a, a);
    camera.position.y += rand(-a, a);
  }
  camera.lookAt(cameraLook);
}

function cycleCamera() {
  cameraIndex = (cameraIndex + 1) % CAMERA_PRESETS.length;
  ui.cameraLabel.textContent = CAMERA_PRESETS[cameraIndex].name;
}

// =====================================================================
//  VÒNG LẶP CHÍNH
// =====================================================================
const clock = new THREE.Clock();
let elapsed = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  if (state === 'playing') updateGame(dt, elapsed);
  if (state === 'over') overTime += dt;

  const worldSpeed = state === 'playing' ? gameSpeed : 0;
  if (player.model) updatePlayerAnimation(dt, elapsed);
  updateWeather(dt, elapsed);
  updateScrollingProps(dt, worldSpeed);
  updateSnow(dt, elapsed, worldSpeed);
  updatePuffs(dt);
  updateCamera(dt);

  renderer.render(scene, camera);
}

// =====================================================================
//  INPUT
// =====================================================================
const JUMP_KEYS = ['Space', 'ArrowUp', 'KeyW'];
const DUCK_KEYS = ['ArrowDown', 'KeyS'];

window.addEventListener('keydown', (e) => {
  if ([...JUMP_KEYS, ...DUCK_KEYS].includes(e.code)) e.preventDefault();

  if (e.code === 'KeyC' && !e.repeat) return cycleCamera();
  if (e.code === 'KeyM' && !e.repeat) return toggleSound();
  if (e.code === 'KeyP' && !e.repeat) return toggleAurora();

  if (JUMP_KEYS.includes(e.code)) {
    if (state === 'ready' && !e.repeat) return startGame();
    if (state === 'over' && !e.repeat && overTime > 0.6) return startGame();
    if (state === 'playing') requestJump();
  }
  if (DUCK_KEYS.includes(e.code)) input.down = true;
});

window.addEventListener('keyup', (e) => {
  if (DUCK_KEYS.includes(e.code)) input.down = false;
});

window.addEventListener('blur', () => (input.down = false));

// ---------- Cảm ứng: chạm để nhảy, vuốt xuống để cúi ----------
let touchStartY = null;
let touchDucking = false;
renderer.domElement.addEventListener(
  'touchstart',
  (e) => {
    e.preventDefault();
    sound.init();
    touchStartY = e.touches[0].clientY;
    touchDucking = false;
    if (state === 'ready') return startGame();
    if (state === 'over' && overTime > 0.6) return startGame();
    if (state === 'playing') requestJump();
  },
  { passive: false }
);
renderer.domElement.addEventListener(
  'touchmove',
  (e) => {
    e.preventDefault();
    if (touchStartY === null) return;
    if (e.touches[0].clientY - touchStartY > 35) {
      touchDucking = true;
      input.down = true;
      input.jumpQueued = 0;
    }
  },
  { passive: false }
);
renderer.domElement.addEventListener('touchend', () => {
  touchStartY = null;
  if (touchDucking) input.down = false;
  touchDucking = false;
});

// Nút cảm ứng
function bindHold(btn, onDown, onUp) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sound.init();
    onDown();
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, () => onUp && onUp()));
}
bindHold(ui.touchJump, () => {
  if (state === 'ready' || (state === 'over' && overTime > 0.6)) return startGame();
  if (state === 'playing') requestJump();
});
bindHold(
  ui.touchDuck,
  () => (input.down = true),
  () => (input.down = false)
);

// ---------- Nút UI ----------
function toggleSound() {
  sound.init();
  const on = sound.toggle();
  ui.soundLabel.textContent = on ? 'Bật' : 'Tắt';
}

// Không cho nút giữ focus (tránh phím Space "click" lại nút)
document.querySelectorAll('button').forEach((b) => {
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => b.blur());
});

ui.btnStart.addEventListener('click', () => state === 'ready' && startGame());
ui.btnRestart.addEventListener('click', () => state === 'over' && startGame());
ui.btnCamera.addEventListener('click', cycleCamera);
ui.btnAurora.addEventListener('click', toggleAurora);
ui.btnSound.addEventListener('click', toggleSound);
ui.btnHelp.addEventListener('click', () => ui.helpPanel.classList.toggle('hidden'));

// ---------- Resize & Orientation ----------
function handleResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}
window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', () => {
  setTimeout(handleResize, 100);
  setTimeout(handleResize, 300);
});

// =====================================================================
//  KHỞI ĐỘNG
// =====================================================================
animate();

loadAllModels()
  .then((models) => {
    setupWorld(models);
    state = 'ready';
    ui.loading.classList.add('hidden');
    ui.start.classList.remove('hidden');
  })
  .catch((err) => {
    console.error(err);
    ui.loadingText.textContent = '⚠ ' + err.message;
    ui.loadingText.style.color = '#ffd166';
  });

