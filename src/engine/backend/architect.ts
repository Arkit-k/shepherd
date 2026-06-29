import type { Repo } from "../ingest.js";
import type { Finding } from "../report.js";
import { claudeAvailable } from "../fixers/claude.js";
import { claudeAgentJsonArray } from "../claude-json.js";
import { detectStack } from "../tech-stack.js";

// THE SCALE ARCHITECT — Shepherd's "turn a broken project into 1,000,000 users"
// pass. The file-level detectors (backend/scale.ts) catch local bottlenecks; this
// is the WHOLE-PROJECT one: a principal architect who surveys the system, works
// out which infrastructure the workload actually needs — a cache (Redis), a task
// queue (BullMQ/RabbitMQ), an event stream (Kafka/Redpanda), full-text search, a
// CDN, object storage, read replicas, rate limiting, observability — and which
// current open-source tools to reach for, grounded in LIVE web research so the
// recommendation is today's best practice, not a 2021 memory.
//
// It is agentic (reads the repo to find the evidence) and web-enabled (looks up
// current tools/versions), and it NEVER edits — it prescribes. The output is a
// roadmap the user hands to their own Claude Code session.

export type InfraComponent =
  | "cache"
  | "task-queue"
  | "event-stream"
  | "search"
  | "cdn"
  | "object-storage"
  | "read-replica"
  | "rate-limiter"
  | "connection-pool"
  | "realtime"
  | "observability"
  | "feature-flags"
  | "other";

export type Priority = "now" | "soon" | "later";

export interface InfraPrescription {
  component: InfraComponent;
  // The workload evidence IN THIS REPO that creates the need — not generic advice.
  need: string;
  // The tool Shepherd recommends, plus runners-up so the user can choose.
  recommendation: string;
  alternatives?: string[];
  // Where current best practice was confirmed (a real URL from the web pass).
  source?: string;
  // The file/route/subsystem this plugs into.
  where?: string;
  priority: Priority;
  // Rough effort to wire it in: "hours" | "days" | "weeks".
  effort?: string;
}

interface Raw extends Partial<InfraPrescription> {}

const VALID: ReadonlySet<string> = new Set<InfraComponent>([
  "cache",
  "task-queue",
  "event-stream",
  "search",
  "cdn",
  "object-storage",
  "read-replica",
  "rate-limiter",
  "connection-pool",
  "realtime",
  "observability",
  "feature-flags",
  "other",
]);

const PRIORITY_SEVERITY: Record<Priority, Finding["severity"]> = {
  now: "critical",
  soon: "warn",
  later: "info",
};

