/**
 * 输入格式的 schema 版本约定。
 *
 * 只给**会被用户长期保存**的对象用（型材规格、连接规则覆盖）；一次性调用体
 * 随引擎版本走，不重复标注。缺省视为当前版本，越界必须给出可执行提示。
 */

export const SCHEMA_VERSION = 1;

/** 返回 null 表示合法；否则返回可直接进错误信息的说明。 */
export function schemaVersionProblem(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `schemaVersion 必须是整数，收到 ${JSON.stringify(value)}`;
  }
  if (value < 1) return `schemaVersion 从 1 起算，收到 ${value}`;
  if (value > SCHEMA_VERSION) {
    return `本引擎只支持 schemaVersion 1..${SCHEMA_VERSION}，收到 ${value}；请升级引擎或改写文件`;
  }
  return null;
}

/** 运行时对象的键名白名单检查，供「未知字段一律拒绝」的入口复用。 */
export function unknownKeyProblem(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return `含未知字段：${key}；允许：${allowed.join('、')}（拼写错误不会被静默忽略）`;
    }
  }
  return null;
}
