/**
 * Kill stale opencode-cli sidecar processes launched from this project's
 * target/ or src-tauri/binaries/ directory.
 * Avoids killing user-installed opencode-cli instances.
 */

const { execSync } = require('child_process')
const path = require('path')
const os = require('os')

const projectRoot = path.resolve(__dirname, '..')
const platform = os.platform()

// Normalize to forward slashes for cross-platform substring matching
const projectRootNorm = projectRoot.replace(/\\/g, '/')

if (platform === 'win32') {
  // Use a PowerShell script block via -File or encode it to avoid quoting hell
  const ps = `
$procs = Get-Process -Name opencode-cli -ErrorAction SilentlyContinue
foreach ($p in $procs) {
  $exePath = $p.Path -replace '\\\\', '/'
  if ($exePath -like '*open-db-studio*') {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Write-Host "Killed opencode-cli PID $($p.Id) at $($p.Path)"
  }
}
`
  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  try {
    execSync(`powershell -EncodedCommand ${encoded}`, { stdio: 'inherit' })
  } catch (_) {
    // Process not found — that's fine
  }
} else {
  // macOS / Linux: pkill by path containing project root
  try {
    execSync(
      `pkill -f "open-db-studio.*opencode-cli" 2>/dev/null; true`,
      { shell: '/bin/sh', stdio: 'ignore' }
    )
  } catch (_) {
    // Process not found — that's fine
  }
}
