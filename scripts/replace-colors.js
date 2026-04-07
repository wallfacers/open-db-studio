const fs = require('fs');
const path = require('path');

// 颜色映射表
const colorMap = {
  // 主题色
  '#00c9a7': 'var(--accent)',
  '#00b396': 'var(--accent-hover)',
  '#00a98f': 'var(--accent-hover)',
  '#29edd0': 'var(--accent)',

  // 背景色
  '#080d12': 'var(--background-void)',
  '#0d1117': 'var(--background-base)',
  '#0d1520': 'var(--background-base)',
  '#111922': 'var(--background-panel)',
  '#151d28': 'var(--background-elevated)',
  '#1a2639': 'var(--background-hover)',
  '#003d2f': 'var(--accent-subtle)',

  // 文字色
  '#c8daea': 'var(--foreground-default)',
  '#e8f4ff': 'var(--foreground)',
  '#b5cfe8': 'var(--foreground)',
  '#7a9bb8': 'var(--foreground-muted)',
  '#4a6480': 'var(--foreground-subtle)',
  '#2a3e56': 'var(--foreground-ghost)',

  // 边框色
  '#161e2e': 'var(--border-subtle)',
  '#1e2d42': 'var(--border-default)',
  '#2a3f5a': 'var(--border-strong)',
  '#253347': 'var(--border-strong)',
};

// 需要处理的文件扩展名
const extensions = ['.tsx', '.ts', '.css'];

// 递归遍历目录
function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    const dirPath = path.join(dir, f);
    const isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(dirPath);
  });
}

// 替换文件中的颜色
function replaceColorsInFile(filePath) {
  const ext = path.extname(filePath);
  if (!extensions.includes(ext)) return;

  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  for (const [oldColor, newColor] of Object.entries(colorMap)) {
    if (content.includes(oldColor)) {
      content = content.split(oldColor).join(newColor);
      modified = true;
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✓ ${filePath}`);
  }
}

// 主程序
console.log('开始替换颜色值...\n');
walkDir('src', replaceColorsInFile);
console.log('\n✓ 所有颜色替换完成！');
