/**
 * 页面表单脚本（普通 script，非模块），由 page.ts 内插。
 * 会话自动保存：所有用户输入即状态，input 事件 debounce 后 POST /api/workspace，
 * 启动时 GET 恢复。恢复失败只提示，不覆盖服务端文件。
 */
export const FORM_SCRIPT = `
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

const SESSION_FIELDS = {frameText:'frameBox', specText:'specBox', checkText:'checkBox', cutText:'cutBox', presetId:'presetSel', stockText:'stockInp', kerfText:'kerfInp'};
function sessionMsg(text){ document.getElementById('sessionMsg').textContent = text; }
function sessionSnapshot() {
  const fields = {};
  for (const key of Object.keys(SESSION_FIELDS)) fields[key] = document.getElementById(SESSION_FIELDS[key]).value;
  return {schemaVersion:1, kind:'mycad.workspace', savedAt:new Date().toISOString(), fields:fields};
}
let saveTimer = null;
function saveWorkspace() {
  saveTimer = null;
  fetch('/api/workspace', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(sessionSnapshot())})
    .then(r=>r.json())
    .then(j=>{ if (j.ok === false) sessionMsg('自动保存失败：' + j.message); else sessionMsg('已自动保存 ' + new Date().toLocaleTimeString('zh-CN')); })
    .catch(e=>sessionMsg('自动保存失败：' + e));
}
function scheduleSave(){ if (saveTimer !== null) clearTimeout(saveTimer); saveTimer = setTimeout(saveWorkspace, 800); }
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t && t.id && Object.values(SESSION_FIELDS).includes(t.id)) scheduleSave();
});
window.addEventListener('beforeunload', () => {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  fetch('/api/workspace', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(sessionSnapshot()), keepalive:true});
});
function restoreWorkspace() {
  fetch('/api/workspace').then(r=>r.json()).then(j=>{
    if (j.ok === false) { sessionMsg('会话恢复失败：' + j.message); return; }
    const notes = [];
    if (j.snapshot) {
      for (const key of Object.keys(SESSION_FIELDS)) document.getElementById(SESSION_FIELDS[key]).value = j.snapshot.fields[key];
      notes.push('已恢复会话（' + j.snapshot.savedAt + (j.source === 'backup' ? '，主文件不可用，改自上一代备份' : '') + '）');
    }
    if (j.problems && j.problems.length) notes.push(j.problems.join('；'));
    if (j.file) notes.push('落盘位置：' + j.file);
    sessionMsg(notes.join(' · '));
  }).catch(e=>sessionMsg('会话恢复失败：' + e));
}
fetch('/api/presets').then(r=>r.json()).then(j=>{
  const sel = document.getElementById('presetSel');
  for (const p of j.presets) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.id + ' — ' + p.title; sel.appendChild(o); }
  const custom = document.createElement('option'); custom.value=''; custom.textContent='自定义 DSL 规格…'; sel.appendChild(custom);
  sel.value = 'eu2020';
  restoreWorkspace();
});
`;