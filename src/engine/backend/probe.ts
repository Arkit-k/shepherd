import { spawnSync } from "node:child_process";
import type { Repo } from "../ingest.js";
import type { Finding } from "../report.js";
import { startServer } from "./server.js";
import { claudeAvailable } from "../fixers/claude.js";
import { loadProject } from "../project.js";

// The dynamic differentiator: Shepherd doesn't just *infer* a cost-bomb from
// source — it boots the app and *proves* it with bounded, curl-style attacks
// against localhost. Hard caps + timeouts everywhere: this tests the user's
// own dev server, it is never an external target and never unbounded.

const REQUEST_TIMEOUT = 4000;
const MAX_ROUTES_PROBED = 6;

interface AttackEvidence {
  attack: string;
  route: string;
  detail: string;
}

function isApiRoute(p: string): boolean {
  return /\/api\/.*route\.(ts|js)$/.test(p) || /pages\/api\//.test(p);
}

// Turn a source path like app/api/ai-chat/route.ts into the URL path /api/ai-chat.
function routeUrlPath(srcPath: string): string {
  let p = srcPath.replace(/\\/g, "/");
  const appMatch = p.match(/app\/(.*)\/route\.(ts|js)$/);
  if (appMatch) return "/" + appMatch[1];
  const pagesMatch = p.match(/pages\/(api\/.*)\.(ts|js)$/);
  if (pagesMatch) return "/" + pagesMatch[1].replace(/\/index$/, "");
  return "/";
}

function sensitivity(srcContent: string): number {
  return /openai|anthropic|sendMail|resend|nodemailer|sendgrid|chat\/completions/i.test(srcContent)
    ? 2
    : /auth|login|register|checkout|payment|stripe/i.test(srcContent)
      ? 1
      : 0;
}

async function fetchSafe(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; bodySnippet: string } | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
    const text = await res.text().catch(() => "");
    return { status: res.status, headers: res.headers, bodySnippet: text.slice(0, 400) };
  } catch {
    return null;
  }
}

// 1. Rate-limit burst — fire N quick requests; if nothing ever 429s, the
//    endpoint is drainable. Bounded by `burst` (default 40).
async function rateLimitBurst(
  baseUrl: string,
  routePath: string,
  burst: number,
): Promise<AttackEvidence | null> {
  const url = baseUrl + routePath;
  const results = await Promise.all(
    Array.from({ length: burst }, () => fetchSafe(url, { method: "GET" })),
  );
  const answered = results.filter((r): r is NonNullable<typeof r> => r !== null);
  if (answered.length === 0) return null; // route not reachable via GET
  const throttled = answered.some((r) => r.status === 429);
  if (throttled) return null; // good — it defends itself
  return {
    attack: "rate-limit",
    route: routePath,
    detail: `${answered.length}/${burst} requests answered, none returned 429 — no rate limiting observed.`,
  };
}

// 2. Auth bypass — hit a sensitive route with no credentials; a 200 means the
//    gate isn't enforced server-side.
async function authBypass(baseUrl: string, routePath: string): Promise<AttackEvidence | null> {
  const r = await fetchSafe(baseUrl + routePath, { method: "GET" });
  if (!r) return null;
  if (r.status === 200) {
    return {
      attack: "auth-bypass",
      route: routePath,
      detail: `Unauthenticated GET returned 200 — confirm this route is meant to be public.`,
    };
  }
  return null;
}

// 3. Security headers — one GET to the app root.
async function securityHeaders(baseUrl: string): Promise<AttackEvidence | null> {
  const r = await fetchSafe(baseUrl + "/", { method: "GET" });
  if (!r) return null;
  const missing = [
    "content-security-policy",
    "strict-transport-security",
    "x-content-type-options",
    "x-frame-options",
  ].filter((h) => !r.headers.get(h));
  if (missing.length === 0) return null;
  return {
    attack: "security-headers",
    route: "/",
    detail: `Missing response headers: ${missing.join(", ")}.`,
  };
}

// 4. Error leakage — send a malformed/oversized payload; a 500 that echoes a
//    stack trace leaks internals.
async function errorLeakage(baseUrl: string, routePath: string): Promise<AttackEvidence | null> {
  const r = await fetchSafe(baseUrl + routePath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ this is : not json " + "A".repeat(2000),
  });
  if (!r) return null;
  if (r.status >= 500 && /at\s+\w+.*\(.*:\d+:\d+\)|stack|Error:/i.test(r.bodySnippet)) {
    return {
      attack: "error-leakage",
      route: routePath,
      detail: `Malformed payload produced ${r.status} with an internal stack trace in the response body.`,
    };
  }
  return null;
}

