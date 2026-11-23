---
name: broker-restart
description: 'Restart the agent-bus broker with install-task.ps1 -Restart, never Stop-/Start-ScheduledTask'
type: feedback
---

Restart the broker with `scripts/install-task.ps1 -Restart` (Windows PowerShell 5.1: `& .\scripts\install-task.ps1 -Restart`; `pwsh` isn't installed on Nick's machine).

**Why:** on 2026-11-19 I told Nick to use `Stop-ScheduledTask; Start-ScheduledTask`. The task stopped but the node broker survived holding port 47823, so the new one exited 78 ("port in use") and the old broker kept its old environment (`AGENT_BUS_HOLD_SECONDS`). `-Restart` stops the launcher and the node process by ID and waits for the port (README 0.4.2).

**How to apply:** whenever an env var changes or new broker code needs to go live; afterwards confirm in `%LOCALAPPDATA%\agent-bus\logs\broker-<local date>.log` that "agent-bus broker listening" is newer than the change. See [[live-slack-testing]].
