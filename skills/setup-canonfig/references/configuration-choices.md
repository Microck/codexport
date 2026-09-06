# Configuration choice catalogue

Use this as a coverage checklist, not a questionnaire to paste into chat.
Simple exposes essential fields plus an editable summary. Advanced offers every
relevant section and supports keeping it as a whole. Both use the question
format in [questions.md](questions.md) for every editable field below.

## Construct each menu

Take the row's purpose for `Why it matters`. Turn observed values and supported
alternatives into numbered choices with brief consequences. Mark the safest
applicable choice `Recommended` and explain why. Append numbered
`Other (type your own)` even for enum, boolean, list, nested, and approval fields.
Other is a route to validated input or clarification, not an unsupported feature.

For free-form fields, offer Keep current (when present), Use a verified detected
value or explicitly labelled proposal (when available), and Other. If there is
no valid preset, offer Enter a custom value / Defer / Other; deferred required
values block the affected stage. Do not invent tokens, accounts, profiles,
versions, file paths, or package identifiers to fill a menu.

For lists, offer Keep current / Choose detected entries (multi-select) / None
(only when optional) / Other. Drill into one chosen record at a time. For nested
objects, offer Keep / Edit selected fields / Add a record / Other. Apply the same
menu rule recursively to every field in that record, including target-specific
extensions discovered in the installed schema. This avoids an endless flat form.

Preserve valid state before suggesting defaults. Existing discoveries establish
candidates, not ownership, authorization, or a requirement to enable them.

## Environment and machines

| Field(s) | Why it matters | Candidate choices to number |
| --- | --- | --- |
| Setup mode | Controls question depth, not permissions | Simple; Advanced (in-depth) |
| Goal / role | Chooses configuration authority or project-only work | Source; Follower; CLI only; project harness |
| State owner | Credentials and jobs belong to an OS account | Keep observed owner; current non-root user; another confirmed account |
| Existing state | Avoids accidental reinitialization | Keep/resume; inspect only; defer conflict resolution |
| Package / version | Must match supported commands and runtime | Keep compatible installed version; documented exact version; another verified exact version |
| Install location / method | Controls PATH and account scope | Keep working user install; approved user-owned npm prefix; defer prerequisite installation |
| Prerequisite remediation | Missing runtimes are not permission to install | Use existing supported runtime; approve documented user-level installation; stop |
| Logging | Controls local lifecycle records | Keep; default local logging; disable; approved private path |
| Device source | Supplies machine candidates, not access grants | This machine; optional Tailscale peer listing; manual inventory; defer |
| Source device | Exactly one machine publishes | Keep confirmed Source; this machine; one explicitly selected visible peer; manual candidate |
| Follower devices | Defines the requested fleet | Current machine; selected peers (multi-select); manual inventory; none yet |
| Discovery refresh | Keeps selections tied to identities | Keep displayed snapshot; refresh with consent; manual entry |
| Connection / endpoint | Must preserve Canonfig loopback TLS pinning | Existing verified loopback origin; operator-managed TLS-transparent tunnel; defer |
| Source port / follower local port | Tunnel ports can differ between machines | Keep existing; observed free candidate; custom valid port |
| Tunnel ownership / availability | Scheduled sync needs the tunnel running | Keep verified operator-managed tunnel; manual-only sync; defer scheduling |
| Remote account / access | Device visibility is not OS login permission | Existing explicitly confirmed account; manual handoff; defer |

OS, architecture, shell, and tool availability are observations. When disputed,
offer Recheck / Choose another machine / Other instead of allowing an unsupported
platform to be declared supported. Never change firewall, ACL, SSH, Tailscale
Serve/Funnel, or login settings as a side effect of selecting a device.

## Machine Profile and resources

| Field(s) | Why it matters | Candidate choices to number |
| --- | --- | --- |
| Profile ID / display name | Identifies the profile followers consume | Keep; authorized existing profile; proposed new machine-class ID/name |
| Authored profile file | Holds the reviewed desired configuration | Existing approved JSONC file; proposed new user-owned path; defer |
| Discovery inputs | Bounds what source files may be read | Selected observed files (multi-select); no discovery/use authored profile; manual paths |
| Supported platforms | Every target needs a verified recipe/path | Observed target OSes; selected Linux/macOS/Windows set; defer unknown targets |
| Groups / descriptions / resource membership | Controls which configuration is delivered | Keep; no additional groups; select declared groups; add a justified group |
| Profile schedule default | Offers a calendar, not implicit scheduling consent | Keep; supported daily; supported weekly |
| Resource ID / kind | Names a desired capability and its behavior | Keep; detected candidate; file/directory/config/skill/tool/credential/schedule |
| Resource target / per-platform design | Prevents paths and ownership from overlapping | Keep portable target; verified explicit target; separate authored resources/profiles where necessary |
| Dependencies | Determines valid apply ordering | Keep; select declared resource IDs; none when independent |
| Apply Policy | Decides treatment of local edits | Keep; kind's documented default; another schema-compatible policy |
| File content / mode / executable / symlink | Controls exact bytes, permissions, and link identity | Keep; approved source content and modes; regular file or exact raw link target |
| Directory / skill name, files, empty directories, modes | Defines the owned tree and deletion boundary | Keep; reviewed canonical tree; edit selected entries |
| Config format / keys / values | Selects shared keys without erasing local keys | JSON/TOML/YAML; keep existing keys; choose reviewed keys; edit one value |
| Local Overlay keys | Preserves explicitly follower-owned config | Keep; choose keys of an authorized merge-config resource; none |
| Verification method / arguments / expected value | Proves desired state independently | Keep valid check; compatible digest/command/executable/credential/symlink check |
| Verification timeout / scope where supported | Bounds verification cost and mutation risk | Existing documented bound; tighter supported bound; defer unsupported check |

