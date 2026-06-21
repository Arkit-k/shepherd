#!/usr/bin/env bash
# Shepherd v0 manual scanner — run inside any repo:  bash prod-ready-scan.sh
# Deterministic checks only (free, no LLM). This is the seed of the engine's detectors.
echo "🔎 Production-readiness scan"
echo "================================"

SRC="./src ./app ./pages"

# 1. 🔴 Secrets shipped to the client (data-leak bomb)
echo -e "\n[1] Client-exposed secrets:"
grep -rIn --include=*.{ts,tsx,js,jsx} \
  -E "(service_role|sk-[a-zA-Z0-9]{20,}|SUPABASE_SERVICE|OPENAI_API_KEY *=|AKIA[0-9A-Z]{16})" \
  $SRC 2>/dev/null | grep -vE "process.env|\.example" || echo "  ✅ none in source"

# 2. 🔴 Exhaustive secret scan
echo -e "\n[2] Secret scan (gitleaks):"
command -v gitleaks >/dev/null && gitleaks detect --no-banner -v || echo "  ⚠️ install gitleaks for full + git-history scan"

# 3. 🔴 Cost-bomb: AI/email endpoints with no rate limiting  (CHECK #1)
echo -e "\n[3] Unprotected AI/email endpoints (cost-bomb risk):"
grep -rIln -E "openai|anthropic|generateText|chat.completions|sendMail|resend" ./app/api ./pages/api 2>/dev/null \
  | while read f; do grep -qiE "ratelimit|rate-limit|upstash|auth|session" "$f" || echo "  ⚠️ no rate-limit/auth: $f"; done

# 4. 🔴 API routes with no auth check
echo -e "\n[4] API routes missing auth:"
grep -rILn -E "auth|session|getUser|verifyToken" ./app/api ./pages/api 2>/dev/null | grep -E "route\.|\.ts$" || echo "  ✅ or no api dir"

# 5. 🟡 Hardcoded localhost (breaks on deploy)
echo -e "\n[5] Hardcoded localhost:"
grep -rIn "localhost:" --include=*.{ts,tsx,js,jsx} $SRC 2>/dev/null || echo "  ✅ none"

# 6. 🟡 Oversized files (SRP smell — the 5000-line problem)
echo -e "\n[6] Files > 800 lines:"
find $SRC -name "*.ts" -o -name "*.tsx" 2>/dev/null | xargs wc -l 2>/dev/null | awk '$1 > 800 && $2 != "total" {print "  ⚠️ "$1" lines: "$2}' || echo "  ✅ none"

# 7. 🟠 Dependency CVEs
echo -e "\n[7] Dependency vulnerabilities:"
command -v npm >/dev/null && npm audit --omit=dev 2>/dev/null | tail -3 || echo "  run npm audit"

echo -e "\n================================\nDone. (RLS check is separate — see rls-check.sql)"
