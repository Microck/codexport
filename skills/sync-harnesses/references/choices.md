# Harness sync choices

Reuse earlier answers. Simple means fewer questions, not fewer checks. Every
editable field below uses this menu contract, including nested records:
`Question: ID`, `Why it matters:`, optional `Detected:`, `Recommended:`, and
consecutive numbered `Options:` ending in `Other (type your own)`.
Give each option a brief consequence. Offer only supported alternatives; custom
input is validated data, never permission or a command. Paginate long inventories.

## Essential menus

Ask MODE only when it is not known. A custom preference maps to one of the two
modes; clarify rather than inventing a third mode.

```text
Question: MODE — How much detail should setup expose?
Why it matters: Both modes preserve originals and verify results.
Recommended: 1 — fewer decisions for a normal migration.
Options:
1. Simple — essentials, recommendations, and an editable summary.
2. Advanced (in-depth) — review each relevant field and translation.
3. Other (type your own) — describe the guidance needed.
```

INPUT choices come from inspected configuration, not merely installed binaries.
Skip this question when the user already chose Codex. These are example labels,
not claims that configuration has been detected.

```text
Question: INPUT — Which configuration should we start from?
Why it matters: This chooses migration input, not a Source Machine identity.
Recommended: Keep existing canonical sources; otherwise use the requested harness.
Options:
1. Existing Canonfig sources — preserve reviewed shared configuration.
2. Codex — review selected Codex files before converting supported fields.
3. Claude Code — review selected Claude files before converting supported fields.
4. Other (type your own) — name a harness or a non-secret configuration path.
```

ROOT and SCOPE are separate fields when ambiguous. Never use the entire home
directory as a projection root to imitate global sync.

```text
Question: SCOPE — Which settings should enter this project?
Why it matters: Importing user-wide settings makes selected values project-visible.
Recommended: 1 — avoid spreading unrelated global preferences or credentials.
Options:
1. Project settings only — leave user-global configuration alone.
2. Project plus selected global settings — inspect global files after consent.
3. Review global-only requirements — identify what project projection cannot do.
4. Other (type your own) — specify a narrower input scope.
```

TARGETS is multi-select; offer actual IDs from the installed adapter registry,
with installed/unknown and feature compatibility labels. INPUT is not
implicitly included. These example destinations are supported adapter IDs, not
assumptions about the operator's installation.

```text
Question: TARGETS — Which harnesses should receive the shared configuration?
Why it matters: Each harness needs its own translation and verification.
Recommended: Select only the destinations named in the request.
Options:
1. Claude Code (claude-code) — project instructions, MCP, and selected features.
2. Antigravity (antigravity) — the installed adapter's CLI/project mappings.
3. Codex (codex) — also manage Codex outputs after reviewing its existing keys.
4. Other (type your own) — another installed-registry target or a combination.
```

FEATURES offers inspected feature groups, not an automatic selection of every
hook or permission. Simple must still disclose requested unsupported fields.

```text
Question: FEATURES — What should be migrated?
Why it matters: Hooks execute code; permissions and models may not be portable.
Recommended: 1 — start with useful non-executable shared configuration.
Options:
1. Instructions, skills, and selected MCP definitions — review credentials separately.
2. All discovered features for review — include rules, hooks, agents, and commands.
3. Keep the current canonical selection — avoid re-importing native changes.
4. Other (type your own) — list features or individual records.
```

```text
Question: MACHINES — Where should the configuration be applied?
Why it matters: Every remote checkout needs separate access, paths, and verification.
Recommended: This computer unless additional machines were requested.
Options:
1. This computer — project-local projection only.
2. Selected remote machines — choose known hosts and approve access separately.
3. Prepare a remote handoff — generate instructions without claiming deployment.
4. Other (type your own) — name a machine or explicit combination.
```

## Advanced sections and editable Simple summary

Expose only relevant sections. Selecting Keep accepts a section's displayed
values; selecting Edit opens the same numbered menu for each nested field.
Every listed field has Keep/current, supported alternatives, and Other; optional
records also have Disabled/Exclude. No fixed four-choice ceiling for registries:
show short pages and preserve the number-to-ID mapping.

| Section | Editable fields and useful choices |
| --- | --- |
| Input | Harness, machine, project root, user/project scope, selected native files, canonical reuse versus explicit re-import. Choose detected paths, approved global files, or a typed path. |
| Canonical sources | YAML or strict JSON; existing root or another checkout; project name; instructions file; rule and skill roots. Do not create a second format. |
| Destinations | Target IDs, versions observed, enabled state, target options; multi-select actual adapters. Preserve unselected target ownership. |
| Rules and skills | ID, file/root, activation, description, path scope, included assets; preserve content, narrow scope, or exclude after review. |
| MCP | Server ID, enabled state, stdio/streamable-http/sse, command, args, cwd, URL, symbolic env/header references, timeoutMs, enabledTools, disabledTools. Do not weaken filters when a target cannot represent them. |
| Hooks | ID, enabled state, event, matcher capabilities/tools/inputRegex, run argument list, timeoutMs, onFailure block/warn/ignore. Preserve safety behavior or block the mapping. |
| Agents | ID, file, description, model, tools, writable; choose supported target semantics, retain native, or exclude explicitly. |
| Commands | ID, file, description, argumentHint; retain native command or review translation into a skill. |
| Permissions | Pattern, allow/ask/deny, reason; inspect actual adapter support, not just schema acceptance. Do not turn a source denial into a destination default allow. |
| Extensions | Target ID and supported target-specific keys; keep local, review explicit mapping, or exclude. Not a passthrough for arbitrary source keys. |
| Compatibility | Strict; revise/remove an unsupported feature; review a specific shim/loss. Non-strict does not make unsupported features supported. |
| Ownership | Preserve, revise candidate, or transfer individually reviewed entries. Force is invocation-wide, not scoped to one approved row. |
| Remote | Stable device ID/host, account, shell, checkout, targets, delivery route, canonical digest, credentials available locally; manual entry always works. |
| Repeated runs | On demand; approved project task/handoff; separately reviewed scheduler or delivery integration. No built-in harness watcher or remote scheduler. |

Ask for secret reference names and secure input methods, never secret values.
"Other" cannot bypass schema checks, unsupported features, or access controls.
`Use recommendations` excludes consent and approval questions. A batch response
may be `SCOPE=1; TARGETS=1,2; ROOT=3: /work/project`. A bare number answers only
one active question. Accept corrections without replaying the interview.

## Approval menu

Instantiate this for canonical writes, remote reads/delivery, and each apply
stage. Reuse approval for the unchanged displayed scope; a new host, changed
plan, broader permissions, or different input requires new approval.

```text
Question: APPLY — Apply the displayed changes on the listed machine and project?
Why it matters: This changes owned project configuration and may install executable shims.
Recommended: Review first; no automatic approval.
Options:
1. Apply this reviewed stage — only the listed paths, targets, and machine.
2. Keep the plan only — make no destination changes.
3. Revise the selection — update settings and show a new plan.
4. Other (type your own) — narrow the scope or stop.
```
