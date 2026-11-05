#!/usr/bin/env bash
# 安装 mycad 桌面启动项（~/.local/share/applications），使其出现在应用菜单。
# 双击行为由桌面环境决定；若从文件管理器双击脚本本体，需在其属性中勾选「允许运行」。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS"

cat > "$APPS/mycad.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=mycad 铝型材设计台
Comment=本地铝型材框架设计（截面/连接/校核/BOM/DXF）
Exec=$DIR/scripts/launch-mycad.sh
Path=$DIR
Icon=text-x-python
Terminal=false
Categories=Engineering;CAD;
EOF

chmod +x "$DIR/scripts/launch-mycad.sh"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS" 2>/dev/null || true
fi

echo "已写入 $APPS/mycad.desktop"
echo "在应用菜单搜索 mycad 即可启动；服务地址 http://127.0.0.1:8617/"