Policies are not interchangeable: offer only combinations the installed profile
schema allows. Compute real digests from reviewed content, never placeholders in
a publication. Local Overlays apply to authorized merge-config keys; they are
not an arbitrary skill-tree merge or per-platform target override mechanism.

## Tools, credentials, agents, schedules

| Field(s) | Why it matters | Candidate choices to number |
| --- | --- | --- |
| Tool executable / upstream | Establishes the intended capability and provenance | Detected verified executable/upstream; reviewed catalogue candidate; defer |
| Per-platform method / package / exact version | Prevents installing a similarly named wrong package | Keep reviewed recipe; choose upstream-backed supported recipe; defer |
| Artifact / integrity / Python index | Bounds provenance and supply sources | Keep verified artifact/index; default supported registry; reviewed credential-free alternative |
| Build policy / steps / executables / paths / origins | Build scripts execute code | Scripts disabled; manually reviewed required build with explicit bounds; defer unsupported automation |
| Login required / instructions | Identifies a human prerequisite without copying credentials | No login when verified; existing local login; human login with non-secret instructions |
| Credential reference / provider | Keeps secret values outside profiles | Existing symbolic reference; native store reference; defer unavailable storage |
| Shared-secret authority / names / recipients | Separately grants sensitive values to followers | Keep disabled; review explicitly required names and recipients; defer |
| Invitation groups / lifetime / delivery | Limits enrollment scope and exposure | Minimal declared groups; 15m proposed expiry or another supported expiry; local private delivery |
| Agent policy | Separates deterministic work, proposals, and execution | deterministic-only; agent-propose; agent-apply with separate approval |
| Agent harness kind / executable | Selects the actual local executor | Existing configured adapter; verified codex/claude/gemini executable; none |
| Path / executable / HTTPS origin allowlists | Bounds agent actions | Keep minimal valid set; select task-required entries; none/deny |
| Elevation / login / restart / reboot | Changes privileged or disruptive behavior | Denied; explicitly scoped human decision; defer |
| Maximum input bytes | Limits material passed to an agent | Keep verified bound; tighter supported bound; validated custom integer |
| Schedule enablement / calendar / timezone | Controls unattended apply behavior | Keep existing/manual; verified profile default; supported daily/weekly; detected or explicit IANA timezone |
| Scheduled executable / failure visibility | Unattended jobs use a different environment | Keep verified path/output; observed absolute path and native job evidence; defer |
| Recovery / drift choice | Protects interrupted work and local changes | Inspect; resume persisted recoverable plan; preserve edit; reviewed restore |
| Publication / apply / ownership approval | Makes the mutation boundary explicit | Approve displayed stage; edit; stop |

Do not offer a package manager absent from the runtime's supported recipe set,
guess an architecture-specific package, or promise arbitrary cron/custom
schedules through a CLI limited to daily/weekly calendars. Shared-secret grants
are not necessarily per-name access controls: inspect the installed sharing
contract before promising per-secret isolation. Never treat a grant as merely
another default accepted in bulk.

## Project harness features

| Field(s) | Why it matters | Candidate choices to number |
| --- | --- | --- |
| Repository root / project name | Bounds generated files to one project | Observed repository; another explicit repository; existing/proposed label |
| Source format | Exactly one harness source is allowed | Keep YAML/YML/JSON; new YAML; new strict JSON |
| Targets / enabled / target options | Chooses which adapters generate output | Keep; selected installed/declared targets; add supported targets from listing |
| Translation strictness | Exposes semantic loss instead of hiding it | Strict; review each non-strict mapping; defer unsupported feature |
| Instruction root | Supplies canonical instructions | Existing approved source; proposed canonical copy; custom path |
| Rules: ID, file, paths, activation, description | Determines when instructions apply | Keep/edit rule; observed file/globs; always/path/manual/model as supported |
| Skills: roots | Chooses canonical skill directories | Keep; select observed roots; none; custom paths |
| MCP: enabled, transport, command, args, cwd, URL | Starts or connects to external services | Keep/edit detected server; stdio/streamable-http/SSE; disabled |
| MCP: env, headers, timeout, enabled/disabled tools | Controls credentials, latency, and tool exposure | Symbolic env references; existing limits; minimal selected tools; disabled |
| Hooks: ID, event, enabled, matcher, run, timeout, onFailure | Hooks execute commands at lifecycle events | Keep/disabled; select supported event/matcher; block/warn/ignore policy |
| Agents: ID, file, description, model, tools, writable | Bounds delegated work | Keep/disabled; verified file/model; selected capabilities; read-only/writable |
| Commands: ID, file, description, argument hint | Creates project command entry points | Keep; observed approved file; none |
| Permissions: pattern, action, reason | Determines allow/ask/deny behavior | Keep; deny; ask; scoped allow |
| Extensions: target-specific fields | Native features may lack portable equivalents | Keep; disabled; edit fields supported by the installed adapter |
| Native collision / generated-file edit | Transfers ownership only when approved | Preserve; revise source; specifically reviewed transfer |
| Cleanup | Removes only recorded Canonfig-owned output | Preview; approve reviewed cleanup; keep |

Do not ask the user to define empty optional sections. In Advanced, the section's
Disabled/Keep answer closes it. In Simple, requested or detected sections appear
in the editable summary; they are not silently dropped. Secret defaults must
never contain real values. A selected harness target is not the separate
Configuration Agent runtime policy.
