import { readFileSync } from "node:fs";
import path from "node:path";
import type { Repo } from "./ingest.js";
import type { Finding } from "./report.js";
import { classifyShape } from "./backend/architecture.js";
import { claudeAvailable } from "./fixers/claude.js";
import { claudeAgentJsonArray } from "./claude-json.js";

// RIGHT-SIZING — "knowing when to STOP optimizing." The counterweight to the scale
// architect. AI writes the staff-level version on day 0: caching, batching,
// configurable strategies, a connection pool for 50 records a day. Most of it
// solves a problem the codebase doesn't have yet — interfaces with one
// implementation, generic configs for cases that never change, premature infra.
//
// This is the voice of YAGNI: it flags over-engineering at BOTH altitudes —
// high-level (premature infra, microservices, deep layering for a tiny app) and
// low-level (single-implementation interfaces, speculative pluggability). Every
// finding is ADVISORY — over-engineering is complexity-debt, not a ship blocker;
// the call ("do I need this yet?") is the engineer's. Mostly deterministic (the
// moat); an optional Claude pass adds judgment. The scale architect prescribes for
// the workload you're HEADING toward; this asks about the workload you have TODAY.

// Heavy infrastructure deps — operating these has a real cost; in a tiny app
// they're usually a problem you don't have yet.
const HEAVY_INFRA: Record<string, string> = {
  kafkajs: "Kafka",
  "node-rdkafka": "Kafka",
  amqplib: "RabbitMQ",
  "amqp-connection-manager": "RabbitMQ",
  nats: "NATS",
  bullmq: "BullMQ (Redis queue)",
  bull: "Bull (Redis queue)",
  ioredis: "Redis",
  "@elastic/elasticsearch": "Elasticsearch",
  "@opensearch-project/opensearch": "OpenSearch",
  "cassandra-driver": "Cassandra",
  "@temporalio/client": "Temporal",
  "@temporalio/worker": "Temporal",
};

const LAYER_DIRS = ["models", "controllers", "services", "repositories", "entities", "dtos", "mappers", "adapters", "ports", "usecases", "use-cases", "interfaces"];

