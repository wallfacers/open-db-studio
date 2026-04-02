#!/bin/bash
# WSL2 中文支持启动脚本

# 设置字体目录
export FONTCONFIG_PATH=/etc/fonts

# 设置locale
export LANG=zh_CN.UTF-8
export LC_ALL=zh_CN.UTF-8

# 强制使用 X11 后端（WSL2 推荐）
export GDK_BACKEND=x11
export QT_QPA_PLATFORM=xcb

# 设置输入法环境变量（使用 fcitx5）
export GTK_IM_MODULE=fcitx
export QT_IM_MODULE=fcitx
export XMODIFIERS=@im=fcitx
export SDL_IM_MODULE=fcitx
export GLFW_IM_MODULE=ibus

# WebKit/GTK 特定设置
export WEBKIT_DISABLE_COMPOSITING_MODE=1

# 禁用 Wayland
unset WAYLAND_DISPLAY

# 确保 fcitx5 配置目录存在
mkdir -p ~/.config/fcitx5/conf ~/.config/fcitx5/addons

# 创建默认配置（如果没有）
if [ ! -f ~/.config/fcitx5/profile ]; then
cat > ~/.config/fcitx5/profile << 'CONFIGEOF'
[Groups/0]
Name=Default
Default Layout=us
DefaultIM=pinyin

[Groups/0/Items/0]
Name=keyboard-us
Layout=

[Groups/0/Items/1]
Name=pinyin
Layout=

[GroupOrder]
0=Default
CONFIGEOF
fi

# 停止旧的 fcitx 进程
pkill -9 fcitx 2>/dev/null
pkill -9 fcitx5 2>/dev/null
sleep 1

# 启动 fcitx5 守护进程
echo "启动 fcitx5..."
fcitx5 --disable-wayland -d --verbose="*=warning" 2>/dev/null
sleep 2

# 检查 fcitx5 是否运行
if pgrep -x "fcitx5" > /dev/null; then
    echo "✓ fcitx5 已启动"
    # 尝试切换到中文输入法
    fcitx5-remote -t 2>/dev/null || true
else
    echo "✗ fcitx5 启动失败"
fi

echo ""
echo "输入法环境:"
echo "  GTK_IM_MODULE=$GTK_IM_MODULE"
echo "  QT_IM_MODULE=$QT_IM_MODULE"
echo "  XMODIFIERS=$XMODIFIERS"
echo ""
echo "快捷键: Ctrl+Space 切换输入法"
echo ""

npm run tauri:dev
