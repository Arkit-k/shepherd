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
| `/autopilot` *(`/pipeline`, `/run-all`)* | **The whole loop, consultatively** — Shepherd *asks* what you want (scale, architecture, infra, deploy), then runs design → right-size → certify → release |
| `/go-live-checks` *(`/audit`)* | Full audit — deterministic + deep review + scale + cost → go-live verdict |
| `/certify` *(`/prove`, `/verify`)* | Re-scan + **run your tests**, prove each gate closed → a reproducible `.shepherd/certificate.md` |
| `/release-check` *(`/ship-it`, `/deploy`)* | Release gate — deploy only a **proven** build (cert fresh + matches HEAD + clean); `pipeline` writes a gated CI/CD work-order; `<url>` health-checks a deploy |
| `/rightsize` *(`/yagni`, `/simplify`)* | The YAGNI counterweight — flags **over-engineering** you don't need yet (premature infra, single-impl interfaces, speculative config) |
| `/insights` *(`/stats`, `/ledger`)* | The **data flywheel** — which findings recur most across the repos you've scanned; sharpens every run |
| `/architecture-review` *(`/arch`)* | Design review at scale: layering, coupling, boundaries, data flow *(diagnostic)* |
| `/design` *(`/spec`, `/blueprint`)* | Author the architecture **blueprint to build from** *(prescriptive)*: target pattern, boundaries, design patterns, principles, infra plan |
| `/security-review` *(`/sec`)* | Focused security pass (authz, injection, secrets, exposure) |
| `/review <file\|function>` | Focused code/function review |
| `/scale` *(`/infra`)* | Infra roadmap to ~1M users + a written scale plan |
| `/infra-cost` *(`/cost`)* | $ abuse exposure (cost-bombs) + infra bill at 1M, web-grounded |
| `/git-check` *(`/git-check install`)* | Review only what you're about to push → go/no-go; `install` wires a pre-push hook |
| `/scaffold` *(`/hygiene`)* | Find missing production-grade files (Husky, linter, formatter, license, …) + a work-order |
| `/fingerprint` *(`/provenance`, `/built-by`)* | Detect the AI builder (Lovable / Bolt / v0 / Replit / …) and load that tool's known failure modes |
| `/tests <target>` | Design the essential tests + a work-order |
| `/fix` | Write the fix work-order for your Claude Code session |
| `/profile` | Show what Shepherd remembers about this project |
| `/help` · `/exit` | List commands · leave |

## Why Shepherd

- **It knows how *AI* code fails.** The detectors target the specific failure modes of generated code — public AI/email endpoints with no rate limit, secrets in the client bundle, access control enforced only on the frontend, deprecated libraries the model still reaches for.
- **It knows *who* built it.** Shepherd fingerprints the AI builder from structural signatures — Lovable, Bolt, v0, Replit, Cursor, Claude, Copilot, Windsurf — and loads *that tool's* known failure modes before it reviews. *"This is a Lovable app — RLS is your only access control and it's usually off; the Edge Functions have no rate limit."* A generic scanner can't make that call; the per-tool failure corpus is the moat.
- **It's grounded, not hand-wavy.** When you ask for a review, the agent runs Shepherd's *own* deterministic detectors (via its built-in MCP server) and quotes the real findings — reviews are backed by the engine, not vibes.
- **It knows when to *stop*, not just when to add.** AI writes the staff-level version on day 0 — caching, batching, a connection pool and a pluggable backend for a function handling 50 records a day. Most of it solves a problem you don't have yet. Shepherd's `/rightsize` is the counterweight to its own scale advice: it flags over-engineering at both altitudes — premature infra/microservices/deep layering up high, single-implementation interfaces and speculative configs down low — and tells you to keep the complexity only if today's workload earns it. A tool that *only* says "add more" has a bias, not judgment; Shepherd argues both sides.
- **It designs *before* you build, not just critiques after.** Most tools only tell you what's wrong once it's written. Ask `/design` and Shepherd authors the **blueprint to build from** — the target architecture pattern for *this* app, the module boundaries and dependency direction, the design patterns to apply (and avoid) at your scale, the industry-standard principles as hard constraints, and the infra to wire in from the start. Your Claude Code session builds against it; `/certify` then proves the build matches. Design → build → prove, one loop.
- **It proves the fix — it doesn't just claim it.** Shepherd holds your open gates as state (an objectives ledger). After your Claude Code applies the work-order, say `/certify`: Shepherd re-scans, **runs your test suite**, and flips a gate to ✅ only with fresh passing evidence. The result is a `certificate.md` where every line names the command to re-run the proof yourself — *"3 objectives proven closed, 147 tests green (`npm test`)."* A reproducible measurement is what you can trust; an opinion isn't.
- **It thinks about *scale*, not just bugs.** Ask how to reach a million users and Shepherd becomes a principal infrastructure architect: it reads the system, finds the workload pressures (inline email, `ILIKE` search, in-memory sessions, a single DB pool), and prescribes the infrastructure to fix them — a cache, a task queue, an event stream, search, read replicas — naming current, actively-maintained open-source tools it confirms on the **live web**. A broken weekend project gets a credible road to production load.
- **It remembers.** Across runs Shepherd keeps the project's recurring soft spots, your triage decisions ("ruled a false-positive because X"), and the tests that matter here — and recalls them before it judges, so it doesn't re-litigate what you've settled.
- **It learns, and it compounds.** Recurring findings the regex can't yet catch get distilled into *candidate* rules for your review. And every scan feeds a local ledger that ranks findings by **real-world frequency** — which flows *back into reviews*: a common failure is tagged inline (*"📊 seen in 75% of the repos you've scanned — #1 most common"*), and `/insights` shows the full leaderboard. The more you (and your team) scan, the sharper Shepherd's priorities get. A code-cloner starts at zero data and can't catch up.
- **One engine, two shells.** The same engine runs in the **CLI agent** (on *your* Claude Code — free) and, soon, as a **GitHub App** (server-side, on our API — paid). Same checks everywhere.

