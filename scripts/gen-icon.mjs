import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { join } from 'path';

const ICONS_DIR = join(import.meta.dirname, '..', 'src-tauri', 'icons');
const ASSETS_DIR = join(import.meta.dirname, '..', 'src', 'assets');
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

// SVG: 蓝→青渐变圆角矩形 + 白色粗体 "DB"
function makeSvg(size) {
  const r = Math.round(size * 0.22); // 圆角比例
  const fontSize = Math.round(size * 0.42);
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#g)"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle"
        font-family="Arial,Helvetica,sans-serif" font-weight="800"
        font-size="${fontSize}" fill="white" letter-spacing="${Math.round(size*0.01)}">DB</text>
</svg>`);
}

// 生成 PNG
async function genPng(size, outPath) {
  await sharp(makeSvg(size)).resize(size, size).png().toFile(outPath);
  console.log(`  ${size}x${size} -> ${outPath}`);
}

// 构建 ICO（内嵌 PNG 格式）
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6 + count * 16;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type = ICO
  header.writeUInt16LE(count, 4); // image count

  const entries = Buffer.alloc(count * 16);
  let offset = headerSize;
  const sizes = [256, 48, 32, 16];

  for (let i = 0; i < count; i++) {
    const s = sizes[i];
    const buf = pngBuffers[i];
    entries.writeUInt8(s < 256 ? s : 0, i * 16);      // width (0=256)
    entries.writeUInt8(s < 256 ? s : 0, i * 16 + 1);  // height
    entries.writeUInt8(0, i * 16 + 2);                  // color palette
    entries.writeUInt8(0, i * 16 + 3);                  // reserved
    entries.writeUInt16LE(1, i * 16 + 4);               // color planes
    entries.writeUInt16LE(32, i * 16 + 6);              // bits per pixel
    entries.writeUInt32LE(buf.length, i * 16 + 8);      // size
    entries.writeUInt32LE(offset, i * 16 + 12);         // offset
    offset += buf.length;
  }

  return Buffer.concat([header, entries, ...pngBuffers]);
}

async function main() {
  console.log('Generating icon PNGs...');

  // Tauri bundle 需要的尺寸
  const tauriSizes = [32, 64, 128, 256, 512];
  for (const s of tauriSizes) {
    if (s === 256) {
      await genPng(s, join(ICONS_DIR, `128x128@2x.png`));
    } else if (s === 512) {
      await genPng(s, join(ICONS_DIR, `icon.png`));
    } else {
      await genPng(s, join(ICONS_DIR, `${s}x${s}.png`));
    }
  }
  await genPng(128, join(ICONS_DIR, '128x128.png'));

  // ICO: 256, 48, 32, 16
  console.log('Generating icon.ico...');
  const icoSizes = [256, 48, 32, 16];
  const pngBuffers = await Promise.all(
    icoSizes.map(s => sharp(makeSvg(s)).resize(s, s).png().toBuffer())
  );
  const ico = buildIco(pngBuffers);
  writeFileSync(join(ICONS_DIR, 'icon.ico'), ico);
  console.log(`  icon.ico (${icoSizes.join(', ')}px)`);

  // macOS icns 用的 icon.png (512)
  // 已在上面生成

  // 前端 assets & public
  await genPng(256, join(ASSETS_DIR, 'icon.png'));
  await genPng(256, join(PUBLIC_DIR, 'app-icon.png'));

  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
