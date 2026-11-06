/**
 * serve 页面：单文件 HTML，零外部资源（不引 CDN，离线可用）。
 * 结果区同时显示引擎 JSON 与错误提示；数值口径与 CLI 完全一致。
 */

export const PAGE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mycad — 铝型材框架本地设计台</title>
<style>
:root{font-size:15px}
body{font-family:system-ui,"Noto Sans CJK SC",sans-serif;margin:0;background:#f5f6f8;color:#1c2330}
header{background:#16324f;color:#fff;padding:14px 22px}
header h1{font-size:18px;margin:0}
header p{margin:4px 0 0;font-size:12px;opacity:.75}
main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:18px 22px;max-width:1400px;margin:0 auto}
section{background:#fff;border:1px solid #dde2ea;border-radius:8px;padding:14px 16px}
section h2{font-size:15px;margin:0 0 10px}
label{display:block;font-size:12px;color:#5a6678;margin:8px 0 2px}
textarea{width:100%;box-sizing:border-box;font:12px/1.5 ui-monospace,monospace;border:1px solid #c8d0dc;border-radius:6px;padding:8px}
.row{display:flex;gap:10px;align-items:end;flex-wrap:wrap}
button{background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:7px 13px;font-size:13px;cursor:pointer}
button:hover{background:#1958c0}
input[type=number]{width:110px;padding:5px;border:1px solid #c8d0dc;border-radius:6px}
pre{background:#0e1726;color:#d8e2f0;border-radius:6px;padding:10px;font-size:12px;overflow:auto;max-height:420px;margin:10px 0 0}
.err{color:#b3261e;font-size:12px;white-space:pre-wrap;margin-top:8px}
.hint{font-size:12px;color:#5a6678}
.full{grid-column:1/-1}
</style>
</head>
<body>
<header>
  <h1>mycad 铝型材框架本地设计台</h1>
  <p>引擎与 CLI 同源 · 只监听 127.0.0.1 · 输出含公式来源与免责，校核不替代工程师判断</p>
</header>
<main>
<section>
  <h2>① 型材截面</h2>
  <label>内置预设（来源与未证实字段见 mycad presets）</label>
  <select id="presetSel"></select>
  <div class="row" style="margin-top:8px">
    <button onclick="calcSection()">截面特性</button>
    <button onclick="downloadDxf()">下载截面 DXF</button>
  </div>
  <label>或自定义参数化规格（L1 DSL）</label>
  <textarea id="specBox" rows="5">{"width":20,"height":20,"slot":{"opening":6.15,"depth":4.5,"headWidth":9,"headStart":2},"bore":{"radius":2.5}}</textarea>
  <pre id="sectionOut" hidden></pre><div class="err" id="sectionErr"></div>
</section>

<section>
  <h2>② 校核（标准工况解析解）</h2>
  <p class="hint">示例用米思米公布值 Ix=0.72cm⁴（优先于理想化计算值）。默认限值均为工程惯例，须在 JSON 里写明 eSource/deflectionSource。</p>
  <textarea id="checkBox" rows="12">{"case":"ss_udl","lengthMm":600,"eMpa":70000,"eSource":"米思米20系列样本：6063-T5 E=70000N/mm2（核对于2026-11-06）","section":{"areaMm2":159,"iMm4":7200,"wMm3":720,"bendingNote":"米思米公布Ix=Lx=0.72cm4，对中性轴x"},"bendingAxis":"x","qNPerMm":0.5,"allowableMpa":80,"allowableSource":"工程惯例（6063-T5），非规范条文","deflectionRatioLimit":250,"deflectionSource":"工程惯例，非规范条文"}</textarea>
  <div class="row" style="margin-top:8px"><button onclick="runCheck()">校核</button></div>
  <pre id="checkOut" hidden></pre><div class="err" id="checkErr"></div>
</section>

<section class="full">
  <h2>③ 框架：求解 / 连接方案 / BOM</h2>
  <p class="hint">示例：600×750 单框加中立柱（含角接与 T 接）。start/end 为节点坐标 mm，trimStart/trimEnd 为让量。</p>
  <textarea id="frameBox" rows="14">{"profiles":[{"id":"p20","spec":{"width":20,"height":20,"slot":{"opening":6.15,"depth":4.5,"headWidth":9,"headStart":2},"bore":{"radius":2.5}},"material":{"name":"6063-T5（米思米样本）","densityKgPerM3":2700}}],"members":[
{"id":"底梁","profileId":"p20","start":[0,0,0],"end":[600,0,0]},
{"id":"左柱","profileId":"p20","start":[0,0,0],"end":[0,0,750]},
{"id":"右柱","profileId":"p20","start":[600,0,0],"end":[600,0,750]},
{"id":"顶梁","profileId":"p20","start":[0,0,750],"end":[600,0,750]},
{"id":"中立柱","profileId":"p20","start":[300,0,750],"end":[300,0,0]}
]}</textarea>
  <div class="row" style="margin-top:8px">
    <button onclick="runFrame()">框架求解</button>
    <button onclick="runConnect()">连接方案</button>
    <button onclick="runBom()">BOM</button>
    <label style="margin:0">棒料 mm<input id="stockInp" type="number" value="6000"></label>
    <label style="margin:0">锯缝 mm<input id="kerfInp" type="number" value="3"></label>
  </div>
  <pre id="frameOut" hidden></pre><div class="err" id="frameErr"></div>
</section>

<section class="full">
  <h2>④ 一维下料</h2>
  <textarea id="cutBox" rows="4">{"pieces":[{"id":"600梁","lengthMm":600,"quantity":4},{"id":"750柱","lengthMm":750,"quantity":2}],"options":{"stockLengthMm":6000,"kerfMm":3}}</textarea>
  <div class="row" style="margin-top:8px"><button onclick="runCut()">下料方案</button></div>
  <pre id="cutOut" hidden></pre><div class="err" id="cutErr"></div>
</section>

<section class="full">
  <h2>⑤ 3D 预览</h2>
  <div class="row">
    <button onclick="window.render3d()">渲染当前框架</button>
    <span id="sceneInfo" class="hint"></span>
  </div>
  <div id="viewer" style="height:480px;margin-top:8px;border-radius:6px;background:#0e1726;position:relative;overflow:hidden"></div>
  <div class="err" id="sceneErr"></div>
  <p class="hint">左键拖拽旋转 · 滚轮缩放 · 右键平移。杆件渲染为截面外包络实体（槽口与圆角细节不建模），颜色按型材区分；尺寸来自引擎求解结果，与 BOM 同源。</p>
</section>
</main>
<script>
async function api(path, body, outId, errId) {
  const out = document.getElementById(outId), err = document.getElementById(errId);
  out.hidden = true; err.textContent = '';
  try {
    const r = await fetch('/api/' + path, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
    const j = await r.json();
    if (j.ok === false) { err.textContent = '错误[' + j.code + ']：' + j.message + (j.hint ? '\\n提示：' + j.hint : ''); return; }
    out.textContent = JSON.stringify(j, null, 2); out.hidden = false;
  } catch (e) { err.textContent = String(e); }
}
function specInput() {
  const sel = document.getElementById('presetSel').value;
  if (sel) return {presetProfile: sel};
  return {profileSpec: JSON.parse(document.getElementById('specBox').value)};
}
function calcSection(){ api('section', specInput(), 'sectionOut', 'sectionErr'); }
async function downloadDxf() {
  const r = await fetch('/api/dxf-section', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(specInput())});
  const t = await r.text();
  if (t.startsWith('{')) { document.getElementById('sectionErr').textContent = JSON.parse(t).message; return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([t], {type:'application/dxf'}));
  a.download = 'section.dxf'; a.click(); URL.revokeObjectURL(a.href);
}
function frameJson(){ return JSON.parse(document.getElementById('frameBox').value); }
function runFrame(){ api('frame', frameJson(), 'frameOut', 'frameErr'); }
function runConnect(){ api('connect', frameJson(), 'frameOut', 'frameErr'); }
function runBom(){ api('bom', {frame: frameJson(), options:{stockMm: +document.getElementById('stockInp').value || undefined, kerfMm: +document.getElementById('kerfInp').value}}, 'frameOut', 'frameErr'); }
function runCheck(){ api('check', JSON.parse(document.getElementById('checkBox').value), 'checkOut', 'checkErr'); }
function runCut(){ api('cut', JSON.parse(document.getElementById('cutBox').value), 'cutOut', 'cutErr'); }
fetch('/api/presets').then(r=>r.json()).then(j=>{
  const sel = document.getElementById('presetSel');
  for (const p of j.presets) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.id + ' — ' + p.title; sel.appendChild(o); }
  const custom = document.createElement('option'); custom.value=''; custom.textContent='自定义 DSL 规格…'; sel.appendChild(custom);
  sel.value = 'eu2020';
});
</script>
<script type="module">
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

function memberBox(model, member, color) {
  const s = member.start, e = member.end;
  const dir = new THREE.Vector3(e.x - s.x, e.y - s.y, e.z - s.z);
  dir.normalize();
  const profile = model.profiles.find((p) => p.id === member.profileId);
  const w = (profile !== undefined ? profile.spec.width : 20) / 1000;
  const h = (profile !== undefined ? profile.spec.height : 20) / 1000;
  const cut = member.cutLength / 1000;
  const geo = new THREE.BoxGeometry(cut, h, w);
  const mat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.55, metalness: 0.25 });
  const mesh = new THREE.Mesh(geo, mat);
  const mid = new THREE.Vector3(s.x / 1000, s.y / 1000, s.z / 1000).addScaledVector(dir, (member.trimStart + member.cutLength / 2) / 1000);
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
      sp.position.set(jt.point.x / 1000, jt.point.y / 1000, jt.point.z / 1000);
      root.add(sp);
    }
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    target.copy(center);
    radius = Math.max(0.8, size.length() * 1.4);
    info.textContent = model.members.length + ' 根杆件、' + model.joints.length + ' 个关节已渲染（包围盒 ' +
      Math.round(size.x * 1000) + '×' + Math.round(size.y * 1000) + '×' + Math.round(size.z * 1000) + ' mm，视口 ' +
      viewer.clientWidth + '×' + viewer.clientHeight + 'px）';
  } catch (e) { errEl.textContent = String(e); }
};
</script>
</body>
</html>
`;
