/**
 * 页面 3D 预览脚本（module script）。从 page.ts 拆出，行为不变。
 * three.js 本地 vendor（MIT），相机为自研球坐标轨道，不引 OrbitControls。
 */
export const VIEWER_SCRIPT = `
import * as THREE from '/vendor/three.module.js';

const viewer = document.getElementById('viewer');
const info = document.getElementById('sceneInfo');
const errEl = document.getElementById('sceneErr');
const PALETTE = [0x4f8fd0, 0xd08a4f, 0x6fbf73, 0xc05f7a, 0x9a7fd0];

let renderer = null, scene = null, camera = null, root = null;
let theta = 0.7, phi = 1.15, radius = 2, target = new THREE.Vector3();

function ensureRenderer() {
  if (renderer !== null) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  viewer.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1726);
  camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3a52, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(2, 3, 2);
  scene.add(dir);
  scene.add(new THREE.GridHelper(4, 20, 0x3a4f6b, 0x223046));
  root = new THREE.Group();
  scene.add(root);

  let drag = null;
  const el = renderer.domElement;
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, btn: e.button }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    if (drag === null) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.btn === 0) { theta -= dx * 0.008; phi = Math.min(Math.PI - 0.05, Math.max(0.05, phi - dy * 0.008)); }
    else if (drag.btn === 2) {
      const right = new THREE.Vector3(), up = new THREE.Vector3();
      camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
      const k = radius * 0.0011;
      target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    }
  });
  el.addEventListener('pointerup', () => { drag = null; });
  el.addEventListener('wheel', (e) => { e.preventDefault(); radius = Math.min(30, Math.max(0.2, radius * Math.exp(e.deltaY * 0.001))); }, { passive: false });

  renderer.setAnimationLoop(() => {
    const w = viewer.clientWidth, h = viewer.clientHeight;
    if (el.width !== Math.floor(w * renderer.getPixelRatio()) || el.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta));
    camera.lookAt(target);
    renderer.render(scene, camera);
  });
}

function clearRoot() {
  while (root.children.length > 0) {
    const obj = root.children.pop();
    if (obj.geometry !== undefined) obj.geometry.dispose();
    if (obj.material !== undefined) obj.material.dispose();
  }
}

// 引擎约定 z 轴向上、单位 mm；three.js 约定 y 轴向上、单位 m。
function toScene(p) {
  return new THREE.Vector3(p.x / 1000, p.z / 1000, -p.y / 1000);
}

function memberBox(model, member, color) {
  const s = toScene(member.start), e = toScene(member.end);
  const dir = e.sub(s).normalize();
  const profile = model.profiles.find((p) => p.id === member.profileId);
  const w = (profile !== undefined ? profile.spec.width : 20) / 1000;
  const h = (profile !== undefined ? profile.spec.height : 20) / 1000;
  const cut = member.cutLength / 1000;
  const geo = new THREE.BoxGeometry(cut, h, w);
  const mat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.55, metalness: 0.25 });
  const mesh = new THREE.Mesh(geo, mat);
  const mid = s.clone().addScaledVector(dir, (member.trimStart + member.cutLength / 2) / 1000);
  mesh.position.copy(mid);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  return mesh;
}

window.render3d = async function render3d() {
  errEl.textContent = '';
  try {
    const r = await fetch('/api/frame', { method: 'POST', headers: { 'content-type': 'application/json' }, body: document.getElementById('frameBox').value });
    const j = await r.json();
    if (j.ok === false) { errEl.textContent = '错误[' + j.code + ']：' + j.message + (j.hint ? ' 提示：' + j.hint : ''); return; }
    ensureRenderer();
    clearRoot();
    const model = j.model;
    const colorOf = new Map();
    model.profiles.forEach((p, i) => colorOf.set(p.id, PALETTE[i % PALETTE.length]));
    for (const m of model.members) root.add(memberBox(model, m, colorOf.get(m.profileId) ?? 0x8899aa));
    const jointGeo = new THREE.SphereGeometry(0.012, 16, 12);
    const jointMat = new THREE.MeshStandardMaterial({ color: 0xd7dce4, roughness: 0.4 });
    for (const jt of model.joints) {
      const sp = new THREE.Mesh(jointGeo, jointMat);
      sp.position.copy(toScene(jt.point));
      root.add(sp);
    }
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    target.copy(center);
    radius = Math.max(0.8, size.length() * 1.4);
    info.textContent = model.members.length + ' 根杆件、' + model.joints.length + ' 个关节已渲染（包围盒 宽×高×深 ' +
      Math.round(size.x * 1000) + '×' + Math.round(size.y * 1000) + '×' + Math.round(size.z * 1000) + ' mm，视口 ' +
      viewer.clientWidth + '×' + viewer.clientHeight + 'px）';
  } catch (e) { errEl.textContent = String(e); }
};
`;