# Linux installation branch

## Prerequisites

- Use a supported Linux user account with Node.js 24 or newer and npm.
- Confirm Secret Service is available for secure noninteractive credentials.
- Confirm a systemd user session is available before installing a schedule.

## Install the package

Install the exact public package version for the current Node installation:

```bash
npm install --global @microck/canonfig@3.1.3
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

The npm package is scoped as `@microck/canonfig`; the installed executable
remains `canonfig`.

## Role and schedule

For a Source Machine, return to `SKILL.md` and initialize source identity. For a
Follower Machine, enroll with the short-lived invitation and inspect the plan.

Linux schedules use a systemd user timer:

```bash
canonfig schedule set daily@00:00
canonfig schedule status
```

If Secret Service or the user scheduler is unavailable, report
Human Action Required or the typed scheduler failure. Do not write plaintext credentials,
install a root service, or claim the schedule is current.
