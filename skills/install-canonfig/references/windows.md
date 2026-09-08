# Windows installation branch

## Prerequisites

- Use Windows 10 or 11 with Node.js 24 or newer and npm in PowerShell.
- Confirm Credential Manager is available to the user that will run Canonfig.
- Confirm per-user Task Scheduler access before installing a schedule.

## Install the package

Install the exact public package version:

```powershell
npm install --global @microck/canonfig@3.1.2
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

The npm package is scoped as `@microck/canonfig`; the installed executable
remains `canonfig`.

## Role and schedule

For a Source Machine, return to `SKILL.md` and initialize source identity. For a
Follower Machine, hold the invitation only in the current PowerShell process,
enroll, clear the variable, and inspect the plan.

Windows schedules use a per-user Task Scheduler task:

```powershell
canonfig schedule set daily@00:00
canonfig schedule status
```

Use Windows paths when configuring harness allowlists. If Credential Manager or
Task Scheduler is unavailable, preserve the Human Action Required or typed
scheduler failure. Do not place an invitation in command history, write
plaintext credentials, install a machine-level task, or claim convergence.
