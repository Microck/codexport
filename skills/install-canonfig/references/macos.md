# macOS installation branch

## Prerequisites

- Use a supported macOS user account with Node.js 24 or newer and npm.
- Confirm Keychain is available to the user that will run Canonfig.
- Confirm the user launchd domain is available before installing a schedule.

## Install the package

Install the exact public package version:

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

macOS schedules use a launchd user agent:

```bash
canonfig schedule set daily@00:00
canonfig schedule status
```

If Keychain or the user launchd domain is unavailable, preserve the resulting
Human Action Required or scheduler failure. Do not create plaintext credential
files, install a system daemon, or claim convergence.
