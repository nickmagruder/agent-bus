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

.PARAMETER Restart
  Stop the task and the broker it started, then start it again: picks up new
  code and changed environment variables. Doesn't touch a broker you started
  by hand with npm run broker.

.PARAMETER Uninstall
  Stop the task and its broker, and remove the task.

.EXAMPLE
  .\scripts\install-task.ps1 -WhatIf
  .\scripts\install-task.ps1 -StartNow
  .\scripts\install-task.ps1 -Restart
  .\scripts\install-task.ps1 -Uninstall
#>
[CmdletBinding(SupportsShouldProcess)]
param([switch]$StartNow, [switch]$Restart, [switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$TaskName = 'agent-bus broker'
$Repo     = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Runner   = Join-Path $Repo 'scripts\run-broker.ps1'
# Windows PowerShell even when this script runs in pwsh: it's always installed.
$Shell    = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$User     = "$env:USERDOMAIN\$env:USERNAME"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# The broker the task started: run-broker.ps1 passes the absolute path of
# main.ts, unlike npm run broker (relative), so hand-started brokers don't match.
function Get-TaskBroker {
    $main = (Join-Path $Repo 'src\broker\main.ts').ToLowerInvariant()
    @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($main) })
}

# The hidden launcher(s) running run-broker.ps1.
function Get-TaskLauncher {
    $runner = $Runner.ToLowerInvariant()
    @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($runner) })
}

# Stops the launcher first (it would otherwise restart node), waits for it to
# exit, then stops the broker and waits for the port to be free.
# Stop-ScheduledTask returns before Windows has ended the launcher, so the
# launcher is also stopped by process ID.
function Stop-TaskBroker {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    foreach ($process in Get-TaskLauncher) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
        Write-Host "stopped  launcher (powershell pid $($process.ProcessId))"
    }
    foreach ($process in Get-TaskBroker) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
        Write-Host "stopped  broker (node pid $($process.ProcessId))"
    }
}

if ($Uninstall -or $Restart) {
    if (-not $existing) {
        Write-Host "not installed: $TaskName (run without -Uninstall/-Restart to register it)"
        return
    }
    if ($Uninstall) {
        if ($PSCmdlet.ShouldProcess($TaskName, 'Stop broker and remove scheduled task')) {
            Stop-TaskBroker
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "removed  $TaskName"
        }
    } elseif ($PSCmdlet.ShouldProcess($TaskName, 'Stop broker and start the task again')) {
        Stop-TaskBroker
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "started  $TaskName (check the log: $env:LOCALAPPDATA\agent-bus\logs)"
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
