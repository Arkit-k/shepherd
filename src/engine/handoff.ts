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
