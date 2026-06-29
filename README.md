<div align="center">

<img src="assets/shepherd.jpg" alt="Shepherd" width="200" />

# Shepherd

**Production-readiness agent for AI-written code.**
*You code, we maintain.*

</div>

---

AI tools (Lovable, Bolt, v0, Cursor, Claude) ship working apps fast — and quietly leave behind cost-bombs, missing auth, client-only access control, outdated patterns, and architectural drift. Shepherd is the agent that catches what AI code specifically gets wrong, then **guides you through fixing it** — and writes the tests so it stays fixed.

```bash
npx shepherd
```

That starts Shepherd and drops you into a conversation. **It's an agent, not a set of commands** — there's nothing to memorize. Shepherd boots as a 200-year-old principal engineer (its `soul.md`), takes stock of your repo on its own, and then you just talk to it:

- *“review the architecture”*
- *“review the `handleCheckout` function in `billing.ts`”*
- *“is it production ready?”*  →  the full deterministic + deep audit + a go-live verdict
- *“how do I scale this to a million users?”*  →  it surveys the system, researches current infra on the live web, and writes a scale plan — *“add a task queue (BullMQ) here, Valkey for sessions there, Meilisearch instead of this `ILIKE`”* — each with the exact file it plugs into
- *“write tests for the auth flow”*  →  it designs the essential tests + a work-order to add them
- *“that's a false positive — the limiter's in middleware”*  →  it remembers, and never raises it again

Shepherd is the **maintainer; it never edits your code itself.** It finds what's wrong, explains why it matters at a million users, and hands a precise work-order to *your* Claude Code session — so every change stays under your review.

Prefer shortcuts? Type **`/`** for Claude-style slash commands — natural language still works, but these are the fast, discoverable path:

| Command | What it does |
|---|---|
| `/go-live-checks` *(`/audit`)* | Full audit — deterministic + deep review + scale + cost → go-live verdict |
| `/architecture-review` *(`/arch`)* | Design review at scale: layering, coupling, boundaries, data flow |
| `/security-review` *(`/sec`)* | Focused security pass (authz, injection, secrets, exposure) |
| `/review <file\|function>` | Focused code/function review |
| `/scale` *(`/infra`)* | Infra roadmap to ~1M users + a written scale plan |
| `/infra-cost` *(`/cost`)* | $ abuse exposure (cost-bombs) + infra bill at 1M, web-grounded |
| `/tests <target>` | Design the essential tests + a work-order |
| `/fix` | Write the fix work-order for your Claude Code session |
| `/profile` | Show what Shepherd remembers about this project |
| `/help` · `/exit` | List commands · leave |

## Why Shepherd

- **It knows how *AI* code fails.** The detectors target the specific failure modes of generated code — public AI/email endpoints with no rate limit, secrets in the client bundle, access control enforced only on the frontend, deprecated libraries the model still reaches for.
- **It's grounded, not hand-wavy.** When you ask for a review, the agent runs Shepherd's *own* deterministic detectors (via its built-in MCP server) and quotes the real findings — reviews are backed by the engine, not vibes.
- **It thinks about *scale*, not just bugs.** Ask how to reach a million users and Shepherd becomes a principal infrastructure architect: it reads the system, finds the workload pressures (inline email, `ILIKE` search, in-memory sessions, a single DB pool), and prescribes the infrastructure to fix them — a cache, a task queue, an event stream, search, read replicas — naming current, actively-maintained open-source tools it confirms on the **live web**. A broken weekend project gets a credible road to production load.
- **It remembers.** Across runs Shepherd keeps the project's recurring soft spots, your triage decisions ("ruled a false-positive because X"), and the tests that matter here — and recalls them before it judges, so it doesn't re-litigate what you've settled.
- **It learns.** Recurring findings the regex can't yet catch get distilled into *candidate* rules for your review — and every scan feeds an anonymized ledger that ranks findings by real-world frequency. A code-cloner starts at zero data.
- **One engine, two shells.** The same engine runs in the **CLI agent** (on *your* Claude Code — free) and, soon, as a **GitHub App** (server-side, on our API — paid). Same checks everywhere.

## What it does on an audit

Ask *“audit”* (or run it in CI — see below) and Shepherd runs the full walk-through, the way a senior engineer reviews a handoff:

