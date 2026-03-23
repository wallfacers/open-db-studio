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
  const { execSync } = require('child_process');

  console.log(`Downloading: ${url}`);

  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "` +
      `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ` +
      `$ProgressPreference = 'SilentlyContinue'; ` +
      `Invoke-WebRequest -Uri '${url}' -OutFile '${dest}' -UseBasicParsing"`,
      { stdio: 'inherit' }
    );
  } else {
    execSync(`curl -L -o "${dest}" "${url}" --progress-bar`, { stdio: 'inherit' });
  }

  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    throw new Error('Downloaded file is empty or missing');
  }

  console.log('Download complete!');
}

/**
 * 解压归档文件：.zip 用 AdmZip，.tar.gz 用系统 tar（Linux）
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
    if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
      // Linux: 使用系统 tar 解压
      const { execSync } = require('child_process');
      execSync(`tar xzf "${archivePath}" -C "${targetDir}"`, { stdio: 'inherit' });
      fs.unlinkSync(archivePath);

      const extractedPath = path.join(targetDir, exeName);
      if (!fs.existsSync(extractedPath)) {
        throw new Error(`Could not find ${exeName} after tar extraction`);
      }
      fs.renameSync(extractedPath, targetPath);
      fs.chmodSync(targetPath, 0o755);
    } else {
      // Windows / macOS: 使用 AdmZip 解压 .zip
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(targetDir, true); // overwrite

      let extractedPath = path.join(targetDir, exeName);
      if (!fs.existsSync(extractedPath)) {
        const entries = zip.getEntries();
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

      fs.renameSync(extractedPath, targetPath);
      fs.unlinkSync(archivePath);

      if (process.platform !== 'win32') {
        fs.chmodSync(targetPath, 0o755);
      }
    }

    console.log(`Extracted to: ${targetPath}`);
    return targetPath;
  } catch (error) {
    throw new Error(`Failed to extract archive: ${error.message}`);
  }
}

function main() {
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

  // 存在旧 zip 无论是否完整，直接删除重新下载
  if (fs.existsSync(archivePath)) {
    console.log(`Removing existing archive: ${archivePath}`);
    fs.unlinkSync(archivePath);
  }

  try {
    downloadFile(archiveUrl, archivePath);
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
