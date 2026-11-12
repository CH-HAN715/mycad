/**
 * 网页设计台的会话快照落盘：原子写 + 上一代备份。
 *
 * 只存用户输入的文本，不存引擎结果——结果可由同源引擎随时重算，存下来只会制造两份真相。
 * 校验口径与型材规格一致：未知字段一律拒绝，schemaVersion 越界直接拒绝。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, schemaVersionProblem, unknownKeyProblem } from '../geom/schema.ts';

export const WORKSPACE_KIND = 'mycad.workspace';

export const WORKSPACE_FIELDS = [
  'frameText',
  'specText',
  'checkText',
  'cutText',
  'presetId',
  'stockText',
  'kerfText',
] as const;

export type WorkspaceField = (typeof WORKSPACE_FIELDS)[number];

export interface WorkspaceSnapshot {
  readonly schemaVersion: number;
  readonly kind: typeof WORKSPACE_KIND;
  readonly savedAt: string;
  readonly fields: Readonly<Record<WorkspaceField, string>>;
}

export interface WorkspaceLoad {
  readonly snapshot: WorkspaceSnapshot | null;
  readonly source: 'main' | 'backup' | null;
  readonly problems: readonly string[];
  readonly file: string;
}

export class WorkspaceError extends Error {
  readonly code: string;
  readonly hint: string;

  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/** 用户级状态目录，跟随 XDG；不落在仓库里，避免设计数据被误提交。 */
export function defaultStateDir(): string {
  return join(process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state'), 'mycad');
}

export function workspacePaths(dir: string): { main: string; backup: string; temp: string } {
  const main = join(dir, 'workspace.json');
  return { main, backup: `${main}.bak`, temp: `${main}.tmp` };
}

function fail(message: string, hint: string): never {
  throw new WorkspaceError('E_SHAPE', message, hint);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('会话快照必须是 JSON 对象', '形如 {"schemaVersion":1,"kind":"mycad.workspace","savedAt":"…","fields":{…}}');
  }
  const record = value as Record<string, unknown>;
  const unknown = unknownKeyProblem(record, ['schemaVersion', 'kind', 'savedAt', 'fields']);
  if (unknown !== null) fail(`会话快照${unknown}`, '允许的字段：schemaVersion、kind、savedAt、fields');
  const versionProblem = schemaVersionProblem(record['schemaVersion']);
  if (versionProblem !== null) fail(`会话快照 ${versionProblem}`, `缺省即视为 v${SCHEMA_VERSION}，可不写该字段`);
  if (record['kind'] !== WORKSPACE_KIND) {
    fail(`kind 必须是 ${WORKSPACE_KIND}，收到 ${JSON.stringify(record['kind'])}`, '别的文件不能当会话快照套用');
  }
  const savedAt = record['savedAt'];
  if (typeof savedAt !== 'string' || !Number.isFinite(Date.parse(savedAt))) {
    fail('savedAt 必须是可解析的时间字符串', '形如 2026-11-12T09:00:00.000Z');
  }
  const fieldsRaw = record['fields'];
  if (typeof fieldsRaw !== 'object' || fieldsRaw === null || Array.isArray(fieldsRaw)) {
    fail('fields 必须是对象', `键：${WORKSPACE_FIELDS.join('、')}`);
  }
  const fields = fieldsRaw as Record<string, unknown>;
  const fieldUnknown = unknownKeyProblem(fields, WORKSPACE_FIELDS);
  if (fieldUnknown !== null) fail(`fields ${fieldUnknown}`, `允许的键：${WORKSPACE_FIELDS.join('、')}`);
  for (const key of WORKSPACE_FIELDS) {
    if (typeof fields[key] !== 'string') {
      fail(`fields.${key} 必须是字符串（空串合法）`, '缺键会让恢复把 undefined 写进输入框，一律拒绝');
    }
  }
  return {
    // 落盘文件必须自带版本号，缺省时补当前版本，不依赖读取方猜测。
    schemaVersion: record['schemaVersion'] === undefined ? SCHEMA_VERSION : (record['schemaVersion'] as number),
    kind: WORKSPACE_KIND,
    savedAt,
    fields: fields as Record<WorkspaceField, string>,
  };
}

async function readSnapshot(file: string, label: string, problems: string[]): Promise<WorkspaceSnapshot | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`${label}读取失败：${errorText(error)}`);
    return null;
  }
  try {
    return parseWorkspaceSnapshot(JSON.parse(text) as unknown);
  } catch (error) {
    problems.push(`${label}不可用：${errorText(error)}`);
    return null;
  }
}

/** 恢复失败只报告，不写盘：坏文件留着供人工排查，覆盖会把仅存的一代也毁掉。 */
export async function loadWorkspace(dir: string): Promise<WorkspaceLoad> {
  const { main, backup } = workspacePaths(dir);
  const problems: string[] = [];
  const current = await readSnapshot(main, '主文件', problems);
  if (current !== null) return { snapshot: current, source: 'main', problems, file: main };
  const previous = await readSnapshot(backup, '上一代备份', problems);
  if (previous !== null) {
    problems.push(`已改用上一代备份：${backup}`);
    return { snapshot: previous, source: 'backup', problems, file: main };
  }
  return { snapshot: null, source: null, problems, file: main };
}

async function rotateBackup(main: string, backup: string): Promise<void> {
  try {
    await rename(main, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function saveWorkspace(dir: string, value: unknown): Promise<string> {
  const snapshot = parseWorkspaceSnapshot(value);
  const { main, backup, temp } = workspacePaths(dir);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    // 顺序不可调换：临时文件先写全，再把主文件轮换成备份，最后原子就位。
    // 任一步崩掉，主文件要么是完整旧版要么是完整新版，半截文件只会出现在 .tmp。
    await rotateBackup(main, backup);
    await rename(temp, main);
  } catch (error) {
    throw new WorkspaceError('E_WORKSPACE_IO', `会话保存失败：${errorText(error)}`, `目标：${main}；检查目录权限与磁盘空间`);
  }
  return main;
}