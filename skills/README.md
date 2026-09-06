# Canonfig skills

- [`setup-canonfig`](setup-canonfig/SKILL.md): guided setup in Simple or Advanced
  (in-depth) mode. It inspects first, offers numbered choices plus custom input,
  explains each question, recommends safe defaults, then plans and verifies the
  requested Source Machine, Follower Machine, or project harness outcome.
- [`install-canonfig`](install-canonfig/SKILL.md): direct installation and
  first-time role establishment.
- [`operate-canonfig`](operate-canonfig/SKILL.md): evidence-first publication,
  synchronization, scheduling, diagnostics, drift handling, and recovery.

Start with `Use $setup-canonfig in simple mode to set up this machine` or
`Use $setup-canonfig in advanced mode to review my configuration`.
Answer with an option number, a label, or custom text. Multi-select accepts
comma-separated numbers; a batch can use `ROLE=2; NAME=3: studio-laptop`.
`Use recommendations` accepts shown settings, not execution or discovery consent.
Switch modes at any time without restarting.

For multi-machine work, the skill can optionally list peers already visible to
the local Tailscale client. Discovery is opt-in and read-only, never port scanning
or automatic remote setup. Manual machine entry works without Tailscale.

Use the narrower install or operate skill when the requested command path is
already known.
