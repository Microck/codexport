---
name: install-canonfig
description: Install Canonfig 2 from its scoped npm package and initialize a Source Machine or securely enroll a Linux, macOS, or Windows Follower Machine. Use for Canonfig prerequisites, package installation, first-time source setup, follower invitations and pinned trust, native schedule setup, installation verification, or installation troubleshooting.
---

# Install Canonfig

Install the shipped package, establish exactly one machine role, and stop at any
security or human-action boundary.

## Workflow

1. Identify the operating system, machine role, user account, and whether the
   request is interactive.
2. Read exactly one platform branch:
   - Linux: [references/linux.md](references/linux.md)
   - macOS: [references/macos.md](references/macos.md)
   - Windows: [references/windows.md](references/windows.md)
3. Confirm Node.js 24 or newer and npm are available.
4. Install the exact `@microck/canonfig@3.1.4` package version. The installed
   executable remains `canonfig`.
5. Run `canonfig --version` and bounded diagnostics.
6. Initialize a Source Machine **or** enroll a Follower Machine. Never initialize
   both roles in the same state directory.
7. On a follower, inspect the selected profile, configure the native schedule,
   and run a plan before the first apply.
8. Report the role, installed version, diagnostics, selected profile, schedule,
   and every unresolved Human Action Required record. Installation is complete
   only when these observations are explicit.

## Source Machine

Initialize local source authority:

```bash
canonfig source init
canonfig doctor --no-input --timeout-ms 5000
canonfig profile list
```

The shipped server is loopback-only:

```bash
canonfig source serve --host 127.0.0.1 --port 17342
```

Create a short-lived, single-use invitation only while the endpoint is running:

```bash
canonfig source invite --endpoint https://127.0.0.1:17342 --expires 15m --group developers
```

Treat the returned invitation as temporary sensitive material. The endpoint must
be reachable as the exact enrolled HTTPS origin; cross-host exposure and port
forwarding are outside the shipped contract.

## Follower Machine

Keep the invitation in an ephemeral shell variable, then enroll:

```bash
canonfig follower enroll "$INVITE" --name laptop --profile workstation
canonfig profile select workstation
canonfig sync --plan
```

Enrollment pins the source TLS and signing fingerprints and issues an
independently revocable follower credential. Refuse an expired, replayed,
exposed, or fingerprint-mismatched invitation. Request a new invitation from
the Source Machine; never reset trust or suppress verification.

Configure and inspect the default native schedule:

```bash
canonfig schedule set daily@00:00
canonfig schedule status
```

The schedule invokes `canonfig sync --apply --no-input`. Apply interactively
only after the plan matches the intended targets:

```bash
canonfig sync --apply
canonfig status
```

## Safety boundary

- Keep source signing material, follower credentials, invitation payloads, and
  the SQLite state database out of repositories, logs, screenshots, and chat.
- Store credentials through Secret Service, Keychain, or Credential Manager.
  If secure noninteractive storage is unavailable, preserve the Human Action
  Required outcome and present its exact instructions.
- Keep secrets out of command arguments, profile content, recipes, and
  environment examples.
- Preserve certificate pins, action journals, follower-modified skills, and
  existing state while troubleshooting.
- Use user-level installation and schedulers. Treat elevation, login, restart,
  or reboot as explicit human decisions.

## Troubleshooting

Run:

```bash
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig status --json
```

Interpret exit code `3` as Human Action Required, `4` as conflict or Follower
Drift, `5` as authentication or revocation, `6` as transport, and `7` as
verification or apply failure. Preserve evidence and resolve the reported cause
instead of deleting state.