## What it does on an audit

Ask *“audit”* (or run it in CI — see below) and Shepherd runs the full walk-through, the way a senior engineer reviews a handoff:

1. **Survey** — what is this app, how is it built, how is it organized (layer-folders vs feature-slices).
2. **Modernity** — outdated deps, deprecated patterns, and old-but-works idioms where a newer/safer primitive exists (form `fetch` → Server Actions, class components → hooks, `moment` → date-fns).
3. **Audit** — security, performance, architecture, and logic, split into **gates** (block the merge) and **advice**, plus design-pattern trade-offs judged *as per this project's* scale, and a DevOps / infra-as-code review (GitHub Actions, nginx, Jenkins, Terraform/CFN/Bicep, compose).
4. **Backend & production-readiness** — detects the real pattern (event-driven, task-queue, CQRS, hexagonal…), reasons like a principal engineer about required-but-missing infra at 1M, researches current best practice on the live web (with source URLs), runs a bounded **live attack probe** on localhost — a small red team that *proves* the exploit: the cost-bomb (rate-limit drain), broken access control (IDOR), SQL injection, reflected XSS, `alg:none` JWT bypass, prompt injection on LLM endpoints, and stack-trace leaks — plus a **blue check** of whether the app actually detected/rejected the hostile input, checks **operations & observability**, and — if Docker's present — a bounded **load test** that projects honestly toward the target.
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

## Autopilot — it asks, then runs the whole loop

The four stages — design, right-size, certify, release — run as one loop with `/autopilot`. But Shepherd doesn't *assume* what you're building; it **interviews you first**, showing its own recommendation at each step (accept or override):

```
🐑 Autopilot — I'll ask what you want, then run the whole loop.

  Building for?  1) small / just starting   2) growing   3) ~1M+   [1]  ▸ 3
  Architecture — I recommend: Modular monolith.  [enter] to accept, or 1–4  ▸ ⏎
  Infrastructure I'd add:  1) Redis (cache)  2) BullMQ (queue)  3) Meilisearch (search)
  Include which? [enter]=all, 'none', or comma numbers  ▸ 1,2
  Deploy target? 1) Vercel 2) Fly 3) Render 4) Docker+k8s 5) skip  ▸ 2
  Anything else I should know?  ▸ keep the public API stable

  ①  Design     → architecture-spec.md  (built to your choices)
  ②  Right-size → calibrated to "~1M+", so the infra you picked isn't flagged
  ③  Certify    → ran your tests → certificate.md
  ④  Release    → 🟢 clear to deploy
```

Your answers are saved to `.shepherd/intent.json` and reused next time (it offers `[Y/edit]` instead of re-asking) — and the non-interactive `npx shepherd` run honors the same choices. Crucially, **your declared scale is what calibrates the judgment**: say "~1M+" and Redis/Kafka is *needed*; say "small" and the same infra gets flagged as over-engineering. You set the horizon; Shepherd advises against it.

## The certificate — proof, not opinion

A go-live verdict tells you *what's wrong*. A **certificate** proves *it's actually fixed*. Shepherd tracks every blocker as an **objective**; after you apply the fixes, `/certify` (or any full `npx shepherd` run) re-checks each one against fresh evidence and **runs your real test suite as a hard gate**:

