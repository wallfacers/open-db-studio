#!/bin/bash
# WSL2 中文支持启动脚本 - 使用 ibus

# 设置字体目录
export FONTCONFIG_PATH=/etc/fonts

# 设置locale
export LANG=zh_CN.UTF-8
export LC_ALL=zh_CN.UTF-8

# 强制使用 X11 后端
export GDK_BACKEND=x11
export QT_QPA_PLATFORM=xcb

# 设置输入法环境变量（使用 ibus）
export GTK_IM_MODULE=ibus
export QT_IM_MODULE=ibus
export XMODIFIERS=@im=ibus
export SDL_IM_MODULE=ibus
export GLFW_IM_MODULE=ibus

# WebKit/GTK 特定设置
export WEBKIT_DISABLE_COMPOSITING_MODE=1

# 禁用 Wayland
unset WAYLAND_DISPLAY

# 停止旧的输入法进程
pkill -9 fcitx 2>/dev/null
pkill -9 fcitx5 2>/dev/null
pkill -9 ibus-daemon 2>/dev/null
sleep 1

# 启动 ibus 守护进程
echo "启动 ibus..."
ibus-daemon -d -r --xim
sleep 2

# 检查 ibus 是否运行
if pgrep -x "ibus-daemon" > /dev/null; then
    echo "✓ ibus 已启动"
    # 添加拼音输入法
    ibus engine libpinyin 2>/dev/null || true
else
    echo "✗ ibus 启动失败"
fi

echo ""
echo "输入法环境:"
echo "  GTK_IM_MODULE=$GTK_IM_MODULE"
echo "  QT_IM_MODULE=$QT_IM_MODULE"
echo "  XMODIFIERS=$XMODIFIERS"
echo ""
echo "快捷键:"
echo "  Super+Space 或 Ctrl+Space 切换输入法"
echo ""

npm run tauri:dev
