#!/usr/bin/env node

/**
 * Download opencode-cli TUI binaries from GitHub Releases
 *
 * Usage: node scripts/download-sidecar.cjs
 *
 * Environment variables:
 *   SIDECAR_VERSION - Version to download (default: 1.2.27)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const VERSION = process.env.SIDECAR_VERSION || '1.2.27';
const REPO = 'anomalyco/opencode';
const BINARIES_DIR = path.join(__dirname, '..', 'src-tauri', 'binaries');

// TUI 版本下载映射（zip 压缩包）
const PLATFORMS = {
  'win32-x64': {
    zipFile: 'opencode-windows-x64.zip',
    exeInZip: 'opencode.exe',
    targetFile: 'opencode-cli-x86_64-pc-windows-msvc.exe'
  },
  'darwin-x64': {
    zipFile: 'opencode-darwin-x64.zip',
    exeInZip: 'opencode',
    targetFile: 'opencode-cli-x86_64-apple-darwin'
  },
  'darwin-arm64': {
    zipFile: 'opencode-darwin-arm64.zip',
    exeInZip: 'opencode',
    targetFile: 'opencode-cli-aarch64-apple-darwin'
  }
};

function getPlatform() {
  const platform = `${process.platform}-${process.arch}`;
  if (!PLATFORMS[platform]) {
    console.error(`Unsupported platform: ${platform}`);
    console.error('Supported platforms:', Object.keys(PLATFORMS).join(', '));
    process.exit(1);
  }
  return platform;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);

    const file = fs.createWriteStream(dest);
    let redirectCount = 0;

    const request = (url) => {
      redirectCount++;
      if (redirectCount > 10) {
        reject(new Error('Too many redirects'));
        return;
      }

      https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          request(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${url}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (totalSize) {
            const percent = ((downloaded / totalSize) * 100).toFixed(1);
            process.stdout.write(`\rDownloading: ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
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

function extractZip(zipPath, targetDir, exeName, targetName) {
  console.log(`Extracting ${exeName} from zip...`);

  // 使用 PowerShell 解压（Windows）
  if (process.platform === 'win32') {
    const tempDir = path.join(targetDir, '_temp_extract');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force"`, {
      stdio: 'inherit'
    });

    // 查找可执行文件
    const extractedPath = path.join(tempDir, exeName);
    if (!fs.existsSync(extractedPath)) {
      // 可能解压到了子目录中
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        const subDir = path.join(tempDir, file);
        if (fs.statSync(subDir).isDirectory()) {
          const exePath = path.join(subDir, exeName);
          if (fs.existsSync(exePath)) {
            fs.copyFileSync(exePath, path.join(targetDir, targetName));
            fs.rmSync(tempDir, { recursive: true });
            fs.unlinkSync(zipPath);
            return;
          }
        }
      }
      throw new Error(`Could not find ${exeName} in zip`);
    }

    fs.copyFileSync(extractedPath, path.join(targetDir, targetName));
    fs.rmSync(tempDir, { recursive: true });
    fs.unlinkSync(zipPath);
  } else {
    // macOS/Linux 使用 unzip
    execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, { stdio: 'inherit' });

    const extractedPath = path.join(targetDir, exeName);
    if (!fs.existsSync(extractedPath)) {
      throw new Error(`Could not find ${exeName} in zip`);
    }

    fs.renameSync(extractedPath, path.join(targetDir, targetName));
    fs.unlinkSync(zipPath);
  }

  console.log(`Extracted to: ${path.join(targetDir, targetName)}`);
}

async function main() {
  // Create binaries directory if not exists
  if (!fs.existsSync(BINARIES_DIR)) {
    fs.mkdirSync(BINARIES_DIR, { recursive: true });
  }

  const platform = getPlatform();
  const { zipFile, exeInZip, targetFile } = PLATFORMS[platform];
  const targetPath = path.join(BINARIES_DIR, targetFile);

  // Check if file already exists
  if (fs.existsSync(targetPath)) {
    console.log(`Sidecar already exists: ${targetPath}`);
    console.log('Delete the file to re-download.');
    return;
  }

  const zipUrl = `https://github.com/${REPO}/releases/download/v${VERSION}/${zipFile}`;
  const zipPath = path.join(BINARIES_DIR, zipFile);

  try {
    await downloadFile(zipUrl, zipPath);
    extractZip(zipPath, BINARIES_DIR, exeInZip, targetFile);

    // Make executable on Unix
    if (process.platform !== 'win32') {
      fs.chmodSync(targetPath, 0o755);
    }

    console.log(`\nSidecar ready: ${targetPath}`);
  } catch (error) {
    console.error(`\nFailed to download sidecar: ${error.message}`);
    console.error('\nPlease check the release at:');
    console.error(`  https://github.com/${REPO}/releases/tag/v${VERSION}`);
    process.exit(1);
  }
}

main();
