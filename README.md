# Shepherd — Planning Kit
*(production-readiness gate for AI-written code — guides your code safely to production)*

**Start here when you come back.** This folder holds the complete plan. Read in this order:

| File | What it is |
|---|---|
| **README.md** (this) | Index + current status + the immediate next step |
| **SPEC.md** | The master spec — product, architecture, checklist, models, billing, pricing, economics |
| **ROADMAP.md** | The build, broken into phases with concrete tasks/checkboxes |
| **CHECKLIST.md** | The moat — every check + how to detect it (deterministic / dynamic / LLM) + gate-vs-advise. This is what you build. |
| **DECISIONS.md** | Locked decisions (+ the *why*) and open questions to resolve while building |
| **scan/** | Runnable artifacts you can use TODAY: `prod-ready-scan.sh` + `rls-check.sql` |

---

## One-line pitch
"You code, we maintain." Continuous production-readiness checking + auto-fix for AI-built apps (Lovable, Bolt, v0, Cursor, Claude). The moat is **the checklist**.

## Architecture in one breath
**One engine, two shells.** Build the engine once (detect → triage → fix). Wrap it as a **CLI** (local, runs on the user's own Claude, free, viral) and a **GitHub App** (server, runs on your API, paid). Same npm package, two install targets.

## Status (as of 2026-06-21)
- ✅ Design fully locked and pressure-tested
- ✅ Moat validated — manual scan of a real repo (`windback-fe`) caught a live cost-bomb (`/api/ai-chat`: public, unauthed, no rate limit, drainable by curl)
- ⬜ Engine not built yet

## The immediate next step
Build the engine, starting with the deterministic detectors in `CHECKLIST.md` §v1. Test them via the CLI shell against a real repo. The cost-bomb check is check #1 (already proven). See `ROADMAP.md` Phase 0–1.

## How to resume with Claude
Point Claude at this folder and say: *"Read production-gate/SPEC.md and ROADMAP.md, then scaffold the engine (Phase 0)."*
