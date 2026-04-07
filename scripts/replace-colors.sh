#!/bin/bash
# 颜色替换脚本 - 将旧颜色值替换为新的 CSS 变量

# 定义颜色映射
# 旧颜色 -> 新颜色 (CSS 变量格式)

echo "开始替换旧颜色值为新设计系统..."

# 1. 替换旧的电光青主题色
find src -type f \( -name "*.tsx" -o -name "*.ts" -o -name "*.css" \) -exec sed -i \
  -e 's/#00c9a7/var(--accent)/g' \
  -e 's/#00b396/var(--accent-hover)/g' \
  -e 's/#00a98f/var(--accent-hover)/g' \
  -e 's/#29edd0/var(--accent)/g' \
  {} +

echo "✓ 主题色替换完成"

# 2. 替换背景色
find src -type f \( -name "*.tsx" -o -name "*.ts" -o -name "*.css" \) -exec sed -i \
  -e 's/#080d12/var(--background-void)/g' \
  -e 's/#0d1117/var(--background-base)/g' \
  -e 's/#0d1520/var(--background-base)/g' \
  -e 's/#111922/var(--background-panel)/g' \
  -e 's/#151d28/var(--background-elevated)/g' \
  -e 's/#1a2639/var(--background-hover)/g' \
  -e 's/#003d2f/var(--accent-subtle)/g' \
  {} +

echo "✓ 背景色替换完成"

# 3. 替换文字色
find src -type f \( -name "*.tsx" -o -name "*.ts" -o -name "*.css" \) -exec sed -i \
  -e 's/#e8f4ff/var(--foreground)/g' \
  -e 's/#c8daea/var(--foreground-default)/g' \
  -e 's/#b5cfe8/var(--foreground)/g' \
  -e 's/#7a9bb8/var(--foreground-muted)/g' \
  -e 's/#4a6480/var(--foreground-subtle)/g' \
  -e 's/#2a3e56/var(--foreground-ghost)/g' \
  {} +

echo "✓ 文字色替换完成"

# 4. 替换边框色
find src -type f \( -name "*.tsx" -o -name "*.ts" -o -name "*.css" \) -exec sed -i \
  -e 's/#161e2e/var(--border-subtle)/g' \
  -e 's/#1e2d42/var(--border-default)/g' \
  -e 's/#2a3f5a/var(--border-strong)/g' \
  -e 's/#253347/var(--border)/g' \
  {} +

echo "✓ 边框色替换完成"

# 5. 替换其他常见颜色
find src -type f \( -name "*.tsx" -o -name "*.ts" -o -name "*.css" \) -exec sed -i \
  -e 's/#f43f5e/var(--error)/g' \
  -e 's/#4ade80/var(--success)/g' \
  -e 's/#f59e0b/var(--warning)/g' \
  -e 's/#5eb2f7/var(--info)/g' \
  {} +

echo "✓ 语义色替换完成"

echo ""
echo "所有颜色替换完成！"
echo "请检查以下文件确认替换结果:"
echo "  - src/App.tsx"
echo "  - src/components/ERDiagram.tsx"
echo "  - src/styles/theme.ts"
