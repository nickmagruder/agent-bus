<#
.SYNOPSIS
  Runs the agent-bus broker and restarts it after a crash. Started at logon
  by the "agent-bus broker" scheduled task (see install-task.ps1).

.DESCRIPTION
  The broker writes its own daily logs to <data dir>\logs (--log-to-file).
  Exit codes:
    0   clean shutdown        -> stop
    78  config or port problem -> stop (a restart can't fix it; see the log)
    other                      -> restart after 5 s, doubling to 5 min; the
                                  delay resets after 10 minutes of uptime
  Launcher messages go to <data dir>\logs\launcher.log.
#>
$ErrorActionPreference = 'Stop'

$Repo    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DataDir = if ($env:AGENT_BUS_DATA_DIR) { $env:AGENT_BUS_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'agent-bus' }
$LogDir  = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$LauncherLog = Join-Path $LogDir 'launcher.log'
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-LauncherLog([string]$Message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    [System.IO.File]::AppendAllText($LauncherLog, $line + [Environment]::NewLine, $Utf8NoBom)
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-LauncherLog 'node not found on PATH; not starting the broker'
    exit 78
}

$delay = 5
while ($true) {
    $started = Get-Date
    Write-LauncherLog "starting broker ($node)"
    & $node --disable-warning=ExperimentalWarning (Join-Path $Repo 'src\broker\main.ts') --log-to-file
    $code = $LASTEXITCODE
    if ($code -eq 0 -or $code -eq 78) {
        Write-LauncherLog "broker exited with $code; not restarting"
        exit $code
    }
    if (((Get-Date) - $started).TotalMinutes -ge 10) { $delay = 5 }
    Write-LauncherLog "broker exited with $code; restarting in $delay s"
    Start-Sleep -Seconds $delay
    $delay = [Math]::Min($delay * 2, 300)
}
