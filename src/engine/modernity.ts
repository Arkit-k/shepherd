import { spawnSync } from "node:child_process";
import type { Repo } from "./ingest.js";
import type { Finding } from "./report.js";
import { detectStack } from "./tech-stack.js";
import { claudeAvailable } from "./fixers/claude.js";

function major(v: string): number {
  return parseInt((v || "0").split(".")[0], 10) || 0;
}

async function latestVersion(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
    if (!res.ok) return null;
    const j = (await res.json()) as { version?: string };
    return j.version ?? null;
  } catch {
    return null;
  }
}

// Tier 1 — flag dependencies that are major versions behind latest (npm registry).
export async function outdatedDependencies(repo: Repo): Promise<Finding[]> {
  const tech = detectStack(repo);
  const out: Finding[] = [];
  for (const dep of tech.notable) {
    const latest = await latestVersion(dep.name);
    if (!latest) continue;
    const behind = major(latest) - major(dep.version);
    if (behind >= 1) {
      out.push({
        id: "outdated-dependency",
        severity: "warn",
        disposition: "advise",
        file: "package.json",
        message: `${dep.name}@${dep.version} is ${behind} major version${behind > 1 ? "s" : ""} behind latest (${latest}).`,
      });
    }
  }
  return out;
}

interface Raw {
  severity?: string;
  gate?: boolean;
  line?: number | null;
  message?: string;
}

function reviewFile(file: string, content: string, techLine: string, root: string): Finding[] {
  const prompt = [
    `This project uses ${techLine}.`,
    `Review the file below for OUTDATED or deprecated patterns given those versions:`,
    `legacy React idioms (class components, old lifecycle/context, old data fetching),`,
    `deprecated APIs, pre-Next-15 patterns, or anything not using the modern recommended`,
    `approach. AI-generated code often uses yesterday's patterns — flag those.`,
    `Respond with ONLY a JSON array: {"severity":"critical"|"warn","gate":false,"line":number|null,"message":string}.`,
    `Return [] if the file already uses modern patterns.`,
    ``,
    `File: ${file}`,
    "```",
    content,
    "```",
  ].join("\n");

  const res = spawnSync("claude", ["-p", "--output-format", "json"], {
    input: prompt,
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
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let raw: Raw[];
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return [];
  }
  return raw
    .filter((r) => r && r.message)
    .map<Finding>((r) => ({
      id: "outdated-pattern",
      severity: r.severity === "critical" ? "critical" : "warn",
      disposition: "advise",
      file,
      line: typeof r.line === "number" ? r.line : undefined,
      message: String(r.message),
    }));
}

// Tier 2 — Claude flags deprecated/old code patterns given the stack versions.
// Scoped to the largest UI files (most likely to carry legacy idioms).
export function reviewModernity(repo: Repo): Finding[] {
  if (!claudeAvailable()) {
    console.log("⚠️  --deep modernity needs Claude Code on PATH; skipping.");
    return [];
  }
  const tech = detectStack(repo);
  const techLine = `${tech.frameworks.join(", ")} (${tech.notable.map((n) => `${n.name}@${n.version}`).join(", ")})`;

  const targets = [...repo.files]
    .filter((f) => /\.(tsx|jsx)$/.test(f.path))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 3);

  const out: Finding[] = [];
  for (const f of targets) {
    console.log(`  checking ${f.path} for old patterns …`);
    out.push(...reviewFile(f.path, f.content.slice(0, 16000), techLine, repo.root));
  }
  return out;
}
