#!/usr/bin/env node

/**
 * Download Tauri sidecar binaries from GitHub Releases
 *
 * Usage: node scripts/download-sidecar.js
 *
 * Environment variables:
 *   SIDECAR_VERSION - Version to download (default: 1.2.27)
 *   SIDECAR_REPO    - GitHub repo (default: wallfacers/open-db-studio)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const VERSION = process.env.SIDECAR_VERSION || '1.2.27';
const REPO = process.env.SIDECAR_REPO || 'wallfacers/open-db-studio';
const BINARIES_DIR = path.join(__dirname, '..', 'src-tauri', 'binaries');

const PLATFORMS = {
  'win32-x64': {
    file: 'opencode-cli-x86_64-pc-windows-msvc.exe',
    url: `https://github.com/${REPO}/releases/download/sidecar-v${VERSION}/opencode-cli-x86_64-pc-windows-msvc.exe`
  },
  'darwin-x64': {
    file: 'opencode-cli-x86_64-apple-darwin',
    url: `https://github.com/${REPO}/releases/download/sidecar-v${VERSION}/opencode-cli-x86_64-apple-darwin`
  },
  'darwin-arm64': {
    file: 'opencode-cli-aarch64-apple-darwin',
    url: `https://github.com/${REPO}/releases/download/sidecar-v${VERSION}/opencode-cli-aarch64-apple-darwin`
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

    const request = (url) => {
      https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Follow redirect
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
          const percent = ((downloaded / totalSize) * 100).toFixed(1);
          process.stdout.write(`\rDownloading: ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
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

async function main() {
  // Create binaries directory if not exists
  if (!fs.existsSync(BINARIES_DIR)) {
    fs.mkdirSync(BINARIES_DIR, { recursive: true });
  }

  const platform = getPlatform();
  const { file, url } = PLATFORMS[platform];
  const dest = path.join(BINARIES_DIR, file);

  // Check if file already exists
  if (fs.existsSync(dest)) {
    console.log(`Sidecar already exists: ${dest}`);
    console.log('Delete the file to re-download.');
    return;
  }

  try {
    await downloadFile(url, dest);

    // Make executable on Unix
    if (process.platform !== 'win32') {
      fs.chmodSync(dest, 0o755);
    }

    console.log(`Sidecar downloaded to: ${dest}`);
  } catch (error) {
    console.error(`Failed to download sidecar: ${error.message}`);
    console.error('\nPlease ensure the release exists at:');
    console.error(`  https://github.com/${REPO}/releases/tag/sidecar-v${VERSION}`);
    process.exit(1);
  }
}

main();
