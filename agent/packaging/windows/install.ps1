# Install the MyDeskTime agent for the current user.
#
#   .\install.ps1 -Login you@company.com -Org acme -Server https://mydesktime.example.com
#   .\install.ps1 -EnrollKey ABCD-EFGH-IJKL-MNOP -Server https://mydesktime.example.com
#
# Per-user, no admin rights. A machine-wide service would survive user
# switching but could not read the interactive desktop, which is the only place
# the foreground window and idle time exist.
param(
  [string]$Login,
  [string]$EnrollKey,
  [string]$Org,
  [Parameter(Mandatory = $true)][string]$Server
)

$ErrorActionPreference = 'Stop'

if (-not $Login -and -not $EnrollKey) {
  Get-Content $PSCommandPath -TotalCount 8 | ForEach-Object { $_ -replace '^# ?', '' }
  exit 2
}

$here = Split-Path -Parent $PSCommandPath
$dest = Join-Path $env:LOCALAPPDATA 'Programs\MyDeskTime'

if ($here -ne $dest) {
  # Replace the payload wholesale so an upgrade cannot strand a stale DLL for
  # the new binary to load. Skipped when re-run from the install directory —
  # changing an enrolment should not delete the script mid-run.
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item "$here\*" $dest -Recurse -Force
}

# Enrol before wiring autostart. An agent that starts unenrolled just writes
# the same refusal to its log at every sign-in, invisibly — it is windowed, so
# there is nothing on screen to notice.
$setupArgs = @('--server', $Server)
if ($Org)       { $setupArgs += @('--org', $Org) }
if ($Login)     { $setupArgs += @('--login', $Login) }
if ($EnrollKey) { $setupArgs += @('--enroll', $EnrollKey) }

& (Join-Path $dest 'MyDeskTime-Setup.exe') @setupArgs
if ($LASTEXITCODE -ne 0) { throw "Enrolment failed; nothing was installed for autostart." }

# A scheduled task, not a Run-key entry. The Run key is a single string that
# any installer can overwrite, users can disable from Task Manager without
# knowing what it was, and it offers no restart-on-failure.
$exe = Join-Path $dest 'sentinel-agent.exe'
$action  = New-ScheduledTaskAction -Execute $exe
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 `
  -ExecutionTimeLimit ([TimeSpan]::Zero)   # 0 = never killed; it runs all day

Register-ScheduledTask -TaskName 'MyDeskTime Agent' -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName 'MyDeskTime Agent'

Write-Host ""
Write-Host "Installed to $dest and started."
Write-Host "Check it any time with:  $dest\MyDeskTime-Setup.exe --status"