// Claude reads the raw attack evidence and turns it into graded findings.
function interpret(evidence: AttackEvidence[], root: string): Finding[] {
  if (evidence.length === 0 || !claudeAvailable()) {
    // No Claude (or nothing found): fall back to deterministic mapping so the
    // probe still produces findings on its own.
    return evidence.map(mapEvidence);
  }

  const prompt = [
    `You are a security engineer. Below is raw evidence from bounded attacks run`,
    `against a developer's OWN app on localhost. For each item decide severity and`,
    `whether it should BLOCK a release. Respond with ONLY a JSON array of`,
    `{"id":string,"severity":"critical"|"warn"|"info","gate":boolean,"route":string,"message":string}.`,
    `Keep messages concrete and short. Evidence:`,
    JSON.stringify(evidence, null, 2),
  ].join("\n");

  const res = spawnSync("claude", ["-p", "--output-format", "json"], {
    input: prompt,
    cwd: root,
    encoding: "utf8",
    timeout: 150_000,
    maxBuffer: 8 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (res.status !== 0 || !res.stdout) return evidence.map(mapEvidence);

  let text = res.stdout;
  try {
    const env = JSON.parse(res.stdout);
    if (typeof env.result === "string") text = env.result;
  } catch {
    /* raw */
  }
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return evidence.map(mapEvidence);
  try {
    const raw = JSON.parse(m[0]) as Array<{
      id?: string;
      severity?: string;
      gate?: boolean;
      route?: string;
      message?: string;
    }>;
    return raw
      .filter((r) => r && r.message)
      .map<Finding>((r) => ({
        id: r.id || "live-attack",
        severity: r.severity === "critical" ? "critical" : r.severity === "info" ? "info" : "warn",
        disposition: r.gate === true ? "gate" : "advise",
        file: `live:${r.route || "/"}`,
        message: String(r.message),
      }));
  } catch {
    return evidence.map(mapEvidence);
  }
}

function mapEvidence(e: AttackEvidence): Finding {
  const gate = e.attack === "rate-limit" || e.attack === "auth-bypass" || e.attack === "error-leakage";
  return {
    id: `live-${e.attack}`,
    severity: gate ? "critical" : "warn",
    disposition: gate ? "gate" : "advise",
    file: `live:${e.route}`,
    message: `[live] ${e.detail}`,
  };
}

// Orchestrates: boot the app → run bounded attacks on localhost → interpret →
// always shut the server down. Returns [] (with a console note) if the app
// won't start, so the rest of the run continues.
export async function liveProbe(repo: Repo): Promise<Finding[]> {
  const project = loadProject(repo.root);
  if (project.config.liveProbe === false) {
    console.log("  live probe disabled in .shepherd/config.json — skipping.");
    return [];
  }

  console.log("  Booting your app for the live probe …");
  const server = await startServer(repo);
  if (!server) {
    console.log(
      "  ⚠️  Couldn't start the dev server (no runnable script, or it didn't come up in 60s) — live probe skipped.",
    );
    return [];
  }
  console.log(`  Server up at ${server.baseUrl} — running bounded attacks (localhost only) …`);

  const burst = project.config.attackBurst ?? 40;
  const evidence: AttackEvidence[] = [];

  try {
    // pick the most sensitive routes to probe, capped.
    const routes = repo.files
      .filter((f) => isApiRoute(f.path))
      .map((f) => ({ url: routeUrlPath(f.path), sens: sensitivity(f.content) }))
      .sort((a, b) => b.sens - a.sens)
      .slice(0, MAX_ROUTES_PROBED);

    const headers = await securityHeaders(server.baseUrl);
    if (headers) evidence.push(headers);

    for (const r of routes) {
      const burstHit = await rateLimitBurst(server.baseUrl, r.url, burst);
      if (burstHit) evidence.push(burstHit);
      const auth = r.sens >= 1 ? await authBypass(server.baseUrl, r.url) : null;
      if (auth) evidence.push(auth);
      const leak = await errorLeakage(server.baseUrl, r.url);
      if (leak) evidence.push(leak);
    }
  } finally {
    server.stop();
    console.log("  Server stopped.");
  }

  return interpret(evidence, repo.root);
}
