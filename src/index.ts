/**
 * 包入口。`package.json` 的 exports 指向这里与 ./geom。
 * 只导出已实现且经验证的层，未实现的层不预留空壳。
 */
export * from './geom/index.ts';
export * from './frame/index.ts';
export * from './connect/index.ts';
export * from './production/index.ts';
export * from './check/index.ts';
export * from './io/index.ts';
export * from './report/sectionReport.ts';
