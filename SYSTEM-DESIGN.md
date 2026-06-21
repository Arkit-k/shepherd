# Shepherd — System Design

The engine is one pipeline. Both shells (CLI, GitHub App) call it.

```
Repo → Ingest → Parse to AST → Detect (5 families) → Triage → Fix → Report
                     │                                            │
              the backbone everything                        Shells: CLI / App
              code-quality depends on
```

## Layer 0 — Ingest
Read repo, detect stack (Next.js/Supabase from `package.json`), respect `.gitignore`, collect source files.

## Layer 1 — Parse to AST  (the critical backbone)
**You cannot regex your way to SOLID or design patterns.** You need an AST — the code parsed into classes, functions, imports, and a call graph. Built with **`ts-morph`** (TypeScript compiler API). Produces a structural model that the code-quality and design analyzers feed off.

## Layer 2 — Detectors (5 families)
| Family | Method | Examples |
|---|---|---|
| 1. Pattern | regex (deterministic) | secrets-in-client, localhost, cost-bomb signatures |
| 2. Static / AST | AST (deterministic) | file size, function length, cyclomatic complexity, **god-class, duplication, coupling, nesting** ← measurable SOLID; unauthed routes; IDOR heuristics |
| 3. Design analyzer | AST + **LLM** | abstract SOLID + design patterns (see below) |
| 4. Config / deps | scanners (deterministic) | `npm audit` CVEs, Supabase RLS, env, CORS, headers |
| 5. Dynamic / runtime | runs the app | curl-flood (rate limit), response timing, N+1 query count |

### How the SOLID / design-pattern check works (Family 3)
Two stages, both on the Layer 1 AST:
1. **Measurable (deterministic → GATES):** SOLID violations leave numeric fingerprints — a class with 30 methods = SRP; duplicated blocks = DRY; complexity > 15 = unmaintainable. Counted from the AST; these **block**.
2. **Judgment (LLM → ADVISES):** feed the *structural summary* (class/method/dependency map, not raw code) to Claude → "this class mixes auth+email+billing, split it" / "this repeated switch → Strategy pattern" / "X and Y are tightly coupled." These **advise**, never gate.

Reliable (numbers gate, opinions advise) **and** full SOLID/design-pattern coverage.

## Layer 3 — Triage
Haiku 4.5 dedupes, validates "is this real," ranks severity. Cheap.

## Layer 4 — Fix
Opus 4.8 takes a finding + relevant AST/code → patch → PR (App) or paste/handoff (CLI).

## Layer 5 — Report
Findings → console (CLI) or PR + status checks (App). Each tagged 🔴/🟠/🟡 and **gate** vs **advise**.

## Build sequence (complete design, dependency order)
1. **Layer 0 + 1** — ingest + AST backbone ← *building now*
2. **Layer 2 fam 1–2** — pattern + static/AST detectors (incl. measurable SOLID)
3. **Layer 2 fam 3** — LLM design/architecture analyzer (abstract SOLID + patterns)
4. **Layer 2 fam 4** — config/dep/RLS scanners
5. **Layer 4** — fix layer
6. **Layer 2 fam 5 + GitHub App** — dynamic probes, then the App

Governing rule: **gate on measurable, advise on subjective.**

---

## The walk-through (product flow — understand before judging)
Shepherd doesn't just scan; it orients first, then audits.

**① UNDERSTAND**
- Map repo (Tier 1): file tree, AST, routes, entry points, dep graph
- Detect tech + versions (Tier 1) — `tech-stack.ts` ✅ (`shepherd understand`)
- Comprehend (Tier 2 Claude): plain-English architecture summary

**② REPORT**
- 📦 Tech (+ outdated/EOL) · 🏗️ architecture · 🧪 tests (exist? pass?) · 🎯 system-design assessment

**③ AUDIT**
| Area | Tier |
|---|---|
| 🔒 Security — rate-limit, AI-endpoint, email-bomb, secrets, auth/IDOR, injection | 1+2 |
| ⚡ Performance — N+1, unbounded input, missing caching/timeouts | 1+2 |
| 🆕 **Modernity** — outdated versions (`npm outdated`) + deprecated/old API patterns AI uses | 1+2 |
| 🏛️ Architecture — coupling, layering, god-objects, separation | 2 |
| 🧠 Logic — bugs, edge cases, races, error handling | 2 |

**④ FIX LOOP** — Claude fixes → re-verify (tests + re-scan) → repeat

Context strategy: never dump the whole repo at Claude. Build the cheap Tier-1 map, then Claude reasons over the *map* + targeted files. Understanding stays affordable.

**Status:** ① tech detection done. Next: Claude architecture summary, modernity check, broaden deep-review to perf/arch/logic.
