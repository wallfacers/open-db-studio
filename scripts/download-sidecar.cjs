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
const { execSync, spawnSync } = require('child_process');

const VERSION = process.env.SIDECAR_VERSION || '1.2.27';
const REPO = 'anomalyco/opencode';
const BINARIES_DIR = path.join(__dirname, '..', 'src-tauri', 'binaries');

// 平台映射：下载的 zip 文件名 -> zip 内的可执行文件名 -> Tauri 期望的文件名
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
    let totalSize = 0;
    let downloaded = 0;

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
          reject(new Error(`HTTP ${response.statusCode}: ${urlStr}`));
          return;
        }

        totalSize = parseInt(response.headers['content-length'], 10) || 0;

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
 * 跨平台解压函数
 * 支持：unzip, tar, PowerShell Expand-Archive, 7z
 */
function extractArchive(archivePath, targetDir, exeName, targetName) {
  console.log(`Extracting ${exeName} from archive...`);

  const isZip = archivePath.endsWith('.zip');
  const isTarGz = archivePath.endsWith('.tar.gz');
  const targetPath = path.join(targetDir, targetName);

  // 方法1：尝试使用系统命令
  const extractMethods = [];

  if (isTarGz) {
    // tar.gz 文件用 tar 命令
    extractMethods.push({
      name: 'tar',
      cmd: () => {
        execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, { stdio: 'inherit' });
        return true;
      }
    });
  }

  if (isZip) {
    // zip 文件优先用 unzip（Git Bash 自带）
    extractMethods.push({
      name: 'unzip',
      cmd: () => {
        const result = spawnSync('unzip', ['-o', archivePath, '-d', targetDir], {
          stdio: 'inherit',
          shell: process.platform === 'win32'
        });
        return result.status === 0;
      }
    });

    // Windows 下尝试 PowerShell
    if (process.platform === 'win32') {
      extractMethods.push({
        name: 'PowerShell',
        cmd: () => {
          const psCmd = `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`;
          const result = spawnSync('powershell', ['-Command', psCmd], {
            stdio: 'inherit',
            shell: true
          });
          return result.status === 0;
        }
      });

      // 尝试 7z
      extractMethods.push({
        name: '7z',
        cmd: () => {
          const result = spawnSync('7z', ['x', archivePath, `-o${targetDir}`, '-y'], {
            stdio: 'inherit',
            shell: true
          });
          return result.status === 0;
        }
      });
    }
  }

  // 尝试各种解压方法
  let extracted = false;
  for (const method of extractMethods) {
    try {
      console.log(`Trying ${method.name}...`);
      if (method.cmd()) {
        extracted = true;
        console.log(`Extracted using ${method.name}`);
        break;
      }
    } catch (e) {
      console.log(`${method.name} failed: ${e.message}`);
    }
  }

  if (!extracted) {
    throw new Error('No suitable extraction tool found. Please install unzip, tar, or 7z.');
  }

  // 查找并重命名可执行文件
  const extractedPath = path.join(targetDir, exeName);
  if (fs.existsSync(extractedPath)) {
    fs.renameSync(extractedPath, targetPath);
  } else {
    // 可能在子目录中，递归查找
    const findAndMove = (dir) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
          findAndMove(filePath);
        } else if (file === exeName) {
          fs.renameSync(filePath, targetPath);
          return true;
        }
      }
      return false;
    };

    if (!findAndMove(targetDir)) {
      throw new Error(`Could not find ${exeName} in extracted archive`);
    }
  }

  // 清理压缩包
  fs.unlinkSync(archivePath);

  // 清理可能的空目录
  const cleanupEmptyDirs = (dir) => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      if (fs.statSync(filePath).isDirectory()) {
        cleanupEmptyDirs(filePath);
        if (fs.readdirSync(filePath).length === 0 && filePath !== targetDir) {
          fs.rmdirSync(filePath);
        }
      }
    }
  };
  cleanupEmptyDirs(targetDir);

  // Unix 系统添加执行权限
  if (process.platform !== 'win32') {
    fs.chmodSync(targetPath, 0o755);
  }

  console.log(`Extracted to: ${targetPath}`);
  return targetPath;
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
    // 空文件，删除重新下载
    fs.unlinkSync(targetPath);
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
