# Shepherd — The Checklist (the moat)

This is the asset. It grows with every repo you scan. Each check has a **detection method**
(deterministic = cheap regex/static; dynamic = run the app; LLM = judgment) and a
**gate vs advise** flag.

> **Governing rule:** *Block a merge only on what you can measure.* Subjective findings are advisory.

---

## v1 — ship these first (measurable + high-value)

### 🔴 Security
| Check | Detect | Gate? | How |
|---|---|---|---|
| Secret in client bundle | deterministic | gate | regex: `service_role`, `sk-[A-Za-z0-9]{20,}`, `AKIA[0-9A-Z]{16}`, `OPENAI_API_KEY=` in `src/app/pages` (client files); `gitleaks` for full + git history |
| **Cost-bomb endpoint** ✅ | deterministic | gate | AI/email routes (`openai`, `anthropic`, `chat.completions`, `sendMail`) with no `ratelimit`/`auth` nearby; flag unbounded request body (e.g. `history` array) |
| Unauthed API route | deterministic | gate | `app/api`/`pages/api` route files with no `auth`/`session`/`getUser`/`verifyToken` |
| **Authorization / IDOR** | LLM-assisted | advise→gate | routes with `:id`/`[id]`/`[email]` params that fetch a resource without an ownership check. Dynamic: log in as A, try B's resource, expect 403 |
| Injection | deterministic | gate | user input interpolated into SQL/shell (`query(\`...${}\`)`, `exec(`) |
| Dependency CVEs | deterministic | advise | `npm audit --json` |

### 🟡 Code Quality (measurable smells, not abstract SOLID)
| Check | Detect | Gate? | Threshold |
|---|---|---|---|
| File too long (SRP smell) | deterministic | gate | > 800 lines |
| Function too long | deterministic | advise | > 80 lines |
| Cyclomatic complexity | deterministic | gate | > 15 |
| Nesting depth | deterministic | advise | > 4 |
| Duplication (DRY) | deterministic | advise | jscpd/semgrep |
| God-class | deterministic | advise | class with > ~20 methods |

### 🟠 Reliability
| Check | Detect | Gate? |
|---|---|---|
| Hardcoded `localhost:` | deterministic | gate |
| Missing error handling / boundaries | deterministic | advise |
| No tests / tests fail | deterministic | advise |
| Env vars misconfigured | deterministic | advise |

---

## v2 — Runtime / Dynamic (the differentiator — RUNS the app)
- Curl-flood an endpoint → no 429 = missing rate limit (the easy, high-impact one)
- Email triggers: per-email AND per-IP rate limit; inline vs queued send; idempotency
- Response time: server vs client
- DB query count per request (N+1); missing indexes
- **Supabase connection pooler vs direct connection** (the #1 real "dies at 50 users" crash)
- Timeouts on external `fetch` calls

## v3 — Scaling to 1M (advisory benchmark)
Sessions (stateless JWT vs DB), email index, bcrypt CPU, Redis-backed rate limiting
(in-memory breaks at >1 instance), async queues/workers, caching, read replicas,
multi-region, CDN, cost-optimization, load testing (k6/artillery).

---

## RLS check (can't be grepped — run in Supabase SQL editor)
```sql
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables WHERE schemaname = 'public'
ORDER BY rls_enabled;   -- any false = wide-open table
```

## Auth-app worked example (failure modes are textbook — good test bed)
- Phase 1: flood `/login` (brute force), `/register` (spam), `/forgot-password` (email bomb), `/verify-otp`; timing attack on login (user enumeration); inline vs queued email
- Phase 2: one god-file `auth.ts`; logic in route handlers; duplicated validation
- Phase 3: DB sessions vs JWT at 1M; `users.email` index; bcrypt CPU; in-memory rate limiter breaks horizontally
