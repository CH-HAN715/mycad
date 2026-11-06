/**
 * mycad serve —— 本地 HTTP 壳（路线 A：浏览器界面，零新依赖）。
 *
 * 契约：
 * - 只监听 127.0.0.1；无鉴权，不对外网开放。
 * - 所有 /api/* 返回单份 JSON：成功 {ok:true,...}，失败 {ok:false,code,message,hint}。
 * - 直接调用引擎层函数，与 CLI 共用同一套解析与校验（未知字段一律拒绝）。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { GeometryInputError } from '../geom/polygon.ts';
import { buildProfile, parseProfileSpec } from '../geom/profile.ts';
import { unknownKeyProblem } from '../geom/schema.ts';
import { PROFILE_PRESETS, findProfilePreset } from '../geom/presets.ts';
import { sectionProperties } from '../geom/inertia.ts';
import { sectionToDxf } from '../io/dxf.ts';
import type { CircleSpec } from '../io/dxf.ts';
import { FrameInputError, buildFrame, parseFrameInput } from '../frame/model.ts';
import { ConnectError, parseConnectInput, planConnections } from '../connect/plan.ts';
import { CheckError, parseCheckInput, runCheck } from '../check/beam.ts';
import { buildBom } from '../production/bom.ts';
import { CutInputError, planCuts } from '../production/cutPlan.ts';
import type { CutOptions, CutPieceInput } from '../production/cutPlan.ts';
import { PAGE_HTML } from './page.ts';

const MAX_BODY_BYTES = 2_000_000;

class ServeError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly status: number;

  constructor(code: string, message: string, hint: string, status = 400) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

function engineErrorInfo(error: unknown): { code: string; message: string; hint: string; status: number } {
  if (error instanceof ServeError) return { code: error.code, message: error.message, hint: error.hint, status: error.status };
  if (error instanceof FrameInputError || error instanceof ConnectError || error instanceof CheckError || error instanceof CutInputError) {
    const e = error as { message: string; hint?: string; reason?: string };
    return { code: e.reason ?? 'E_INPUT', message: e.message, hint: e.hint ?? '', status: 400 };
  }
  if (error instanceof GeometryInputError) {
    return { code: 'E_GEOMETRY', message: error.message, hint: error.hint ?? '', status: 400 };
  }
  if (error instanceof SyntaxError) {
    return { code: 'E_JSON', message: `JSON 解析失败：${error.message}`, hint: '请求体必须是合法 JSON', status: 400 };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'E_INTERNAL', message, hint: '', status: 500 };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ServeError('E_TOO_LARGE', '请求体超过 2MB 上限', '框架规模超出本地工具预期，拆分后提交'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string, contentType: string, filename?: string): void {
  const headers: Record<string, string> = { 'content-type': contentType, 'cache-control': 'no-store' };
  if (filename !== undefined) headers['content-disposition'] = `attachment; filename="${filename}"`;
  res.writeHead(status, headers);
  res.end(text);
}

function bodyRecord(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ServeError('E_SHAPE', '请求体必须是 JSON 对象', '形如 {"profileSpec": {...}}');
  }
  return parsed as Record<string, unknown>;
}

function sectionGeometry(raw: unknown): { outer: ReturnType<typeof buildProfile>['outer']; holes: ReturnType<typeof buildProfile>['holes']; presetId: string | null } {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'presetProfile' in raw) {
    const id = (raw as { presetProfile: unknown }).presetProfile;
    if (typeof id !== 'string' || findProfilePreset(id) === undefined) {
      throw new ServeError('E_PRESET', `未知型材预设：${String(id)}`, `可用：${PROFILE_PRESETS.map((p) => p.id).join('、')}`);
    }
    const preset = findProfilePreset(id)!;
    const geometry = buildProfile(preset.spec);
    return { outer: geometry.outer, holes: geometry.holes, presetId: id };
  }
  const geometry = buildProfile(parseProfileSpec(raw));
  return { outer: geometry.outer, holes: geometry.holes, presetId: null };
}

/** API 入参：profileSpec 给 DSL 对象，presetProfile 给预设 id 字符串，二选一。 */
function sectionSource(input: Record<string, unknown>): unknown {
  const spec = input['profileSpec'];
  const preset = input['presetProfile'];
  if (spec !== undefined && preset !== undefined) {
    throw new ServeError('E_SHAPE', 'profileSpec 与 presetProfile 只能选一个', 'DSL 对象或预设 id 字符串');
  }
  if (typeof preset === 'string') return { presetProfile: preset };
  if (spec !== undefined) return spec;
  throw new ServeError('E_SHAPE', '缺少 profileSpec 或 presetProfile', '{"presetProfile":"eu2020"} 或 {"profileSpec":{...}}');
}

