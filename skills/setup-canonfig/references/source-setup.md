# Source Machine setup

Use for the sole publishing authority, Machine Profile authoring, publication,
and invitations. Follow the selected Simple/Advanced mode and numbered question
contract from [questions.md](questions.md), not a separate free-text interview.

## Inspect and select

Confirm user, Node.js 24+, npm, installed Canonfig version, secure credential
capability, existing role, revisions, and diagnostics. Never initialize over a
Follower identity or unknown state. These are conditional observations:

```bash
canonfig --version
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig profile list
```

If choosing another computer, offer This machine / Opt-in Tailscale listing /
Manual entry / Other through [device discovery](tailscale-discovery.md). A
selected remote peer remains unconfigured until an authorized handoff or session
verifies it. Never initialize locally on behalf of a selected remote machine.

In Simple, ask only unresolved profile identity and configuration scope after
ownership is established; show groups, schedule default, and policies as editable
summary rows. In Advanced, offer environment, devices, profile, each resource,
credentials, and invitation sections from [the catalogue](configuration-choices.md).
For each field: observed candidates, supported alternatives, numbered Other, a
short explanation, and a justified recommendation. No invented profile inventory.

Recommend preserving valid state, only explicit approved discovery files, no
additional groups without a need, deterministic-only, and no new shared secrets.
Profile names such as workstation are proposals, not discovered facts. Calendar
proposals must show their timezone and remain editable.

## Install and initialize

After the displayed stage is approved, install only if necessary:

```bash
npm install --global @microck/canonfig@3.1.2
canonfig --version
canonfig source init
canonfig doctor --no-input --timeout-ms 5000
```

Initialization establishes signing/TLS authority, not a published profile.
Report its owner and location without displaying key material. Preserve existing
compatible installations and identities rather than rerunning initialization.

## Discover and author

Scan only approved explicit files. Example:

```bash
canonfig source scan --file AGENTS.md --file package.json
```

Summarize accepted and needs-review evidence, login requirements, skills, tool
recipes, and unresolved Agent Tasks. Do not execute discovered prose or infer
package equivalence across platforms. Prefer an authored JSONC Machine Profile
for files, configs, skills, tools, credentials, schedules, groups, dependencies,
and verified per-platform recipes.

Show compact editable resource rows: ID/kind, target, groups, dependencies,
ownership/policy, recipe/version, and independent verification. Simple drills
into ambiguous or requested rows; Advanced offers each relevant field. Use the
catalogue's recursive numbered menus for content, permissions, symlinks, config
keys, build bounds, and checks rather than asking users to write raw schema.

| Kind | Documented default Apply Policy |
| --- | --- |
| file | replace |
| directory | mirror-owned |
| config | merge |
| skill | replace-if-unmodified |
| tool | ensure |
| credential | require-local |
| schedule | replace |

A default replacement policy is not proof an existing target is safe to overwrite.
Offer only schema-compatible alternatives and show destructive consequences.
Credential resources hold references, never values. Local Overlays are for
supported merge-config keys, not arbitrary skill-tree or target-path overrides.

## Publication gate

Validate unique IDs, dependencies, cycles, group references, nonoverlapping safe
targets, policy compatibility, platform recipes, and independent verification.
Show the exact profile, groups, calendar, resources, discovery inputs, and any
blockers. Hash reviewed input files and recheck before publication; publication
with `--proposal` rescans that input. If it changed, review the changed candidate.
Do not invent a validation/dry-run flag absent from the installed CLI.

```text
Question: PUBLISH — Publish this exact Machine Profile as a new immutable revision?
Why it matters: Authorized followers can consume the signed revision; publication is permanent.
Recommended: No automatic recommendation; review all resources and unresolved items first.
Options:
1. Publish this candidate — sign only the reviewed content, with no unresolved blockers.
2. Revise a setting — reopen its choices and revalidate the candidate.
3. Stop before publication — preserve authoring files without signing.
4. Other (type your own) — request a narrower candidate or explanation.
```

After explicit publication approval, use actual reviewed paths, reviewer, and
returned revision IDs, not the illustrative IDs below:

```bash
canonfig source publish --profile-file ~/.canonfig/source/profile.jsonc --reviewer operator
canonfig profile list
canonfig profile show revision-one
```

Add `--proposal <approved-input>` only for reviewed discovery input to merge.
Do not duplicate publication on resume merely to demonstrate success.

## Serving, invitations, and shared secrets

Serve loopback only. Example for an explicitly approved group:

```bash
canonfig source serve --host 127.0.0.1 --port 17342
canonfig source invite --endpoint https://127.0.0.1:17342 --expires 15m --group developers
```

Omit `--group` when no group is intended. Tailscale peers are not valid direct
invitation endpoints. Use the discovery reference's separately approved,
operator-managed TLS-transparent tunnel/handoff flow for remote machines.
Record the follower-local loopback origin separately from the source host.

Offer numbered choices for follower identity, selected profile, declared groups,
lifetime, secure delivery, and any shared-secret grant. Recommend minimum scope,
15m proposed expiry, and fresh material for exposed, expired, or replayed invites.
Never ask for or display a real invitation in chat or reports. A protected file
is only a temporary local input method, not a new CLI invitation-file flag.

`canonfig:secrets` is separate authority. Before granting it, review what the
installed sharing contract makes available; do not imply unsupported per-name
access controls. A new grant requires explicit approval, not Use recommendations.
Set approved values through stdin only, without printing them:

```bash
printf %s "$GITHUB_TOKEN" | canonfig secrets set github-token
```

## Completion

Verify intended Source owner/identity and relevant diagnostics. When publication
was requested, report actual profile/revision ID, sequence, digest, and time;
inspect that revision against the reviewed candidate. Keep unresolved recipes,
Human Action Required, and unconfigured remote machines explicit. Source-only
initialization need not publish an unrequested profile to count as complete.
