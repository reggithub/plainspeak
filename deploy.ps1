# Mirror the tracked extension source to the unpacked-extension folder Chrome loads.
#
# Chrome reads C:\Plainspeak\extension straight off disk, so that folder is a
# build output, not source. Edit files under .\extension, run this script, then
# hit Reload on chrome://extensions.

$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot 'extension'
$dst = 'C:\Plainspeak\extension'

if (-not (Test-Path -LiteralPath $src)) { throw "extension source not found: $src" }

New-Item -ItemType Directory -Force -Path $dst | Out-Null

# /MIR makes $dst an exact copy: anything there that is not in source is deleted.
robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null

# Robocopy uses 0-7 for success (1 = files copied, 2 = extras removed, ...).
$rc = $LASTEXITCODE
if ($rc -ge 8) { throw "robocopy failed (exit $rc)" }

Write-Host "Deployed $src -> $dst"
exit 0
