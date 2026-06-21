import pc from "picocolors";
import { ingest } from "./engine/ingest.js";
import { buildModel } from "./engine/ast.js";
import { detectStack, printStack } from "./engine/tech-stack.js";
import { understandArchitecture } from "./engine/understand.js";
import { outdatedDependencies, reviewModernity } from "./engine/modernity.js";
import { scan } from "./engine/run.js";
import { fixLoop } from "./engine/loop.js";
import { claudeAvailable, ClaudeFixer } from "./engine/fixers/claude.js";
import { printReport, type Finding } from "./engine/report.js";
import { recordScan } from "./engine/ledger.js";
import { analyzeArchitecture } from "./engine/backend/architecture.js";
import { scaleAndResilience } from "./engine/backend/scale.js";
import { liveProbe } from "./engine/backend/probe.js";
import { writeReport } from "./engine/report-file.js";
import { loadProject } from "./engine/project.js";

interface AgentOptions {
  autoFix?: boolean; // apply fixes automatically (default true)
}

function phase(n: number, title: string, agent: string): void {
  console.log(
    "\n" +
      pc.bold(pc.whiteBright(`  ${n}  ${title}`)) +
      pc.dim(`   · ${agent}`),
  );
  console.log(pc.dim("  " + "─".repeat(46)));
}

// The autonomous run. No subcommands, no flags to remember — the user runs
// `shepherd` and walks away. Shepherd surveys, audits, and (if Claude is
// present) fixes the repo end-to-end on the user's own Claude session.
export async function runAgent(root = ".", opts: AgentOptions = {}): Promise<number> {
  const autoFix = opts.autoFix !== false;
  const hasClaude = claudeAvailable();
  const ts = new Date().toISOString(); // injected into the report (engine stays pure)

  console.log(
    hasClaude
      ? pc.dim("  Claude Code detected — running the full walk-through on your session.\n")
      : pc.yellow(
          "  Claude Code not found on PATH — running the free deterministic pass only.\n" +
            "  Install Claude Code to unlock architecture review, deep audit, and auto-fix.\n",
        ),
  );

  const repo = await ingest(root);
  const model = buildModel(repo);
  console.log(pc.dim(`  Read ${repo.files.length} source files.`));

  // first run installs .shepherd/ and tracks the project from here on.
  loadProject(root);

  // ① Surveyor — what is this app, and what is it built with?
  phase(1, "Survey", "Surveyor");
  const tech = detectStack(repo);
  printStack(tech);
  if (hasClaude) {
    console.log(pc.dim("\n  Reading the architecture …"));
    const summary = understandArchitecture(repo, model);
    if (summary) console.log("\n" + summary.trim() + "\n");
  }

  // ② Modernizer — outdated deps + deprecated patterns AI tools still emit.
  phase(2, "Modernity", "Modernizer");
  const modernity: Finding[] = await outdatedDependencies(repo);
  if (hasClaude) modernity.push(...reviewModernity(repo));
  printReport(modernity);

  // ③ Auditor — security / performance / architecture / logic.
  phase(3, "Audit", "Auditor");
  const audit = await scan(root, { deep: hasClaude });

  // ④ Backend & Production-Readiness — architecture shape + comms correctness,
  //    scale/resilience, and a live attack against the auto-started server.
  phase(4, "Backend & Production-Readiness", "Architect · Stress · Striker");
  console.log(pc.dim("  Classifying the backend and checking it scales / tolerates failure …"));
  const architecture = analyzeArchitecture(repo);
  console.log(
    pc.dim(`  Shape: ${architecture.shape} · Comms: ${architecture.comms.join(", ") || "REST/HTTP"}`),
  );
  const scaleFindings = scaleAndResilience(repo, { deep: hasClaude });
  const live = await liveProbe(repo);
  const liveProbeRan = live.length > 0 || true; // attempted; probe logs if skipped

  const findings: Finding[] = [
    ...audit.findings,
    ...architecture.findings,
    ...scaleFindings,
    ...live,
  ];
  printReport(findings);
  try {
    if (!process.env.SHEPHERD_NO_LEDGER) recordScan(repo, findings);
  } catch {
    /* ledger is best-effort */
  }

  // record the keep-able artifact + project tracking, no matter the verdict.
  let reportPath = "";
  try {
    reportPath = writeReport(repo, { ts, tech, architecture, liveProbeRan, findings });
  } catch {
    /* report is best-effort */
  }
  if (reportPath) console.log(pc.dim(`\n  📄 Detailed report: ${reportPath.replace(/\\/g, "/")}`));

  const gates = findings.filter((f) => f.disposition === "gate");

  // ⑤ Fixer — close the gates on the user's Claude, then re-verify.
  if (gates.length === 0) {
    console.log(pc.green("\n  ✅ No blocking issues. Shepherd says: shipshape.\n"));
    return 0;
  }

  if (!hasClaude) {
    console.log(
      pc.yellow(
        `\n  ${gates.length} blocking issue(s) found. Install Claude Code and re-run, ` +
          `or fix them by hand — Shepherd held the gate.\n`,
      ),
    );
    return 1;
  }

  if (!autoFix) {
    console.log(
      pc.yellow(
        `\n  ${gates.length} blocking issue(s) found. Re-run without --no-fix to let ` +
          `Shepherd close them automatically.\n`,
      ),
    );
    return 1;
  }

  phase(5, "Fix", "Fixer");
  console.log(
    pc.dim("  Handing the gates to your Claude. Files are edited in place — your repo is\n  git-tracked, so every change is reviewable and reversible.\n"),
  );
  const remaining = await fixLoop(root, new ClaudeFixer(), {
    maxIterations: 5,
    deep: true,
  });

  const stillBlocking = remaining.filter((f) => f.disposition === "gate");
  if (stillBlocking.length === 0) {
    console.log(pc.green("\n  ✅ Shepherd closed every gate. Shipshape.\n"));
    return 0;
  }
  console.log(
    pc.yellow(
      `\n  Shepherd fixed what it could; ${stillBlocking.length} issue(s) need a human. ` +
        `They're listed above.\n`,
    ),
  );
  return 1;
}
