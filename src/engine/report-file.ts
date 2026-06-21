import { writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import type { Finding } from "./report.js";
import type { Repo } from "./ingest.js";
import type { TechStack } from "./tech-stack.js";
import type { ArchitectureResult } from "./backend/architecture.js";
import type { PatternResult } from "./backend/production.js";
import type { LoadMetrics } from "./backend/loadtest.js";
import {
  loadProject,
  recordRun,
  reportsDir,
  profilePath,
  type Project,
} from "./project.js";

// Writes the detailed, keep-able artifact into `.shepherd/` — the thing a buyer
// holds onto. Also appends to the per-project history and refreshes SHEPHERD.md.

export interface ReportSections {
  ts: string; // ISO timestamp, injected by the caller (no Date.now in the engine)
  tech: TechStack;
  architecture: ArchitectureResult;
  production: PatternResult;
  liveProbeRan: boolean;
  loadMetrics?: LoadMetrics;
  findings: Finding[];
}

function isApiRoute(p: string): boolean {
  return /\/api\/.*route\.(ts|js)$/.test(p) || /pages\/api\//.test(p);
}

function severityRank(s: Finding["severity"]): number {
  return s === "critical" ? 0 : s === "warn" ? 1 : 2;
}

function findingsTable(findings: Finding[]): string {
  if (findings.length === 0) return "_No findings._\n";
  const rows = [...findings]
    .sort((a, b) => {
      if (a.disposition !== b.disposition) return a.disposition === "gate" ? -1 : 1;
      return severityRank(a.severity) - severityRank(b.severity);
    })
    .map((f) => {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      const sev = f.severity === "critical" ? "🔴" : f.severity === "warn" ? "🟡" : "🔵";
      const disp = f.disposition === "gate" ? "**GATE**" : "advise";
      const msg = f.message.replace(/\|/g, "\\|").replace(/\n/g, " ");
      return `| ${sev} | ${disp} | \`${f.id}\` | \`${loc}\` | ${msg} |`;
    });
  return ["| | | Check | Location | Detail |", "|---|---|---|---|---|", ...rows].join("\n") + "\n";
}

// Every API route, with what we know about its protection — the "rate-limit map".
function rateLimitMap(repo: Repo, findings: Finding[]): string {
  const routes = repo.files.filter((f) => isApiRoute(f.path));
  if (routes.length === 0) return "_No API routes detected._\n";

  const liveByRoute = new Set(findings.filter((f) => f.file.startsWith("live:")).map((f) => f.file));
  const costBombFiles = new Set(findings.filter((f) => f.id === "cost-bomb").map((f) => f.file));

  const rows = routes.map((f) => {
    const limited = /ratelimit|rate-limit|rateLimit|upstash|limiter|throttle/i.test(f.content);
    const authed = /getUser|getSession|getServerSession|currentUser|requireAuth|verifyToken|withAuth|isAuthenticated|auth\(\)/.test(
      f.content,
    );
    const provenOpen = costBombFiles.has(f.path) || liveByRoute.size > 0;
    return `| \`${f.path}\` | ${authed ? "✅" : "⚠️"} | ${limited ? "✅" : "❌"} | ${provenOpen && !limited ? "🔴 drainable" : "—"} |`;
  });
  return ["| Route | Auth | Rate-limit | Live |", "|---|---|---|---|", ...rows].join("\n") + "\n";
}

function loadTestSection(m?: LoadMetrics): string {
  if (!m || !m.ran) return `_Skipped — ${m?.note ?? "Docker not available / no server"}._\n`;
  const rows = m.stages.map(
    (st) =>
      `| ${st.concurrency} | ${st.rps} | ${st.p50} | ${st.p95} | ${st.p99} | ${(st.errorRate * 100).toFixed(1)}% |`,
  );
  return [
    `Real dependencies stood up via Docker; bounded ramp against \`${m.target}\`.`,
    ``,
    `| Concurrency | req/s | p50 (ms) | p95 (ms) | p99 (ms) | errors |`,
    `|---|---|---|---|---|---|`,
    ...rows,
    ``,
    `**Projection:** ${m.projection}`,
  ].join("\n");
}

function buildMarkdown(repo: Repo, s: ReportSections): string {
  const gates = s.findings.filter((f) => f.disposition === "gate");
  const advise = s.findings.filter((f) => f.disposition === "advise");

  return [
    `# Shepherd Report`,
    ``,
    `_Generated ${s.ts}_`,
    ``,
    `**Verdict:** ${gates.length === 0 ? "✅ shipshape" : `🔴 ${gates.length} blocking issue(s)`} · ${advise.length} advisory.`,
    ``,
    `## Tech stack`,
    `- **Language:** ${s.tech.language}`,
    `- **Frameworks:** ${s.tech.frameworks.join(", ") || "—"}`,
    `- **Databases:** ${s.tech.databases.join(", ") || "—"}`,
    `- **Testing:** ${s.tech.testing.join(", ") || "⚠️ none detected"}`,
    ``,
    `## Architecture`,
    `- **Shape:** ${s.architecture.shape}`,
    `- **Pattern:** ${s.production.patterns.join(", ")}`,
    `- **Communication:** ${s.architecture.comms.join(", ") || "REST / HTTP"}`,
    ``,
    `## Production tooling (does the pattern have what it needs at 1M?)`,
    `| Component | Present |`,
    `|---|---|`,
    `| Message broker | ${s.production.infra.broker ?? "❌ none"} |`,
    `| Task / job queue | ${s.production.infra.taskQueue ?? "❌ none"} |`,
    `| Cache | ${s.production.infra.cache ?? "❌ none"} |`,
    `| Database | ${s.production.infra.database ?? "—"} |`,
    `| Connection pooling | ${s.production.infra.pooling ? "✅" : "❌ none"} |`,
    `| Docker | ${s.production.infra.hasCompose ? "compose ✅" : s.production.infra.hasDockerfile ? "Dockerfile ✅" : "❌ none"} |`,
    ``,
    `## Rate-limit map`,
    rateLimitMap(repo, s.findings),
    `## Live attack probe`,
    s.liveProbeRan
      ? `Bounded, localhost-only attacks were run against the auto-started server. Results are folded into the findings table (rows tagged \`live:…\`).`
      : `_Skipped — the dev server could not be started, or the live probe is disabled in \`.shepherd/config.json\`._`,
    ``,
    `## Load test (Docker + bounded ramp)`,
    loadTestSection(s.loadMetrics),
    ``,
    `## Findings`,
    findingsTable(s.findings),
    `---`,
    `_Shepherd — production-readiness gate for AI-written code._`,
    ``,
  ].join("\n");
}

function buildProfile(repo: Repo, s: ReportSections): string {
  const recurring = new Map<string, number>();
  for (const f of s.findings) recurring.set(f.id, (recurring.get(f.id) ?? 0) + 1);
  const top = [...recurring.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  return [
    `# Shepherd — project profile`,
    ``,
    `_Maintained by Shepherd. Last updated ${s.ts}._`,
    ``,
    `## What this is`,
    `A ${s.architecture.shape} backend (${s.architecture.comms.join(", ") || "REST/HTTP"}), ` +
      `${s.tech.frameworks.join(" + ") || s.tech.language}, ${repo.files.length} source files.`,
    ``,
    `## Recurring soft spots`,
    top.length ? top.map(([id, n]) => `- \`${id}\` ×${n}`).join("\n") : "- none recorded yet",
    ``,
  ].join("\n");
}

// Write the report + history + profile. Returns the report path.
export function writeReport(repo: Repo, sections: ReportSections): string {
  const project: Project = loadProject(repo.root);

  const stamp = sections.ts.replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir(project), `${stamp}.md`);
  const md = buildMarkdown(repo, sections);
  writeFileSync(reportPath, md);
  copyFileSync(reportPath, path.join(reportsDir(project), "latest.md"));

  recordRun(project, sections.ts, sections.findings, repo.files.length);
  writeFileSync(profilePath(project), buildProfile(repo, sections));

  return path.relative(repo.root, reportPath);
}
