# Build the MyDeskTime agent for Windows.
#
#   .\scripts\build.ps1            build
#   .\scripts\build.ps1 -Check     build, then run the capability self-test
#                                  through the packaged bundle
#
# For macOS and Linux use scripts/build.sh on those machines, or let
# .github/workflows/agent-build.yml build all three.
param([switch]$Check)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# A fresh interpreter, not the development venv: whatever was ever
# pip-installed there ends up in the bundle, and the only symptom is an
# artifact twice the size it should be.
if (Test-Path .venv-build) { Remove-Item -Recurse -Force .venv-build }
python -m venv .venv-build
& .\.venv-build\Scripts\python.exe -m pip install --quiet --upgrade pip
& .\.venv-build\Scripts\python.exe -m pip install --quiet -r requirements.txt pyinstaller==6.11.1

foreach ($d in 'build', 'dist') { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
& .\.venv-build\Scripts\pyinstaller.exe sentinel-agent.spec --noconfirm --clean
if ($LASTEXITCODE -ne 0) { throw "pyinstaller failed" }

# The bundle alone is not shippable: somebody still has to enrol it and wire
# autostart, so the installer travels with it.
Copy-Item packaging\windows\install.ps1 dist\sentinel-agent\ -Force

$arch = $env:PROCESSOR_ARCHITECTURE.ToLower()
$out = "dist\mydesktime-agent-windows-$arch.zip"
Compress-Archive -Path dist\sentinel-agent -DestinationPath $out -Force

Write-Host ""
Write-Host "built: $out"

# Proof the bundle runs, not just that PyInstaller exited 0. A hidden import
# the spec missed shows up here rather than on an employee's laptop.
& .\dist\sentinel-agent\sentinel-setup.exe --status

if ($Check) {
  Write-Host ""
  Write-Host "--- capability self-test, run through the packaged bundle ---"
  & .\dist\sentinel-agent\sentinel-setup.exe --selftest
}
