# Project harness setup

For migration from an existing native harness (for example Codex to Claude Code)
or explicitly requested remote harness deployment, use
[`sync-harnesses`](../../sync-harnesses/SKILL.md). Preserve the selected mode and
previous answers. That skill distinguishes reviewed native migration, local
projection, remote delivery, and existing-follower limitations.

Project-local projection is separate from Source/Follower synchronization. Do
not initialize machine identities, ask fleet questions, or discover Tailscale
peers for this local branch alone.

## Inspect and offer choices

Observe the repository root, the single existing harness YAML/YML/JSON source,
`.canonfig/.harness-state.json`, instructions, rules, skills, MCP, hooks, agents,
commands, permissions, installed targets, and native-file collisions:

```bash
canonfig harness targets
canonfig harness doctor --json
canonfig harness status --json
```

In Simple, offer unresolved targets, approved instruction/skill inputs, and
collisions; show other settings in an editable summary. In Advanced, offer each
relevant section from [the catalogue](configuration-choices.md), then use its
recursive menus for each selected record's fields. Follow [questions](questions.md)
for numbered options, explanations, recommendations, multi-select, and Other.

Do not ask the user to define empty optional sections. An Advanced section menu
can choose Keep / Disabled / Configure / Other before asking record details.
Simple must not discard detected or explicitly requested MCP/hook/agent settings.

Targets come from the installed target listing, not an invented or stale enum.
Distinguish installed candidates from requested targets; installation alone is not
intent. Preserve valid format and files, recommend YAML for a new source unless
JSON is established, and begin with strict translation to surface compromises.

```text
Question: FORMAT — Which harness source format should this project use?
Why it matters: Exactly one YAML/YML/JSON source can be active.
Detected: <existing format, or omit if none>
Recommended: Preserve the existing format; otherwise 1, the documented YAML default.
Options:
1. YAML — human-editable source using the default scaffold.
2. Strict JSON — explicit JSON source with the same schema.
3. Other (type your own) — describe a format requirement to validate.
```

For an existing source, add Keep current as the first option instead of
implicitly offering a destructive migration. Custom unsupported formats are
clarifications, not permission to create competing harness files.

## Scaffold and populate

After approval, scaffold only a new source, with selected targets:

```bash
canonfig harness init
```

Or when JSON was chosen:

```bash
canonfig harness init --format json
```

Use approved canonical instructions/rules/skills and only intended optional
features. Every nested field has numbered choices plus Other: MCP transport,
command/args/cwd/URL, env/header references, timeouts/tool filters; hooks' events,
matchers/run/failure behavior; agents' models/tools/writability; commands' source
files/hints; permissions' patterns/actions; and supported target extensions.
Never copy secret values into source, generated files, or tool output.

## Validate and plan

```bash
canonfig harness validate
canonfig harness plan --strict
canonfig harness diff
```

Keep selected targets and strictness consistent across validate/plan/diff/apply.
Show support per feature, changed paths/keys, executable shims, ownership, and
symbolic credential references. Strict mode rejects shim/lossy/unsupported
mappings. A non-strict choice requires explicit review of each compromise;
unsupported functionality does not become supported by suppressing a diagnostic.

```text
Question: COLLISION — May Canonfig take ownership of <specific path or key>?
Why it matters: Force may replace an existing native entry or an externally edited artifact.
Detected: <verified conflict and reviewed before/after content>
Recommended: 1 — preserve the existing entry until an intentional transfer is approved.
Options:
1. Preserve — do not overwrite the existing content.
2. Transfer this reviewed entry — authorize only this exact ownership change.
3. Revise canonical source — avoid the conflict and produce another plan.
4. Other (type your own) — explain the required ownership behavior.
```

Approval for one collision does not authorize blanket `--force`. The flag is
not a per-file selector: isolate or resolve other collisions before applying it,
and verify that every affected entry is explicitly approved.

## Apply and verify

Use the stage approval menu after plan review. For a strict selected plan:

```bash
canonfig harness apply --strict
canonfig harness status
canonfig harness doctor
```

Check diagnostics and actual pending entries, not just process exit codes.
Target doctor output may report missing executables while the command succeeds.
Configuration generated is not the same as the installed harness loading it;
report required unavailable targets as unresolved and verify native loading when
an authorized, supported check exists. Preview cleanup before approving removal
of Canonfig-owned artifacts.

## Completion

Require one canonical source, valid configuration, explicit targets/support,
no unapproved collision/force/edit, successful apply, and no pending owned
changes. Report target-probe results and every translation limitation. Both
modes use the same evidence; a skipped optional section is not a failed setup,
but a deferred required feature prevents full completion.