1. **Survey** — what is this app, how is it built, how is it organized (layer-folders vs feature-slices).
2. **Modernity** — outdated deps, deprecated patterns, and old-but-works idioms where a newer/safer primitive exists (form `fetch` → Server Actions, class components → hooks, `moment` → date-fns).
3. **Audit** — security, performance, architecture, and logic, split into **gates** (block the merge) and **advice**, plus design-pattern trade-offs judged *as per this project's* scale, and a DevOps / infra-as-code review (GitHub Actions, nginx, Jenkins, Terraform/CFN/Bicep, compose).
4. **Backend & production-readiness** — detects the real pattern (event-driven, task-queue, CQRS, hexagonal…), reasons like a principal engineer about required-but-missing infra at 1M, researches current best practice on the live web (with source URLs), runs a bounded **live attack probe** on localhost (proves the cost-bomb, auth bypass, header/stack-trace leaks), checks **operations & observability**, and — if Docker's present — a bounded **load test** that projects honestly toward the target.
5. **Scale architect** — a whole-system, web-grounded pass that prescribes the *infrastructure* to carry the app to ~1M users (cache, task queue, event stream, search, read replicas, connection pool, rate limiter…), names current open-source tools with source URLs, and writes a `.shepherd/scale-plan.md` you can work through one change at a time.
6. **Go-Live Gate** — collapses everything into distinct, ordered blockers and gives one verdict: **Ship / Not-ready**, with a rough effort-to-green.
7. **Hand-off** — writes the blockers into `.shepherd/fix-order.md` for your Claude Code session to apply. Shepherd never edits your code.

```
  ════════════════════════════════════════
   GO-LIVE VERDICT:  🔴 NOT READY
  ════════════════════════════════════════
   Blocked on 9 must-fix (in order):
     1. Unprotected expensive/AI endpoint (needs auth + rate limit)
     2. Error/stack-trace leakage to clients
     3. Request input not validated
     ...
   + 1 advisory. Estimated about a week to green.
  ════════════════════════════════════════
```

## Soul & memory

Shepherd is the same engineer every time, and it gets sharper the more you work with it.

- **`soul.md`** (repo root) — Shepherd's identity: the 200-year-old principal engineer who audits, architects, and believes everything essential deserves a test. Injected into every reasoning turn. Edit it to change *how* Shepherd thinks — it doubles as training material.
- **`.shepherd/SHEPHERD.md`** — a living profile of your architecture and recurring soft spots, regenerated every run.
- **`.shepherd/triage.json`** — your decisions (accept / won't-fix / false-positive) with reasons; suppressed on future runs and recalled in reviews.
- **`.shepherd/test.md`** — the tests Shepherd has designed, plus what it has learned matters most here.
- **`.shepherd/user.md`** — the conversation log; Shepherd distills it to learn which tests this team cares about.
- **`.shepherd/candidate-rules/`** — rules Shepherd distilled from recurring findings, waiting for your review (move one into `~/.shepherd/packs/` to activate). Learning proposes; you commit.

`config.json`, `SHEPHERD.md`, `triage.json` and `test.md` are meant to be committed (team-shared); history, reports, and the conversation log are gitignored by default.

## In CI (no one to talk to)

When there's no terminal — a CI job, a pipe — Shepherd can't have a conversation, so it does the whole job autonomously once and exits non-zero if the repo isn't production-ready:

```bash
npx shepherd .          # non-interactive → full audit + hand-off, fails the build on gates
```

## How the hand-off works

Shepherd finds the problems and writes the prompt; your Claude Code session does the editing, so you stay in control. Just ask Shepherd to *“write the fix work-order”* (or *“write the tests”*, or *“how do I scale to 1M?”*), then in your session say *“apply the fixes in `.shepherd/fix-order.md`”* — or work through `.shepherd/scale-plan.md` one infrastructure change at a time. If Shepherd's MCP server is wired into your session, it can also push the order to you automatically (Channels, research preview).

## Safety of the live probe

The attack stage hits **localhost only**, against a server Shepherd itself starts, with hard request caps and per-request timeouts — bounded testing of your own app, never an external target, never unbounded. The server is always shut down afterward; if it can't boot, the probe is skipped and the run continues.

## Install

```bash
npm i -g shepherd      # or just use npx
```

Requires Node 18+. The conversation and deep reviews use [Claude Code](https://claude.com/claude-code) on your own account when present; without it, the deterministic audit still runs free.

## Status

The engine is built and verified end-to-end on real AI-built repos, and the agent interface + memory loop (soul, grounded reviews, conversational triage, test generation, living profile, rule self-evolution) are in. See [`ROADMAP.md`](ROADMAP.md) for what's next (the GitHub App).

## License

MIT
