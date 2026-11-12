#!/usr/bin/env node
/**
 * 发布一致性自检。
 *
 * 只做一件事：把过去靠人盯的规矩变成会失败的检查。
 * 任何一项不过就 exit 1，并打印三处实际值的对照表。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const failures = [];
const notes = [];

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

// 1) 版本三处一致：package.json = CHANGELOG 最新已发布标题 = HEAD 上的 tag
const released = [...changelog.matchAll(/^## (v\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
const latestRelease = released[0] ?? null;
if (latestRelease === null) {
  notes.push('CHANGELOG 里还没有任何已发布版本标题，跳过版本一致性检查');
} else if (latestRelease !== `v${pkg.version}`) {
  failures.push({
    check: '版本一致',
    detail: `package.json=${pkg.version}  CHANGELOG 最新已发布=${latestRelease}`,
    fix: '发版时三处必须一字不差：代码版本号、CHANGELOG 标题、git tag',
  });
}
const headTags = (git(['tag', '--points-at', 'HEAD']) ?? '').split('\n').filter(Boolean);
for (const tag of headTags) {
  if (tag.startsWith('v') && tag !== `v${pkg.version}`) {
    failures.push({
      check: 'tag 一致',
      detail: `HEAD 上的 tag=${tag}  package.json=${pkg.version}`,
      fix: 'tag 必须与 CHANGELOG 版本标题、package.json 版本号完全相同',
    });
  }
}

// 2) 许可证与开源状态自洽
const tracked = (git(['-c', 'core.quotepath=false', 'ls-files']) ?? '')
  .split('\n')
  .map((line) => line.replace(/^"|"$/g, ''))
  .filter(Boolean);
if (pkg.license !== 'UNLICENSED' && !tracked.includes('LICENSE')) {
  failures.push({
    check: '许可证',
    detail: `package.json license=${pkg.license} 但仓库没有 LICENSE 文件`,
    fix: '声明的许可证必须有 LICENSE 文件支撑，否则保持 UNLICENSED',
  });
}
if (tracked.includes('.env')) {
  failures.push({ check: '密钥', detail: '.env 被跟踪', fix: '从仓库移除并检查历史是否已泄漏' });
}
for (const file of tracked) {
  const isOurDoc = /^docs\/.*\.md$/i.test(file);
  const badExt = /\.(bindata|scene|chm|exe|dll|msi|ico)$/i.test(file);
  const vendorName = /maycad|framedesigner|maytec/i.test(file) && !isOurDoc;
  if (badExt || vendorName) {
    failures.push({
      check: '版权素材',
      detail: `疑似厂商素材被跟踪：${file}`,
      fix: '禁止搬用原版代码、图标、位图、帮助文本与私有格式内容',
    });
  }
}

// 3) 测试发现陷阱：当前 test 脚本的 glob 只保证一层，嵌套目录会被静默跳过
const walk = (dir, depth = 0) => {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full, depth + 1));
    else if (name.endsWith('.test.ts')) found.push({ full, depth });
  }
  return found;
};
const testFiles = walk(join(ROOT, 'tests'));
const nested = testFiles.filter((f) => f.depth > 0);
if (nested.length > 0) {
  failures.push({
    check: '测试发现',
    detail: `${nested.length} 个嵌套测试文件不在 glob 覆盖范围内：${nested.map((f) => f.full.replace(`${ROOT}/`, '')).join('、')}`,
    fix: '要么把测试放回 tests/ 平层，要么同步修改 package.json 的 test 脚本',
  });
}

// 4) 校核算例必须入库
const beamFixtures = 'src/verify/beamFixtures.ts';
if (!existsSync(join(ROOT, beamFixtures))) {
  failures.push({ check: '算例入库', detail: `缺少 ${beamFixtures}`, fix: '校核改动必须带可手算对照算例入库' });
}

console.log(`mycad 发布自检 · ${testFiles.length} 个测试文件 · 已发布版本 ${latestRelease ?? '无'} · HEAD tag ${headTags.join(',') || '无'}`);
for (const note of notes) console.log(`说明：${note}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL [${f.check}] ${f.detail}\n  → ${f.fix}`);
  console.error(`共 ${failures.length} 项不通过`);
  process.exit(1);
}
console.log('全部通过');
