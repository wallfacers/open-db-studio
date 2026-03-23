/**
 * Kill stale opencode-cli sidecar processes launched from this project's
 * target/ directory. Avoids killing user-installed opencode-cli instances.
 */

const { execSync } = require('child_process')
const path = require('path')
const os = require('os')

const projectRoot = path.resolve(__dirname, '..')
const targetDir = path.join(projectRoot, 'src-tauri', 'target')
const platform = os.platform()

try {
  if (platform === 'win32') {
    // Filter by executable path so we only kill the sidecar from this project
    const psCmd = [
      `Get-Process opencode-cli -ErrorAction SilentlyContinue`,
      `Where-Object { $_.Path -like '${targetDir.replace(/\\/g, '\\\\')}*' }`,
      `Stop-Process -Force`
    ].join(' | ')
    execSync(`powershell -Command "${psCmd}"`, { stdio: 'ignore' })
  } else {
    // macOS / Linux: pkill by full path pattern
    execSync(`pkill -f "${targetDir}/.*opencode-cli" 2>/dev/null; true`, {
      shell: '/bin/sh',
      stdio: 'ignore'
    })
  }
} catch (_) {
  // Process not found — that's fine
}
