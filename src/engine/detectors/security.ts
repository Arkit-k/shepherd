import type { Repo } from "../ingest.js";
import type { Finding } from "../report.js";

// Layer 2, family 1 — deterministic security/pattern detectors (no LLM).

// Match the actual hardcoded SECRET VALUE, not just a keyword — `service_role`
// alone reads as a false positive on any code that merely mentions Supabase (or, as
// dogfooding caught, on this detector's own pattern source). A leaked service_role
// key IS a JWT, so we match the JWT shape instead.
// A JWT-shaped string is not automatically a credential. Test fixtures and docs
// examples share the `eyJ…` prefix but fall apart under inspection, and gating on
// them is how a detector loses the user's trust — dogfooding caught Shepherd
// blocking its OWN repo on its own fixture.
//
// Two structural facts separate a credential from a placeholder:
//   - an HS256/RS256 signature is ~43+ base64url chars; a fixture's is short
//   - the header and payload of a real token decode to JSON
function looksLikeRealJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts as [string, string, string];
  if (signature.length < 40) return false;
  return [header, payload].every((seg) => {
    try {
      const json = Buffer.from(seg, "base64url").toString("utf8");
      const parsed: unknown = JSON.parse(json);
      return typeof parsed === "object" && parsed !== null;
    } catch {
      return false;
    }
  });
}

const SECRET_PATTERNS: { re: RegExp; label: string; valid?: (m: string) => boolean }[] = [
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    label: "a hardcoded JWT (e.g. a Supabase service_role/anon key or an auth token)",
    valid: looksLikeRealJwt,
  },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, label: "an OpenAI-style secret key (sk-…)" },
  { re: /AKIA[0-9A-Z]{16}/, label: "an AWS access key id (AKIA…)" },
  { re: /(OPENAI|ANTHROPIC|SUPABASE_SERVICE)[A-Z_]*\s*=\s*['"][A-Za-z0-9_\-]{16,}['"]/, label: "a hardcoded API key assignment" },
];

const AI_EMAIL_CALL =
  /openai|anthropic|openrouter|chat\/completions|chat\.completions|generateText|streamText|AI_API_KEY|sendMail|nodemailer|resend|sgMail|postmark|sendgrid/i;

// rate limiting (the thing whose absence makes an endpoint a cost-bomb)
const RATE_LIMIT = /ratelimit|rate-limit|rateLimit|upstash|limiter|throttle/i;

// INCOMING request auth — deliberately specific so the outgoing "Authorization"
// header on an upstream call doesn't read as a false "this route is protected".
const INCOMING_AUTH =
  /getUser|getSession|getServerSession|currentUser|requireAuth|verifyToken|withAuth|isAuthenticated|cookies\(\)|auth\(\)|requireSession/;

// A webhook authenticates by verifying a signature over the raw body, not by a
// session. Without this, every webhook endpoint in a repo reads as "unauthed"
// and the warn tier becomes noise the user learns to ignore.
const SIGNATURE_AUTH =
  /constructEvent|timingSafeEqual|createHmac|verifySignature|verifyHeader|new Webhook\(|svix|x-hub-signature|stripe-signature|razorpay-signature|webhook[_-]?secret/i;

// Files that are SUPPOSED to point at localhost. Flagging these is the fastest
// way to get the gate switched off.
const DEV_ONLY_FILE =
  /(^|\/)(\w+\.config\.(ts|js|mjs|cjs)|.*\.(test|spec|stories)\.[tj]sx?)$|(^|\/)(e2e|tests?|__tests__|__mocks__|fixtures?|mocks?)\//;

// Exported HTTP handlers — used to anchor a route-level finding to a real line
// so it can become an inline PR comment.
const ROUTE_HANDLER =
  /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b|export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*=|export\s+default\s+(?:async\s+)?function/;

function isApiRoute(p: string): boolean {
  return /\/api\/.*route\.(ts|js)$/.test(p) || /pages\/api\//.test(p);
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

// Blank out comments while preserving every byte offset and newline, so a match
// index still maps to the right line. String literals are LEFT INTACT: an import
// specifier ("openai") and a header name ("stripe-signature") are real evidence,
// and `http://` inside a string must not be mistaken for a comment.
//
// Why this matters in both directions:
//   - `// FIXME: add upstash rate-limit` used to SATISFY the rate-limit check and
//     silence a critical cost-bomb gate.
//   - `// we don't call openai here` used to CREATE a cost-bomb finding.
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;

  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];

    if (quote) {
      if (c === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

export function security(repo: Repo): Finding[] {
  const out: Finding[] = [];

  for (const f of repo.files) {
    const api = isApiRoute(f.path);
    // Behavioural checks read the code with comments blanked out; secret and
    // localhost checks below deliberately read the raw file.
    const code = stripComments(f.content);
    const authed = INCOMING_AUTH.test(code) || SIGNATURE_AUTH.test(code);
    const handler = code.match(ROUTE_HANDLER);
    const handlerLine = handler ? lineOf(code, handler.index ?? 0) : 1;

    // 1. 🔴 cost-bomb — AI/email endpoint with no rate limiting
    const aiCall = code.match(AI_EMAIL_CALL);
    if (api && aiCall && !RATE_LIMIT.test(code)) {
      const open = !authed;
      out.push({
        id: "cost-bomb",
        severity: "critical",
        disposition: "gate",
        file: f.path,
        line: lineOf(code, aiCall.index ?? 0),
        message:
          `${open ? "Public " : ""}AI/email endpoint with no rate limiting` +
          `${open ? " or auth" : ""} — it can be hit in a loop to drain your API budget or spam emails.`,
      });
    }

    // 2. 🔴 hardcoded secret in source
    for (const { re, label, valid } of SECRET_PATTERNS) {
      if (/\.example$/.test(f.path)) break;
      const m = f.content.match(re);
      if (m && (!valid || valid(m[0]))) {
        out.push({
          id: "exposed-secret",
          severity: "critical",
          disposition: "gate",
          file: f.path,
          line: lineOf(f.content, m.index ?? 0),
          message: `Possible hardcoded secret — ${label}. Move it to an env var and rotate it.`,
        });
        break; // one per file is enough
      }
    }

    // 3. 🟡 unauthed API route (skip auth endpoints themselves — login/register are meant to be public)
    if (api && !authed && !/\/auth\//.test(f.path)) {
      out.push({
        id: "unauthed-route",
        severity: "warn",
        disposition: "advise",
        file: f.path,
        line: handlerLine,
        message: "API route has no visible auth check — confirm it's meant to be public.",
      });
    }

    // 4. 🟡 hardcoded localhost — advise, never gate. It is cosmetic next to the
    // findings above, and blocking a push over a dev URL is how a gate gets
    // disabled on day one.
    const lh = DEV_ONLY_FILE.test(f.path) ? null : f.content.match(/https?:\/\/localhost:\d+/);
    if (lh) {
      out.push({
        id: "hardcoded-localhost",
        severity: "warn",
        disposition: "advise",
        file: f.path,
        line: lineOf(f.content, lh.index ?? 0),
        message: `Hardcoded ${lh[0]} — breaks once deployed. Use an env var.`,
      });
    }
  }

  return out;
}
