# Shepherd — Decisions Log

## Locked decisions (and why)
1. **Product = "you code, we maintain"** — continuous production-readiness gate, not one-time scan. *Why:* continuous = recurring revenue + retention = a product, not a feature.
2. **Moat = the checklist**, not the AI. *Why:* everyone has Claude; nobody has your curated list of how AI-built code leaks. The AI is a commodity; the questions are the asset.
3. **One engine, two shells (CLI + GitHub App).** *Why:* proven devtool shape (Snyk/Semgrep). Don't build logic twice.
4. **Detection = deterministic; fixes = LLM.** *Why:* security must be exhaustive/reproducible/cheap — regex/gitleaks beat an LLM at finding; Claude is best at fixing.
5. **CLI runs on the user's own Claude; App runs on your API.** *Why:* CLI has a human + their Claude to borrow (free, viral); the App runs autonomously server-side (no Claude to borrow → you supply it → you charge).
6. **Free = scan (deterministic, $0); fixes = paid (your Claude, covered by price).** *Why:* removes all cost pressure — unlimited free scanners cost ~$0; only payers trigger your API.
7. **Never give away your-Claude on the CLI free.** *Why:* CLI is high-frequency/unbounded ($55–220/dev). Managed-CLI only as a quota'd paid add-on.
8. **Block on measurable; advise on subjective.** *Why:* block on an opinion → teams rip you out; block on a number → you're Snyk.
9. **Market narrow ("AI app leaking your DB"), build universal (stack-based engine).**
10. **Models:** fixes = Opus 4.8 (`claude-opus-4-8`); triage = Haiku 4.5 (`claude-haiku-4-5`).
11. **Target = dev teams + solo (funnel: CLI acquisition → App monetization).** B2B-aligned with the broader portfolio plan.

## Open questions (resolve while building)
- [ ] Product name (ProdGate is a placeholder)
- [ ] First vertical/beachhead: indie vibe-coders vs agencies/freelancers vs dev teams — pick ONE to message first
- [ ] CLI ↔ Claude Code handoff: shell out to `claude` CLI, or a structured findings file it reads? Define the exact format.
- [ ] Team pricing: per-seat ($15) vs quota+overage — pick before launch
- [ ] How much of IDOR can be deterministic vs needs the dynamic/LLM pass
- [ ] First-scan heavy-cost handling (one-time "initial hardening" fee vs absorb)

## Validation done
- Manual scan of `windback-fe` caught a live **cost-bomb** (`/api/ai-chat`: public, unauthed, no rate limit, unbounded `history`). SonarQube/CodeRabbit would miss it. Moat confirmed on a real app.

## Next action
Build the engine (ROADMAP Phase 0–1), cost-bomb as check #1, test via CLI against `windback-fe`.
