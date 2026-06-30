import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Repo } from "../ingest.js";
import type { Finding } from "../report.js";
import { claudeAvailable } from "../fixers/claude.js";

// Understands the *shape* of the backend — monolith vs microservices, and which
// inter-service communication style is in play (tRPC / gRPC / GraphQL / queue) —
// then has Claude check that communication is done correctly. AI tools wire
// these up shallowly (no input validation, no retries, no typed contracts).

export type BackendShape = "monolith" | "microservices" | "serverless" | "unknown";

const COMMS: Record<string, string> = {
  "@trpc/server": "tRPC",
  "@trpc/client": "tRPC",
  "@grpc/grpc-js": "gRPC",
  "grpc": "gRPC",
  "@nestjs/microservices": "gRPC/microservices",
  graphql: "GraphQL",
  "@apollo/server": "GraphQL (Apollo)",
  bullmq: "queue (BullMQ)",
  kafkajs: "queue (Kafka)",
  amqplib: "queue (RabbitMQ)",
  nats: "queue (NATS)",
};

export interface ArchitectureResult {
  shape: BackendShape;
  comms: string[];
  findings: Finding[];
}

function allDeps(root: string): Record<string, string> {
  const pkgPaths = fg.sync("**/package.json", {
    cwd: root,
    ignore: ["**/node_modules/**"],
    absolute: true,
  });
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

function countServices(root: string): number {
  // distinct app/service packages (excluding the monorepo root)
  const pkgPaths = fg.sync(["apps/*/package.json", "services/*/package.json", "packages/*/package.json"], {
    cwd: root,
    ignore: ["**/node_modules/**"],
  });
  return pkgPaths.length;
}

function composeServiceCount(root: string): number {
  for (const name of ["docker-compose.yml", "docker-compose.yaml"]) {
    const p = path.join(root, name);
    if (!existsSync(p)) continue;
    try {
      const txt = readFileSync(p, "utf8");
      // count top-level entries under `services:` (2-space indented keys)
      const m = txt.match(/^services:\s*$([\s\S]*?)(^\S|\Z)/m);
      const block = m ? m[1] : "";
      const svcs = block.match(/^ {2}\w[\w-]*:/gm);
      return svcs ? svcs.length : 0;
    } catch {
      /* ignore */
    }
  }
  return 0;
}

// The cheap, DETERMINISTIC classification only (no Claude). Used by the forward-
// looking architecture spec, which wants the shape/comms but not the diagnostic
// review of existing code.
export function classifyShape(repo: Repo): { shape: BackendShape; comms: string[] } {
  const deps = allDeps(repo.root);
  const comms = [...new Set(Object.keys(COMMS).filter((k) => k in deps).map((k) => COMMS[k]))];

  const services = countServices(repo.root);
  const composeSvcs = composeServiceCount(repo.root);
  const serverless = repo.hasNext || "vercel" in deps || existsSync(path.join(repo.root, "serverless.yml"));

  let shape: BackendShape = "unknown";
  if (services >= 2 || composeSvcs >= 3) shape = "microservices";
  else if (serverless) shape = "serverless";
  else if (Object.keys(deps).some((d) => ["express", "fastify", "@nestjs/core", "hono", "koa"].includes(d)))
    shape = "monolith";

  return { shape, comms };
}

export function analyzeArchitecture(repo: Repo): ArchitectureResult {
  const { shape, comms } = classifyShape(repo);

  const findings: Finding[] = [];
  const claudeReview = reviewCommunication(repo, shape, comms);
  findings.push(...claudeReview);

  return { shape, comms, findings };
}

// Claude checks that whatever communication style is in use is done properly.
// Scoped to the contract/router/proto files, not the whole repo.
function reviewCommunication(repo: Repo, shape: BackendShape, comms: string[]): Finding[] {
  if (comms.length === 0 || !claudeAvailable()) return [];

  // gather the files most likely to define service contracts
  const contractFiles = repo.files
    .filter((f) =>
      /router|trpc|\.proto$|resolver|schema\.(ts|js)|service\.(ts|js)|grpc|queue|worker|consumer|producer/i.test(
        f.path,
      ),
    )
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 4);

  if (contractFiles.length === 0) return [];

  const snippets = contractFiles
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 6000)}\n\`\`\``)
    .join("\n\n");

  const prompt = [
    `This is a ${shape} backend using: ${comms.join(", ")}.`,
    `Review the inter-service / API communication below for CORRECTNESS at scale:`,
    `- typed contracts end-to-end (tRPC routers, gRPC proto, GraphQL schema)`,
    `- input validation on every procedure/handler (zod or equivalent)`,
    `- error handling: typed errors, no leaking internals`,
    `- resilience between services: timeouts, retries, idempotency`,
    `- auth on service-to-service calls`,
    `Respond with ONLY a JSON array of`,
    `{"severity":"critical"|"warn","gate":boolean,"file":string,"line":number|null,"message":string}.`,
    `Return [] if communication is already solid.`,
    ``,
    snippets,
  ].join("\n");

  const res = spawnSync("claude", ["-p", "--output-format", "json"], {
    input: prompt,
    cwd: repo.root,
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
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const raw = JSON.parse(m[0]) as Array<{
      severity?: string;
      gate?: boolean;
      file?: string;
      line?: number | null;
      message?: string;
    }>;
    return raw
      .filter((r) => r && r.message)
      .map<Finding>((r) => ({
        id: "service-communication",
        severity: r.severity === "critical" ? "critical" : "warn",
        disposition: r.gate === true ? "gate" : "advise",
        file: r.file || contractFiles[0].path,
        line: typeof r.line === "number" ? r.line : undefined,
        message: String(r.message),
      }));
  } catch {
    return [];
  }
}
