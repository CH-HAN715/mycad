import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sectionProperties } from '../src/geom/inertia.ts';
import { v2 } from '../src/geom/polygon.ts';
import { buildProfile } from '../src/geom/profile.ts';
import { SYN_2020_SPEC } from '../src/verify/fixtures.ts';
import { buildSectionReport, renderSectionReportMarkdown, serializeSectionValues } from '../src/report/sectionReport.ts';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], input?: string): RunResult {
  const options: { encoding: 'utf8'; input?: string } = { encoding: 'utf8' };
  if (input !== undefined) options.input = input;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], options);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function synthReport() {
  const geometry = buildProfile(SYN_2020_SPEC);
  const properties = sectionProperties(geometry.outer, geometry.holes);
  return buildSectionReport({
    source: 'preset:syn-2020-ideal',
    version: '0.0.0',
    properties,
    profile: { spec: SYN_2020_SPEC, meta: geometry.meta },
  });
}

describe('截面报告', () => {
  it('Markdown 含结果、公式、校验、假设、局限与免责', () => {
    const markdown = renderSectionReportMarkdown(synthReport());
    assert.ok(markdown.startsWith('# 截面特性报告'));
    assert.ok(markdown.includes('| 面积 A |'));
    assert.ok(markdown.includes('mm^2'));
    assert.ok(markdown.includes('## 公式'));
    assert.ok(markdown.includes('## 校验状态'));
    assert.ok(markdown.includes('## 假设'));
    assert.ok(markdown.includes('## 局限'));
    assert.ok(markdown.includes('## 免责'));
    assert.ok(markdown.includes('不得用于免除结构校核责任'));
  });

  it('型材报告包含模型参数与未建模项', () => {
    const markdown = renderSectionReportMarkdown(synthReport());
    assert.ok(markdown.includes('## 型材模型'));
    assert.ok(markdown.includes('20 × 20 mm'));
    assert.ok(markdown.includes('4 个'));
    assert.ok(markdown.includes('未建模'));
    assert.ok(markdown.includes('圆角与倒角'));
  });

  it('结果数值来自同一份序列化，不重复实现', () => {
    const geometry = buildProfile(SYN_2020_SPEC);
    const properties = sectionProperties(geometry.outer, geometry.holes);
    const report = buildSectionReport({ source: 'x', version: '0.0.0', properties });
    assert.deepEqual(report.result, serializeSectionValues(properties));
    assert.equal((report.result as { area: number }).area, 225.681087681);
  });

  it('无型材规格时 profile 为 null，报告仍完整', () => {
    const properties = sectionProperties([v2(-10, -10), v2(10, -10), v2(10, 10), v2(-10, 10)]);
    const report = buildSectionReport({ source: 'stdin', version: '0.0.0', properties });
    assert.equal(report.profile, null);
    const markdown = renderSectionReportMarkdown(report);
    assert.ok(!markdown.includes('## 型材模型'));
    assert.ok(markdown.includes('## 免责'));
  });

  it('各向同性截面的主轴角标注为任意，不编造角度', () => {
    const markdown = renderSectionReportMarkdown(synthReport());
    assert.ok(markdown.includes('任意（imax ≈ imin）'));
  });
});

describe('mycad report', () => {
  it('--preset 生成 Markdown 到 stdout', () => {
    const result = run(['report', '--preset', 'syn-2020-ideal']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('# 截面特性报告'));
    assert.ok(result.stdout.includes('preset:syn-2020-ideal'));
    assert.ok(result.stdout.includes('225.681087681'));
  });

  it('--json 输出机器可读报告', () => {
    const result = run(['report', '--json', '--preset', 'tube-40x20-t3']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      report: { result: { area: number }; formulas: readonly string[]; disclaimer: string };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'report');
    assert.equal(payload.report.result.area, 324);
    assert.ok(payload.report.formulas.length > 0);
    assert.ok(payload.report.disclaimer.length > 0);
  });

  it('--out 写入文件并自动创建父目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mycad-report-'));
    try {
      const out = join(dir, 'nested', 'report.md');
      const result = run(['report', '--preset', 'syn-2020-ideal', '--out', out]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(out));
      const text = readFileSync(out, 'utf8');
      assert.ok(text.includes('# 截面特性报告'));
      assert.ok(text.includes('225.681087681'));
      assert.ok(result.stdout.includes(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--out 仅适用于 report', () => {
    const result = run(['section', '--json', '--out', '/tmp/x.md'], '{}');
    assert.equal(result.status, 2);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, 'E_USAGE');
  });

  it('report 也接受 stdin 的几何 JSON', () => {
    const input = JSON.stringify({ outer: [[0, 0], [40, 0], [40, 20], [0, 20]], holes: [] });
    const result = run(['report', '--json'], input);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { report: { result: { area: number }; source: string } };
    assert.equal(payload.report.result.area, 800);
    assert.equal(payload.report.source, 'stdin');
  });

  it('非法输入走结构化错误，退出码 2', () => {
    const result = run(['report', '--json'], '{"outer": [[0,0],[10,10],[10,0],[0,10]]}');
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout) as { ok: boolean; error: { reason: string } };
    assert.equal(payload.ok, false);
    assert.equal(payload.error.reason, 'self_intersection');
  });
});
