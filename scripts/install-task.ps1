<#
.SYNOPSIS
  Registers (or removes) the scheduled task that starts the agent-bus broker
  when you log on.

.DESCRIPTION
  Task "agent-bus broker", for the current user only (no admin rights):
    - trigger: at your logon
    - action: hidden Windows PowerShell running scripts\run-broker.ps1, which
      starts the broker with file logging and restarts it after a crash
    - one instance at a time, no time limit, runs on battery
  It reads SLACK_*, AGENT_BUS_TOKEN_* etc. from your user environment when it
  starts. Logs: %LOCALAPPDATA%\agent-bus\logs (or AGENT_BUS_DATA_DIR\logs).

  Stop any broker you started by hand before -StartNow; only one can hold
  the port.

.PARAMETER StartNow
  Start the task right after registering it.

.PARAMETER Uninstall
  Stop and remove the task.

.EXAMPLE
  .\scripts\install-task.ps1 -WhatIf
  .\scripts\install-task.ps1 -StartNow
  .\scripts\install-task.ps1 -Uninstall
#>
[CmdletBinding(SupportsShouldProcess)]
param([switch]$StartNow, [switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$TaskName = 'agent-bus broker'
$Repo     = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Runner   = Join-Path $Repo 'scripts\run-broker.ps1'
# Windows PowerShell even when this script runs in pwsh: it's always installed.
$Shell    = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$User     = "$env:USERDOMAIN\$env:USERNAME"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($Uninstall) {
    if (-not $existing) {
        Write-Host "not installed: $TaskName"
        return
    }
    if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and remove scheduled task')) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "removed  $TaskName (a broker it started may still be running; end node.exe or log off)"
    }
    return
}

$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`""
$action    = New-ScheduledTaskAction -Execute $Shell -Argument $arguments -WorkingDirectory $Repo
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $User
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$task      = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Starts the agent-bus broker (Slack + local MCP endpoint) at logon. Installed by agent-bus scripts\install-task.ps1.'

$verb = if ($existing) { 'Update' } else { 'Register' }
$done = if ($existing) { 'updated' } else { 'registered' }
if ($PSCmdlet.ShouldProcess($TaskName, "$verb scheduled task")) {
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    Write-Host "$done $TaskName"
} else {
    Write-Host "would $($verb.ToLower()) '$TaskName' for $User"
    Write-Host "  at logon: $Shell $arguments"
    Write-Host "  working directory: $Repo"
}

if ($StartNow -and $PSCmdlet.ShouldProcess($TaskName, 'Start scheduled task')) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "started  $TaskName (check the log: $env:LOCALAPPDATA\agent-bus\logs)"
}
