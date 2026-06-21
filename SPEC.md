# Shepherd — Production-Readiness Gate for AI-Written Code
*("You code. We shepherd it to production.")*

**One line:** "You code, we maintain." Continuous production-readiness checking + auto-fix for AI-built apps (Lovable, Bolt, v0, Cursor, Claude — any stack).

---

## 1. The product
A production-readiness engine that scans AI-generated code for the ways it specifically breaks, and opens fix PRs. Continuous, not one-time — it runs forever (on every push), which is what makes it a product, not a feature.

**Moat = the checklist.** The AI is a commodity; the curated, ever-growing list of "how AI-built apps leak/break" is the asset. Competitors have the same Claude; they don't have the checklist, the packaging, or the always-on automation.

**Target:** AI-built apps. Market narrow ("stop your AI app from leaking your DB"), but the engine is stack-based so it works on any Next.js+Supabase / React+Firebase app regardless of who built it.

---

## 2. Architecture — one engine, two shells
```
        THE ENGINE (build once)  ← the company
        detect → triage → fix
              │
      ┌───────┴────────┐
   CLI shell        GitHub App shell
   (local)          (server)
```
Same npm package. `npm i -g prodgate` for the CLI; the same package imported by the server for the App.

| | CLI | GitHub App |
|---|---|---|
| Runs | Dev's machine | Your server |
| Model | User's own Claude ($0 to you) | Your Anthropic API |
| Trigger | Manual | Automatic, on push |
| Role | Free, viral — **acquisition** | Paid — **monetization** |

**Detection = deterministic (no LLM):** gitleaks, semgrep, curl-flood, line counts. Cheap, exhaustive, free.
**Fix = LLM:** Claude writes the patch → opens a PR (never direct push to main).

---

## 3. The checklist (the moat)
**① Security (static)** — secrets in client bundle, open Supabase RLS, unauthed endpoints, **cost-bomb endpoints** (no rate limit on AI/email), **authorization / IDOR** (logged-in user reaching another user's data — OWASP #1, the must-have), injection, dependency CVEs (`npm audit`).

**② Runtime / Dynamic (the differentiator — RUNS the app)** — curl-flood → detect missing rate limit, response-time (server vs client), DB query count per request (N+1), load behavior. No competitor runs the app; they only read code.

**③ Code Quality (measurable smells, not abstract SOLID)** — file size, function length, cyclomatic complexity, god-class, duplication, nesting depth. SOLID violations are checked via their measurable fingerprints, not opinions.

**④ Reliability (static config)** — error handling, env vars, localhost links, backups, observability, tests exist + pass, health checks.

**⑤ Scaling to 1M (advisory/benchmark)** — connection pooling (the #1 real crash), caching, indexes, stateless app servers, async queues, multi-region, CDN, cost-opt, load testing.

**Governing rule:** *Block a merge only on what you can measure. Everything subjective is advisory.* Block on "secret exposed / endpoint un-rate-limited / file > 800 lines." Advise on "consider a Strategy pattern." Block on a number → you're Snyk. Block on an opinion → teams rip you out.

**Sequencing:** v1 = measurable + static + the one easy dynamic check (cost-bomb, IDOR, secrets, file-size, curl/rate-limit). v2 = DB profiling, perf, advisory architecture. v3 = autonomous coder+verifier loop, multi-region.

---

## 4. Models
- **Detection:** none (deterministic).
- **Fixes:** Claude Opus 4.8 (`claude-opus-4-8`) — best at code, 1M context, effort=high.
- **Triage ("is this real?"):** Claude Haiku 4.5 (`claude-haiku-4-5`) — cheap.
- Skip Fable 5 ($10/$50) — overkill.

---

## 5. Billing model (architecture dictates it)
- **CLI:** runs on the user's own Claude → **$0 inference to you.** If no Claude: scan-only (free) or BYOK.
- **GitHub App:** runs on **your** API → you pay, you charge.
- **The rule that removes all cost pressure:** *Free tier = scan (deterministic, $0). Fixes = paid (your Claude, covered by price).* 10,000 free scanners cost ~$0.
- **No-Claude vibe-coder (Lovable user):** free scan is the scary hook → pays $29 for fixes (covers ~$12 App cost) → he's the best customer, not a cost problem. Bounded per-push, not unbounded.
- **Never** give away your-Claude on the CLI free — CLI is high-frequency/unbounded (~$55–220/dev). Managed-CLI only as a quota'd paid add-on.

---

## 6. Pricing (India-first, solo→team funnel)
| Plan | India ₹/mo | Global $/mo | Gets | Your cost |
|---|---|---|---|---|
| Free | 0 | 0 | Unlimited scans | ~$0 |
| Solo/Pro | 699 | 12 | Fix PRs, BYOK | ~$0 |
| Team | 2,499 flat / per-seat | 15/seat | Continuous gate, IDOR/cost-bomb | ~$0–12 |
| Single project | 2,499 | 29 | App on one repo | ~$12 |
| Agency/Managed | 20,000+ | 250+ | Done-for-you on their cloud (the retainer) | ~$10–30 |

Per-seat or quota+overage for Team (never unlimited-flat — your API is the variable cost).

---

## 7. Economics
- **Fixed cost:** ~$20/mo (hosting + domain). Inference only on paid App.
- **Per fix:** ~$0.50 (Opus + caching + Haiku triage).
- **Per App project:** ~$12/mo typical to you; charge $29 → ~$17 profit.
- **Profitable at customer #1.** Free stuff (CLI + scans) is genuinely $0 to run. ~95% gross margin.

| Paid App projects | Your Claude bill | Revenue @ $29 | Profit |
|---|---|---|---|
| 10 | ~$120 | $290 | ~$170 |
| 50 | ~$600 | $1,450 | ~$850 |
| 100 | ~$1,200 | $2,900 | ~$1,700 |

---

## 8. Validation (done)
Ran the checklist manually against a real repo (`windback-fe`) — caught a live **cost-bomb**: `/api/ai-chat` is a public, unauthed, no-rate-limit endpoint with unbounded `history`, drainable via curl. SonarQube/CodeRabbit would miss it. Moat confirmed on a real app.

---

## 9. Build order
1. **Build the engine** (checklist + scan + fix) — 90% of the work.
2. **Test as CLI** — fast, no infra (already started).
3. **Wrap as GitHub App** — OAuth + webhook + your API key. This is where the no-Claude users and the money are.

CLI ships ~free as a byproduct of building/testing the engine. Logic is never written twice.