// A compact snapshot of what infra is ALREADY wired, so the architect doesn't
// prescribe a cache when ioredis is already a dependency. The agent verifies by
// reading the repo, but this focuses it and keeps the obvious cases honest.
function infraFingerprint(repo: Repo): string {
  const tech = detectStack(repo);
  const present = new Set<string>();
  const probe: Array<[RegExp, string]> = [
    [/\b(ioredis|["']redis["']|createClient\()/, "Redis client"],
    [/\bbullmq|bull\b|new Queue\(/, "BullMQ/Bull queue"],
    [/\bamqplib|rabbit/i, "RabbitMQ"],
    [/\bkafkajs|@confluentinc\/kafka|redpanda/i, "Kafka/Redpanda"],
    [/\b@elastic\/elasticsearch|meilisearch|typesense|opensearch/i, "search engine"],
    [/\bsocket\.io|\bws\b|websocket|pusher|ably/i, "realtime/websocket"],
    [/\b@aws-sdk\/client-s3|@google-cloud\/storage|minio/i, "object storage"],
    [/\b@opentelemetry|sentry|datadog|prom-client|pino|winston/i, "observability"],
    [/\brate-?limit|@upstash\/ratelimit/i, "rate limiter"],
    [/\bcloudfront|cloudflare|fastly|@vercel\/edge/i, "CDN/edge"],
  ];
  for (const f of repo.files) {
    for (const [re, label] of probe) if (re.test(f.content)) present.add(label);
  }
  return [
    `Detected stack: ${tech.language}; frameworks: ${tech.frameworks.join(", ") || "—"}; ` +
      `databases: ${tech.databases.join(", ") || "—"}.`,
    `Infra already wired (do NOT re-prescribe these): ${present.size ? [...present].join(", ") : "none detected"}.`,
    `Backend files: ${repo.files.filter((f) => /\/(api|server|services?|workers?|lib)\//.test(f.path)).length}.`,
  ].join("\n");
}

function prompt(repo: Repo): string {
  return [
    `You are a PRINCIPAL INFRASTRUCTURE ARCHITECT. This repo is an app that "works on a`,
    `laptop" but must survive growth to ~1,000,000 users / high traffic. Your job: decide`,
    `which INFRASTRUCTURE the workload actually needs, and which current open-source tools`,
    `to use — so a broken/naive project becomes one that scales.`,
    ``,
    infraFingerprint(repo),
    ``,
    `Method (use your tools — evidence first, do not guess):`,
    `1. Survey the repo: read package.json, the API routes/handlers, data-access code,`,
    `   any background work, websockets, file uploads, external API calls, heavy compute.`,
    `2. For each scaling pressure you find evidence of, decide the infrastructure answer:`,
    `   - repeated/expensive reads, sessions, hot counters → a CACHE (e.g. Redis/Valkey/Dragonfly)`,
    `   - slow/async work done inline in the request (email, image, AI, webhooks) → a TASK QUEUE`,
    `     (e.g. BullMQ on Redis, or RabbitMQ) so the request returns fast`,
    `   - many services needing the same events / audit log / fan-out → an EVENT STREAM`,
    `     (e.g. Kafka, or Redpanda/NATS as lighter options)`,
    `   - LIKE/ILIKE text search over a growing table → a SEARCH engine (Meilisearch/Typesense/OpenSearch)`,
    `   - large static/media payloads → CDN + OBJECT STORAGE (S3/R2/MinIO)`,
    `   - read-heavy DB, no pooling → READ REPLICAS + a CONNECTION POOL (PgBouncer)`,
    `   - public expensive endpoints → a distributed RATE LIMITER`,
    `   - polling for realtime → websockets/SSE (or a managed realtime layer)`,
    `   - no metrics/traces/logs → OBSERVABILITY (OpenTelemetry + a backend)`,
    `3. RESEARCH THE WEB for each recommendation: confirm the tool is current, actively`,
    `   maintained, and a sane 2026 choice — prefer modern open-source. Capture a source URL.`,
    `4. Recommend ONLY what the evidence justifies. Do not prescribe Kafka for a CRUD app.`,
    `   If something is already wired (see fingerprint), don't re-prescribe it.`,
    ``,
    `Respond with ONLY a JSON array (no prose). Each element:`,
    `{"component":"cache"|"task-queue"|"event-stream"|"search"|"cdn"|"object-storage"|`,
    `"read-replica"|"rate-limiter"|"connection-pool"|"realtime"|"observability"|"feature-flags"|"other",`,
    `"need":"the concrete evidence in THIS repo that creates the need",`,
    `"recommendation":"the specific tool you'd use",`,
    `"alternatives":["one or two runners-up"],`,
    `"source":"a real URL you consulted","where":"file/route/subsystem it plugs into",`,
    `"priority":"now"|"soon"|"later","effort":"hours"|"days"|"weeks"}`,
    `- priority=now means it will fall over before 1M without this.`,
    `Return [] only if the app genuinely needs no new infrastructure to reach the target.`,
  ].join("\n");
}

function toFinding(p: InfraPrescription): Finding {
  const alt = p.alternatives?.length ? ` Alternatives: ${p.alternatives.join(", ")}.` : "";
  const src = p.source ? ` [src: ${p.source}]` : "";
  const eff = p.effort ? ` (~${p.effort})` : "";
  return {
    id: `infra-${p.component}`,
    severity: PRIORITY_SEVERITY[p.priority] ?? "info",
    // Infrastructure is advice, never a merge gate — you don't block a PR on "add Kafka".
    disposition: "advise",
    file: p.where || "(architecture)",
    message:
      `${p.recommendation} — ${p.need}${eff}.${alt}${src}`.trim(),
  };
}

export interface ArchitectResult {
  prescriptions: InfraPrescription[];
  findings: Finding[];
}

// Run the architect. Agentic + web by default (the recommendation is only as good
// as it is current). Bounded by a dollar cap so the survey can't run away.
export function scaleArchitect(
  repo: Repo,
  opts: { web?: boolean; budgetUsd?: number } = {},
): ArchitectResult {
  if (!claudeAvailable()) {
    console.log("⚠️  the scale architect needs Claude Code logged in on PATH; skipping.");
    return { prescriptions: [], findings: [] };
  }

  const raw = claudeAgentJsonArray<Raw>(prompt(repo), repo.root, {
    web: opts.web ?? true,
    budgetUsd: opts.budgetUsd ?? 0.6,
  });
  if (!raw) return { prescriptions: [], findings: [] };

  const prescriptions: InfraPrescription[] = raw
    .filter((r): r is Raw => !!r && !!r.need && !!r.recommendation)
    .map((r) => ({
      component: VALID.has(String(r.component)) ? (r.component as InfraComponent) : "other",
      need: String(r.need),
      recommendation: String(r.recommendation),
      alternatives: Array.isArray(r.alternatives) ? r.alternatives.map(String).slice(0, 3) : undefined,
      source: typeof r.source === "string" ? r.source : undefined,
      where: typeof r.where === "string" ? r.where : undefined,
      priority: r.priority === "now" || r.priority === "soon" || r.priority === "later" ? r.priority : "soon",
      effort: typeof r.effort === "string" ? r.effort : undefined,
    }))
    // most urgent first — "now" before "soon" before "later".
    .sort((a, b) => order(a.priority) - order(b.priority));

  return { prescriptions, findings: prescriptions.map(toFinding) };
}

function order(p: Priority): number {
  return p === "now" ? 0 : p === "soon" ? 1 : 2;
}
