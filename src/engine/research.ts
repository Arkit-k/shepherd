import type { Repo } from "./ingest.js";
import type { Finding } from "./report.js";
import type { TechStack } from "./tech-stack.js";
import type { InfraInventory } from "./backend/production.js";
import { claudeAvailable } from "./fixers/claude.js";
import { claudeJsonArray } from "./claude-json.js";
import { loadProject } from "./project.js";

// The "principal engineer looks it up" step. ONE web-grounded call on LOW
// context (just the stack + pattern + infra summary — no code) so it stays cheap
// and fast. It checks the CURRENT reality of the internet: latest stable
// versions, today's best-practice tooling for the detected pattern at scale, and
// known security advisories — each finding carrying a source URL.

export interface ResearchInput {
  tech: TechStack;
  patterns: string[];
  infra: InfraInventory;
}

interface RawResearch {
  id?: string;
  severity?: string;
  gate?: boolean;
  message?: string;
  source?: string;
}

export function researchProduction(repo: Repo, input: ResearchInput): Finding[] {
  if (!claudeAvailable()) return [];
  const project = loadProject(repo.root);
  if (project.config.web === false) {
    console.log("  web research disabled in .shepherd/config.json — skipping.");
    return [];
  }

  const versions = input.tech.notable.map((n) => `${n.name}@${n.version}`).join(", ") || "—";
  const prompt = [
    `You are a principal production engineer. Use WebSearch/WebFetch to check the`,
    `CURRENT (today's) reality before answering — do not rely on memory. Be concise.`,
    ``,
    `Stack: ${input.tech.language}, ${input.tech.frameworks.join(", ") || "—"}.`,
    `Key dependency versions in use: ${versions}.`,
    `Architecture pattern(s): ${input.patterns.join(", ")}.`,
    `Infra present: broker=${input.infra.broker ?? "none"}, queue=${input.infra.taskQueue ?? "none"}, ` +
      `cache=${input.infra.cache ?? "none"}, db=${input.infra.database ?? "none"}, pooling=${input.infra.pooling ? "yes" : "no"}.`,
    `Scale target: ~1,000,000 users.`,
    ``,
    `Research and report ONLY things grounded in what you find online right now:`,
    `1) Any dependency that is behind the current stable major — give the current version.`,
    `2) The current best-practice production tooling for THIS pattern at this scale`,
    `   (e.g. which broker/cache/queue the field recommends now) and why.`,
    `3) Any known security advisory / CVE affecting the listed dependencies.`,
    `Respond with ONLY a JSON array of`,
    `{"id":string,"severity":"critical"|"warn"|"info","gate":boolean,"message":string,"source":string}`,
    `where "source" is the URL you used. Return [] if nothing notable.`,
  ].join("\n");

  const raw = claudeJsonArray<RawResearch>(prompt, repo.root, { web: true });
  if (!raw) return [];

  return raw
    .filter((r) => r && r.message)
    .map<Finding>((r) => ({
      id: r.id ? `research-${r.id}`.slice(0, 28) : "research",
      severity: r.severity === "critical" ? "critical" : r.severity === "info" ? "info" : "warn",
      disposition: r.gate === true ? "gate" : "advise",
      file: "(researched)",
      message: r.source ? `${r.message}  [source: ${r.source}]` : String(r.message),
    }));
}
