---
name: broker-restart
description: 'Restart the agent-bus broker with install-task.ps1 -Restart, never Stop-/Start-ScheduledTask'
type: feedback
---

Restart the broker with `scripts/install-task.ps1 -Restart` (README, "Start
the broker at login"), never `Stop-ScheduledTask; Start-ScheduledTask`.

**Why:** the scheduled task stops but the node broker survives holding the
port, so the new one exits 78 ("port in use") and the old broker keeps its
old environment. `-Restart` stops both and waits for the port (README
changelog 0.4.2).

**How to apply:** whenever an env var changes or new broker code needs to go
live; then check the broker log (README "Troubleshooting") shows "agent-bus
broker listening" after the change.
