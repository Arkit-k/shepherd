import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import type { Finding } from "./report.js";

// The per-project `.shepherd/` folder — Shepherd's equivalent of `.claude/`.
// It installs into the project and tracks it across runs: learned config,
// a human-readable project profile, run history, and an accepted-findings
// baseline. This is the workflow lock-in surface.

export interface ProjectConfig {
  // What Shepherd learned about how to boot this app for the live probe.
  // Detected once, reused after — and the user can hand-edit it.
  startCommand?: string; // e.g. "npm run dev"
  cwd?: string; // absolute dir to run it in (the app, not the monorepo root)
  port?: number; // e.g. 3000
  readyMarker?: string; // a string in stdout that means "the server is up"
  framework?: string; // e.g. "Next.js"
  // Toggles + safety caps.
  liveProbe?: boolean; // run the localhost attack probe (default true)
  attackBurst?: number; // requests in the rate-limit burst (default 40)
}

const DEFAULT_CONFIG: ProjectConfig = {
  liveProbe: true,
  attackBurst: 40,
};

export interface Project {
  root: string;
  dir: string; // <root>/.shepherd
  config: ProjectConfig;
}

function dirOf(root: string): string {
  return path.join(root, ".shepherd");
}

export function isInitialized(root: string): boolean {
  return existsSync(path.join(dirOf(root), "config.json"));
}

// Create `.shepherd/` and seed its files. Idempotent: never clobbers a
// config.json or SHEPHERD.md the user (or a prior run) already wrote.
export function initProject(root: string): Project {
  const dir = dirOf(root);
  mkdirSync(path.join(dir, "reports"), { recursive: true });

  const configPath = path.join(dir, "config.json");
  let config = { ...DEFAULT_CONFIG };
  if (existsSync(configPath)) {
    config = { ...config, ...readConfig(configPath) };
  } else {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  }

  const profile = path.join(dir, "SHEPHERD.md");
  if (!existsSync(profile)) {
    writeFileSync(
      profile,
      "# Shepherd — project profile\n\n" +
        "_Shepherd maintains this file. It records what it has learned about this\n" +
        "project's architecture and recurring soft spots. Safe to read; it's regenerated._\n\n" +
        "No runs recorded yet.\n",
    );
  }

  // commit the shared profile + config; keep local run noise out of git.
  const ignore = path.join(dir, ".gitignore");
  if (!existsSync(ignore)) {
    writeFileSync(ignore, ["history.jsonl", "reports/", ""].join("\n"));
  }

  return { root, dir, config };
}

function readConfig(configPath: string): ProjectConfig {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as ProjectConfig;
  } catch {
    return {};
  }
}

// Load the project, initializing the folder if it's the first run.
export function loadProject(root: string): Project {
  const dir = dirOf(root);
  const configPath = path.join(dir, "config.json");
  if (!existsSync(configPath)) return initProject(root);
  return { root, dir, config: { ...DEFAULT_CONFIG, ...readConfig(configPath) } };
}

// Persist learned config back to disk (e.g. the start command/port we
// discovered while booting the server) so the next run doesn't re-guess.
export function saveConfig(project: Project, patch: Partial<ProjectConfig>): void {
  project.config = { ...project.config, ...patch };
  mkdirSync(project.dir, { recursive: true });
  writeFileSync(
    path.join(project.dir, "config.json"),
    JSON.stringify(project.config, null, 2) + "\n",
  );
}

export interface HistoryEntry {
  ts: string; // ISO timestamp, injected by caller
  files: number;
  blocking: number;
  advisories: number;
  checks: Record<string, number>;
}

// Append a run summary to the per-project trend log.
export function recordRun(project: Project, ts: string, findings: Finding[], files = 0): void {
  const checks: Record<string, number> = {};
  for (const f of findings) checks[f.id] = (checks[f.id] ?? 0) + 1;
  const entry: HistoryEntry = {
    ts,
    files,
    blocking: findings.filter((f) => f.disposition === "gate").length,
    advisories: findings.filter((f) => f.disposition === "advise").length,
    checks,
  };
  appendFileSync(path.join(project.dir, "history.jsonl"), JSON.stringify(entry) + "\n");
}

export function readHistory(project: Project): HistoryEntry[] {
  const p = path.join(project.dir, "history.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as HistoryEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is HistoryEntry => e !== null);
}

// A finding is "accepted" if a key matching it is in baseline.json. Re-runs
// can then surface only what's new — the lint-baseline pattern.
function findingKey(f: Finding): string {
  return `${f.id}:${f.file}:${f.line ?? ""}`;
}

export function readBaseline(project: Project): Set<string> {
  const p = path.join(project.dir, "baseline.json");
  if (!existsSync(p)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(p, "utf8")) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

export function isAccepted(project: Project, f: Finding): boolean {
  return readBaseline(project).has(findingKey(f));
}

export function reportsDir(project: Project): string {
  return path.join(project.dir, "reports");
}

export function profilePath(project: Project): string {
  return path.join(project.dir, "SHEPHERD.md");
}
