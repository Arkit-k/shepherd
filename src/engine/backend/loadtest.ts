import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Repo } from "../ingest.js";
import type { Finding } from "../report.js";
import { startServer } from "./server.js";

// The "run Docker autonomously" stage. If Docker + a compose file are present,
// stand up the REAL dependencies (Postgres/Redis/Kafka/…), boot the app against
// them, run a BOUNDED local load test to find the breaking point, then project
// honestly toward the scale target and name the bottleneck. Always tears down.
//
// Honesty contract: you cannot prove 1M req/s on one laptop. We measure the
// single-box ceiling and PROJECT, naming what stands between here and target.

export interface LoadMetrics {
  ran: boolean;
  note?: string; // why it was skipped, if it was
  target: string;
  stages: StageResult[];
  maxSustainedRps: number; // best throughput with <5% errors and sane p99
  projection: string;
}

interface StageResult {
  concurrency: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
}

// 1M requests/day ≈ 11.6 rps average; assume a 10× peak.
const TARGET_DAILY = 1_000_000;
const AVG_RPS = TARGET_DAILY / 86_400;
const PEAK_RPS = AVG_RPS * 10;

const STAGES = [10, 25, 50, 100];
const STAGE_MS = 6000;
const SENSITIVE = /openai|anthropic|chat\/completions|stripe|payment|checkout|sendMail|resend|nodemailer|sendgrid/i;

function run(cmd: string, args: string[], cwd: string, timeoutMs = 180_000) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    shell: process.platform === "win32",
  });
}

function dockerAvailable(): boolean {
  return run("docker", ["--version"], process.cwd(), 10_000).status === 0;
}

function findCompose(root: string): string | null {
  for (const n of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    if (existsSync(path.join(root, n))) return n;
  }
  return null;
}

// `docker compose` (v2) with a fallback to `docker-compose` (v1).
function composeCmd(root: string, sub: string[]): boolean {
  let res = run("docker", ["compose", ...sub], root);
  if (res.status === 0) return true;
  res = run("docker-compose", sub, root);
  return res.status === 0;
}

// Pick a SAFE GET target — the app root, or a non-sensitive GET route. Never an
// AI/payment/email endpoint (hammering an LLM proxy would cost real money).
function pickTarget(repo: Repo, baseUrl: string): string {
  const safeRoute = repo.files.find(
    (f) =>
      (/\/api\/.*route\.(ts|js)$/.test(f.path) || /pages\/api\//.test(f.path)) &&
      /health|status|ping|version/i.test(f.path) &&
      !SENSITIVE.test(f.content),
  );
  if (safeRoute) {
    const m = safeRoute.path.replace(/\\/g, "/").match(/app\/(.*)\/route\.(ts|js)$/);
    if (m) return baseUrl + "/" + m[1];
  }
  return baseUrl + "/"; // root is always safe
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[i]);
}

// One bounded stage: `concurrency` workers loop fetching until the deadline.
async function runStage(url: string, concurrency: number, durationMs: number): Promise<StageResult> {
  const latencies: number[] = [];
  let reqs = 0;
  let errors = 0;
  const deadline = performance.now() + durationMs;

  async function worker() {
    while (performance.now() < deadline) {
      const t0 = performance.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        await res.arrayBuffer().catch(() => undefined);
        if (res.status >= 500) errors++;
      } catch {
        errors++;
      }
      latencies.push(performance.now() - t0);
      reqs++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  latencies.sort((a, b) => a - b);
  return {
    concurrency,
    rps: Math.round((reqs / durationMs) * 1000),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    errorRate: reqs ? errors / reqs : 0,
  };
}

function project(maxRps: number, missing: string[]): string {
  const dayOk = maxRps >= PEAK_RPS;
  const instancesForDay = Math.max(1, Math.ceil(PEAK_RPS / Math.max(maxRps, 1)));
  const gaps = missing.length ? ` Before horizontal scale will even hold, fix: ${missing.join(", ")}.` : "";
  return (
    `Single-box ceiling ≈ ${maxRps} req/s (sustained, <5% errors). ` +
    `1M requests/day means ~${AVG_RPS.toFixed(0)} req/s average and ~${PEAK_RPS.toFixed(0)} req/s at peak — ` +
    (dayOk
      ? `one instance handles that with headroom.`
      : `you'd need ~${instancesForDay} instances behind a load balancer to absorb peak.`) +
    ` Reaching 1M req/SECOND is a fleet concern: ~${Math.ceil(1_000_000 / Math.max(maxRps, 1)).toLocaleString()} ` +
    `instances + CDN + the right broker/cache/pool — not a single-box property.${gaps}`
  );
}

export async function loadTest(repo: Repo, missingInfra: string[] = []): Promise<{ findings: Finding[]; metrics: LoadMetrics }> {
  const skip = (note: string): { findings: Finding[]; metrics: LoadMetrics } => {
    console.log(`  load test skipped — ${note}`);
    return { findings: [], metrics: { ran: false, note, target: "", stages: [], maxSustainedRps: 0, projection: "" } };
  };

  if (!dockerAvailable()) return skip("Docker not installed");

  const compose = findCompose(repo.root);
  let composeUp = false;
  if (compose) {
    console.log(`  Standing up real dependencies with Docker (${compose}) …`);
    composeUp = composeCmd(repo.root, ["up", "-d"]);
    if (!composeUp) console.log("  ⚠️  docker compose up failed — load-testing the app without its containers.");
    else await new Promise((r) => setTimeout(r, 5000)); // brief grace for services to accept connections
  } else {
    console.log("  No docker-compose file — load-testing the app standalone.");
  }

  const server = await startServer(repo);
  if (!server) {
    if (composeUp) composeCmd(repo.root, ["down"]);
    return skip("the app server didn't start");
  }

  const target = pickTarget(repo, server.baseUrl);
  console.log(`  Load-testing ${target} (bounded ramp: ${STAGES.join(", ")} concurrent) …`);

  const stages: StageResult[] = [];
  try {
    for (const c of STAGES) {
      const s = await runStage(target, c, STAGE_MS);
      stages.push(s);
      console.log(`    ${String(c).padStart(4)} conc → ${s.rps} req/s · p99 ${s.p99}ms · err ${(s.errorRate * 100).toFixed(1)}%`);
      if (s.errorRate > 0.2) break; // it's already falling over; don't push harder
    }
  } finally {
    server.stop();
    if (composeUp) {
      console.log("  Tearing down Docker dependencies …");
      composeCmd(repo.root, ["down"]);
    }
  }

  // best sustained throughput with acceptable errors + latency.
  const healthy = stages.filter((s) => s.errorRate < 0.05 && s.p99 < 3000);
  const maxSustainedRps = healthy.length ? Math.max(...healthy.map((s) => s.rps)) : 0;
  const projection = project(maxSustainedRps, missingInfra);

  const findings: Finding[] = [];
  const worst = stages[stages.length - 1];
  if (worst && worst.errorRate > 0.05) {
    findings.push({
      id: "load-breaks-early",
      severity: "critical",
      disposition: "gate",
      file: "(load test)",
      message: `Errors hit ${(worst.errorRate * 100).toFixed(1)}% at only ${worst.concurrency} concurrent requests (p99 ${worst.p99}ms). It falls over well below production load. ${projection}`,
    });
  } else {
    findings.push({
      id: "load-projection",
      severity: "info",
      disposition: "advise",
      file: "(load test)",
      message: projection,
    });
  }

  return { findings, metrics: { ran: true, target, stages, maxSustainedRps, projection } };
}
