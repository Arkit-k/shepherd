import pc from "picocolors";
import { scan } from "./run.js";
import { runTests } from "./tests.js";
import { printReport, type Finding } from "./report.js";
import type { Fixer } from "./fixers/types.js";

export interface LoopOptions {
  maxIterations?: number;
  withTests?: boolean;
  deep?: boolean;
}

// The coder ↔ verifier loop. detect (+ optionally run tests) → fix blocking
// findings grouped by file → re-verify → repeat, until a stopping condition.
export async function fixLoop(
  root: string,
  fixer: Fixer,
  opts: LoopOptions = {},
): Promise<Finding[]> {
  const maxIterations = opts.maxIterations ?? 5;
  const withTests = opts.withTests ?? false;
  const deep = opts.deep ?? false;
  let prevSignature = "";

  console.log(
    pc.dim(`fix loop — fixer: ${fixer.name}, max ${maxIterations}${withTests ? ", +tests" : ""}`),
  );

  for (let i = 1; i <= maxIterations; i++) {
    const { findings } = await scan(root, { deep });
    const gates: Finding[] = findings.filter((f) => f.disposition === "gate");

    // verification: run the project's tests; a failing suite is a gate.
    if (withTests) {
      const t = runTests(root);
      if (t.ran && !t.passed) {
        gates.push({
          id: "tests-failing",
          severity: "critical",
          disposition: "gate",
          file: "(test suite)",
          message: t.output || "Tests failed.",
        });
      }
    }

    console.log(
      pc.bold(`\n── iteration ${i}/${maxIterations} — `) +
        (gates.length ? pc.red(`${gates.length} blocking`) : pc.green("clean")) +
        pc.bold(" ──"),
    );

    // STOP 1 — success.
    if (gates.length === 0) {
      console.log(pc.green("✅ All gates clear" + (withTests ? " and tests pass" : "") + " — shipshape."));
      return findings;
    }

    // STOP 2 — no progress (same gates as last round). For tests, the output
    // length stands in for "did anything change".
    const signature = gates
      .map((g) => (g.id === "tests-failing" ? `tests:${g.message.length}` : `${g.id}:${g.file}:${g.line ?? ""}`))
      .sort()
      .join("|");
    if (signature === prevSignature) {
      console.log(pc.yellow("⚠️  No progress since last iteration — stopping. Remaining gates need a human."));
      printReport(gates);
      return gates;
    }
    prevSignature = signature;

    // FEEDBACK — group blocking findings by file; one fixer call per file.
    const byFile = new Map<string, Finding[]>();
    for (const g of gates) {
      const arr = byFile.get(g.file) ?? [];
      arr.push(g);
      byFile.set(g.file, arr);
    }

    let applied = 0;
    for (const [file, fileFindings] of byFile) {
      const res = await fixer.fixFile(file, fileFindings, root);
      if (res.changed) {
        applied++;
        console.log(pc.cyan(`  ✎ fixed  ${file}`));
      } else {
        console.log(pc.dim(`  · skip   ${file}  (${res.reason ?? "no fix"})`));
      }
    }

    // STOP 3 — fixer changed nothing.
    if (applied === 0) {
      console.log(pc.yellow("\n⚠️  Fixer applied no changes — stopping."));
      printReport(gates);
      return gates;
    }
  }

  // STOP 4 — budget exhausted.
  console.log(pc.yellow(`\n⚠️  Hit max iterations (${maxIterations}) — stopping.`));
  const { findings } = await scan(root, { deep });
  return findings.filter((f) => f.disposition === "gate");
}
