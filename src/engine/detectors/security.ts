import type { Repo } from "../ingest.js";
import type { Finding } from "../report.js";

// Layer 2, family 1 — deterministic security/pattern detectors (no LLM).

const SECRET_PATTERNS: RegExp[] = [
  /service_role/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /AKIA[0-9A-Z]{16}/,
  /(OPENAI|ANTHROPIC|SUPABASE_SERVICE)[A-Z_]*\s*=\s*['"][A-Za-z0-9_\-]{16,}['"]/,
];

const AI_EMAIL_CALL =
  /openai|anthropic|openrouter|chat\/completions|chat\.completions|generateText|streamText|AI_API_KEY|sendMail|nodemailer|resend|sgMail|postmark|sendgrid/i;

// rate limiting (the thing whose absence makes an endpoint a cost-bomb)
const RATE_LIMIT = /ratelimit|rate-limit|rateLimit|upstash|limiter|throttle/i;

// INCOMING request auth — deliberately specific so the outgoing "Authorization"
// header on an upstream call doesn't read as a false "this route is protected".
const INCOMING_AUTH =
  /getUser|getSession|getServerSession|currentUser|requireAuth|verifyToken|withAuth|isAuthenticated|cookies\(\)|auth\(\)|requireSession/;

function isApiRoute(p: string): boolean {
  return /\/api\/.*route\.(ts|js)$/.test(p) || /pages\/api\//.test(p);
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

export function security(repo: Repo): Finding[] {
  const out: Finding[] = [];

  for (const f of repo.files) {
    const api = isApiRoute(f.path);

    // 1. 🔴 cost-bomb — AI/email endpoint with no rate limiting
    if (api && AI_EMAIL_CALL.test(f.content) && !RATE_LIMIT.test(f.content)) {
      const open = !INCOMING_AUTH.test(f.content);
      out.push({
        id: "cost-bomb",
        severity: "critical",
        disposition: "gate",
        file: f.path,
        message:
          `${open ? "Public " : ""}AI/email endpoint with no rate limiting` +
          `${open ? " or auth" : ""} — it can be hit in a loop to drain your API budget or spam emails.`,
      });
    }

    // 2. 🔴 hardcoded secret in source
    for (const re of SECRET_PATTERNS) {
      if (/\.example$/.test(f.path)) break;
      const m = f.content.match(re);
      if (m) {
        out.push({
          id: "exposed-secret",
          severity: "critical",
          disposition: "gate",
          file: f.path,
          line: lineOf(f.content, m.index ?? 0),
          message: `Possible hardcoded secret (/${re.source}/) — move it to an env var and rotate it.`,
        });
        break; // one per file is enough
      }
    }

    // 3. 🟡 unauthed API route (skip auth endpoints themselves — login/register are meant to be public)
    if (api && !INCOMING_AUTH.test(f.content) && !/\/auth\//.test(f.path)) {
      out.push({
        id: "unauthed-route",
        severity: "warn",
        disposition: "advise",
        file: f.path,
        message: "API route has no visible auth check — confirm it's meant to be public.",
      });
    }

    // 4. 🟡 hardcoded localhost (breaks in production)
    const lh = f.content.match(/https?:\/\/localhost:\d+/);
    if (lh) {
      out.push({
        id: "hardcoded-localhost",
        severity: "warn",
        disposition: "gate",
        file: f.path,
        line: lineOf(f.content, lh.index ?? 0),
        message: `Hardcoded ${lh[0]} — breaks once deployed. Use an env var.`,
      });
    }
  }

  return out;
}
