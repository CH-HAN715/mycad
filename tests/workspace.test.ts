import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startServe } from '../src/serve/server.ts';
import type { ServeHandle } from '../src/serve/server.ts';
import {
  WorkspaceError,
  defaultStateDir,
  loadWorkspace,
  parseWorkspaceSnapshot,
  saveWorkspace,
  workspacePaths,
} from '../src/serve/workspaceStore.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mycad-workspace-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function snapshot(fields: Record<string, string> = {}, savedAt = '2026-11-12T09:00:00.000Z'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'mycad.workspace',
    savedAt,
    fields: {
      frameText: '{"profiles":[],"members":[]}',
      specText: '{"width":20,"height":20}',
      checkText: '{}',
      cutText: '{}',
      presetId: 'eu2020',
      stockText: '6000',
      kerfText: '3',
      ...fields,
    },
  };
}

function isShapeError(pattern: RegExp): (error: unknown) => boolean {
  return (error) => error instanceof WorkspaceError && error.code === 'E_SHAPE' && pattern.test(error.message);
}

describe('会话快照校验', () => {
  it('合法快照原样通过，缺省 schemaVersion 补当前版本', () => {
    const parsed = parseWorkspaceSnapshot(snapshot());
    assert.equal(parsed.kind, 'mycad.workspace');
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.fields['kerfText'], '3');

    const bare = snapshot();
    delete bare['schemaVersion'];
    assert.equal(parseWorkspaceSnapshot(bare).schemaVersion, 1);
  });

  it('非对象一律拒绝', () => {
    for (const bad of [null, [], 'x', 1]) {
      assert.throws(() => parseWorkspaceSnapshot(bad), isShapeError(/必须是 JSON 对象/));
    }
  });

  it('顶层未知字段拒绝', () => {
    assert.throws(() => parseWorkspaceSnapshot({ ...snapshot(), typo: 1 }), isShapeError(/未知字段：typo/));
  });

  it('fields 未知键拒绝', () => {
    const bad = snapshot();
    (bad['fields'] as Record<string, unknown>)['frameTxt'] = 'x';
    assert.throws(() => parseWorkspaceSnapshot(bad), isShapeError(/未知字段：frameTxt/));
  });

  it('fields 缺键与非字符串拒绝（避免把 undefined 写进输入框）', () => {
    const missing = snapshot();
    delete (missing['fields'] as Record<string, unknown>)['kerfText'];
    assert.throws(() => parseWorkspaceSnapshot(missing), isShapeError(/fields\.kerfText 必须是字符串/));

    const numeric = snapshot();
    (numeric['fields'] as Record<string, unknown>)['stockText'] = 6000;
    assert.throws(() => parseWorkspaceSnapshot(numeric), isShapeError(/fields\.stockText 必须是字符串/));

    assert.throws(() => parseWorkspaceSnapshot({ ...snapshot(), fields: [] }), isShapeError(/fields 必须是对象/));
  });

  it('schemaVersion 越界与非整数拒绝', () => {
    for (const version of [0, 2, 1.5, '1']) {
      assert.throws(() => parseWorkspaceSnapshot({ ...snapshot(), schemaVersion: version }), isShapeError(/schemaVersion/));
    }
  });

  it('kind 不符拒绝', () => {
    assert.throws(() => parseWorkspaceSnapshot({ ...snapshot(), kind: 'mycad.frame' }), isShapeError(/kind 必须是 mycad\.workspace/));
  });

  it('savedAt 非法拒绝', () => {
    for (const savedAt of ['昨天', 123, '']) {
      assert.throws(() => parseWorkspaceSnapshot({ ...snapshot(), savedAt }), isShapeError(/savedAt/));
    }
  });
});

