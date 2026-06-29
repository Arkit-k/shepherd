import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { loadProject } from "./project.js";
import { verifyMethod } from "./verify.js";
import type { Finding } from "./report.js";

// Shepherd is the maintainer, not the editor. It never spawns its own headless
// claude to change code. Instead it writes a precise fix WORK-ORDER (the prompt)
// and hands it to the user's own running Claude Code session, which does the
// edits under the user's eye. This module builds + persists that work-order.

const ORDER_FILE = "fix-order.md";

// Group blocking findings by file and turn them into a precise, minimal-diff
// instruction the user's Claude Code session can execute verbatim.
export function buildFixOrder(gates: Finding[], ts: string): string {
  const byFile = new Map<string, Finding[]>();
  for (const g of gates) {
    const arr = byFile.get(g.file) ?? [];
    arr.push(g);
    byFile.set(g.file, arr);
  }

  let anyJudgment = false;
  const sections: string[] = [];
  let n = 0;
  for (const [file, findings] of byFile) {
    n++;
    const items = findings
      .map((f) => {
        const judgment = verifyMethod(f) === "claude";
        if (judgment) anyJudgment = true;
        const tag = judgment ? " ⚠️" : "";
        return `   - [${f.id}${f.line ? ` · line ${f.line}` : ""}]${tag} ${f.message}`;
      })
      .join("\n");
    sections.push(`${n}. **\`${file}\`**\n${items}`);
  }

  const verifyNote = anyJudgment
    ? [
        `**Verifying your fixes:**`,
        `- Most gates re-confirm with \`npx shepherd scan\` — the same deterministic check re-runs and must come back clean.`,
        `- Items marked ⚠️ are model-judgment findings with **no deterministic re-check**. A passing plain \`scan\` does NOT prove these are fixed — re-verify them by re-running the full \`npx shepherd\` audit (a fresh model review) or a human read.`,
      ]
    : [`After editing, run \`npx shepherd scan\` — the same checks re-run and must come back clean.`];

  return [
    `# Shepherd — fix work-order`,
    ``,
    `_Generated ${ts}. ${gates.length} blocking issue(s). Shepherd found these; you apply them._`,
    ``,
    `You are fixing production-readiness gates in this repo. Work through each file below.`,
    `Apply the **minimal** change for each issue — do not refactor, reformat, or touch anything unrelated.`,
    ``,
    ...verifyNote,
    ``,
    ...sections,
    ``,
    `When every gate above is closed, re-run \`npx shepherd\` for a fresh audit.`,
    ``,
  ].join("\n");
}

// Persist the work-order into the project's .shepherd/ folder. Returns the path
// relative to the repo root.
export function writeFixOrder(root: string, order: string): string {
  const project = loadProject(root);
  const abs = path.join(project.dir, ORDER_FILE);
  writeFileSync(abs, order);
  return path.relative(root, abs);
}

// The test work-order — the same hand-off model as fixes, for tests. Shepherd
// designs the essential test cases (everything essential deserves a test) and
// writes the order; the user's Claude Code session creates the files. Shepherd
// designs, it does not write the code.
export function writeTestOrder(root: string, order: string): string {
  const project = loadProject(root);
  const abs = path.join(project.dir, "test-order.md");
  writeFileSync(abs, order);
  return path.relative(root, abs);
}

// The SCALE PLAN — the architect's roadmap to ~1M users. Same hand-off model:
// Shepherd prescribes the infrastructure (what + which tool + where it plugs in),
// the user's own Claude Code session wires it. Grouped by priority so the user
// knows what falls over first. Shepherd prescribes; it does not install.
export function buildScalePlan(
  prescriptions: import("./backend/architect.js").InfraPrescription[],
  ts: string,
): string {
  const order: Array<["now" | "soon" | "later", string]> = [
    ["now", "🔴 Now — will fall over before 1M without this"],
    ["soon", "🟡 Soon — needed as traffic ramps"],
    ["later", "🔵 Later — headroom for the next order of magnitude"],
  ];

  const sections: string[] = [];
  let n = 0;
  for (const [pri, heading] of order) {
    const group = prescriptions.filter((p) => p.priority === pri);
    if (group.length === 0) continue;
    sections.push(`## ${heading}\n`);
    for (const p of group) {
      n++;
      const lines = [
        `${n}. **${p.recommendation}** — _${p.component}_${p.effort ? ` · ~${p.effort}` : ""}`,
        `   - **Why here:** ${p.need}`,
        ...(p.where ? [`   - **Plugs into:** \`${p.where}\``] : []),
        ...(p.alternatives?.length ? [`   - **Alternatives:** ${p.alternatives.join(", ")}`] : []),
        ...(p.source ? [`   - **Reference:** ${p.source}`] : []),
      ];
      sections.push(lines.join("\n"));
    }
    sections.push("");
  }

  return [
    `# Shepherd — scale plan (road to ~1,000,000 users)`,
    ``,
    `_Generated ${ts}. ${prescriptions.length} infrastructure recommendation(s), researched against`,
    `current best practice. Shepherd prescribed these; you wire them — one minimal, reviewable change at a time._`,
    ``,
    `Each item is the infrastructure the workload in THIS repo will need. Tackle the 🔴 Now items first;`,
    `they're the ones that break under real load. Don't add what you don't yet have evidence for.`,
    ``,
    ...sections,
    `When you've wired an item, re-run \`npx shepherd\` (or ask me to "review the scale") for a fresh read.`,
    ``,
  ].join("\n");
}

export function writeScalePlan(root: string, plan: string): string {
  const project = loadProject(root);
  const abs = path.join(project.dir, "scale-plan.md");
  writeFileSync(abs, plan);
  return path.relative(root, abs);
}

// The cost report — the FinOps dollar story (abuse exposure + infra run-cost).
export function writeCostReport(root: string, report: string): string {
  const project = loadProject(root);
  const abs = path.join(project.dir, "cost-report.md");
  writeFileSync(abs, report);
  return path.relative(root, abs);
}

export function readFixOrder(root: string): string | null {
  const abs = path.join(root, ".shepherd", ORDER_FILE);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// Best-effort: is a Claude Code session already running somewhere? We can't
// inject into it (Claude Code exposes no stdin/IPC for live sessions), but we
// can tell the user it's there and ready to receive the hand-off.
export function claudeSessionRunning(): boolean {
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /NH', { encoding: "utf8" });
      if (/claude\.exe/i.test(out)) return true;
      // claude often runs under node; look for a claude code process by window title
      const wt = execSync("tasklist /V /FI \"IMAGENAME eq node.exe\" /NH", { encoding: "utf8" });
      return /claude/i.test(wt);
    }
    const out = execSync("ps -eo args 2>/dev/null | grep -i '[c]laude' || true", { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
