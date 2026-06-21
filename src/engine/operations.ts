import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fg from "fast-glob";
import type { Repo } from "./ingest.js";
import type { Finding } from "./report.js";

// Is it OPERABLE, not just sound? The production-readiness checklists are clear:
// observability + rollback + incident ownership are the non-negotiables. This
// module checks the operational basics AI-built apps almost always skip — error
// tracking, structured logging, health endpoints, graceful shutdown, secret/env
// hygiene, CI/CD, Dockerfile hygiene, and known CVEs (npm audit). Mostly cheap
// deterministic presence checks — the moat.

interface OpsOptions {
  audit?: boolean; // run `npm audit` (network + lockfile; best-effort)
}

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

const hasAny = (deps: Record<string, string>, names: RegExp) => Object.keys(deps).some((d) => names.test(d));

function isBackendFile(p: string): boolean {
  return (
    /\/api\/.*route\.(ts|js)$/.test(p) ||
    /pages\/api\//.test(p) ||
    /\/(server|services?|controllers?|handlers?|workers?|lib)\//.test(p) ||
    /server\.(ts|js)$|index\.(ts|js)$|main\.(ts|js)$|app\.(ts|js)$/.test(p)
  );
}

function advise(id: string, file: string, message: string, severity: Finding["severity"] = "warn"): Finding {
  return { id, severity, disposition: "advise", file, message };
}
function gate(id: string, file: string, message: string): Finding {
  return { id, severity: "critical", disposition: "gate", file, message };
}

