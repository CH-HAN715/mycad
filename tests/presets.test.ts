import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildProfile, parseProfileSpec } from '../src/geom/profile.ts';
import { PROFILE_PRESETS, findProfilePreset, presetIds } from '../src/geom/presets.ts';
import { sectionProperties } from '../src/geom/inertia.ts';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

function run(args: readonly string[], input?: string) {
  const options: { encoding: 'utf8'; input?: string } = { encoding: 'utf8' };
  if (input !== undefined) options.input = input;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], options);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('型材预设数据', () => {
  it('每个预设都能构建且净面积为正', () => {
    for (const preset of PROFILE_PRESETS) {
      const geometry = buildProfile(parseProfileSpec(preset.spec));
      const props = sectionProperties(geometry.outer, geometry.holes);
      assert.ok(props.area > 0, `${preset.id} 面积应为正`);
    }
  });

  it('eu2020 理想化 Ix 相对米思米公布值偏大 15%–35%（空心腔未建模的已知方向）', () => {
    const preset = findProfilePreset('eu2020');
    assert.ok(preset !== undefined && preset.reference !== undefined);
    const geometry = buildProfile(preset.spec);
    const props = sectionProperties(geometry.outer, geometry.holes);
    const ratio = props.ix / preset.reference.ixMm4!;
    assert.ok(ratio > 1.15 && ratio < 1.35, `偏差方向应为系统性偏大，实际比值 ${ratio.toFixed(3)}`);
  });

  it('预设来源带核对日期与 URL（AGENTS.md 五.1）', () => {
    for (const preset of PROFILE_PRESETS) {
      if (preset.reference === undefined) continue;
      assert.match(preset.reference.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(preset.reference.sourceUrl.startsWith('https://'));
    }
  });

  it('未知 id 查找返回 undefined', () => {
    assert.equal(findProfilePreset('nope'), undefined);
    assert.deepEqual(presetIds(), ['eu2020', 'eu4040']);
  });
});

describe('mycad presets / --preset-profile', () => {
  it('presets --json 输出全部预设', () => {
    const result = run(['presets', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { ok: boolean; presets: { id: string; unverifiedFields: string[] }[] };
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.presets.map((p) => p.id), ['eu2020', 'eu4040']);
  });

  it('section --preset-profile eu2020 附带 profilePreset 与厂家值', () => {
    const result = run(['section', '--json', '--preset-profile', 'eu2020']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      input: { source: string };
      result: { ix: number };
      profilePreset: { reference: { ixMm4: number; sourceUrl: string } };
    };
    assert.equal(payload.input.source, 'preset-profile:eu2020');
    assert.equal(payload.profilePreset.reference.ixMm4, 7200);
    assert.ok(payload.result.ix > 7200);
  });

  it('未知预设 id 退出码 2 并列出可用', () => {
    const result = run(['section', '--preset-profile', 'eu9999']);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('eu2020'), result.stderr);
  });

  it('--preset-profile 与 --file 互斥', () => {
    const result = run(['section', '--preset-profile', 'eu2020', '--file', 'x.json']);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('只能选一个'), result.stderr);
  });

  it('dxf --preset-profile eu2020 输出实体', () => {
    const result = run(['dxf', '--preset-profile', 'eu2020']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('LINE'));
  });
});