describe('会话快照落盘与恢复', () => {
  it('保存后读回同一份快照，且不留临时文件', async () => {
    const dir = tempDir();
    const paths = workspacePaths(dir);
    const file = await saveWorkspace(dir, snapshot({ frameText: '第一代' }));
    assert.equal(file, paths.main);
    assert.equal(existsSync(paths.temp), false, '原子写完成后不应残留 .tmp');

    const loaded = await loadWorkspace(dir);
    assert.equal(loaded.source, 'main');
    assert.deepEqual(loaded.problems, []);
    assert.equal(loaded.snapshot?.fields['frameText'], '第一代');
    assert.equal(loaded.file, paths.main);
  });

  it('第二代保存后，备份保留上一代', async () => {
    const dir = tempDir();
    const paths = workspacePaths(dir);
    await saveWorkspace(dir, snapshot({ frameText: '第一代' }, '2026-11-12T09:00:00.000Z'));
    await saveWorkspace(dir, snapshot({ frameText: '第二代' }, '2026-11-12T10:00:00.000Z'));

    const loaded = await loadWorkspace(dir);
    assert.equal(loaded.snapshot?.fields['frameText'], '第二代');
    const backup = JSON.parse(readFileSync(paths.backup, 'utf8')) as { fields: { frameText: string } };
    assert.equal(backup.fields.frameText, '第一代');
  });

  it('主文件损坏时回落备份，且不覆盖坏文件', async () => {
    const dir = tempDir();
    const paths = workspacePaths(dir);
    await saveWorkspace(dir, snapshot({ frameText: '第一代' }));
    await saveWorkspace(dir, snapshot({ frameText: '第二代' }));
    writeFileSync(paths.main, '{ 半截文件', 'utf8');

    const loaded = await loadWorkspace(dir);
    assert.equal(loaded.source, 'backup');
    assert.equal(loaded.snapshot?.fields['frameText'], '第一代');
    assert.ok(loaded.problems.some((p) => p.includes('主文件不可用')), `problems 应说明主文件问题：${loaded.problems.join('；')}`);
    assert.ok(loaded.problems.some((p) => p.includes('已改用上一代备份')));
    assert.equal(readFileSync(paths.main, 'utf8'), '{ 半截文件', '恢复只读不写，坏文件留作排查');
  });

  it('主文件缺失（轮换中途崩溃）时回落备份', async () => {
    const dir = tempDir();
    const paths = workspacePaths(dir);
    await saveWorkspace(dir, snapshot({ frameText: '第一代' }));
    await saveWorkspace(dir, snapshot({ frameText: '第二代' }));
    rmSync(paths.main);

    const loaded = await loadWorkspace(dir);
    assert.equal(loaded.source, 'backup');
    assert.equal(loaded.snapshot?.fields['frameText'], '第一代');
  });

  it('两代都没有时返回空快照，不报错也不建目录', async () => {
    const dir = join(tempDir(), '尚未创建');
    const loaded = await loadWorkspace(dir);
    assert.equal(loaded.snapshot, null);
    assert.equal(loaded.source, null);
    assert.deepEqual(loaded.problems, []);
    assert.equal(existsSync(dir), false);
  });

  it('两代都损坏时报告问题而不抛异常', async () => {
    const dir = tempDir();
    const paths = workspacePaths(dir);
    writeFileSync(paths.main, 'not json', 'utf8');
    writeFileSync(paths.backup, '{"kind":"别的文件"}', 'utf8');
    const loaded = await loadWorkspace(dir);
    assert.equal(loaded.snapshot, null);
    assert.equal(loaded.problems.length, 2);
  });

  it('校验失败不写盘：非法快照不会毁掉已有主文件', async () => {
    const dir = tempDir();
    const paths = workspacePaths(dir);
    await saveWorkspace(dir, snapshot({ frameText: '完好一代' }));
    await assert.rejects(saveWorkspace(dir, { ...snapshot(), typo: 1 }), isShapeError(/未知字段/));
    const loaded = await loadWorkspace(dir);
    assert.equal(loaded.snapshot?.fields['frameText'], '完好一代');
    assert.equal(existsSync(paths.backup), false);
  });

  it('目录不可写时给 E_WORKSPACE_IO，而不是静默失败', async () => {
    const fileAsDir = join(tempDir(), '占位文件');
    writeFileSync(fileAsDir, 'x', 'utf8');
    await assert.rejects(
      saveWorkspace(fileAsDir, snapshot()),
      (error) => error instanceof WorkspaceError && error.code === 'E_WORKSPACE_IO' && error.hint.includes(fileAsDir),
    );
  });

  it('状态目录跟随 XDG_STATE_HOME', () => {
    const original = process.env['XDG_STATE_HOME'];
    try {
      process.env['XDG_STATE_HOME'] = '/tmp/mycad-xdg-probe';
      assert.equal(defaultStateDir(), '/tmp/mycad-xdg-probe/mycad');
      delete process.env['XDG_STATE_HOME'];
      assert.equal(defaultStateDir(), join(homedir(), '.local', 'state', 'mycad'), '缺省应落在用户状态目录，不在仓库里');
    } finally {
      if (original === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = original;
    }
  });
});

describe('serve 的会话接口', () => {
  let handle: ServeHandle;
  let base: string;
  let dir: string;

  before(async () => {
    dir = tempDir();
    handle = await startServe({ port: 0, stateDir: dir });
    base = `http://127.0.0.1:${handle.port}`;
  });
  after(() => handle.close());

  async function postWorkspace(body: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${base}/api/workspace`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }

  it('GET 空会话返回 snapshot:null 与落盘位置', async () => {
    const r = await fetch(`${base}/api/workspace`);
    assert.equal(r.status, 200);
    const j = (await r.json()) as { ok: boolean; snapshot: unknown; source: unknown; file: string };
    assert.equal(j.ok, true);
    assert.equal(j.snapshot, null);
    assert.equal(j.source, null);
    assert.equal(j.file, workspacePaths(dir).main);
  });

  it('POST 后 GET 往返一致', async () => {
    const saved = await postWorkspace(JSON.stringify(snapshot({ frameText: '网页输入' })));
    assert.equal(saved.status, 200);
    assert.equal(saved.json.ok, true);
    assert.equal(saved.json.file, workspacePaths(dir).main);

    const r = await fetch(`${base}/api/workspace`);
    const j = (await r.json()) as { source: string; snapshot: { fields: { frameText: string } } };
    assert.equal(j.source, 'main');
    assert.equal(j.snapshot.fields.frameText, '网页输入');
  });

  it('POST 未知字段 400，且不覆盖已保存的会话', async () => {
    const bad = await postWorkspace(JSON.stringify({ ...snapshot({ frameText: '不该落盘' }), typo: 1 }));
    assert.equal(bad.status, 400);
    assert.equal(bad.json.ok, false);
    assert.match(String(bad.json.message), /未知字段/);

    const r = await fetch(`${base}/api/workspace`);
    const j = (await r.json()) as { snapshot: { fields: { frameText: string } } };
    assert.equal(j.snapshot.fields.frameText, '网页输入');
  });

  it('POST schemaVersion 越界 400', async () => {
    const bad = await postWorkspace(JSON.stringify({ ...snapshot(), schemaVersion: 99 }));
    assert.equal(bad.status, 400);
    assert.match(String(bad.json.message), /schemaVersion/);
  });

  it('POST 坏 JSON 走 E_JSON 口径', async () => {
    const bad = await postWorkspace('{ 半截');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'E_JSON');
  });

  it('页面含会话 UI 与自动保存脚本', async () => {
    const text = await (await fetch(`${base}/`)).text();
    assert.ok(text.includes('id="sessionMsg"'), '页面应有会话状态元素');
    assert.ok(text.includes('function saveWorkspace()'), '表单脚本应已内插');
    assert.ok(text.includes('restoreWorkspace();'), '启动时应触发恢复');
    assert.ok(text.includes('window.render3d'), '3D 脚本应已内插');
    assert.ok(!text.includes('${'), '模板插值不应泄漏到页面');
  });

  it('未知 API 的提示里列出 workspace', async () => {
    const r = await fetch(`${base}/api/nope`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 404);
    const j = (await r.json()) as { hint: string };
    assert.ok(j.hint.includes('workspace'));
  });
});