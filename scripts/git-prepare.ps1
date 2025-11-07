<#
  scripts/git-prepare.ps1
  Usage (from project root in VSCode terminal):
    # if execution policy allows:
    pwsh .\scripts\git-prepare.ps1
    # or (if using Windows PowerShell) with bypass:
    powershell -ExecutionPolicy Bypass -File .\scripts\git-prepare.ps1

  NOTE: This script will COMMIT locally but WILL NOT PUSH.
#>

set -e

# Helper for timestamp
function timestamp() {
  return (Get-Date).ToString("yyyyMMdd-HHmmss")
}

Write-Host "== Git prepare script started ==" -ForegroundColor Cyan

# 1. Verify we're inside a git repo
try {
  git rev-parse --is-inside-work-tree 2>$null | Out-Null
} catch {
  Write-Host "Error: This folder does not appear to be a git repository. Initialize git first (git init) or run this in the repo root." -ForegroundColor Red
  exit 1
}

# 2. Ensure git user config exists (inform user and set a placeholder if missing)
$gitName = git config user.name
$gitEmail = git config user.email

if ([string]::IsNullOrWhiteSpace($gitName)) {
  Write-Host "Git user.name not set. Setting placeholder values. You can change them later with 'git config user.name \"Your Name\"'." -ForegroundColor Yellow
  git config user.name "Your Name"
}
if ([string]::IsNullOrWhiteSpace($gitEmail)) {
  Write-Host "Git user.email not set. Setting placeholder values. You can change them later with 'git config user.email \"you@example.com\"'." -ForegroundColor Yellow
  git config user.email "you@example.com"
}

# 3. Prepare .gitignore (merge with existing if present)
$gitignorePath = ".gitignore"
$backupSuffix = "-" + (timestamp()) + ".bak"
if (Test-Path $gitignorePath) {
  $bakPath = ".gitignore$backupSuffix"
  Copy-Item -Path $gitignorePath -Destination $bakPath -Force
  Write-Host "Backed up existing .gitignore -> $bakPath" -ForegroundColor Green
  $existingLines = Get-Content $gitignorePath -ErrorAction SilentlyContinue
} else {
  $existingLines = @()
}

# Desired lines for .gitignore
$desired = @(
  "# Node / npm",
  "node_modules/",
  "npm-debug.log*",
  "yarn-error.log",
  "",
  "# Environment files",
  ".env",
  "backend/.env",
  "frontend/.env",
  "",
  "# React / build",
  "build/",
  "dist/",
  "",
  "# OS / editor",
  ".DS_Store",
  ".vscode/",
  "*.log"
)

# Merge unique, preserve existing entries
$merged = @()
$lowerSeen = @{}
# keep existing lines first (preserve order), then append desired that are missing
foreach ($line in $existingLines) {
  if (-not [string]::IsNullOrWhiteSpace($line)) {
    $lc = $line.Trim().ToLowerInvariant()
    if (-not $lowerSeen.ContainsKey($lc)) {
      $lowerSeen[$lc] = $true
      $merged += $line
    }
  } else {
    $merged += $line
  }
}
foreach ($line in $desired) {
  if (-not [string]::IsNullOrWhiteSpace($line)) {
    $lc = $line.Trim().ToLowerInvariant()
    if (-not $lowerSeen.ContainsKey($lc)) {
      $lowerSeen[$lc] = $true
      $merged += $line
    }
  } else {
    # include blank lines where helpful
    $merged += $line
  }
}

# Write merged .gitignore
$merged | Set-Content -Path $gitignorePath -Encoding UTF8
Write-Host "Wrote merged .gitignore" -ForegroundColor Green

# 4. Remove any tracked .env files from index while keeping local copies
$envPaths = @(".env", "backend/.env", "frontend/.env")

foreach ($p in $envPaths) {
  # If the file exists locally or is/was tracked, attempt to remove from index
  try {
    # Only attempt git rm --cached if file is known to Git or exists on disk
    $isTracked = $false
    # use git ls-files to check if tracked
    $ls = git ls-files --error-unmatch $p 2>$null
    if ($LASTEXITCODE -eq 0) { $isTracked = $true }

    if ($isTracked) {
      git rm --cached --ignore-unmatch $p 2>$null
      Write-Host "Removed tracked file from index (kept local): $p" -ForegroundColor Yellow
    } else {
      # If not tracked but exists locally, still leave it alone
      if (Test-Path $p) {
        Write-Host "Local file exists but not tracked by git: $p" -ForegroundColor DarkYellow
      } else {
        Write-Host "No file or tracking for: $p" -ForegroundColor DarkGray
      }
    }
  } catch {
    Write-Host "Warning: could not remove $p from index (maybe not tracked)." -ForegroundColor Yellow
  }
}

# 5. Stage all changes
git add -A
Write-Host "Staged all changes (git add -A)" -ForegroundColor Green

# 6. Commit
$commitMessage = "Restore frontend components and updated controllers; add .gitignore; remove .env from index"
# If there's nothing to commit, skip commit
$changes = git status --porcelain
if ([string]::IsNullOrWhiteSpace($changes)) {
  Write-Host "No changes to commit. Nothing staged." -ForegroundColor Yellow
} else {
  git commit -m $commitMessage
  Write-Host "Committed changes: $commitMessage" -ForegroundColor Green
}

# 7. Show status & last 5 commits
Write-Host "`n== Git status (porcelain) ==" -ForegroundColor Cyan
git status --short

Write-Host "`n== Last 5 commits ==" -ForegroundColor Cyan
git --no-pager log --oneline -n 5

Write-Host "`n== Done. No push was performed. To push later run: git push origin main" -ForegroundColor Magenta