async function handleApi(path: string, body: string, res: ServerResponse): Promise<void> {
  if (path === 'section') {
    const input = bodyRecord(body);
    const { outer, holes, presetId } = sectionGeometry(sectionSource(input));
    const props = sectionProperties(outer, holes);
    const preset = presetId === null ? null : findProfilePreset(presetId);
    sendJson(res, 200, { ok: true, result: props, ...(preset !== null ? { profilePreset: preset } : {}) });
    return;
  }
  if (path === 'frame') {
    const model = buildFrame(parseFrameInput(JSON.parse(body) as unknown));
    sendJson(res, 200, { ok: true, model });
    return;
  }
  if (path === 'connect') {
    const parsed = parseConnectInput(JSON.parse(body) as unknown);
    const plan = planConnections(buildFrame(parsed.frame), parsed.options);
    sendJson(res, 200, { ok: true, plan });
    return;
  }
  if (path === 'bom') {
    const input = bodyRecord(body);
    const model = buildFrame(parseFrameInput(input['frame'] ?? input));
    const optionsRaw = input['options'];
    let cutOptions: CutOptions | undefined;
    if (typeof optionsRaw === 'object' && optionsRaw !== null) {
      const o = optionsRaw as Record<string, unknown>;
      const problem = unknownKeyProblem(o, ['stockMm', 'kerfMm']);
      if (problem !== null) throw new ServeError('E_SHAPE', `bom options ${problem}`, '允许的字段：stockMm、kerfMm');
      const hasStock = typeof o['stockMm'] === 'number';
      const hasKerf = typeof o['kerfMm'] === 'number';
      if (hasStock !== hasKerf) {
        throw new ServeError('E_SHAPE', 'stockMm 与 kerfMm 必须同时给出', '没有锯缝请写 kerfMm:0，不会静默按 0 处理');
      }
      if (hasStock && hasKerf) cutOptions = { stockLengthMm: o['stockMm'] as number, kerfMm: o['kerfMm'] as number };
    }
    sendJson(res, 200, { ok: true, bom: buildBom(model, cutOptions) });
    return;
  }
  if (path === 'check') {
    const result = runCheck(parseCheckInput(JSON.parse(body) as unknown));
    sendJson(res, 200, { ok: true, result });
    return;
  }
  if (path === 'cut') {
    const input = bodyRecord(body);
    const pieces = input['pieces'];
    const optionsRaw = input['options'];
    if (!Array.isArray(pieces) || typeof optionsRaw !== 'object' || optionsRaw === null) {
      throw new ServeError('E_SHAPE', '需要 pieces 数组与 options 对象', '{"pieces":[{"id":"a","lengthMm":600,"quantity":2}],"options":{"stockLengthMm":6000,"kerfMm":3}}');
    }
    const cutProblem = unknownKeyProblem(optionsRaw as Record<string, unknown>, [
      'stockLengthMm',
      'kerfMm',
      'maxPieces',
    ]);
    if (cutProblem !== null) {
      throw new ServeError('E_SHAPE', `cut options ${cutProblem}`, '允许的字段：stockLengthMm、kerfMm、maxPieces');
    }
    const options = optionsRaw as unknown as CutOptions;
    sendJson(res, 200, { ok: true, plan: planCuts(pieces as CutPieceInput[], options) });
    return;
  }
  if (path === 'dxf-section') {
    const input = bodyRecord(body);
    const { outer, holes } = sectionGeometry(sectionSource(input));
    const circlesRaw = input['circles'];
    if (Array.isArray(circlesRaw)) {
      for (const [i, circle] of circlesRaw.entries()) {
        if (typeof circle !== 'object' || circle === null) {
          throw new ServeError('E_SHAPE', `circles[${i}] 必须是对象`, '形如 {"center":[x,y],"diameter":6.5}');
        }
        const problem = unknownKeyProblem(circle as Record<string, unknown>, ['center', 'diameter']);
        if (problem !== null) throw new ServeError('E_SHAPE', `circles[${i}] ${problem}`, '允许的字段：center、diameter');
      }
    }
    const circles = (Array.isArray(circlesRaw) ? circlesRaw : []) as CircleSpec[];
    const text = sectionToDxf(outer, holes, circles.length > 0 ? { circles } : {});
    sendText(res, 200, text, 'application/dxf', 'section.dxf');
    return;
  }
  throw new ServeError('E_ROUTE', `未知 API：${path}`, '可用：section、frame、connect、bom、check、cut、dxf-section', 404);
}

export interface ServeHandle {
  readonly port: number;
  close(): Promise<void>;
}

export function startServe(options: { port: number; host?: string }): Promise<ServeHandle> {
  const host = options.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const path = url.pathname;
    void (async () => {
      try {
        if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
          sendText(res, 200, PAGE_HTML, 'text/html; charset=utf-8');
          return;
        }
        if (req.method === 'GET' && path === '/api/presets') {
          sendJson(res, 200, { ok: true, presets: PROFILE_PRESETS });
          return;
        }
        if (req.method === 'GET' && path === '/vendor/three.module.js') {
          const file = readFileSync(new URL('./vendor/three.module.js', import.meta.url), 'utf8');
          sendText(res, 200, file, 'text/javascript; charset=utf-8');
          return;
        }
        if (req.method === 'POST' && path.startsWith('/api/')) {
          await handleApi(path.slice('/api/'.length), await readBody(req), res);
          return;
        }
        sendJson(res, 404, { ok: false, code: 'E_ROUTE', message: `未知路径：${path}`, hint: '页面在 /，API 在 /api/*' });
      } catch (error) {
        const info = engineErrorInfo(error);
        sendJson(res, info.status, { ok: false, ...info });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
