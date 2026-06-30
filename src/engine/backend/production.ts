import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Repo } from "../ingest.js";
import type { Finding } from "../report.js";
import { claudeAvailable } from "../fixers/claude.js";
import { claudeJsonArray } from "../claude-json.js";

// Beyond "monolith vs microservices" — what architectural PATTERN is actually
// followed, and (thinking like a principal production engineer) does it have the
// production tooling that pattern REQUIRES at scale? AI tools scaffold the shape
// of an event-driven / queue-backed system but leave out the real broker, the
// worker, the cache, the pool — the parts that matter at 1M.

export interface InfraInventory {
  broker?: string; // Kafka / RabbitMQ / NATS / SQS
  taskQueue?: string; // BullMQ / Celery / Sidekiq / Bull
  cache?: string; // Redis / Memcached
  database?: string; // Postgres / MySQL / Mongo
  pooling: boolean; // PgBouncer / explicit pool config
  hasCompose: boolean; // docker-compose present
  hasDockerfile: boolean;
}

export interface PatternResult {
  patterns: string[]; // e.g. ["event-driven", "hexagonal", "spec-driven"]
  infra: InfraInventory;
  findings: Finding[];
}

const DEP_SIGNALS: Record<string, { kind: keyof InfraInventory; label: string }> = {
  kafkajs: { kind: "broker", label: "Kafka" },
  "node-rdkafka": { kind: "broker", label: "Kafka" },
  amqplib: { kind: "broker", label: "RabbitMQ" },
  "amqp-connection-manager": { kind: "broker", label: "RabbitMQ" },
  nats: { kind: "broker", label: "NATS" },
  "@aws-sdk/client-sqs": { kind: "broker", label: "SQS" },
  bullmq: { kind: "taskQueue", label: "BullMQ" },
  bull: { kind: "taskQueue", label: "Bull" },
  agenda: { kind: "taskQueue", label: "Agenda" },
  "@nestjs/bull": { kind: "taskQueue", label: "BullMQ (Nest)" },
  celery: { kind: "taskQueue", label: "Celery" },
  ioredis: { kind: "cache", label: "Redis" },
  redis: { kind: "cache", label: "Redis" },
  memcached: { kind: "cache", label: "Memcached" },
  pg: { kind: "database", label: "PostgreSQL" },
  postgres: { kind: "database", label: "PostgreSQL" },
  mysql2: { kind: "database", label: "MySQL" },
  mongoose: { kind: "database", label: "MongoDB" },
};

