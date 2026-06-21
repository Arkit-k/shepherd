<div align="center">

<img src="assets/shepherd.jpg" alt="Shepherd" width="200" />

# Shepherd

**Production-readiness gate for AI-written code.**
*You code, we maintain.*

</div>

---

AI tools (Lovable, Bolt, v0, Cursor, Claude) ship working apps fast — and quietly leave behind cost-bombs, missing auth, client-only access control, outdated patterns, and architectural drift. Shepherd is the gate that catches what AI code specifically gets wrong. It runs continuously — on every push — not as a one-time audit.

```bash
npx shepherd
```

That's the whole interface. No flags, no subcommands to learn. Shepherd surveys your codebase, audits it, and stress-tests it — then **hands a precise fix work-order to your own Claude Code session** to apply. Shepherd is the maintainer; it never edits your code itself, so every change stays under your review.

## Why Shepherd

- **It knows how *AI* code fails.** The detectors target the specific failure modes of generated code — public AI/email endpoints with no rate limit, secrets in the client bundle, access control enforced only on the frontend, deprecated libraries the model still reaches for.
- **Shepherd maintains; your Claude Code edits.** Detection is deterministic (the moat). Shepherd never silently edits your code — it writes a precise fix work-order and hands it to *your* running Claude Code session, so every change happens under your eye.
- **One engine, two shells.** The same engine runs as a **CLI** (on *your* Claude Code — free) and as a **GitHub App** (server-side, on our API — paid). Same checks everywhere.
- **It learns.** Every scan feeds an anonymized ledger that ranks findings by real-world frequency. A code-cloner starts at zero data.

## The walk-through

One run dispatches a sequence of agents — the way a senior engineer reviews a handoff:

1. **Surveyor** — walks the codebase and states what it is and what it's built with.
2. **Modernizer** — flags outdated dependencies and deprecated patterns AI tools still emit.
3. **Auditor** — security, performance, architecture, and logic findings, split into **gates** (block the merge) and **advice**.
4. **Backend & Production-Readiness** — the part that earns the "production" promise:
   - **Pattern** — detects the *actual* architecture: event-driven, task-queue/async-jobs, CQRS, event-sourcing, hexagonal/clean, spec-driven, layered/MVC.
   - **Production engineer** — takes inventory of what infra is *present* (broker / queue / cache / pool / Docker) and reasons like a principal engineer: *given this pattern at 1M, what's required and missing?* Event-driven on an in-process `EventEmitter` with no Kafka/RabbitMQ → gate. Background work in the request path with no BullMQ/Celery worker → gate. No cache, no connection pool → gate.
   - **Researches the live internet** — one low-context, web-grounded pass (like a principal engineer who *looks it up*): the current stable versions, today's best-practice tooling for your pattern at scale, and known CVEs/advisories — each recommendation carrying a **source URL**. (e.g. *"current field default is BullMQ v5.71 on Redis — source: bullmq.io"*.)
   - **Scale & resilience** — scales-to-1M and error-tolerance checks (N+1, unbounded queries, no timeouts/retries/validation, in-memory state).
   - **Frontend at 1M DAU** — raw `<img>`, heavy client bundles, fetch waterfalls, unvirtualized lists.
   - **Live attack** — boots your app and runs a bounded, localhost-only probe that *proves* the cost-bomb (no `429` under a burst), auth bypass, missing headers, stack-trace leakage.
   - **Load test** — if Docker is present, stands up the real dependencies, runs a bounded ramp, finds the single-box ceiling, and **projects honestly** toward the target with the bottleneck named. (We measure and project — we don't pretend a laptop proves 1M req/s.)
5. **Hand-off** — Shepherd writes the blocking issues into a precise fix work-order (`.shepherd/fix-order.md`) and hands it to **your own Claude Code session** to apply. It never edits your code itself.

## How the hand-off works

Shepherd is the maintainer. It finds the problems and writes the prompt; your Claude Code session does the editing, so you stay in control. Three ways, from manual to zero-touch:

- **Manual** — in your open session, say: *“apply the fixes in `.shepherd/fix-order.md`.”*
- **MCP pull** (`shepherd init`): ask Claude to *“get the shepherd fix order and apply it”* — the `fix_order` tool returns the work-order, your session applies it, then calls `scan` to verify.
- **Zero-touch push (Channels)** — start your session with:
  ```bash
  claude --dangerously-load-development-channels server:shepherd
  ```
  Now any `npx shepherd` run writes the work-order and Shepherd **pushes it straight into that session** — Claude wakes up, reads `.shepherd/fix-order.md`, and applies it. No typing.

> Channels are a Claude Code research-preview feature (v2.1.80+); the `--dangerously-load-development-channels` flag is required while it's in preview. There's no supported way to type into a running terminal session directly — Channels is the official push mechanism.

## It tracks your project (like `.claude/`)

On first run Shepherd installs a **`.shepherd/`** folder into your repo and tracks the project across runs:

- `config.json` — the start command, port, and attack caps it learned (edit to override)
- `SHEPHERD.md` — a living profile of your architecture and recurring soft spots
- `reports/` — a detailed, keep-able report per run (`latest.md` always current)
- `history.jsonl` — the trend over time (gates last week → 0 now)
- `baseline.json` — findings you've accepted, so re-runs surface only what's *new*

`config.json` and `SHEPHERD.md` are meant to be committed (team-shared); history and reports are gitignored by default.

## Safety of the live probe

The attack stage hits **localhost only**, against a server Shepherd itself starts, with hard request caps and per-request timeouts — bounded testing of your own app, never an external target, never unbounded. The server is always shut down afterward; if it can't boot, the probe is skipped and the run continues.

## Advanced: run a single phase

Most people never need these — `shepherd` does it all. But each agent is also a subcommand:

| Command | What it does |
|---|---|
| `shepherd` | **Autonomous run — survey, audit, backend probe, then hand off (this is all you need)** |
| `shepherd scan [path]` | Audit only (`--deep` for the Claude review) |
| `shepherd handoff [path]` | Write the fix work-order for your Claude Code session |
| `shepherd probe [path]` | Just the live attack: boot the app + attack localhost |
| `shepherd understand [--deep]` | Tech stack + Claude architecture summary |
| `shepherd modernity [--deep]` | Outdated deps + deprecated code patterns |
| `shepherd stats` | What Shepherd has learned across all scans |
| `shepherd init [path]` | Install `.shepherd/` + register the MCP server |

## Two ways to run it

- **Shepherd drives (CLI):** `npx shepherd` audits + stress-tests and writes the fix work-order; you hand it to your Claude Code session.
- **Claude Code drives (MCP):** `shepherd init`, then ask Claude to *"get the shepherd fix order and apply it"* — your session pulls the order, applies it, and re-verifies with `scan`.

## Install

```bash
npm i -g shepherd      # or just use npx
```

Requires Node 18+. The `--deep` reviews use [Claude Code](https://claude.com/claude-code) on your own account when present, and your own Claude Code session applies the fix work-order; without Claude, the deterministic scan still runs free.

## Status

The engine is built and verified end-to-end on real AI-built repos — Tier 1 (deterministic) catches cost-bombs and hardcoded hosts; Tier 2 (Claude `--deep`) has caught prompt-injection, billing bypasses, and unbounded inputs in the wild. See [`ROADMAP.md`](ROADMAP.md) for what's next (the GitHub App).

## License

MIT