function rootDeps(root: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    return { ...(raw.dependencies ?? {}), ...(raw.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line++;
  return line;
}

// ── low-level: an interface implemented by exactly ONE class is a seam with a
// single concrete type — the textbook premature abstraction. (Zero implementers =
// it's just a data/type shape, which is fine; we only flag implementCount === 1.)
function singleImplInterfaces(repo: Repo): Finding[] {
  const declared = new Map<string, { file: string; line: number }>();
  for (const f of repo.files) {
    for (const m of f.content.matchAll(/(?:^|\n)\s*(?:export\s+)?interface\s+([A-Z]\w+)/g)) {
      if (!declared.has(m[1])) declared.set(m[1], { file: f.path, line: lineOf(f.content, m.index ?? 0) });
    }
  }
  if (declared.size === 0) return [];

  const implCount = new Map<string, number>();
  for (const f of repo.files) {
    for (const m of f.content.matchAll(/\bimplements\s+([A-Za-z0-9_,\s<>]+?)\s*\{/g)) {
      for (const raw of m[1].split(",")) {
        const base = raw.trim().replace(/<[^>]*>/g, "").trim();
        if (base) implCount.set(base, (implCount.get(base) ?? 0) + 1);
      }
    }
  }

  const out: Finding[] = [];
  for (const [name, loc] of declared) {
    if (implCount.get(name) === 1) {
      out.push({
        id: "overeng-single-impl-interface",
        severity: "info",
        disposition: "advise",
        file: loc.file,
        line: loc.line,
        message:
          `Interface \`${name}\` has exactly one implementation — an abstraction for a seam you don't have yet. ` +
          `Until a second implementation actually exists (a real second provider, a test double you can't otherwise make), ` +
          `inline the concrete type and delete the interface. One-implementation interfaces add indirection and a file to keep in sync for no current benefit.`,
      });
    }
  }
  // cap the noise — list the pattern, not 40 copies of it.
  return out.slice(0, 8);
}

// ── high-level: heavy infra wired into a small codebase is usually premature.
function prematureInfra(repo: Repo, small: boolean): Finding[] {
  if (!small) return [];
  const deps = rootDeps(repo.root);
  const present = Object.keys(HEAVY_INFRA).filter((d) => d in deps).map((d) => HEAVY_INFRA[d]);
  const uniq = [...new Set(present)];
  if (uniq.length === 0) return [];
  return [
    {
      id: "overeng-premature-infra",
      severity: "warn",
      disposition: "advise",
      file: "package.json",
      message:
        `Heavy infrastructure (${uniq.join(", ")}) in a small codebase (${repo.files.length} source files). ` +
        `Each of these is a service to run, monitor, secure, and pay for. If today's volume is modest, this is infrastructure for a problem you don't have yet — ` +
        `a function handling 50 records a day doesn't need a queue, a broker, or a search cluster. Keep it ONLY if you have the load to justify operating it; otherwise a plain table/array/cron is simpler and more readable. ` +
        `(If you're deliberately building for 1M from day one, that's a valid choice — just make it a choice.)`,
    },
  ];
}

// ── high-level: microservices for a tiny domain.
function prematureMicroservices(repo: Repo, small: boolean): Finding[] {
  if (!small) return [];
  const { shape } = classifyShape(repo);
  if (shape !== "microservices") return [];
  return [
    {
      id: "overeng-premature-microservices",
      severity: "warn",
      disposition: "advise",
      file: "(architecture)",
      message:
        `Split into microservices on a small codebase (${repo.files.length} files). Microservices buy independent scaling and deploys at the cost of network calls, distributed transactions, and ops overhead — ` +
        `a tax that only pays off past a certain team/scale. A modular monolith gives you most of the boundary benefits with none of the distributed-systems pain. Stay a monolith until a module's load or team ownership truly forces extraction.`,
    },
  ];
}

// ── high-level: deep layer-cake on a tiny app.
function overLayered(repo: Repo, small: boolean): Finding[] {
  if (!small) return [];
  const present = new Set<string>();
  for (const f of repo.files) {
    for (const seg of f.path.replace(/\\/g, "/").split("/").slice(0, -1)) {
      const s = seg.toLowerCase();
      if (LAYER_DIRS.includes(s)) present.add(s);
    }
  }
  if (present.size < 4) return [];
  return [
    {
      id: "overeng-deep-layering",
      severity: "info",
      disposition: "advise",
      file: "(structure)",
      message:
        `${present.size} architectural layers (${[...present].slice(0, 6).join(", ")}) for ${repo.files.length} files. ` +
        `Each layer is a hop and a mapping to maintain. On a small app this ceremony costs more than it saves — collapse controller→service→repository→mapper into the few that earn their keep, and add layers back only when a real seam appears.`,
    },
  ];
}

// ── the optional judgment pass — the actual "knowing when to stop." Embodies the
// pragmatic-engineer voice: flag what solves a problem this code doesn't have yet.
function judgmentPass(repo: Repo): Finding[] {
  if (!claudeAvailable()) return [];
  const prompt = [
    `You are a pragmatic staff engineer with strong YAGNI instincts. Review this repository for OVER-ENGINEERING —`,
    `abstractions and optimizations that solve a problem the codebase DOESN'T HAVE YET. AI tools write the`,
    `"staff-level" version on day 0; most of it is premature. Read the real code first (use your tools).`,
    ``,
    `Flag, with the concrete SIMPLER alternative for each:`,
    `- generic configs / "pluggable" strategies / registries with a single option that will never change`,
    `- premature caching, batching, async, or memoization where the volume is plainly tiny`,
    `- needless indirection: a wrapper that only delegates, a factory for one concrete type, a generic <T> used at one type`,
    `- speculative extensibility ("we might need to swap this later") with no second case in sight`,
    `- clever/obscure optimizations that hurt readability for no measured gain`,
    ``,
    `Do NOT flag things that are genuinely load-bearing or clearly needed. Favour "make it work and be readable."`,
    `The skill is knowing when to STOP. Respond with ONLY a JSON array of`,
    `{"id":string,"severity":"warn"|"info","file":string,"line":number|null,"message":string}. [] if the code is already right-sized.`,
  ].join("\n");

  const raw = claudeAgentJsonArray<{ id?: string; severity?: string; file?: string; line?: number | null; message?: string }>(
    prompt,
    repo.root,
    { budgetUsd: 0.4 },
  );
  if (!raw) return [];
  return raw
    .filter((r) => r && r.message)
    .slice(0, 12)
    .map<Finding>((r) => ({
      id: r.id ? `overeng-${String(r.id).replace(/^overeng-/, "")}`.slice(0, 28) : "overeng-judgment",
      severity: r.severity === "warn" ? "warn" : "info",
      disposition: "advise",
      file: r.file || "(code)",
      line: typeof r.line === "number" ? r.line : undefined,
      message: String(r.message),
    }));
}

export function rightSizing(repo: Repo, opts: { deep?: boolean } = {}): Finding[] {
  // "small" is our proxy for "you probably don't have the scale problem yet."
  const totalLines = repo.files.reduce((s, f) => s + f.lines, 0);
  const small = repo.files.length <= 25 || totalLines <= 2500;

  const findings: Finding[] = [
    ...singleImplInterfaces(repo),
    ...prematureInfra(repo, small),
    ...prematureMicroservices(repo, small),
    ...overLayered(repo, small),
  ];
  if (opts.deep) findings.push(...judgmentPass(repo));
  return findings;
}
