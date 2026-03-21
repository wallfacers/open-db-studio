#!/usr/bin/env node

/**
 * Download opencode-cli TUI binaries from GitHub Releases
 *
 * Supports: Windows x64, macOS x64, macOS ARM64, Linux x64
 *
 * Usage: node scripts/download-sidecar.cjs
 *
 * Environment variables:
 *   SIDECAR_VERSION - Version to download (default: 1.2.27)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const VERSION = process.env.SIDECAR_VERSION || '1.2.27';
const REPO = 'anomalyco/opencode';
const BINARIES_DIR = path.join(__dirname, '..', 'src-tauri', 'binaries');

const PLATFORMS = {
  'win32-x64': {
    archive: 'opencode-windows-x64.zip',
    exeName: 'opencode.exe',
    targetName: 'opencode-cli-x86_64-pc-windows-msvc.exe'
  },
  'darwin-x64': {
    archive: 'opencode-darwin-x64.zip',
    exeName: 'opencode',
    targetName: 'opencode-cli-x86_64-apple-darwin'
  },
  'darwin-arm64': {
    archive: 'opencode-darwin-arm64.zip',
    exeName: 'opencode',
    targetName: 'opencode-cli-aarch64-apple-darwin'
  },
  'linux-x64': {
    archive: 'opencode-linux-x64.tar.gz',
    exeName: 'opencode',
    targetName: 'opencode-cli-x86_64-unknown-linux-gnu'
  }
};

function getPlatform() {
  const key = `${process.platform}-${process.arch}`;
  if (!PLATFORMS[key]) {
    console.error(`Unsupported platform: ${key}`);
    console.error('Supported platforms:', Object.keys(PLATFORMS).join(', '));
    process.exit(1);
  }
  return key;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);

    const file = fs.createWriteStream(dest);
    let redirectCount = 0;

    const request = (urlStr) => {
      redirectCount++;
      if (redirectCount > 10) {
        reject(new Error('Too many redirects'));
        return;
      }

      https.get(urlStr, (response) => {
        // 跟随重定向
        if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          fs.unlink(dest, () => {});
          reject(new Error(`HTTP ${response.statusCode}: ${urlStr}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'], 10) || 0;
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (totalSize > 0) {
            const percent = ((downloaded / totalSize) * 100).toFixed(1);
            const downloadedMB = (downloaded / 1024 / 1024).toFixed(1);
            const totalMB = (totalSize / 1024 / 1024).toFixed(1);
            process.stdout.write(`\rDownloading: ${percent}% (${downloadedMB}/${totalMB} MB)`);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log('\nDownload complete!');
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };

    request(url);
  });
}

/**
 * 使用 adm-zip 解压（纯 Node.js，跨平台）
 */
function extractArchive(archivePath, targetDir, exeName, targetName) {
  console.log(`Extracting ${exeName} from archive...`);

  const targetPath = path.join(targetDir, targetName);

  // 检查文件是否已存在
  if (fs.existsSync(targetPath)) {
    const stat = fs.statSync(targetPath);
    if (stat.size > 0) {
      console.log(`Sidecar already exists: ${targetPath}`);
      return targetPath;
    }
    fs.unlinkSync(targetPath);
  }

  try {
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(targetDir, true); // overwrite

    // 查找可执行文件
    let extractedPath = path.join(targetDir, exeName);
    if (!fs.existsSync(extractedPath)) {
      // 可能在子目录中，      const entries = zip.getEntries();
      for (const entry of entries) {
        if (entry.entryName.endsWith(exeName) || entry.entryName === exeName) {
          extractedPath = path.join(targetDir, entry.entryName);
          break;
        }
      }

      if (!fs.existsSync(extractedPath)) {
        throw new Error(`Could not find ${exeName} in archive`);
      }
    }

    // 重命名到目标文件名
    fs.renameSync(extractedPath, targetPath);

    // 删除压缩包
    fs.unlinkSync(archivePath);

    // Unix 系统添加执行权限
    if (process.platform !== 'win32') {
      fs.chmodSync(targetPath, 0o755);
    }

    console.log(`Extracted to: ${targetPath}`);
    return targetPath;
  } catch (error) {
    throw new Error(`Failed to extract archive: ${error.message}`);
  }
}

async function main() {
  // 创建目录
  if (!fs.existsSync(BINARIES_DIR)) {
    fs.mkdirSync(BINARIES_DIR, { recursive: true });
  }

  const platform = getPlatform();
  const { archive, exeName, targetName } = PLATFORMS[platform];
  const targetPath = path.join(BINARIES_DIR, targetName);

  // 检查文件是否已存在
  if (fs.existsSync(targetPath)) {
    const stat = fs.statSync(targetPath);
    if (stat.size > 0) {
      console.log(`Sidecar already exists: ${targetPath}`);
      console.log('Delete the file to re-download.');
      return;
    }
    // 空文件，    fs.unlinkSync(targetPath);
  }

  const archiveUrl = `https://github.com/${REPO}/releases/download/v${VERSION}/${archive}`;
  const archivePath = path.join(BINARIES_DIR, archive);

  try {
    await downloadFile(archiveUrl, archivePath);
    extractArchive(archivePath, BINARIES_DIR, exeName, targetName);

    console.log(`\n✅ Sidecar ready: ${targetPath}`);
  } catch (error) {
    console.error(`\n❌ Failed: ${error.message}`);
    console.error(`\nPlease check the release at:`);
    console.error(`  https://github.com/${REPO}/releases/tag/v${VERSION}`);
    process.exit(1);
  }
}

main();
