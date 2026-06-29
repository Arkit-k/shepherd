import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { loadProject, readHistory, profilePath } from "../project.js";
import type { Finding } from "../report.js";

// SEMANTIC memory — the living SHEPHERD.md. It used to be seeded once and left to
// rot ("No runs recorded yet"). Now Shepherd regenerates it after every run: a
// plain-English profile of the project's recurring soft spots, computed
// deterministically from the run history + the latest findings. It's injected
// into the brain's preamble so Shepherd recalls "what this repo keeps getting
// wrong" before it judges — and the user can read it to see what Shepherd knows.

interface ProfileInput {
  findings: Finding[];
  ts: string;
  stack?: string; // e.g. "TypeScript, Next.js"
  shape?: string; // e.g. "layered monolith"
}

// Aggregate how often each check has fired across history + this run, so a
// problem that shows up run after run rises to the top as a "recurring soft spot".
function recurringSoftSpots(root: string, current: Finding[]): { id: string; count: number; runs: number }[] {
  const project = loadProject(root);
  const history = readHistory(project); // past runs (this run not yet recorded)
  const total = new Map<string, number>();
  const runs = new Map<string, number>();

  for (const h of history) {
    for (const [id, n] of Object.entries(h.checks)) {
      total.set(id, (total.get(id) ?? 0) + n);
      runs.set(id, (runs.get(id) ?? 0) + 1);
    }
  }
  for (const f of current) total.set(f.id, (total.get(f.id) ?? 0) + 1);

  return [...total.entries()]
    .map(([id, count]) => ({ id, count, runs: runs.get(id) ?? 0 }))
    .sort((a, b) => b.runs - a.runs || b.count - a.count)
    .slice(0, 12);
}

export function updateProfile(root: string, input: ProfileInput): void {
  try {
    const project = loadProject(root);
    const spots = recurringSoftSpots(root, input.findings);
    const gates = input.findings.filter((f) => f.disposition === "gate").length;

    const spotLines = spots.length
      ? spots
          .map((s) => `- \`${s.id}\` — ${s.count} occurrence(s)${s.runs > 0 ? ` across ${s.runs} prior run(s)` : " (new this run)"}`)
          .join("\n")
      : "- (clean so far — nothing recurring)";

    const md = [
      "# Shepherd — project profile",
      "",
      "_Shepherd maintains this file. It records what it has learned about this project's",
      "architecture and recurring soft spots. Safe to read; it's regenerated each run._",
      "",
      `_Last updated: ${input.ts}_`,
      "",
      "## Architecture",
      "",
      `- Stack: ${input.stack ?? "—"}`,
      `- Shape: ${input.shape ?? "—"}`,
      "",
      "## Recurring soft spots",
      "",
      "_What this repo keeps getting flagged for — review these first._",
      "",
      spotLines,
      "",
      "## Last run",
      "",
      `- ${input.findings.length} finding(s), ${gates} blocking.`,
      "",
    ].join("\n");

    writeFileSync(profilePath(project), md);
  } catch {
    /* the profile is best-effort — never break a run over it */
  }
}

export function readProfile(root: string): string {
  try {
    const project = loadProject(root);
    const p = profilePath(project);
    if (existsSync(p)) return readFileSync(p, "utf8");
  } catch {
    /* ignore */
  }
  return "";
}
