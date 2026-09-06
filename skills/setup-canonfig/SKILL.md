---
name: setup-canonfig
description: Guide Canonfig setup across Linux, macOS, and Windows in Simple or Advanced mode, with numbered questions, explanations, recommended answers, custom input, optional Tailscale device discovery, and verified Source Machine, Follower Machine, or project harness setup.
---

# Set Up Canonfig

Inspect first, offer choices rather than blank forms, and turn the requested
outcome into verified state. Simple and Advanced change interview depth, never
permissions, trust checks, or the definition of completion.

## Interaction contract

1. Inspect before asking. Observe local platform, architecture, user, home,
   shell, Node.js/npm, Canonfig version, existing state, credential capability,
   scheduler, and relevant project configuration. Do not discover network peers
   until the operator selects discovery. Do not claim access to remote machines
   or inspect an agent sandbox as though it were the operator's computer.
2. Do not ask for facts already established by inspection or an earlier answer.
   A detected value is editable; it is not permission to replace existing state.
3. Ask no more than four related unresolved questions per round. Simple should
   normally need one to three essential decisions after mode selection. Advanced
   uses short sections, not a wall of every possible question.
4. Every configurable question, in every branch, has a stable field ID, a short
   `Why it matters`, optional `Detected`, a justified `Recommended` answer (or
   `No automatic recommendation`), numbered `Options`, and a numbered
   `Other (type your own)` escape. Give each option a brief consequence. Do not
   invent alternatives for a field that has only one supported value.
5. Accept an option number, its label, or custom text. Multi-select fields accept
   comma-separated numbers. In a batch use `ROLE=2; NAME=3: studio-laptop`.
   Resolve an ambiguous bare number before any mutation; never silently choose
   which question it answers.
6. `Use recommendations` accepts only displayed configuration recommendations.
   `Skip optional` leaves new optional features disabled and preserves existing
   settings. `Show advanced options`, `advanced`, `in-depth`, and `complex` select
   Advanced; `simple` selects Simple. Switch without restarting or losing answers.
7. Do not ask about optional shared secrets in Simple mode unless relevant.
   Likewise, keep agent execution and empty harness features out of the essential
   interview. Show editable defaults once. In Advanced, offer each relevant
   section, including a numbered keep/disabled choice before detailed fields.
8. Never request passwords, tokens, private keys, credential values, or invitation
   payloads in chat or custom answers. Ask for a secure local input method, not
   the secret. Never retain raw peer maps or secrets in a setup record.
9. A recommendation is not approval. Publication, first apply, shared-secret
   authority, identity replacement, `--force`, agent execution, elevation, restart,
   and reboot require explicit, scoped approval after showing their consequences.
   Reuse approval only for the unchanged displayed stage; do not ask repeatedly.

Read [questions](references/questions.md) before presenting choices. The
[configuration catalogue](references/configuration-choices.md) covers editable
fields, including free-form values and nested resource/harness records.

## Setup modes

Ask MODE once unless the request or resumed session already specifies it:

```text
Question: MODE — How much setup detail would you like?
Why it matters: Both modes make the same safety checks; only the questions differ.
Recommended: 1 — Simple keeps routine choices out of the way.
Options:
1. Simple — essentials and editable recommended defaults.
2. Advanced (in-depth) — review each relevant configuration section.
3. Other (type your own) — describe the guidance you need.
```

There are exactly two modes. Map a typed preference to Simple or Advanced; ask
only when the preference is ambiguous. Do not infer agent permission from mode.

### Simple

Inspect, show essentials with choices, then show one numbered summary whose rows
can be edited through the same choice menus. Prefer existing valid settings;
propose conservative defaults for new settings. A custom answer opens only its
necessary follow-up, not the entire Advanced interview.

If every remaining value has a safe, reversible default in Simple mode, show the
editable summary and continue to the bounded plan rather than asking each field.
Always surface ownership conflicts, missing requirements, unsupported work, and
shared-secret authority, even when they are inconvenient.

### Advanced

Offer these relevant sections in small batches: environment/install, machines
and connectivity, profile/resources, credentials, agent bounds, schedule, and
project harness features. Skip unrelated branches. Populate existing values and
let the operator keep a whole section; do not force empty hooks or MCP records.
Every field must remain editable through numbered options plus custom input.

