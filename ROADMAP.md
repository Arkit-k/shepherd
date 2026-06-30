# Shepherd — Build Roadmap

Build the **engine** once; the CLI and App are thin shells over it. Each phase is shippable.
Stack: **TypeScript + Node**, distributed via `npm`. Targets JS/TS apps (Next.js + Supabase etc.).

## ✅ Progress (2026-06-21)
- Layer 0 ingest + Layer 1 AST backbone (`ts-morph`) — **done, runs on real repos**
- Layer 2 family 2 (measurable SOLID: file-size, long-function, god-class) — **done**
- Layer 2 family 1 (security: cost-bomb, secrets, unauthed-route, localhost) — **done; catches the validated `/api/ai-chat` cost-bomb in windback-fe automatically**
- Loop engineering (`loop.ts`): detect → fix → re-verify → repeat, 4 stopping conditions, pluggable per-file `Fixer` — **done**
- Fixers: `PlaceholderFixer` + `ClaudeFixer` (spawns user's Claude Code headless) — **done**
- **MCP server** (`mcp.ts`): exposes `scan` as a tool so Claude Code can drive Shepherd — **done & verified**
- **Layer 2 family 3 — deep review** (`deep-review.ts`, `--deep`): Claude reviews security-sensitive files on the USER'S account for what regex can't catch — **done & verified** (caught prompt-injection/role-spoofing, unbounded input, missing fetch timeout in ai-chat)
- Test integration (`tests.ts`, `--with-tests`): runs the project's own test suite as a gate — **done**
- `shepherd init`: auto-registers the MCP server with Claude Code — **done**
- Windows fix: Claude prompts go via STDIN (passing as a CLI arg hangs cmd.exe) — **done**
- Verified end-to-end: Tier 1 (hardcoded) catches cost-bomb/localhost; **Tier 2 (Claude `--deep`) catches prompt-injection & unbounded inputs** (~$0.05/file on the user's Claude account)
- **Phase ① Understand** (`tech-stack.ts`, `understand.ts`, `shepherd understand [--deep]`): monorepo-aware stack+version detection, and a Claude architecture summary + soft spots from a cheap map — **done & verified** (correctly identified the BFF-proxy pattern, hand-rolled auth, contract-drift risk, even duplicate callback routes)
- **Modernity check** (`modernity.ts`, `shepherd modernity [--deep]`): Tier 1 compares deps vs the npm registry (flagged Next 15→16, TS 5→6 behind); Tier 2 Claude flags deprecated/old code patterns — **done; Tier 1 verified live**
- **Deep-review broadened** to security/performance/architecture/logic (categorized findings) — **done & verified**: caught a billing-bypass (client-only tier gating), an enterprise-tier limit bug (highest tier → lowest cap), React re-render perf, and pricing-logic drift in windback
- **Moat infrastructure** (`ledger.ts`, `rules/`, `packs/ai-patterns.json`, `shepherd stats`) — **done & verified**:
  - #1 data flywheel: every scan → anonymized ledger; `stats` ranks the checklist by real-world frequency (cloner starts at zero data)
  - #2 AI-tool rule packs: open JSON format, `ai-patterns` pack firing (leftover-console, empty-catch, @ts-ignore) — ship per-tool packs, update weekly
  - #5 community: packs are plain JSON in `~/.shepherd/packs/`
  - #3 brand: the ledger is the dataset for a "State of AI-Built Code" report
- **Backend & Production-Readiness stage** (`engine/backend/`, `report-file.ts`, `project.ts`) — **done & verified end-to-end**:
  - **Architecture** (`backend/architecture.ts`): classifies monolith / microservices / serverless; detects tRPC / gRPC / GraphQL / queues; Claude reviews comms correctness (typed contracts, validation, retries/timeouts, service auth)
  - **Scale & Resilience** (`backend/scale.ts`): Tier-1 heuristics (in-memory state, unbounded query, N+1, no try/catch, no fetch timeout, no input validation) + Claude deep pass — caught no-timeout, no-input-validation, client-per-request, no-max-tokens, no-idempotency on a live target
  - **Live attack probe** (`backend/server.ts` + `backend/probe.ts`): auto-starts the dev server, fires bounded curl-style attacks on **localhost only** (rate-limit burst → *proves* the cost-bomb, auth bypass, security headers, error/stack-trace leakage), Claude grades the evidence, server always torn down. Verified: booted a target, proved the drainable LLM endpoint, freed the port cleanly
  - **`.shepherd/` project tracking** (`project.ts`): installs per-project like `.claude/` — learned `config.json` (start cmd/port), `SHEPHERD.md` profile, `history.jsonl` trend, `reports/`, `baseline.json`
  - **Detailed report** (`report-file.ts`): writes `.shepherd/reports/<ts>.md` (+ `latest.md`) with verdict, tech, architecture, rate-limit map, live results, full findings table
  - All backend findings feed the existing **Fixer** so the autonomous run still closes the gates
- **Architecture-pattern + production-engineer reasoning** (`backend/production.ts`) — **done & verified**: detects the real pattern (event-driven, task-queue, CQRS, event-sourcing, hexagonal, spec-driven, layered) and reasons like a principal prod engineer about required-but-missing infra. On a fixture it correctly flagged in-process EventEmitter → needs a real broker (gate), inline email work → needs a queue/worker (gate), no idempotency/retry/DLQ, no cache, no health/readiness + graceful shutdown, no containerization
- **Frontend scale to 1M DAU** (`frontend/scale.ts`) — **done**: raw `<img>`, heavy client components, useEffect fetch waterfalls, unvirtualized lists + Claude pass
- **Docker load test** (`backend/loadtest.ts`) — **done & verified**: auto-runs when Docker present; stands up compose deps, bounded concurrency ramp (10→100), measures req/s + p50/p95/p99 + error rate, finds the single-box ceiling, **projects honestly** to 1M/day + names the bottleneck (measured 3,573 req/s on the fixture; "1M req/s is a fleet concern, not single-box"). Always tears down. Load-tests a SAFE endpoint (root/health), never the AI/payment routes
- **Internet research** (`research.ts`, web-enabled `claude-json.ts`) — **done & verified**: one low-context, web-grounded Claude call (WebSearch/WebFetch) checks current stable versions, today's best-practice tooling for the detected pattern at scale, and known advisories — each finding carries a source URL. Verified: on the event-driven/no-queue fixture it recommended "BullMQ v5.71 (released 2026-03-11) on Redis" with sources, reserving Kafka for high-throughput only. Toggle via `.shepherd/config.json` `web:false`
- **Maintainer model** (`handoff.ts`) — **done**: Shepherd never edits code; writes `.shepherd/fix-order.md` and hands it to the user's own Claude Code session (MCP `fix_order` tool + CLI `handoff`). Self-fixing machinery removed
- **Modern-idiom upgrades** (`idioms.ts`) — **done & verified**: flags old-but-works patterns where a newer/safer framework primitive exists — Next.js form+fetch → Server Actions, class components → hooks, getServerSideProps → App Router server components, deprecated lifecycles, moment → date-fns. Tier-1 deterministic + optional Claude pass. Advisory
- **Repo structure** (`structure.ts`) — **done & verified**: detects layer-based organization (models/, controllers/, services/) and recommends feature/vertical-slice folders with SOLID boundaries, the way top teams build. Tier-1 + low-context Claude tree review. Verified: layered fixture flagged, windback (feature-organized) read as clean
- **Design-pattern review** (`design-patterns.ts`) — **done & verified**: detects GoF patterns in use (Singleton, Factory, Builder, Proxy, Prototype, Observer, Decorator) and states the trade-off of each; Claude pass judges whether the usage FITS *as per this project's* stack/architecture/scale (a Singleton is fine in a CLI, a problem at 1M). Advisory. Verified: synthetic Singleton/Factory/Builder/Proxy detected, windback (functional) correctly clean
- **DevOps / infra-as-code review** (`devops.ts`) — **done & verified**, grounded in researched best practice (GitHub Actions 2026 security/Wiz/StepSecurity, nginx hardening guides, Checkov/Terraform DevSecOps): GitHub Actions (`${{ github.event }}` command injection [gate], `pull_request_target`+checkout secret-exfil [gate], unpinned actions, missing token permissions), nginx (weak TLS [gate], no rate limit, server_tokens/version disclosure, missing security headers, proxy_buffering off), Jenkins/Groovy (sh interpolation injection, hardcoded creds [gate], no timeout), Terraform/CloudFormation/Bicep (0.0.0.0/0 ingress [gate], public bucket [gate], IAM `*`, unencrypted, hardcoded cloud key [gate]), docker-compose (privileged, exposed DB ports). Deterministic; globs the infra files itself (not in repo.files). Wired into the canonical scan() + Go-Live gate. Verified across GH Actions/nginx/Terraform/Jenkins/compose fixtures
- **Engine hardening (CLI-first)** — **done & verified**: unified ALL deterministic detectors into one canonical `scan()` (security, code-quality, rules, operations, structure, idioms, design, scale-T1, frontend-T1) so `shepherd scan` + the MCP `scan` tool + fix-verification are complete and consistent (was 3 checks → now ~18). Added `dedupeFindings()` (the full run layers scan + per-module passes that overlap on Tier-1). Robust ingest (skips binary/oversized/unreadable files, never crashes; no package.json is fine) and a top-level CLI error handler (clean message, no raw stack). Verified: scan shows 18 distinct checks with zero dups; a no-package.json dir with a binary file scans cleanly
- **Operations & observability** (`operations.ts`) — **done & verified**: error tracking, structured logging + request IDs, health/readiness endpoint, graceful shutdown, `.env` committed-to-git (GATE, via git ls-files), `.env.example` completeness, CI pipeline, Dockerfile hygiene (non-root/multi-stage/pinned), npm-audit CVEs (critical = GATE). Grounded in researched production-readiness checklists (SRE/SigNoz/backend). Mostly deterministic. Verified: fixture flags missing observability/health/CI; a real git repo with a tracked .env triggers the env-committed gate. This is the "is it operable" axis
- **Go-Live Gate** (`gate.ts`) — **done & verified**: collapses overlapping findings into distinct, ordered BLOCKERS (the dedup) and renders one verdict — Ship / Not-ready — with a critical path + rough effort-to-green. Printed as the run's climax and headlined in the report. Verified: 17 raw gates → 9 clean blockers, security/cost first. This is the "principal engineer who clears you for launch" piece
- **Channels zero-touch push** (`mcp.ts`) — **done & verified**: MCP server declares `experimental['claude/channel']`, watches `.shepherd/fix-order.md`, and PUSHES a `notifications/claude/channel` event when a new order is written → the running session (started with `claude --dangerously-load-development-channels server:shepherd`) wakes and applies it. Verified the push fires with correct content; full wake-and-apply needs an interactive channel session. Research preview (Claude Code v2.1.80+)
- **Next:** the **GitHub App** (monetization + lock-in surface #4 — same engine, server-side, your API, fix PRs on push)

## ✅ Progress (2026-06-29) — Agent interface + memory loop
The CLI became an **agent, not a set of programs**. `npx shepherd` now starts one interactive session (the subcommand zoo — scan/handoff/probe/understand/modernity/stats/init — was removed; non-TTY/CI falls back to the autonomous run). All verified end-to-end.
- **Soul** (`soul.md`, `engine/soul.ts`) — Shepherd's identity (200-yr principal engineer) injected into every reasoning turn; editable = retrainable.
- **Conversational brain** (`engine/chat.ts`) — each turn is headless `claude -p` with read-only tools (Read/Grep/Glob) + session continuity. No hand-rolled loop; Claude Code *is* the loop. Read-only ⇒ Shepherd structurally can't edit code.
- **Agentic Tier-2 reviewer** (`detectors/deep-review.ts` + `claudeAgentJsonArray`) — reads the file, greps for existing mitigations, verifies each finding (confidence + evidence) before emitting. Drops low-confidence.
- **Grounded reviews** (#2) — the brain calls Shepherd's own MCP `scan`/`fix_order` (`--mcp-config` + `--strict-mcp-config`) so conversational reviews are backed by the real detectors. Verified: reported the actual `hardcoded-localhost` gate from a live scan.
- **Recall + triage memory** (#1) — `memory/identity.ts` (drift-resistant key, fuzzy exact-match), `triage.ts` (accept/wontfix/false-positive + reason → `triage.json`, suppression), `triage-parse.ts` (dismiss in plain language → recorded by finding index), `brief.ts` (recall injected into the reviewer). Verified exact + file scope.
- **Test generation** (#3, `engine/testgen.ts`) — designs the essential tests, writes a test work-order, logs each to `test.md`. Verified: detected vitest, designed 6 unit tests with coverage reasoning.
- **Living profile** (#4, `memory/profile.ts`) — `SHEPHERD.md` regenerated each run from history + findings (recurring soft spots), injected into the brain's preamble. Verified across 3 runs.
- **Self-evolution** (#5, `memory/evolution.ts`) — recurring judgment findings distilled into **candidate** rules in `.shepherd/candidate-rules/` (NOT a load path — human-gated, the Hermes guardrail). Verified: 3× Math.random()-for-tokens → a JS-valid candidate rule.
- **Parse hardening** (`claude-json.ts`) — robust JSON-array extraction (prefer fenced blocks, balanced-bracket scan) so stray brackets / `[[wiki-links]]` in model prose don't break Tier-2 calls.

### Scale architect — "broken project → 1,000,000 users" (2026-06-29)
- **Whole-project infra advisor** (`backend/architect.ts`) — distinct from the file-level `backend/scale.ts` bottleneck heuristics: a principal *infrastructure* architect that surveys the whole system, finds the workload pressures, and prescribes the infrastructure to carry it to ~1M users — a cache, a task queue, an event stream, search, a CDN, object storage, read replicas, a connection pool, a distributed rate limiter, realtime, observability. Agentic (Read/Grep/Glob to find the evidence) **and web-enabled** (confirms each tool is a current, maintained 2026 choice with a source URL). An `infraFingerprint` of what's already wired keeps it from re-prescribing.
- **Scale-plan hand-off** (`handoff.ts` → `.shepherd/scale-plan.md`) — prescriptions grouped 🔴 now / 🟡 soon / 🔵 later, each with the file it plugs into, alternatives, and a reference. Same maintainer model: Shepherd prescribes, the user's Claude Code wires it.
- **`scale` intent** in the agent — "how do I scale to 1M?", "what infra do I need?", "redis/kafka/queue here?" trigger the architect; prescriptions print in-line and the plan is written. Help + take-stock hint updated.
- **Sharper craft axes** (`detectors/deep-review.ts`) — the deep reviewer's four dimensions now explicitly cover algorithmic complexity / data-structure choice (O(n²) where a Map is O(1)), memory & resource management (leaks, unbounded growth, unreleased handles), API-protocol correctness (pagination, idempotency, status codes), and design-pattern misuse.
- **Verified end-to-end** on an Express fixture: caught inline SMTP → BullMQ task queue, `ILIKE` search → Meilisearch, in-memory session `Map` → Valkey (the live-web pass correctly named the 2026 BSD Redis fork), single pool → PgBouncer, public expensive endpoint → distributed rate limiter, read-heavy → read replicas — each with a real source URL and the exact file it plugs into, priority-ordered.

### Slash commands + pre-push gate (2026-06-29)
- **Slash commands** (`interactive.ts`) — Claude-style shortcuts inside the one agent session (NOT CLI subcommands): `/go-live-checks`, `/architecture-review`, `/security-review`, `/review <x>`, `/scale`, `/infra-cost`, `/git-check`, `/tests`, `/fix`, `/triage`, `/evolve`, `/learn`, `/profile`, `/help`, `/exit`, with aliases. `translateSlash` maps each to an existing intent (one code path) or a framed review; natural language still works; `/` lists them.
- **Git-check / pre-push gate** (`engine/gitcheck.ts`) — reviews ONLY what's about to be pushed (staged + working tree + unpushed commits vs `@{u}`, with a `HEAD~1` fallback), scopes findings to those files, and returns a go/no-go verdict. Exposed three ways: `/git-check` in the agent, `/git-check install` to write a real git `pre-push` hook, and `--git-check` internal CLI plumbing the hook calls (exit 1 on a gate → git blocks the push). `git push --no-verify` / `SHEPHERD_SKIP_HOOK=1` always override. **Verified end-to-end**: a staged hardcoded-localhost gate blocked a real `git push` (exit 1), `--no-verify` bypassed it, and a hardened diff passed (exit 0).

### Project hygiene / scaffolding (2026-06-29)
- **Project-hygiene detector** (`engine/hygiene.ts`) — the "maintainable by a team" axis that `operations.ts` (runtime readiness) didn't cover. Deterministic presence-checks (no Claude, no network) for the dev-tooling/repo scaffolding AI builders skip: committed git hooks (Husky/lefthook/lint-staged), a linter (ESLint/Biome), a formatter (Prettier/Biome), `.editorconfig`, automated dependency updates (Dependabot/Renovate), CODEOWNERS, SECURITY.md, LICENSE, README, `.dockerignore` (only when a Dockerfile exists), and TypeScript `strict`. All advisory — hygiene never gates a merge. Wired into the canonical `scan()` so it shows in the audit, boot take-stock, and git-check.
- **`/scaffold`** (`/hygiene`, `/tooling`) — lists what's missing and writes `.shepherd/scaffold-order.md`, a hand-off work-order (Shepherd describes each file + what goes in it; the user's Claude Code creates them — maintainer model). **Verified**: 11 items on a bare repo, and on Shepherd's own repo correctly suppressed README/ts-strict while flagging the genuine 9 gaps (no LICENSE file, no linter/formatter/Husky, …).

### AI-provenance fingerprinting (2026-06-30)
- **The differentiator no generic scanner can claim** (`engine/provenance.ts`) — detects *which* AI builder produced the repo and applies that tool's known failure modes as targeted priors, so the whole review is primed by who built it. Fully deterministic (no Claude, no network — the moat). Builders: **Lovable, Bolt.new, v0, Replit** (generators — rich failure-mode priors) and **Cursor, Claude Code, Copilot, Windsurf** (assistants — a drift prior). Signals are weighted (marker dep / config dir / scaffold shape / README reference), summed into a confidence %, with a 0.35 detect threshold; generators win the "top" slot over assistants.
- **Failure-mode priors as advisories** — e.g. Lovable → *RLS is your only access control and Lovable usually ships it off* / *authz enforced only in React* / *Edge Functions with no auth+rate-limit (cost-bomb)* / *forms trust client input*; v0 → *Server Actions skip authz*, *NEXT_PUBLIC_ secret leakage*, *mock data left in*; Bolt → *client-only, no server of record*, *keys in the bundle*; Replit → *committed secrets*. All ADVISORY (they prime, never gate), clearly labelled as patterns to verify. Folded into the canonical `scan()` so they surface in the audit, boot take-stock, and (diff-scoped) git-check.
- **Surfaced in the agent** — `detectProvenance` + `buildFingerprintCard`; a `fingerprint` intent ("who built this?", "is this a Lovable app?") and `/fingerprint` (`/provenance`, `/built-by`) slash command print the card and fold the priors into the session; the boot take-stock shows the fingerprint the moment Shepherd wakes. Help + slash-help updated.
- **Verified end-to-end**: a synthetic Lovable fixture (lovable-tagger + componentTagger + README + supabase scaffold) → **Lovable 99%** with all four priors; Shepherd's own repo → honest **Claude Code 50%** (`.claude/`, assistant → drift prior only). Caught and fixed a self-inflicted footgun: an early version scanned source *content* for "Generated by v0" and matched its own regex literal (false-positive on any repo discussing the tool) — removed all source-content matching in favour of config/dep/structure signals only.

### Data flywheel closed — prevalence flows back into reviews (2026-06-30)
The ledger had always RECORDED every scan (`engine/ledger.ts`) but nothing consumed it — the moat was being filled and never spent. Closed the loop: findings are now ranked by how often they actually occur across the repos scanned, and that prevalence flows back into reviews. The compounding moat — a code-cloner starts at zero data.
- **`computeStats` upgraded** — `checkFrequency` now tracks **distinct repos per check** (the honest prevalence denominator, so re-scanning one repo 10× doesn't inflate it); ranked by repo-share then volume.
- **`engine/insights.ts`** (the read side) — `loadInsights()` (with a `ready` gate: ≥3 repos & ≥5 scans, else prevalence is noise), `annotate(findings)` (appends "📊 seen in N% of repos you've scanned (#k most common)" to findings ≥30% prevalence — a DISPLAY copy; raw findings stay clean for gating/certify), `prevalenceNote()` (a one-line priming note for boot/audit), `insightsCard()` (the `/insights` leaderboard). Deliberately does NOT auto-change severity from frequency (frequency ≠ severity).
- **Fed from interactive use too** — `scan()` only recorded via `run()`/`runAgent` before, so conversational sessions never fed the ledger; the interactive boot + audit now `recordScan` (guarded by `SHEPHERD_NO_LEDGER`), closing the intake side.
- **Wired** — `insights` intent + `/insights` (`/stats`, `/ledger`, `/trends`); boot take-stock + audit + the autonomous run print the prevalence note and annotate the displayed report (annotation computed from PRIOR history, before recording the current scan).
- **Honest scoping** — local-first (`~/.shepherd/ledger.jsonl`), so prevalence is "across the repos YOU'VE scanned on this machine"; a global cross-user dataset is the GitHub-App/server story, not this.
- **Verified** on a synthetic 6-scan / 4-repo ledger: leaderboard ranked cost-bomb 75% / file-too-long 50% / no-readme 25% by distinct repos; `annotate` tagged cost-bomb (≥30%) and correctly skipped no-readme (25%); `prevalenceNote` surfaced the top recurring failure.

### Deeper live probe — red team + blue check (2026-06-30)
Extended the existing localhost attack probe (`backend/probe.ts`) rather than building a heavy red/blue framework — the right-sized answer to "do we need red/blue testing?". Still bounded, localhost-only, own-server, authorized self-testing.
- **Red — the exploit classes AI code ships broken:** added **broken object-level access / IDOR** (dynamic `/[id]` route reachable unauth → 200), **SQL injection** (`' OR '1'='1` payload surfacing a DB error via a tight `SQL_ERR` regex), **reflected XSS** (a unique `<shep>` canary echoed verbatim into an HTML response), **`alg:none` JWT bypass** (only on routes that ARE auth-gated — unauth 401/403 then a forged unsigned token → 200), and **prompt injection** (LLM endpoints only — an injected instruction whose canary comes back). Joins the existing rate-limit drain, security-headers, and stack-trace-leak checks. Each new exploit is a GATE (`GATE_ATTACKS` set); ids `live-*`, files `live:<route>` → classified empirical by `verify.ts`, so the certificate re-runs the probe to prove them closed.
- **Blue — did the app defend?** a `Posture` tally over the malicious probes (rejected 4xx / accepted 2xx / crashed 5xx); if the app actively rejects <50% of hostile input, emits an advisory `live-weak-defense` — "isn't detecting or validating hostile input at the edge." The defensive counterpart to the offensive proof.
- **Bounded & safe:** capped routes (6), per-request timeout, single-shot exploit probes, server always torn down. Body capture bumped 400→2000 chars so reflection/error detection works. Replaced the standalone `authBypass` with inline gated/forged-token logic.
- **Verified** against a deliberately-vulnerable local server over real HTTP: SQLi, XSS reflection, JWT alg:none gated-then-bypassed, broken-access, prompt-injection canary, and the blue weak-defense tally all fired correctly; predicates require the actual error/reflection/200 so a defended app won't false-positive.

### Consultative autopilot — the loop runs autonomously (2026-06-30)
The four stages (design → right-size → certify → release) now run as one loop — but **consultatively**: Shepherd interviews the user first, then runs the loop against their decisions. The user's declared SCALE is what reconciles the scale-architect-vs-right-sizing tension (the over-engineering tweet): you set the horizon, Shepherd advises against it.
- **Intent capture** (`engine/intent.ts`) — `LoopChoices {scale, architecture?, infraAll, infra[], deployTarget?, note?}` persisted to `.shepherd/intent.json` (`readChoices`/`writeChoices`/`summarizeChoices`). Ask once, reuse everywhere (interactive offers `[Y/edit]`; the CI run reads it silently).
- **The intake** (`runIntake` in `interactive.ts`) — Shepherd interviews its user via the REPL's readline, showing its OWN recommendation as the default at each step (target scale, architecture, which prescribed infra to keep, deploy target, an open note). Accept or override.
- **The loop** (`engine/pipeline.ts` `runLoop`) — ① `architectureSpec` built to the chosen architecture + only the selected infra + declared scale; ② `rightSizing` calibrated by `scale` (small → flag heavy infra hard; large → it's expected, suppress those flags; single-impl interfaces flagged at any scale); ③ `scan(deep)` + `runTests` + `certify`; ④ `releaseReadiness` + a deploy work-order tuned to the deploy target. Reuses prescriptions across intake → design to avoid a second scale-architect call.
- **Signature extensions** — `architectureSpec` honors `choices` (architecture override via `resolveTarget`, infra filter via `filterInfra`, scale/note in the markdown) + a reusable `prescriptions` opt; `recommendedTarget(repo)` exported for the intake; `rightSizing` takes `scale`.
- **Wired** — `autopilot` intent + `/autopilot` (`/pipeline`, `/run-all`); the autonomous `runAgent` reads saved intent and now also runs the design + release phases (right-size + certify already there), so `npx shepherd` covers all four.
- **Verified** — choices round-trip; spec honors a microservices override + keeps only the chosen infra (Redis, drops Kafka) + shows the declared scale + note; `rightSizing` suppresses premature-infra at scale=large and flags it at scale=small; and `runLoop` ran end-to-end on a git fixture (design → spec, right-size → clean, certify → tests green + certified, release → clear to deploy), writing all artifacts.

### Right-sizing / YAGNI counterweight + release gate (2026-06-30)
Two pieces: the over-engineering counterweight (answering the "knowing when to STOP optimizing" problem) and the deployment gate (gate the deploy, don't do it).
- **Right-sizing detector** (`engine/rightsizing.ts`) — the counterweight to the scale architect. AI writes the staff-level version on day 0 (caching, batching, configurable strategies, a connection pool for 50 records/day); most of it solves a problem the code doesn't have yet. Flags over-engineering at BOTH altitudes — **high-level**: premature heavy infra (Kafka/Redis/Elasticsearch/Temporal) in a small codebase, premature microservices, deep layer-cake for a tiny app; **low-level**: single-implementation interfaces (precise — an interface implemented exactly once; zero impls = a plain type, two+ = a real seam, neither flagged), plus a Claude judgment pass (pragmatic-engineer voice: speculative pluggability, needless indirection, premature caching/async). All ADVISORY — over-engineering is complexity-debt, not a ship blocker; the call is the engineer's. Deterministic tier wired always-on into `scan()` (so Shepherd's voice is balanced everywhere); judgment pass in the full audit. `rightsize` intent + `/rightsize` (`/yagni`, `/simplify`). **Verified**: flagged two single-impl interfaces + Kafka/Redis-in-a-2-file-app, and correctly did NOT flag an interface with two implementations.
- **Release gate** (`engine/release.ts`) — "gate the deploy, don't do it." `releaseReadiness()` clears a deploy only when a fresh Shepherd certificate (1) says certified, (2) attests to the exact commit being deployed (HEAD), and (3) has no uncommitted app drift since — binding the certificate to the artifact. `isDirty()` ignores Shepherd's own `.shepherd/` bookkeeping (else writing the certificate would always mark the tree dirty). `certify()` now stamps the git HEAD into the certificate + a machine-readable `.shepherd/certificate.json` sidecar. Detects whether any deploy pipeline exists; `buildDeployOrder()` writes a gated CI/CD work-order (build → test → `npx shepherd` gate → deploy, where deploy `needs:` the gate). `checkDeployedHealth(url)` hits the live `/health`/`/readyz` post-deploy. `release` intent + `/release-check` (`/ship-it`, `/deploy`; `pipeline` arg writes the work-order, a URL arg runs the health check). **Verified** all four gate states (no cert → hold; certified+matches+clean → clear; app file dirty → hold; cert for a different commit → hold).

### Spec-first mode — the architecture blueprint (2026-06-30)
**The inversion: from diagnostic to prescriptive.** Every other axis judges code AFTER it's written. `buildArchitectureSpec()` authors the blueprint the user's Claude Code builds FROM — "help Claude write the architecture." Closes the loop with /certify: design → build → prove.
- **`engine/spec.ts`** (`architectureSpec()` + `writeArchitectureSpec()` → `.shepherd/architecture-spec.md`) — composes the existing classifiers FORWARD. Mostly DETERMINISTIC (the moat): a target-pattern recommendation derived from the detected pattern/shape (event-driven → "modular monolith with a real broker + worker pool"; ad-hoc → "modular monolith with a clean domain core"; hexagonal → "strengthen it"; etc.), a feature/vertical-slice target structure with a concrete folder tree, scale-aware design-pattern guidance (DI over Singletons, Repository, Strategy/Adapter, Outbox, Factory-only-when-real), and 11 industry-standard **build constraints** (separation of concerns, dependency inversion, validate-at-boundary, typed contracts, SRP, explicit error handling, idempotency/async, statelessness, config/secrets, observability, tests-as-deliverable) stated as non-negotiables. With Claude: a web-grounded **blueprint narrative** authored for THIS app (`claudeAgentJsonArray`, reads real files) + the infra plan folded in from the `scaleArchitect`.
- **Extracted deterministic classifiers** — `classifyShape()` (from `backend/architecture.ts`) and `classifyProduction()` (from `backend/production.ts`) split the cheap shape/pattern/infra detection out of the Claude-bundled `analyze*` functions, so the forward-looking spec gets the classification without triggering diagnostic reviews.
- **Wired** as a `design` intent ("design the architecture", "blueprint", "spec-first" — required keywords so "design the tests" still routes to tests) + `/design` (`/spec`, `/blueprint`) slash. Distinct from `/architecture-review` (diagnostic). Help + slash-help updated.
- **Verified** on a layer-based Express+Kafka fixture with Claude OFF: correctly classified monolith / event-driven+layered / layer-based / Kafka, recommended "Event-driven modular monolith (real broker + worker pool)", prescribed the layer→feature reorg with the folder tree, and rendered all patterns + 11 principles — entirely deterministically (blueprint=0, prescriptions=0 without Claude, skeleton stands alone).

### Closed verify-with-proof loop — the certificate (2026-06-30)
**The foundation of the guarantee.** Shepherd no longer just finds → writes order → done. It now PROVES fixes against fresh evidence and emits a reproducible certificate — a measurement the user can re-run, not an opinion. This is what earns trust.
- **Real test execution** (`engine/testrun.ts`) — the hard gate behind any guarantee. Picks the project's test script (prefers `test:integration`/`test:ci`/`test:e2e` over a plain `test`), runs it (`CI=true`, bounded timeout), and reports the truth: exit code is the verdict, counts (Vitest/Jest/Mocha/Playwright reporters parsed best-effort) make the "147 passed" line. The npm placeholder script is NOT counted as green. This is the ONE place Shepherd executes user code — measurement, not editing, so the maintainer model holds; only ever invoked on an explicit `/certify` (or the autonomous run), never silently, and always prints the exact command to re-run.
- **Objectives ledger + state machine** (`engine/certify.ts`, `.shepherd/objectives.json`) — every Go-Live blocker becomes a tracked OBJECTIVE (`open`→`passed`/`failed`/`unverifiable`), keyed by the blocker title, carrying its `verifyMethod` (deterministic/inventory/empirical/claude) and an evidence trail. `openObjectives()` records them at audit time; `certify()` re-checks each against a fresh (deep) scan: a blocker absent from the fresh scan flips to ✅ (deterministic/inventory/claude verified by absence; **empirical stays `unverifiable` unless the live probe actually re-ran** — honest, since a static pass can't prove a runtime gate). Regressions (a passed objective reappearing) flip back to `failed`. The ledger persists across the fix cycle (verified across separate processes).
- **The certificate** (`buildCertificateMarkdown`/`printCertificate`/`writeCertificate` → `.shepherd/certificate.md`) — a build is **Shepherd-certified** iff every objective is proven closed AND a real suite ran green. No tests → no certificate. Each line names the exact reproducible command. Wired into the agent as a `certify` intent + `/certify` (`/prove`, `/verify`) slash command, and into the autonomous/CI run (where the live probe ran, so empirical objectives can be proven too).
- **Verified end-to-end** on a fixture: gate present + tests green → **NOT CERTIFIED** (objective `failed`); after the gate was fixed + tests green → **✅ CERTIFIED** (objective `passed`, with the re-run command), proving the ledger survives across processes; gate gone but tests **red** → **NOT CERTIFIED** ("the test suite is red") — tests are a genuine hard gate, not decoration.

### Two integration paths (both built)
- **Claude Code drives (MCP):** `claude mcp add shepherd -- node <path>/dist/mcp.js` → ask Claude to "scan and harden with shepherd"
- **Shepherd drives (CLI):** `npx shepherd --fix` → spawns Claude Code per file via `ClaudeFixer`

---

## Phase 0 — Engine scaffold
- [ ] `npm` package `prodgate` (TypeScript). Monorepo or single package.
- [ ] Module structure:
  ```
  src/
    engine/
      detectors/     # deterministic checks (one file per check)
      dynamic/       # curl-flood, runtime probes
      fixers/        # LLM-driven fix generation
      report.ts      # findings model: {id, severity, file, line, gate|advise, message}
      run.ts         # orchestrates: detect → triage → (fix)
    shells/
      cli.ts         # local runner
      app/           # GitHub App (later)
  ```
- [ ] Findings schema + severity (🔴/🟠/🟡) + `gate` vs `advise` flag.

## Phase 1 — v1 detectors (deterministic, no LLM)
Build the checks in `CHECKLIST.md` §v1. All cheap, exhaustive, free:
- [ ] Secrets in client bundle (regex + `gitleaks`)
- [ ] Cost-bomb endpoints (AI/email routes w/o rate limit or auth)  ← **check #1, already validated**
- [ ] Unauthed API routes
- [ ] Authorization / IDOR (flag `:id` routes without ownership check)
- [ ] File size + cyclomatic complexity thresholds
- [ ] Hardcoded localhost
- [ ] Dependency CVEs (`npm audit`)
- [ ] Output a clean report (🔴 N critical …)

## Phase 2 — CLI shell
- [ ] `npx prodgate` / `npm i -g prodgate` runs detectors against a local repo
- [ ] Modes: scan-only (free), fix (needs a model)
- [ ] Model resolution: detect Claude Code installed → use it; else BYOK key; else scan-only
- [ ] Test against a real AI-built repo (start with `windback-fe`)

## Phase 3 — Fix layer (LLM)
- [ ] Given a finding + relevant files, generate a patch (Claude Opus 4.8, effort high)
- [ ] Haiku triage pass ("is this real / worth fixing?") before the expensive fix
- [ ] Output: a PR (App) or a paste-able block / Claude Code handoff (CLI)
- [ ] Prompt caching on the checklist prefix to cut cost

## Phase 4 — GitHub App shell (monetization)
- [ ] GitHub App: install flow, permissions (Contents R/W, PRs write)
- [ ] On push/PR webhook → read repo → run engine → open fix PR (never push to main)
- [ ] Uses YOUR Anthropic API key
- [ ] Free tier = scan only; paid tier = fixes

## Phase 5 — Billing & tiers
- [ ] Free (scan) / Solo ₹699 BYOK / Team $15-seat or $29-project / Agency ₹20k+
- [ ] Per-seat or quota+overage on Team (never unlimited-flat — API is your variable cost)
- [ ] BYOK option to zero-out inference for users who bring a key

## Phase 6 — Dynamic checks + v2
- [ ] Curl-flood → live rate-limit detection (the dynamic differentiator)
- [ ] Response-time (server vs client), DB query count (N+1)
- [ ] Supabase pooler / connection-limit check
- [ ] Advisory: architecture, server-vs-client, scaling (1M benchmark)

## v3 (later)
- [ ] Autonomous coder + verifier loop ("managing Claude")
- [ ] Multi-region / cost-optimization advisory
- [ ] Managed/done-for-you Agency tier tooling

---

### Build principle
Don't build the logic twice. The engine is the company; the CLI and App just call it.
Block a merge only on measurable findings; everything subjective is advisory.
