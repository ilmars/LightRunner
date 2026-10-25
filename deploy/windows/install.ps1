# Run Light Runner as a Windows service (a startup task in Task Scheduler):
# started at boot, before anyone logs in, and restarted if it stops.
#
# In PowerShell "Run as administrator":
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -Uninstall
#   ... -NoSleep   also stops the computer from sleeping on mains power
#
# Logs: data\logs\light-runner.log
param([switch]$Uninstall, [switch]$NoSleep, [int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$TaskName = 'Light Runner'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Error 'Run PowerShell as administrator.'; exit 1 }

if ($Uninstall) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayName 'Light Runner*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Host 'Light Runner service removed. Your show and settings in data\ are kept.'
  exit 0
}

$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error 'Node.js 24 or newer is needed: https://nodejs.org'; exit 1 }
& $node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if ($LASTEXITCODE -ne 0) { Write-Error 'Node.js 24 or newer is needed: https://nodejs.org'; exit 1 }

New-Item -ItemType Directory -Force -Path "$root\data\logs" | Out-Null
$log = "$root\data\logs\light-runner.log"
$cmd = "set PORT=$Port&& `"$node`" `"$root\server\src\supervise.ts`" >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $cmd" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 4
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Light Runner lighting controller' | Out-Null

# Let tablets reach the web page, and Art-Net node replies reach the node finder.
Get-NetFirewallRule -DisplayName 'Light Runner*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Light Runner web' -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private,Domain -Action Allow | Out-Null
New-NetFirewallRule -DisplayName 'Light Runner Art-Net' -Direction Inbound -Protocol UDP -LocalPort 6454 -Profile Private,Domain -Action Allow | Out-Null

if ($NoSleep) { powercfg /change standby-timeout-ac 0; powercfg /change hibernate-timeout-ac 0 }

Start-ScheduledTask -TaskName $TaskName
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
Write-Host "Light Runner is running as a service."
Write-Host "Operator page: http://${ip}:$Port/operator/"
Write-Host "Logs: $log"
Write-Host 'Set the network to Private in Windows settings so tablets can connect.'