For both modes, keep a non-secret decision record: field ID, value, provenance
(Detected/Operator/Recommended default), validation, scope, and approval. Include
mode, deferred requirements, and selected device IDs; re-observe on resume.

## Route the request

- Source identity, Machine Profile, publication, invitations:
  [source setup](references/source-setup.md).
- Follower enrollment, convergence, schedule, recovery:
  [follower setup](references/follower-setup.md).
- Repository-local AI configuration:
  [harness setup](references/harness-setup.md).
- Machine choices from Tailscale, only when relevant and opted in:
  [device discovery](references/tailscale-discovery.md).
- Evidence and final report:
  [completion](references/completion.md).

Harness projection is separate from Machine Profile synchronization. A
harness-only request needs no Source, follower enrollment, or Tailscale discovery.
CLI-only installation needs no machine identity or schedule.

## Workflow

### 1. Observe and establish scope

Inspect locally with bounded probes appropriate to the installed version. These
commands are examples, not an unconditional script:

```text
node --version
npm --version
canonfig --version
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig status --json
canonfig schedule status
canonfig agent policy
canonfig agent harness
canonfig harness targets
canonfig harness status --json
canonfig harness doctor --json
```

A missing command is an observation, not permission to install it. Diagnostic
commands may write lifecycle logs or local bookkeeping; never initialize or
repair an identity just to inspect it. Label examples as examples, never as
observations. Inspect only approved files, not the entire home directory.

If scope is unclear, offer ROLE choices from `references/questions.md`. Select
MODE once. If there is no access to the intended machine, state that limitation
and offer local handoff instead of fabricated diagnostics.

### 2. Collect only the selected mode's decisions

Present 1–4 useful numbered choices plus Other for each question. Paginate longer
inventories. Prefer detected candidates; mark proposals and unavailable choices
honestly. Reuse existing configuration without erasing it to apply a new default.

New-setting recommendations: user-level operation, the documented exact package,
`deterministic-only`, no shared secrets, no force, no elevated capabilities, and
YAML for a new harness unless JSON is already established. Scheduling remains an
explicit choice; there is no universal working-hour or timezone assumption.

Resolve custom text against the installed CLI/schema before proposing execution.
A name, hostname, path, or menu selection is data, never a shell command.

### 3. Validate and show one bounded plan

Verify role/state separation, sole publishing authority, profile/group access,
resource dependencies, targets, policies, recipes, and independent verification.
Inspect conflicts and existing overlays. For requested automation, check native
user scheduling, secure noninteractive credentials, executable environment, and
source/tunnel availability. No secrets may enter profiles, reports, or arguments
except the CLI's documented ephemeral invitation input.

Show changed settings, targets, ownership, pending requirements, and verification.
Unchanged rows can stay collapsed. Use the approval question pattern in
`references/questions.md`; never treat mode selection, a device selection, or
`Use recommendations` as authorization to execute.

### 4. Execute and resume idempotently

Read the selected branch and execute only approved stages. Node.js 24 or newer
and npm are required; the documented package for this revision is:

```bash
npm install --global @microck/canonfig@3.0.1
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

Preserve an existing compatible version unless an upgrade is requested/approved.
Check installed help when it differs; do not downgrade silently.

| Platform | Secure credentials | User scheduler |
| --- | --- | --- |
| Linux | Secret Service | systemd user timer |
| macOS | Keychain | launchd user agent |
| Windows | Credential Manager | per-user Task Scheduler |

Preserve pins, identity, SQLite state, journals, cache, follower edits, and harness
ownership records. Resume from evidence; do not reinstall, reenroll, republish,
reset trust, or force ownership just because setup is invoked again.

### 5. Verify and report

Use the completion checklist in both modes. Separate discovered, selected,
reachable, enrolled, converged, and scheduled machines. One configured machine
is not proof that the whole selected fleet is configured. Unavailable optional
discovery does not prevent an otherwise verified local setup from completing.

## Stop conditions

Stop the affected stage for conflicting identity, unapproved mutation, changed
publication inputs, guessed recipes, unavailable required secure storage, drift,
or failed verification. Preserve Human Action Required and Follower Drift.
Canonfig source endpoints remain loopback HTTPS; a Tailscale IP or MagicDNS name
is not a supported direct invitation endpoint. Discovery never changes that rule.
Do not disable trust checks, overwrite evidence, or silently mark deferred
requirements complete in either mode.
