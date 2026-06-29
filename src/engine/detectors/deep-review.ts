import type { Repo } from "../ingest.js";
import type { Finding } from "../report.js";
import { claudeAvailable } from "../fixers/claude.js";
import { claudeAgentJsonArray } from "../claude-json.js";
import { memoryBrief } from "../memory/brief.js";

interface Raw {
  category?: string;
  severity?: string;
  gate?: boolean;
  line?: number | null;
  message?: string;
  // The agent fills these in AFTER it has actually opened the file and looked
  // around. We use them to keep only verified findings and to show the user why.
  confidence?: string; // "high" | "medium" | "low"
  evidence?: string; // what the agent checked to confirm it (and ruled out a fix)
}

const CATEGORIES = ["security", "performance", "architecture", "logic"];

// The reviewer is now an AGENT, not a one-shot judge. We no longer paste the file
// into the prompt and ask for an opinion; we point it at the file and let it
// explore the repo with read-only tools (Read/Grep/Glob) to CONFIRM each issue
// before reporting it — e.g. grep for a rate-limiter or auth guard elsewhere that
// would mean the "missing" one isn't actually missing.
function prompt(file: string, brief: string | null): string {
  return [
    `You are a senior engineer doing a production-readiness review of ONE file in this`,
    `repository. Your job is to find issues a regex/AST scanner CANNOT, across four`,
    `dimensions, and to VERIFY each one before reporting it.`,
    ``,
    `Target file: ${file}`,
    ...(brief ? ["", brief] : []),
    ``,
    `Method (use your tools — do not guess):`,
    `1. Read the target file.`,
    `2. For every candidate issue, investigate before believing it:`,
    `   - Grep the repo for a mitigation that already exists elsewhere (a middleware`,
    `     rate-limiter, an auth/ownership guard, input validation, a wrapping`,
    `     try/catch, a cache layer). If it exists, the issue is NOT real — drop it.`,
    `   - Open imported/related files when the answer depends on them.`,
    `   - Confirm the exact line number in the target file.`,
    `3. Report ONLY issues you have confirmed are real and unmitigated.`,
    ``,
    `Dimensions (judge the CRAFT, not just the obvious bugs):`,
    `- security: broken authorization / IDOR, injection, secrets, unsafe/unbounded input,`,
    `  and API-protocol correctness (missing pagination, no idempotency on retried writes,`,
    `  wrong status codes, unauthenticated mutations, missing input bounds)`,
    `- performance: N+1 queries, unbounded loops/input, missing caching, serial async`,
    `  that should be parallel, oversized payloads, and ALGORITHMIC complexity / data-structure`,
    `  choice — an O(n²) scan or a linear .find() in a hot loop where a Map/Set would be O(1),`,
    `  plus MEMORY & resource management (unbounded in-memory growth, leaks, listeners/handles/`,
    `  connections never released, missing backpressure)`,
    `- architecture: tight coupling, layering violations, logic in the wrong place, SRP breaks,`,
    `  and design-pattern MISUSE — a pattern applied where it adds cost without benefit, or a`,
    `  hand-rolled tangle where a known pattern (strategy, repository, adapter) would be cleaner`,
    `- logic: real bugs, unhandled edge cases, races, missing error handling, wrong assumptions`,
    ``,
    `Respond with ONLY a JSON array (no prose). Each element:`,
    `{"category":"security"|"performance"|"architecture"|"logic","severity":"critical"|"warn",`,
    `"gate":true|false,"line":number|null,"confidence":"high"|"medium"|"low",`,
    `"message":string,"evidence":string}`,
    `- gate=true only for issues that must block a merge.`,
    `- confidence reflects how sure you are AFTER investigating (low = couldn't confirm).`,
    `- evidence = the concrete thing you checked (e.g. "grep'd for rateLimit across`,
    `  src/ — no limiter wraps this route"). Keep it to one line.`,
    `Return [] if the file is clean or every candidate turned out to be mitigated.`,
  ].join("\n");
}

function idFor(cat?: string): string {
  return CATEGORIES.includes(String(cat)) ? String(cat) : "deep-review";
}

// One AGENTIC review pass over a single file: the model reads it, greps the repo
// to rule out existing mitigations, and returns only confirmed findings. Bounded
// by a per-file dollar cap so the loop can't run away.
function review(file: string, root: string): Finding[] {
  const brief = memoryBrief(root, file); // recall prior triage for this file
  const raw = claudeAgentJsonArray<Raw>(prompt(file, brief), root, { budgetUsd: 0.25 });
  if (!raw) return [];

  return raw
    .filter((r) => r && r.message)
    // The agent investigated; if it still couldn't confirm, don't surface noise.
    .filter((r) => r.confidence !== "low")
    .map<Finding>((r) => ({
      id: idFor(r.category),
      severity: r.severity === "critical" || r.severity === "high" ? "critical" : "warn",
      disposition: r.gate === true ? "gate" : "advise",
      file,
      line: typeof r.line === "number" ? r.line : undefined,
      // Fold the agent's verification evidence into the message so the user (and
      // the fix work-order) can see WHY this was flagged, not just what.
      message: r.evidence ? `${r.message}  [verified: ${r.evidence}]` : String(r.message),
    }));
}

// Pick what to review: all API routes (security-critical) first, then the largest
// remaining files (where perf/arch/logic problems live), capped to bound cost.
function selectTargets(repo: Repo, cap: number): string[] {
  const isApi = (p: string) => /\/api\/.*route\.(ts|js)$/.test(p) || /pages\/api\//.test(p);
  const api = repo.files.filter((f) => isApi(f.path));
  const others = repo.files
    .filter((f) => !isApi(f.path))
    .sort((a, b) => b.lines - a.lines);
  return [...api, ...others].slice(0, cap).map((f) => f.path);
}

// Tier 2 — the "aggressive" multi-dimension review, on the user's Claude account.
// Each file gets one agentic pass (~$0.05–0.25 depending on how much it explores);
// `cap` bounds how many files are reviewed. Shepherd never edits — the agent runs
// read-only and the confirmed findings flow into the fix work-order.
export function deepReview(repo: Repo, opts: { files?: string[]; cap?: number } = {}): Finding[] {
  if (!claudeAvailable()) {
    console.log("⚠️  --deep needs Claude Code logged in on PATH; skipping deep review.");
    return [];
  }
  const targets = opts.files ?? selectTargets(repo, opts.cap ?? 10);
  console.log(
    `  deep-reviewing ${targets.length} file(s) across security/performance/architecture/logic ` +
      `(agent reads + verifies each) …`,
  );

  const out: Finding[] = [];
  for (const p of targets) {
    if (!repo.files.some((f) => f.path === p)) continue;
    out.push(...review(p, repo.root));
  }
  return out;
}
