import { spawnSync } from "node:child_process";
import type { Repo, SourceFile } from "../ingest.js";
import type { Finding } from "../report.js";
import { claudeAvailable } from "../fixers/claude.js";

// The "we promise production" core. Two questions every AI-built backend fails:
// does it scale toward ~1M, and does it tolerate failure? Tier-1 heuristics
// (cheap, deterministic — the moat) plus a Claude deep pass on the hot files.

function isApiRoute(p: string): boolean {
  return /\/api\/.*route\.(ts|js)$/.test(p) || /pages\/api\//.test(p);
}

function isBackendFile(p: string): boolean {
  return (
    isApiRoute(p) ||
    /\/(server|services?|lib\/db|db|repositories?|controllers?|handlers?|workers?)\//.test(p) ||
    /\.(controller|service|resolver|router)\.(ts|js)$/.test(p)
  );
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

// ── Tier 1: deterministic scale + resilience heuristics ────────────────────

function scaleHeuristics(f: SourceFile): Finding[] {
  const out: Finding[] = [];
  const c = f.content;

  // module-level mutable store — breaks the moment you run >1 instance.
  const memStore = c.match(/^(?:export\s+)?(?:const|let)\s+\w+\s*=\s*(?:new\s+(?:Map|Set)\(|\{\}|\[\])/m);
  if (memStore && isBackendFile(f.path) && /\.(set|push|\[\w+\]\s*=)/.test(c)) {
    out.push({
      id: "in-memory-state",
      severity: "warn",
      disposition: "gate",
      file: f.path,
      line: lineOf(c, memStore.index ?? 0),
      message:
        "Module-level mutable state used as a store — won't survive horizontal scaling or serverless cold starts. Move it to a DB/cache (Redis).",
    });
  }

  // unbounded query — no limit/pagination on a list read.
  const unbounded = c.match(/\.(select|find|findMany|from)\([^)]*\)(?![\s\S]{0,120}(\.limit\(|\.take\(|take:|limit:|first:))/);
  if (unbounded && isBackendFile(f.path) && /\.(select|findMany|from)\(/.test(c)) {
    out.push({
      id: "unbounded-query",
      severity: "warn",
      disposition: "advise",
      file: f.path,
      line: lineOf(c, unbounded.index ?? 0),
      message:
        "Query with no visible limit/pagination — fine on seed data, falls over at scale. Add a limit and paginate.",
    });
  }

  // N+1 — awaiting inside a loop over rows.
  if (/for\s*\(.*\)\s*\{[\s\S]{0,200}await\s+\w+\.(find|select|query|get)\(/.test(c) && isBackendFile(f.path)) {
    out.push({
      id: "n-plus-one",
      severity: "warn",
      disposition: "advise",
      file: f.path,
      message: "Looks like a query inside a loop (N+1) — batch it or use a join/`in` query.",
    });
  }

  return out;
}

function resilienceHeuristics(f: SourceFile): Finding[] {
  const out: Finding[] = [];
  const c = f.content;
  if (!isApiRoute(f.path)) return out;

  // handler with no error handling at all.
  if (!/try\s*\{/.test(c) && /export\s+(async\s+)?function|export\s+const\s+\w+\s*=/.test(c)) {
    out.push({
      id: "no-error-handling",
      severity: "warn",
      disposition: "advise",
      file: f.path,
      message: "API handler has no try/catch — an unhandled throw becomes a 500 and can crash the request path.",
    });
  }

  // external fetch with no timeout — a hung upstream ties up your server.
  if (/\bfetch\(/.test(c) && !/AbortSignal|signal\s*:|timeout/i.test(c)) {
    const m = c.match(/\bfetch\(/);
    out.push({
      id: "fetch-no-timeout",
      severity: "warn",
      disposition: "advise",
      file: f.path,
      line: m ? lineOf(c, m.index ?? 0) : undefined,
      message: "Outbound fetch with no timeout/abort — a slow upstream will pile up requests. Add AbortSignal.timeout().",
    });
  }

  // POST/PUT reading a body with no schema validation.
  if (/\.(json|formData)\(\)/.test(c) && !/zod|\.parse\(|\.safeParse\(|yup|joi|valibot/.test(c)) {
    const m = c.match(/\.(json|formData)\(\)/);
    out.push({
      id: "no-input-validation",
      severity: "warn",
      disposition: "advise",
      file: f.path,
      line: m ? lineOf(c, m.index ?? 0) : undefined,
      message: "Request body is read without schema validation — validate with zod before trusting it.",
    });
  }

  return out;
}

// ── Tier 2: Claude deep pass on the hottest backend files ──────────────────

function deepScaleReview(repo: Repo): Finding[] {
  if (!claudeAvailable()) return [];
  const targets = repo.files
    .filter((f) => isBackendFile(f.path))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 4);
  if (targets.length === 0) return [];

  const out: Finding[] = [];
  for (const f of targets) {
    const prompt = [
      `You are a staff engineer reviewing a backend file for PRODUCTION READINESS at`,
      `~1,000,000 users. Find concrete scalability bottlenecks and resilience gaps:`,
      `N+1 queries, missing pagination/indexes, no connection pooling, blocking work in`,
      `the request path, no caching, missing timeouts/retries/idempotency, unhandled`,
      `failure modes. For each, give a specific fix. Respond with ONLY a JSON array of`,
      `{"id":string,"severity":"critical"|"warn","gate":boolean,"line":number|null,"message":string}.`,
      `Return [] if it's already production-grade.`,
      ``,
      `File: ${f.path}`,
      "```",
      f.content.slice(0, 14000),
      "```",
    ].join("\n");

    const res = spawnSync("claude", ["-p", "--output-format", "json"], {
      input: prompt,
      cwd: repo.root,
      encoding: "utf8",
      timeout: 150_000,
      maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    if (res.status !== 0 || !res.stdout) continue;

    let text = res.stdout;
    try {
      const env = JSON.parse(res.stdout);
      if (typeof env.result === "string") text = env.result;
    } catch {
      /* raw */
    }
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) continue;
    try {
      const raw = JSON.parse(m[0]) as Array<{
        id?: string;
        severity?: string;
        gate?: boolean;
        line?: number | null;
        message?: string;
      }>;
      for (const r of raw) {
        if (!r || !r.message) continue;
        out.push({
          id: r.id ? `scale-${r.id}`.slice(0, 28) : "scale-bottleneck",
          severity: r.severity === "critical" ? "critical" : "warn",
          disposition: r.gate === true ? "gate" : "advise",
          file: f.path,
          line: typeof r.line === "number" ? r.line : undefined,
          message: String(r.message),
        });
      }
    } catch {
      /* skip file */
    }
  }
  return out;
}

// Tier 1 always; Tier 2 (Claude) when `deep`.
export function scaleAndResilience(repo: Repo, opts: { deep?: boolean } = {}): Finding[] {
  const out: Finding[] = [];
  for (const f of repo.files) {
    out.push(...scaleHeuristics(f));
    out.push(...resilienceHeuristics(f));
  }
  if (opts.deep) out.push(...deepScaleReview(repo));
  return out;
}