function allDeps(root: string): Record<string, string> {
  const pkgPaths = fg.sync("**/package.json", { cwd: root, ignore: ["**/node_modules/**"], absolute: true });
  let deps: Record<string, string> = {};
  for (const pp of pkgPaths) {
    try {
      const pkg = JSON.parse(readFileSync(pp, "utf8"));
      deps = { ...deps, ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    } catch {
      /* skip */
    }
  }
  return deps;
}

function dirExists(root: string, names: string[]): boolean {
  return fg.sync(names.map((n) => `**/${n}/`), { cwd: root, ignore: ["**/node_modules/**"], onlyDirectories: true }).length > 0;
}

function fileExists(root: string, globs: string[]): boolean {
  return fg.sync(globs, { cwd: root, ignore: ["**/node_modules/**"] }).length > 0;
}

function detectPatterns(repo: Repo, deps: Record<string, string>): string[] {
  const patterns = new Set<string>();
  const code = repo.files.map((f) => f.content).join("\n").slice(0, 500_000);

  // event-driven
  if (
    ["kafkajs", "amqplib", "nats", "@aws-sdk/client-sqs", "@nestjs/microservices"].some((d) => d in deps) ||
    /\.(emit|publish)\(|EventEmitter|on\(['"]\w+['"]|subscribe\(/.test(code) ||
    dirExists(repo.root, ["events", "subscribers", "consumers", "producers"]) ||
    fileExists(repo.root, ["**/*.event.{ts,js}", "**/*.handler.{ts,js}"])
  ) {
    patterns.add("event-driven");
  }
  // background task queue
  if (["bullmq", "bull", "agenda", "@nestjs/bull"].some((d) => d in deps) || dirExists(repo.root, ["workers", "jobs", "tasks"])) {
    patterns.add("task-queue / async-jobs");
  }
  // CQRS
  if ("@nestjs/cqrs" in deps || (dirExists(repo.root, ["commands", "queries"]) && /CommandBus|QueryBus|CommandHandler/.test(code))) {
    patterns.add("CQRS");
  }
  // event sourcing
  if (/eventstore|EventStore|aggregateRoot|applyEvent|replay/.test(code)) patterns.add("event-sourcing");
  // hexagonal / clean
  if (dirExists(repo.root, ["domain", "usecases", "use-cases", "ports", "adapters", "application", "infrastructure"])) {
    patterns.add("hexagonal / clean");
  }
  // spec-driven
  if (fileExists(repo.root, ["**/openapi.{yaml,yml,json}", "**/asyncapi.{yaml,yml}", "**/*.proto", "**/swagger.{yaml,json}"]) || "@asyncapi/parser" in deps) {
    patterns.add("spec-driven");
  }
  // layered / MVC
  if (dirExists(repo.root, ["controllers", "models", "services", "repositories"])) patterns.add("layered / MVC");

  if (patterns.size === 0) patterns.add("ad-hoc (no clear pattern)");
  return [...patterns];
}

function takeInventory(repo: Repo, deps: Record<string, string>): InfraInventory {
  const inv: InfraInventory = { pooling: false, hasCompose: false, hasDockerfile: false };
  for (const [dep, sig] of Object.entries(DEP_SIGNALS)) {
    if (dep in deps && !inv[sig.kind]) {
      (inv[sig.kind] as unknown as string) = sig.label;
    }
  }
  const code = repo.files.map((f) => f.content).join("\n").slice(0, 500_000);
  inv.pooling = /new Pool\(|pgBouncer|pgbouncer|poolSize|connectionLimit|max:\s*\d+.*pool/i.test(code) || "pg-pool" in deps;
  inv.hasCompose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml"].some((n) => existsSync(path.join(repo.root, n)));
  inv.hasDockerfile = fileExists(repo.root, ["**/Dockerfile"]);
  return inv;
}

// The principal-production-engineer pass. Seeds Claude with the detected
// pattern + what infra is actually present, and asks: for THIS architecture at
// ~1M scale, what production tooling is required, missing, or misconfigured?
function productionReadiness(repo: Repo, patterns: string[], inv: InfraInventory): Finding[] {
  if (!claudeAvailable()) return [];

  const prompt = [
    `You are a principal production engineer reviewing a system that must scale toward`,
    `~1,000,000 requests/day with high availability. Detected architecture pattern(s):`,
    `${patterns.join(", ")}.`,
    ``,
    `Infrastructure actually present (from dependencies + code):`,
    `- message broker: ${inv.broker ?? "NONE"}`,
    `- task/job queue: ${inv.taskQueue ?? "NONE"}`,
    `- cache: ${inv.cache ?? "NONE"}`,
    `- database: ${inv.database ?? "NONE"}`,
    `- connection pooling: ${inv.pooling ? "yes" : "NONE"}`,
    `- docker-compose: ${inv.hasCompose ? "yes" : "no"}, Dockerfile: ${inv.hasDockerfile ? "yes" : "no"}`,
    ``,
    `Think about what THIS pattern REQUIRES in production that is missing or wrong:`,
    `- event-driven with only an in-process EventEmitter and no real broker (events lost on restart, no horizontal scale)`,
    `- background/long work done inline in the request path with no worker/queue`,
    `- read-heavy at scale with no cache layer`,
    `- a database with no connection pooling (connection exhaustion under load)`,
    `- no idempotency/retries/dead-letter on async work`,
    `- no health checks / graceful shutdown / backpressure`,
    `Be specific and production-grade. For each gap give the concrete tool + how to wire it.`,
    `Respond with ONLY a JSON array of`,
    `{"id":string,"severity":"critical"|"warn","gate":boolean,"file":string|null,"message":string}.`,
    `Return [] only if the production tooling genuinely matches the architecture.`,
  ].join("\n");

  const raw = claudeJsonArray<{ id?: string; severity?: string; gate?: boolean; file?: string | null; message?: string }>(
    prompt,
    repo.root,
  );
  if (!raw) return [];

  return raw
    .filter((r) => r && r.message)
    .map<Finding>((r) => ({
      id: r.id ? `prod-${r.id}`.slice(0, 28) : "production-gap",
      severity: r.severity === "critical" ? "critical" : "warn",
      disposition: r.gate === true ? "gate" : "advise",
      file: r.file || "(architecture)",
      message: String(r.message),
    }));
}

// The cheap, DETERMINISTIC classification only (no Claude) — the detected
// pattern(s) + the infra actually present. Used by the forward-looking spec.
export function classifyProduction(repo: Repo): { patterns: string[]; infra: InfraInventory } {
  const deps = allDeps(repo.root);
  return { patterns: detectPatterns(repo, deps), infra: takeInventory(repo, deps) };
}

export function analyzeProduction(repo: Repo): PatternResult {
  const { patterns, infra } = classifyProduction(repo);
  const findings = productionReadiness(repo, patterns, infra);
  return { patterns, infra, findings };
}