```
  ══════════════════════════════════════════════════════
   🔏 ✅ SHEPHERD-CERTIFIED        2026-06-30
  ══════════════════════════════════════════════════════
   Objectives (proof of fixes):
     ✅ Unprotected expensive/AI endpoint
        absent on a fresh re-scan  ·  re-run: npx shepherd
     ✅ Hardcoded http://localhost — breaks once deployed
        absent on a fresh re-scan  ·  re-run: npx shepherd

   Integration tests: ✅ 147 tests (Vitest) green · npm test

   2 proven · 0 failed · 0 pending
   Shepherd-certified — proven closed and the suite is green. Reproducible.
  ══════════════════════════════════════════════════════
```

A gate flips to ✅ **only** when its check no longer fires on a fresh scan; the build certifies **only** when every objective is proven *and* a real suite ran green. No test suite → no certificate (you can't certify what you can't measure). Empirical gates (proven by hitting the running app) need a full `npx shepherd` run so the live probe re-fires. The certificate is written to `.shepherd/certificate.md` — commit it, link it in a PR; anyone can re-run the commands and get the same answer. That reproducibility is the trust.

## Soul & memory

Shepherd is the same engineer every time, and it gets sharper the more you work with it.

- **`soul.md`** (repo root) — Shepherd's identity: the 200-year-old principal engineer who audits, architects, and believes everything essential deserves a test. Injected into every reasoning turn. Edit it to change *how* Shepherd thinks — it doubles as training material.
- **`.shepherd/SHEPHERD.md`** — a living profile of your architecture and recurring soft spots, regenerated every run.
- **`.shepherd/triage.json`** — your decisions (accept / won't-fix / false-positive) with reasons; suppressed on future runs and recalled in reviews.
- **`.shepherd/test.md`** — the tests Shepherd has designed, plus what it has learned matters most here.
- **`.shepherd/user.md`** — the conversation log; Shepherd distills it to learn which tests this team cares about.
- **`.shepherd/candidate-rules/`** — rules Shepherd distilled from recurring findings, waiting for your review (move one into `~/.shepherd/packs/` to activate). Learning proposes; you commit.

`config.json`, `SHEPHERD.md`, `triage.json` and `test.md` are meant to be committed (team-shared); history, reports, and the conversation log are gitignored by default.

## The pre-push gate

Don't push code that isn't production-ready. `/git-check` reviews **only what you're about to push** (staged + working tree + unpushed commits) — not the whole repo — and gives a focused go/no-go on the diff.

Run **`/git-check install`** once and Shepherd writes a git `pre-push` hook, so the gate runs automatically on every `git push` and blocks the push if the diff has a blocker:

```
🐑  Shepherd blocked this push — the diff isn't production-ready (see above).
    Fix the gates, or override once with: git push --no-verify
```

It's a heads-up, not a cage — `git push --no-verify` always lets a human override, and `SHEPHERD_SKIP_HOOK=1` disables it for a session.

## In CI (no one to talk to)

When there's no terminal — a CI job, a pipe — Shepherd can't have a conversation, so it does the whole job autonomously once and exits non-zero if the repo isn't production-ready:

```bash
npx shepherd .          # non-interactive → full audit + hand-off, fails the build on gates
```

## How the hand-off works

Shepherd finds the problems and writes the prompt; your Claude Code session does the editing, so you stay in control. Just ask Shepherd to *“write the fix work-order”* (or *“write the tests”*, or *“how do I scale to 1M?”*), then in your session say *“apply the fixes in `.shepherd/fix-order.md`”* — or work through `.shepherd/scale-plan.md` one infrastructure change at a time. If Shepherd's MCP server is wired into your session, it can also push the order to you automatically (Channels, research preview).

## Safety of the live probe (red + blue)

Shepherd doesn't just *infer* vulnerabilities from source — it boots your app and **proves** them. A small **red team** fires the exploit classes AI code actually ships broken (rate-limit drain, IDOR, SQL injection, reflected XSS, `alg:none` JWT bypass, prompt injection, stack-trace leakage), and a **blue check** then asks the defensive question: of all those hostile requests, how many did the app actually *reject* (4xx) versus silently accept (2xx) or crash on (5xx)? Low rejection = no input validation or detection at the edge.

Every probe hits **localhost only**, against a server Shepherd itself starts, with hard request caps and per-request timeouts — authorized testing of *your own* app, never an external target, never unbounded. The server is always shut down afterward; if it can't boot, the probe is skipped and the run continues. (This is the empirical half of `/certify` — a proven exploit is a gate, and re-running the probe is what proves it closed.)

## Install

```bash
npm i -g shepherd      # or just use npx
```

Requires Node 18+. The conversation and deep reviews use [Claude Code](https://claude.com/claude-code) on your own account when present; without it, the deterministic audit still runs free.

## Status

The engine is built and verified end-to-end on real AI-built repos, and the agent interface + memory loop (soul, grounded reviews, conversational triage, test generation, living profile, rule self-evolution) are in. See [`ROADMAP.md`](ROADMAP.md) for what's next (the GitHub App).

## License

MIT
