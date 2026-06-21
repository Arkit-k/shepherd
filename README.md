<div align="center">

<img src="assets/shepherd.jpg" alt="Shepherd" width="200" />

# Shepherd

**Production-readiness gate for AI-written code.**
*You code, we maintain.*

</div>

---

AI tools (Lovable, Bolt, v0, Cursor, Claude) ship working apps fast — and quietly leave behind cost-bombs, missing auth, client-only access control, outdated patterns, and architectural drift. Shepherd is the gate that catches what AI code specifically gets wrong, and fixes it. It runs continuously — on every push — not as a one-time audit.

```bash
npx shepherd            # scan the current repo
npx shepherd --deep     # + Claude-powered aggressive review
npx shepherd fix        # detect → fix → re-verify, until shipshape
```

## Why Shepherd

- **It knows how *AI* code fails.** The detectors target the specific failure modes of generated code — public AI/email endpoints with no rate limit, secrets in the client bundle, access control enforced only on the frontend, deprecated libraries the model still reaches for.
- **Detection is deterministic. Fixing is Claude.** Cheap, exhaustive, hardcoded checks find the problems (the moat); Claude is spent only on judgment — fixing and aggressive review.
- **One engine, two shells.** The same engine runs as a **CLI** (on *your* Claude Code — free) and as a **GitHub App** (server-side, on our API — paid). Same checks everywhere.
- **It learns.** Every scan feeds an anonymized ledger that ranks findings by real-world frequency. A code-cloner starts at zero data.

## The walk-through

Shepherd works the way a senior engineer would review a handoff:

1. **Understand** — walks the codebase, states the tech stack and architecture (`shepherd understand --deep`).
2. **Modernity** — flags outdated dependencies and deprecated code patterns AI tools still emit (`shepherd modernity --deep`).
3. **Audit** — security, performance, architecture, and logic findings, split into **gates** (block the merge) and **advice**.
4. **Fix loop** — Claude fixes each gate, re-verifies, and repeats until clean or no further progress.

## Commands

| Command | What it does |
|---|---|
| `shepherd scan [path]` | Scan for production-readiness issues (default command) |
| `shepherd scan --deep` | Add a Claude review of security-sensitive files |
| `shepherd fix [path]` | Run the agent loop: detect → fix → re-verify |
| `shepherd understand [--deep]` | Tech stack (+ Claude architecture summary) |
| `shepherd modernity [--deep]` | Outdated deps (+ deprecated code patterns) |
| `shepherd stats` | What Shepherd has learned across all scans |
| `shepherd init` | Register Shepherd's MCP server with Claude Code |

## Two ways to run it

- **Shepherd drives (CLI):** `npx shepherd fix` spawns your Claude Code per file to apply fixes.
- **Claude Code drives (MCP):** `shepherd init`, then ask Claude to *"scan and harden with shepherd."*

## Install

```bash
npm i -g shepherd      # or just use npx
```

Requires Node 18+. Fixes and `--deep` review use [Claude Code](https://claude.com/claude-code) on your own account when present; without it, scanning still runs free.

## Status

The engine is built and verified end-to-end on real AI-built repos — Tier 1 (deterministic) catches cost-bombs and hardcoded hosts; Tier 2 (Claude `--deep`) has caught prompt-injection, billing bypasses, and unbounded inputs in the wild. See [`ROADMAP.md`](ROADMAP.md) for what's next (the GitHub App).

## License

MIT
