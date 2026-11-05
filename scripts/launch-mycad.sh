#!/usr/bin/env bash
# mycad 本地网页设计台启动器：双击或命令行调用均可。
# 用法：launch-mycad.sh [额外 serve 参数，如 --port 8700]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。mycad 需要 Node.js 22+（当前开发用 v22 LTS）。" >&2
  exit 1
fi

exec node --disable-warning=ExperimentalWarning "$DIR/src/cli/main.ts" serve --open "$@"
