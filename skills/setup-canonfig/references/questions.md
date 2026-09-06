# Guided choices

Offer decisions, not blank forms. Apply this contract to every question in every
branch, including nested settings, corrections, confirmations, and advanced fields.

## When to ask

Always select MODE once unless already supplied. In Simple, ask only unresolved
intent, essentials, and conflicts; expose other defaults in an editable summary.
In Advanced, offer every relevant configuration section from the
[configuration catalogue](configuration-choices.md), with keep/disabled choices
before nested questions. Existing answers are prefilled in both modes.

Do not ask for facts already established. An optional section is not a required
questionnaire. A skipped required value remains deferred or blocked, not passed.

## Required format

Use a stable field ID instead of numbering both questions and answers. Keep each
question to a few lines; one sentence explains why and one justifies the default.
Never disguise an inference as a detected fact.

```text
Question: ROLE — What should this machine do?
Why it matters: One Source publishes profiles; followers consume them.
Detected: <verified existing role, or omit this line>
Recommended: Keep the verified role; otherwise No automatic recommendation.
Options:
1. Source Machine — own and publish canonical configuration.
2. Follower Machine — receive configuration from an existing Source.
3. CLI only — install without creating a machine identity.
4. Other (type your own) — describe a different goal, such as project setup.
```

Each Options block must use consecutive numbers starting at 1 and end with an
`Other (type your own)` choice. Every option gets a short consequence, not just
an unexplained identifier. Show 1–4 useful alternatives before Other. A boolean
gets Yes / No / Other, not a bare yes/no prompt. A string gets detected value /
reasonable proposal / Other, not invented project or profile names presented as
facts. Finite enums accept Other for clarification but never unsupported values.
Use More results or a filter for long lists; Other is always visible.

Mark single-select versus multi-select. For multi-select, Keep, None, and Skip
are exclusive with other choices. Do not infer that all discovered devices or
installed harnesses should be selected.

## Answer handling

Accept an option number, option label, or plain custom text. Multi-select fields accept
comma-separated numbers. The operator can
override answers by question number or field name; stable field IDs are preferred.
Examples of replies (not commands):

```text
MODE=1; ROLE=2
NAME=3: studio-laptop
MACHINES=1,3
Use recommendations, except schedule: weekly:Mon@10:00 Europe/Madrid
Other: keep this machine local for now
```

A bare `2` is valid only for one active question. If a batch makes it ambiguous,
ask which field it refers to; do not guess. Validate unknown labels, out-of-range
numbers, conflicting multi-selects, paths, IDs, URLs, and enums before execution.
Ask only to repair the invalid field. Other never bypasses schema or permissions.

`Use recommendations` accepts only configuration recommendations already shown;
it never approves future publication, apply, trust changes, shared-secret grants,
agent execution, or elevated capabilities. Exclude consent/approval questions from
bulk recommendation acceptance, even when displayed in the same round.

`Skip optional` preserves existing settings and leaves new optional features off.
`Show advanced options` switches to Advanced. `simple` switches back. Accept
in-depth, indepth, complex, and detailed as Advanced aliases. Keep answers and
approvals for unchanged stages; show only newly relevant questions.

## Recommendation and evidence policy

Prefer existing valid state, then documented conservative defaults. Recommend
minimal mutation, user-level native facilities, deterministic execution, and
independent verification. Never recommend force, deletion, pin reset, permission
expansion, or identity replacement just to pass setup.

Use provenance Detected, Operator, Recommended default, Needs review, or Blocked.
A generated name or example time is a proposal, not a machine observation. Required
operator decisions may have No automatic recommendation. Never collect secret
values through Other; ask for a local input method instead.

## Common menus

These are templates. Replace placeholders with verified candidates or remove an
unavailable choice. Do not ask a field already answered by the request.

### Name or profile ID

```text
Question: NAME — What should this follower be called? (choose one)
Why it matters: A descriptive name helps identify the machine in reports.
Detected: <local hostname, only when observed>
Recommended: 1 — keep the established name to avoid unnecessary changes.
Options:
1. Keep <existing name> — preserve the current label.
2. Use <observed hostname> — match the machine's local name.
3. Other (type your own) — supply a descriptive name.
```

For a new profile, offer a proposed class name such as workstation only when it
matches the request; label it proposed. Profile choices must come from an
actual authorized list or a Source operator's explicit context, not guessed IDs.

### Secure invitation input

```text
Question: INVITE_INPUT — How will you supply the invitation locally?
Why it matters: Invitations grant enrollment and must stay out of chat and history.
Recommended: 1 — keep the value only in the local terminal session.
Options:
1. Local terminal input — read into an ephemeral variable without echo/history.
2. Existing protected temporary file — load locally, then remove it.
3. Not available yet — pause enrollment and request a fresh invitation.
4. Other (type your own) — describe a secure method, never paste the invitation.
```

### Schedule

```text
Question: SCHEDULE — When should this follower synchronize? (choose one)
Why it matters: Scheduled runs apply changes and require the Source and credentials.
Detected: <verified existing/profile schedule and local timezone, when known>
Recommended: 1 — preserve a working schedule, or remain manual until first convergence.
Options:
1. Keep existing / remain manual — make no scheduler change.
2. Use <verified profile default> — follow the Source's calendar.
3. Daily at <proposed time and timezone> — use an explicitly labelled proposal.
4. Other (type your own) — give a supported daily/weekly calendar and timezone.
```

Do not hardcode a user's timezone or working hours. Offer timezone separately in
Advanced. New automatic scheduling needs consent even when the profile declares
a default. Manual mode must not silently remove an existing schedule.

### Agent policy

```text
Question: AGENT_POLICY — How should ambiguous setup work be handled?
Why it matters: Agent proposals and execution have different permission boundaries.
Recommended: 1 — deterministic-only has the smallest execution surface.
Options:
1. deterministic-only — stop for a human when no deterministic recipe exists.
2. agent-propose — review bounded suggestions without executing them.
3. agent-apply — configure explicit bounds and obtain separate execution approval.
4. Other (type your own) — describe a policy requirement to validate.
```

### Stage approval

```text
Question: APPROVE_STAGE — Execute the displayed installation stage?
Why it matters: This installs the displayed package for the specified local user.
Recommended: Review the exact changes; No automatic recommendation to execute.
Options:
1. Approve this stage — execute only its displayed changes.
2. Edit a setting — open its numbered choices without restarting.
3. Stop here — preserve the plan without executing it.
4. Other (type your own) — request a narrower scope or explanation.
```

Use separate scoped approval menus for publication, first apply, secret authority,
force, and privileged actions. Do not turn every command into a confirmation if
an unchanged bounded stage is already approved.

## Correction and completion

Accept terse corrections without replaying the questionnaire. Revalidate affected
dependencies and invalidate only approvals whose scope changed. Never reuse a
number-to-device mapping after refreshing it without showing the new list.

Before the plan, show numbered editable summary rows: role, names/profiles,
selected devices, ownership, credentials, agents, schedule, harness settings.
Mark defaults and deferred fields. Selecting a row opens the same menu in either
mode. Completeness comes from the decision record and verification, not from
making the operator answer every possible question.