export function operationsChecks(repo: Repo, opts: OpsOptions = {}): Finding[] {
  const root = repo.root;
  const deps = allDeps(root);
  const out: Finding[] = [];
  const hasServer =
    repo.hasNext ||
    hasAny(deps, /^(express|fastify|@nestjs\/core|hono|koa|next)$/) ||
    repo.files.some((f) => /createServer\(|\.listen\(/.test(f.content));

  // ── Observability ─────────────────────────────────────────────────────────
  if (!hasAny(deps, /sentry|rollbar|bugsnag|@honeybadger|newrelic|dd-trace/i)) {
    out.push(
      advise(
        "no-error-tracking",
        "package.json",
        "No error tracking (Sentry/Rollbar/Bugsnag) — once live, exceptions are invisible and you'll hear about outages from users. Add error tracking before launch.",
      ),
    );
  }

  const hasLogger = hasAny(deps, /^(pino|winston|bunyan|consola|loglevel|@nestjs\/common)$/);
  const consoleHeavy = repo.files.filter((f) => isBackendFile(f.path) && /console\.(log|error|info)/.test(f.content)).length;
  if (!hasLogger && consoleHeavy >= 3) {
    out.push(
      advise(
        "no-structured-logging",
        "(observability)",
        `Logging is raw console.* (${consoleHeavy} backend files) — use a structured logger (pino/winston) with request/correlation IDs so production logs are queryable and aggregatable.`,
      ),
    );
  }

  if (!hasAny(deps, /opentelemetry|prom-client|prometheus|@opentelemetry/i)) {
    out.push(
      advise(
        "no-metrics",
        "(observability)",
        "No metrics/tracing instrumentation (OpenTelemetry/Prometheus) — you can't see the Four Golden Signals (latency, traffic, errors, saturation). Add it before you need it to debug an incident.",
        "info",
      ),
    );
  }

  // health / readiness endpoint
  const hasHealth = repo.files.some(
    (f) => /\/(health|healthz|readyz|ready|ping|livez)\b/.test(f.path) || /['"`]\/(health|healthz|readyz|livez|ping)['"`]/.test(f.content),
  );
  if (hasServer && !hasHealth) {
    out.push(
      advise(
        "no-health-endpoint",
        "(operations)",
        "No health/readiness endpoint (/healthz, /readyz) — a load balancer or orchestrator can't tell if the instance is alive or draining, so zero-downtime deploys and autoscaling don't work.",
      ),
    );
  }

  // graceful shutdown
  const hasGraceful = repo.files.some((f) =>
    /process\.on\(['"]SIGTERM['"]|onApplicationShutdown|gracefulShutdown|server\.close\(/.test(f.content),
  );
  if (hasServer && !hasGraceful) {
    out.push(
      advise(
        "no-graceful-shutdown",
        "(operations)",
        "No graceful shutdown (no SIGTERM handler / server.close) — on deploy or restart, in-flight requests are killed mid-flight. Drain connections on SIGTERM for zero-downtime deploys.",
      ),
    );
  }

  // ── Env / secret hygiene ──────────────────────────────────────────────────
  out.push(...envHygiene(repo, root));

  // ── Deployment / config ───────────────────────────────────────────────────
  const ciFiles = fg.sync(
    [".github/workflows/*.{yml,yaml}", ".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml", "Jenkinsfile", "bitbucket-pipelines.yml"],
    { cwd: root, dot: true },
  );
  if (ciFiles.length === 0) {
    out.push(
      advise(
        "no-ci",
        "(deploy)",
        "No CI pipeline detected (.github/workflows, .gitlab-ci.yml, …) — set up automated build/test/deploy so releases aren't manual and unverified.",
        "info",
      ),
    );
  }

  out.push(...dockerfileHygiene(root));

  // ── Known CVEs (npm audit — deterministic, uses the internet) ─────────────
  if (opts.audit) out.push(...npmAudit(root));

  return out;
}

// .env committed to git is a real secret-leak; .env.example completeness is hygiene.
function envHygiene(repo: Repo, root: string): Finding[] {
  const out: Finding[] = [];
  const envPath = path.join(root, ".env");

  if (existsSync(envPath)) {
    // is .env actually tracked by git? (the dangerous case)
    let tracked = false;
    try {
      const res = spawnSync("git", ["ls-files", "--error-unmatch", ".env"], {
        cwd: root,
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      tracked = res.status === 0 && Boolean(res.stdout.trim());
    } catch {
      /* git unavailable */
    }
    const gitignore = existsSync(path.join(root, ".gitignore")) ? readFileSync(path.join(root, ".gitignore"), "utf8") : "";
    const ignored = /(^|\n)\s*\.env\s*($|\n)|(^|\n)\s*\*?\.env\*?\s*($|\n)/.test(gitignore);
    if (tracked) {
      out.push(gate("env-committed", ".env", "`.env` is committed to git — your secrets are in history. Remove it (`git rm --cached .env`), add it to .gitignore, and ROTATE every key it contained."));
    } else if (!ignored) {
      out.push(advise("env-not-ignored", ".gitignore", "`.env` exists but isn't in .gitignore — one `git add .` from leaking your secrets. Add `.env` to .gitignore now."));
    }
  }

  // .env.example completeness: every referenced env var should be documented.
  const referenced = new Set<string>();
  for (const f of repo.files) {
    const re = /process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content))) referenced.add(m[1] || m[2]);
  }
  referenced.delete("NODE_ENV");
  referenced.delete("PORT");

  const examplePath = ["env.example", ".env.example", ".env.sample", ".env.template"]
    .map((n) => path.join(root, n))
    .find((p) => existsSync(p));

  if (referenced.size > 0 && !examplePath) {
    out.push(
      advise(
        "no-env-example",
        ".env.example",
        `Code reads ${referenced.size} env var(s) but there's no .env.example — a new dev (or your future self) can't tell what to configure. Add .env.example listing every required key.`,
      ),
    );
  } else if (examplePath) {
    const documented = new Set(
      readFileSync(examplePath, "utf8")
        .split("\n")
        .map((l) => l.split("=")[0].trim())
        .filter(Boolean),
    );
    const missing = [...referenced].filter((k) => !documented.has(k));
    if (missing.length > 0) {
      out.push(
        advise(
          "incomplete-env-example",
          path.basename(examplePath),
          `${missing.length} env var(s) used in code but missing from ${path.basename(examplePath)}: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""}.`,
        ),
      );
    }
  }

  return out;
}

function dockerfileHygiene(root: string): Finding[] {
  const out: Finding[] = [];
  const dockerfiles = fg.sync(["**/Dockerfile", "**/Dockerfile.*"], { cwd: root, ignore: ["**/node_modules/**"], absolute: true });
  for (const df of dockerfiles.slice(0, 3)) {
    let content = "";
    try {
      content = readFileSync(df, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(root, df);
    if (!/^\s*USER\s+/m.test(content)) {
      out.push(advise("docker-runs-as-root", rel, "Dockerfile has no USER — the container runs as root. Add a non-root user before production."));
    }
    if (/FROM\s+\S+:latest|FROM\s+[^\s:]+\s*$/m.test(content)) {
      out.push(advise("docker-unpinned-base", rel, "Dockerfile uses an unpinned/`:latest` base image — builds aren't reproducible. Pin to a specific version/digest.", "info"));
    }
    const stages = (content.match(/^\s*FROM\s+/gim) || []).length;
    if (stages < 2) {
      out.push(advise("docker-not-multistage", rel, "Single-stage Dockerfile — multi-stage builds ship a much smaller image without build tooling/source. Consider a build stage + slim runtime stage.", "info"));
    }
  }
  return out;
}

function npmAudit(root: string): Finding[] {
  try {
    const res = spawnSync("npm", ["audit", "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    if (!res.stdout) return [];
    const j = JSON.parse(res.stdout) as { metadata?: { vulnerabilities?: Record<string, number> } };
    const v = j.metadata?.vulnerabilities;
    if (!v) return [];
    const out: Finding[] = [];
    if ((v.critical ?? 0) > 0) {
      out.push(gate("npm-audit-critical", "package.json", `npm audit: ${v.critical} CRITICAL vulnerability(ies) in dependencies. Run \`npm audit fix\` (or update the offending packages) before shipping.`));
    }
    if ((v.high ?? 0) > 0) {
      out.push(advise("npm-audit-high", "package.json", `npm audit: ${v.high} high-severity vulnerability(ies) in dependencies. Review and update with \`npm audit fix\`.`));
    }
    return out;
  } catch {
    return []; // no lockfile / offline / npm missing — best-effort
  }
}
