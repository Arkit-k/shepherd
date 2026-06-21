import { spawnSync } from "node:child_process";
import type { Repo } from "../ingest.js";
import type { Finding } from "../report.js";
import { claudeAvailable } from "../fixers/claude.js";

interface Raw {
  category?: string;
  severity?: string;
  gate?: boolean;
  line?: number | null;
  message?: string;
}

const CATEGORIES = ["security", "performance", "architecture", "logic"];

function prompt(file: string, content: string): string {
  return [
    `You are a senior engineer doing a production-readiness review. Review the file below across`,
    `FOUR dimensions, catching issues a regex/AST scanner CANNOT:`,
    `- security: broken authorization / IDOR, injection, secrets, unsafe or unbounded input`,
    `- performance: N+1 queries, unbounded loops/input, missing caching/memoization, blocking or`,
    `  serial async that should be parallel, heavy re-renders, oversized payloads`,
    `- architecture: tight coupling, layering violations, business logic in the wrong place, SRP breaks`,
    `- logic: real bugs, unhandled edge cases, race conditions, missing error handling, wrong assumptions`,
    `Read the file. Respond with ONLY a JSON array (no prose); each element:`,
    `{"category":"security"|"performance"|"architecture"|"logic","severity":"critical"|"warn","gate":true|false,"line":number|null,"message":string}`,
    `Set gate=true only for issues that should block a merge. Return [] if the file is clean.`,
    ``,
    `File: ${file}`,
    "```",
    content,
    "```",
  ].join("\n");
}

function idFor(cat?: string): string {
  return CATEGORIES.includes(String(cat)) ? String(cat) : "deep-review";
}

// One headless review call on the user's Claude account, over one pasted file.
function review(file: string, content: string, root: string): Finding[] {
  const res = spawnSync("claude", ["-p", "--output-format", "json"], {
    input: prompt(file, content),
    cwd: root,
    encoding: "utf8",
    timeout: 150_000,
    maxBuffer: 8 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (res.status !== 0 || !res.stdout) return [];

  let text = res.stdout;
  try {
    const env = JSON.parse(res.stdout);
    if (typeof env.result === "string") text = env.result;
  } catch {
    /* raw */
  }
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let raw: Raw[];
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return [];
  }

  return raw
    .filter((r) => r && r.message)
    .map<Finding>((r) => ({
      id: idFor(r.category),
      severity: r.severity === "critical" || r.severity === "high" ? "critical" : "warn",
      disposition: r.gate === true ? "gate" : "advise",
      file,
      line: typeof r.line === "number" ? r.line : undefined,
      message: String(r.message),
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
// Each file is one call (~$0.05); `cap` bounds how many files are reviewed.
export function deepReview(repo: Repo, opts: { files?: string[]; cap?: number } = {}): Finding[] {
  if (!claudeAvailable()) {
    console.log("⚠️  --deep needs Claude Code logged in on PATH; skipping deep review.");
    return [];
  }
  const targets = opts.files ?? selectTargets(repo, opts.cap ?? 10);
  console.log(`  deep-reviewing ${targets.length} file(s) across security/performance/architecture/logic …`);

  const out: Finding[] = [];
  for (const p of targets) {
    const sf = repo.files.find((f) => f.path === p);
    if (!sf) continue;
    out.push(...review(p, sf.content.slice(0, 16000), repo.root));
  }
  return out;
}
