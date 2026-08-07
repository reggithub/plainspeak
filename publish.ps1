# Validate, commit and push annotations.json in one step.
#
#   .\publish.ps1              validate, commit with a generated message, push
#   .\publish.ps1 -Message "…" use your own commit subject
#   .\publish.ps1 -NoPush      commit only, leave pushing to you
#   .\publish.ps1 -Watch       do all of the above every time the file is saved
#
# Run under pwsh. Windows PowerShell blocks scripts on this machine.
#
# Only annotations.json is committed. Code changes stay yours to review.

param(
  [string]$Message,
  [switch]$NoPush,
  [switch]$Watch
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$file = Join-Path $repo 'annotations.json'

function Publish-Once {
  Push-Location $repo
  try {
    # Nothing staged-worthy? Say so and stop -- an empty commit is noise.
    $dirty = git status --porcelain -- annotations.json
    if (-not $dirty) { Write-Host "annotations.json unchanged - nothing to publish"; return }

    # Refuse to publish anything the validator rejects. Out-of-bounds offsets
    # make content.js drop the whole annotation silently, so a bad push looks
    # exactly like a headline that stopped matching.
    Write-Host "validating..." -NoNewline
    $report = & node (Join-Path $repo 'tools/validate.js') 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host ""
      $report | Write-Host
      throw "validation failed - nothing committed"
    }
    Write-Host " ok"

    # Commit subject from what actually changed, unless one was supplied.
    $commitMsg = $Message
    if (-not $commitMsg) {
      $prev = Join-Path ([System.IO.Path]::GetTempPath()) 'plainspeak-head.json'
      git show HEAD:annotations.json 2>$null | Set-Content -LiteralPath $prev -Encoding utf8
      $summary = & node (Join-Path $repo 'tools/summarize.js') $prev $file
      Remove-Item -LiteralPath $prev -ErrorAction SilentlyContinue
      if ($summary -is [array]) { $commitMsg = ($summary -join "`n") } else { $commitMsg = [string]$summary }
      if ($commitMsg -match '^NOCHANGE') { Write-Host "no annotation changed - nothing to publish"; return }
    }

    git add -- annotations.json
    git commit -m $commitMsg | Out-Null
    Write-Host ("committed  " + (git log -1 --format='%h %s'))

    if ($NoPush) { Write-Host "not pushing (-NoPush)"; return }

    git push origin HEAD | Out-Null
    Write-Host "pushed"
    Write-Host "the extension may take up to 5 minutes to see it (CDN cache)"
  }
  finally { Pop-Location }
}

if (-not $Watch) { Publish-Once; exit 0 }

Write-Host "watching $file - Ctrl+C to stop"
$fsw = New-Object System.IO.FileSystemWatcher (Split-Path $file), 'annotations.json'
$fsw.NotifyFilter = [System.IO.NotifyFilters]::LastWrite
$fsw.EnableRaisingEvents = $true

# Editors and the extension both write in bursts; settle before acting.
$last = [datetime]::MinValue
while ($true) {
  $hit = $fsw.WaitForChanged([System.IO.WatcherChangeTypes]::Changed, 1000)
  if ($hit.TimedOut) { continue }
  if (([datetime]::Now - $last).TotalMilliseconds -lt 1500) { continue }
  Start-Sleep -Milliseconds 400
  $last = [datetime]::Now
  Write-Host ""
  Write-Host ("--- change detected " + (Get-Date -Format 'HH:mm:ss'))
  try { Publish-Once } catch { Write-Host $_.Exception.Message -ForegroundColor Red }
}
