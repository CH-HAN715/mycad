/**
 * serve 页面：单文件 HTML，零外部资源（不引 CDN，离线可用）。
 * 结果区同时显示引擎 JSON 与错误提示；数值口径与 CLI 完全一致。
 * 前端脚本拆到 clientForm.ts / clientViewer.ts，此处只负责 HTML 骨架与内插。
 */
import { FORM_SCRIPT } from './clientForm.ts';
import { VIEWER_SCRIPT } from './clientViewer.ts';

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
<section class="full" style="padding:10px 16px">
  <div class="row" style="align-items:baseline">
    <strong style="font-size:13px">会话自动保存</strong>
    <span class="hint">停止输入 0.8 秒后落盘，重开页面自动恢复；主文件不可用时改用上一代备份。</span>
  </div>
  <div id="sessionMsg" class="hint" style="margin-top:4px"></div>
</section>
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
<script>${FORM_SCRIPT}</script>
<script type="module">${VIEWER_SCRIPT}</script>
</body>
</html>
`;
