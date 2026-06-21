import type { Repo } from "./ingest.js";
import type { Finding } from "./report.js";
import { claudeAvailable } from "./fixers/claude.js";
import { claudeJsonArray } from "./claude-json.js";

// Design-pattern review. A principal engineer names the pattern AND its
// trade-offs — patterns aren't free, and AI-generated code often reaches for a
// Singleton or Factory where a plain function would do (over-engineering), or
// skips one where it would untangle a mess. Tier-1 spots the patterns in use and
// states the trade-off; the Claude pass judges whether each usage actually fits.
// Advisory — a pattern is a design choice, not a bug.

interface PatternDef {
  id: string;
  name: string;
  tradeoff: string;
  match: RegExp;
}

const PATTERNS: PatternDef[] = [
  {
    id: "singleton",
    name: "Singleton",
    match: /getInstance\s*\(|private\s+constructor|private\s+static\s+\w*[iI]nstance/,
    tradeoff:
      "Singleton gives one shared instance, but it's global mutable state — hard to unit test (you can't swap it), it hides dependencies, and a *stateful* singleton breaks across multiple server instances at scale. Keep it only for stateless shared resources (a logger, a DB pool); otherwise inject the dependency.",
  },
  {
    id: "factory",
    name: "Factory",
    match: /class\s+\w*Factory\b|export\s+(async\s+)?function\s+create[A-Z]\w*/,
    tradeoff:
      "Factory decouples callers from concrete classes — good when you have families of types or real construction logic. Cost: an extra layer of indirection; don't add a factory for a single concrete type (YAGNI). If it's just `new X()`, skip it.",
  },
  {
    id: "builder",
    name: "Builder",
    match: /class\s+\w*Builder\b|\.\w+\([^)]*\)\s*\.\w+\([^)]*\)\s*\.build\(\)/,
    tradeoff:
      "Builder shines for objects with many optional params (avoids telescoping constructors) and for immutability. Cost: verbosity — for 2–3 params a plain options object is simpler and more idiomatic in TS/JS.",
  },
  {
    id: "proxy",
    name: "Proxy",
    match: /new\s+Proxy\s*\(/,
    tradeoff:
      "Proxy transparently adds a control layer — lazy init, access control, caching, logging. Cost: indirection that hides behavior and performance (a trap runs on every access), and debugging *through* a Proxy is harder. Reserve it for cross-cutting concerns, not core logic.",
  },
  {
    id: "prototype",
    name: "Prototype / clone",
    match: /Object\.create\s*\(|\.clone\s*\(\)/,
    tradeoff:
      "Prototype/clone copies an existing object instead of re-constructing it. Cost: shallow-vs-deep-copy bugs are easy to introduce. In modern JS, `structuredClone()` or an explicit factory is usually clearer than a hand-rolled clone.",
  },
  {
    id: "observer",
    name: "Observer / pub-sub",
    match: /extends\s+EventEmitter|new\s+EventEmitter|\.on\(['"][\w.:]+['"]|\.subscribe\(/,
    tradeoff:
      "Observer decouples publishers from subscribers. Cost: control flow becomes implicit (hard to trace who reacts to what), un-removed listeners leak memory, and an in-process emitter doesn't survive restarts or scale across instances — use a real broker for cross-process events.",
  },
  {
    id: "decorator",
    name: "Decorator",
    match: /^\s*@[A-Z]\w*\(/m,
    tradeoff:
      "Decorators add behavior declaratively (DI, validation, routing). Cost: they hide control flow and depend on metadata/reflect-metadata and build config; overusing them makes the real logic hard to follow. Keep them for framework wiring, not business rules.",
  },
];

function tier1(repo: Repo): Finding[] {
  const hits = new Map<string, string[]>(); // pattern id -> example files
  for (const f of repo.files) {
    if (!/\.(ts|tsx|js|jsx)$/.test(f.path)) continue;
    for (const p of PATTERNS) {
      if (p.match.test(f.content)) {
        const arr = hits.get(p.id) ?? [];
        if (arr.length < 4) arr.push(f.path);
        hits.set(p.id, arr);
      }
    }
  }

  const out: Finding[] = [];
  for (const p of PATTERNS) {
    const files = hits.get(p.id);
    if (!files || files.length === 0) continue;
    out.push({
      id: `design-${p.id}`,
      severity: "info",
      disposition: "advise",
      file: files[0],
      message: `${p.name} pattern in use (${files.length}+ place${files.length > 1 ? "s" : ""}). Trade-off — ${p.tradeoff}`,
    });
  }
  return out;
}

export interface DesignContext {
  stack?: string; // e.g. "TypeScript, Next.js"
  patterns?: string; // architecture pattern(s), e.g. "event-driven, task-queue"
  scale?: string; // e.g. "~1,000,000 users"
}

// Claude judges whether the patterns actually FIT here (or are over-/under-used)
// and gives the trade-off AS PER THIS PROJECT — the same pattern is fine in a CLI
// and a problem in a 1M-scale API. Low context: the few most class-heavy files.
function deepReview(repo: Repo, ctx: DesignContext): Finding[] {
  if (!claudeAvailable()) return [];
  const targets = repo.files
    .filter((f) => /\.(ts|tsx)$/.test(f.path) && /\bclass\s+\w+/.test(f.content))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 3);
  if (targets.length === 0) return [];

  const contextLine =
    `This project: ${ctx.stack || "a JS/TS app"}` +
    (ctx.patterns ? `, architecture: ${ctx.patterns}` : "") +
    (ctx.scale ? `, scale target: ${ctx.scale}` : "") +
    ".";

  const out: Finding[] = [];
  for (const f of targets) {
    const prompt = [
      `You are a principal engineer reviewing DESIGN PATTERNS (GoF) in this file.`,
      contextLine,
      `Identify any patterns used (Singleton, Factory, Builder, Proxy, Facade, Prototype,`,
      `Observer, Strategy, Adapter, Decorator...). For each, judge whether it FITS *for this`,
      `project's needs and scale* or is over-engineering / misused, and state the concrete`,
      `trade-off in that context + a simpler or better alternative if warranted. Also flag a`,
      `spot where a pattern WOULD untangle the code. Be concise and specific. Respond with`,
      `ONLY a JSON array of {"id":string,"line":number|null,"message":string}. [] if clean.`,
      ``,
      `File: ${f.path}`,
      "```",
      f.content.slice(0, 12000),
      "```",
    ].join("\n");

    const raw = claudeJsonArray<{ id?: string; line?: number | null; message?: string }>(prompt, repo.root);
    if (!raw) continue;
    for (const r of raw) {
      if (!r || !r.message) continue;
      out.push({
        id: r.id ? `design-${r.id}`.slice(0, 28) : "design-review",
        severity: "info",
        disposition: "advise",
        file: f.path,
        line: typeof r.line === "number" ? r.line : undefined,
        message: String(r.message),
      });
    }
  }
  return out;
}

export function designPatterns(
  repo: Repo,
  opts: { deep?: boolean; context?: DesignContext } = {},
): Finding[] {
  const out = tier1(repo);
  if (opts.deep) out.push(...deepReview(repo, opts.context ?? {}));
  return out;
}
