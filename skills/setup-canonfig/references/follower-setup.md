# Follower Machine setup

Use for enrollment, convergence, scheduling, or recovery. Keep the selected mode
and use [numbered choices](questions.md) for every unresolved field and approval.

## Inspect first

Observe the current user, platform, runtime, installed version, secure credential
provider, native scheduler, role, selected profile, pins, last run, and drift:

```bash
canonfig --version
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig status --json
canonfig schedule status
```

Preserve SQLite state, credentials, pins, cache, journals, Applied Resource
Records, and follower-modified skills. An unreachable source does not justify
reenrollment or pin replacement.

## Mode-aware choices

In Simple, fill the established name/profile from evidence and ask only missing
identity, Source connection, and local invitation-input decisions. Show schedule
and agent defaults in the editable summary. In Advanced, offer every relevant
field from [the catalogue](configuration-choices.md), including overlays, agent
bounds, credential handling, schedule calendar/timezone/executable, and recovery.
Both modes keep numbered options, explanations, recommendations, and Other.

Use names/profiles from actual state or explicit Source context. Enrollment tokens
do not imply a selected profile ID; do not invent a profile from an invitation.
Selecting groups is a Source authority decision, not a follower self-service menu.

For machine choices, offer optional [Tailscale discovery](tailscale-discovery.md)
or manual entry. This supplies candidates, not authorization or connectivity.
Keep offline selections pending. Do not enroll the current machine when the
operator selected another one; use a separately authorized session or handoff.

Do not ask for the invitation payload in chat. Use the INVITE_INPUT menu: local
terminal variable / protected temporary file / not ready / Other. Read privately
without echo/history, use it locally, then clear/remove the temporary input.
Never put literal tokens in an agent tool call or create an unsupported file flag.

## Install and enroll

Use an approved user-level install only when needed:

```bash
npm install --global @microck/canonfig@3.1.1
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

Required secure noninteractive storage uses Secret Service, Keychain, or Credential
Manager. Do not silently downgrade to a plaintext policy. Missing required storage
remains Human Action Required.

The source is an exact loopback HTTPS origin. A Tailscale IP/MagicDNS name is not
that endpoint; an operator-managed TLS-transparent tunnel is separate. Verify
source process/tunnel availability and preserve TLS/signing pins.

With the locally supplied variable and explicitly selected name/profile:

```bash
canonfig follower enroll "$INVITE" --name laptop --profile workstation
```

Clear the variable or remove its protected temporary file immediately afterward,
on PowerShell as well as POSIX shells. Enrollment must establish independently
revocable credentials, pinned TLS/signing fingerprints, and an authorized profile
revision. Refuse invalid/exposed/expired/replayed material and request a fresh
invitation; never reset trust or suppress verification.

Inspect granted groups without printing the invitation. If `canonfig:secrets` is
present, explain the automatic transfer on successful apply and obtain explicit
sharing consent before first apply in either mode. Discovery or mode selection
does not grant this authority.

## First plan and apply

```bash
canonfig profile select workstation
canonfig sync --plan
```

Show the actual revision, creates/updates/owned removals, recipes, dependencies,
login requirements, agent tasks/bounds, conflicts, and independent verification.
Collapse no-ops by default; keep every blocker visible in both modes.

```text
Question: APPLY — Apply this exact synchronization plan?
Why it matters: Managed targets may change; external installers are not fully reversible.
Recommended: No automatic recommendation; first review the revision and changed targets.
Options:
1. Apply reviewed changes — execute this stage with independent verification.
2. Keep plan only — make no target changes.
3. Revise configuration — reopen affected numbered settings before replanning.
4. Other (type your own) — narrow the stage or ask about its consequences.
```

After approval:

```bash
canonfig sync --apply
canonfig status --json
```

A downloaded blob is not Convergence. Inspect the actual recorded outcome and
fresh evidence; exit zero alone is not enough. An approved shared-secret transfer
must be checked separately and reported using names/references only.

## Schedule last, only when selected

Offer Keep existing/manual / verified profile default / proposed daily or weekly
calendar / Other. Timezone and executable path remain editable, separately in
Advanced. Do not invent local working hours. Manual operation is a valid choice,
not permission to delete an existing schedule.

After first convergence and explicit scheduling selection, use the chosen values
rather than copying this illustrative calendar:

```bash
canonfig schedule set daily@09:00 --timezone Europe/Madrid
canonfig schedule status
```

Native jobs execute:

```text
canonfig sync --apply --no-input
```

Verify the systemd user timer, launchd user agent, or per-user Task Scheduler
under the same user, with executable, noninteractive secure storage, source,
tunnel when needed, and visible failures. A schedule resource in the profile is
also a scheduling mutation: review it before apply. Disabled/drifted or unavailable
jobs cannot count as verified automatic operation.

## Resume, recovery, and drift

Preserve answers/mode; re-observe rather than restarting. Recover only when a
persisted interrupted run exists and the recovery stage is approved:

```bash
canonfig status
canonfig recover --no-input --json
```

Recovery uses the journal, not a new revision or invented rollback of installers.
For Human Action Required show resource, reason, and exact non-secret instruction.
For drift offer numbered Preserve local edit / Review restoring Source content /
Rework eligible local config ownership / Other. An arbitrary edited skill cannot
be moved into a Local Overlay, which is limited to supported merge-config keys.
Replan after resolution; never force ownership to escape an error.

## Completion

Report actual identity/name, profile/revision, groups, pins, verified convergence,
authorized secret outcome, and requested scheduler state. Plan-only work is
complete only as a plan-only request, never as a configured follower. Report
selected remote devices separately until they have their own evidence.
