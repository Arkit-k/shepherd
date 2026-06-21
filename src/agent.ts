import pc from "picocolors";
import { ingest } from "./engine/ingest.js";
import { buildModel } from "./engine/ast.js";
import { detectStack, printStack } from "./engine/tech-stack.js";
import { understandArchitecture } from "./engine/understand.js";
import { outdatedDependencies, reviewModernity } from "./engine/modernity.js";
import { scan } from "./engine/run.js";
import { claudeAvailable } from "./engine/fixers/claude.js";
import { buildFixOrder, writeFixOrder, claudeSessionRunning } from "./engine/handoff.js";
import { printReport, type Finding } from "./engine/report.js";
import { recordScan } from "./engine/ledger.js";
import { analyzeArchitecture } from "./engine/backend/architecture.js";
import { analyzeProduction } from "./engine/backend/production.js";
import { researchProduction } from "./engine/research.js";
import { scaleAndResilience } from "./engine/backend/scale.js";
import { frontendScale } from "./engine/frontend/scale.js";
import { liveProbe } from "./engine/backend/probe.js";
import { loadTest } from "./engine/backend/loadtest.js";
import { writeReport } from "./engine/report-file.js";
import { loadProject } from "./engine/project.js";

interface AgentOptions {
  // reserved for future flags; Shepherd never edits code itself.
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
// `shepherd` and walks away. Shepherd surveys, audits, and stress-tests the
// repo, then hands a precise fix work-order to the user's OWN Claude Code
// session. Shepherd is the maintainer; it never edits the code itself.
export async function runAgent(root = ".", _opts: AgentOptions = {}): Promise<number> {
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
  phase(4, "Backend & Production-Readiness", "Architect · Prod-Engineer · Stress · Striker");
  console.log(pc.dim("  Classifying the backend and checking it scales / tolerates failure …"));
  const architecture = analyzeArchitecture(repo);
  console.log(
    pc.dim(`  Shape: ${architecture.shape} · Comms: ${architecture.comms.join(", ") || "REST/HTTP"}`),
  );

  // think like a production engineer: what does the actual pattern require at 1M?
  const production = analyzeProduction(repo);
  console.log(
    pc.dim(
      `  Pattern: ${production.patterns.join(", ")} · ` +
        `broker:${production.infra.broker ?? "—"} queue:${production.infra.taskQueue ?? "—"} ` +
        `cache:${production.infra.cache ?? "—"} pool:${production.infra.pooling ? "yes" : "—"}`,
    ),
  );

  // research the live internet (one low-context call) like a principal engineer:
  // current versions, today's best-practice tooling, known advisories.
  let researchFindings: Finding[] = [];
  if (hasClaude) {
    console.log(pc.dim("  Researching current best practice on the web (this one's slower) …"));
    researchFindings = researchProduction(repo, {
      tech,
      patterns: production.patterns,
      infra: production.infra,
    });
  }

  const scaleFindings = scaleAndResilience(repo, { deep: hasClaude });
  const feFindings = frontendScale(repo, { deep: hasClaude });
  const live = await liveProbe(repo);
  const liveProbeRan = live.length > 0 || true; // attempted; probe logs if skipped

  // what the detected pattern is MISSING for production — fed to the projection.
  const missingInfra: string[] = [];
  if (!production.infra.broker && production.patterns.includes("event-driven"))
    missingInfra.push("a real message broker (Kafka/RabbitMQ)");
  if (!production.infra.taskQueue && production.patterns.some((p) => p.startsWith("task-queue")))
    missingInfra.push("a job queue + worker (BullMQ/Celery)");
  if (!production.infra.cache) missingInfra.push("a cache (Redis)");
  if (!production.infra.pooling && production.infra.database) missingInfra.push("DB connection pooling");

  // Docker stands up real deps + bounded load test (auto; self-skips if no Docker).
  console.log(pc.dim("\n  Load test (Docker + bounded ramp) …"));
  const { findings: loadFindings, metrics: loadMetrics } = await loadTest(repo, missingInfra);

  const findings: Finding[] = [
    ...audit.findings,
    ...architecture.findings,
    ...production.findings,
    ...researchFindings,
    ...scaleFindings,
    ...feFindings,
    ...live,
    ...loadFindings,
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
    reportPath = writeReport(repo, { ts, tech, architecture, production, liveProbeRan, loadMetrics, findings });
  } catch {
    /* report is best-effort */
  }
  if (reportPath) console.log(pc.dim(`\n  📄 Detailed report: ${reportPath.replace(/\\/g, "/")}`));

  const gates = findings.filter((f) => f.disposition === "gate");

  // ⑤ Hand-off — Shepherd is the maintainer, not the editor. It writes a precise
  //    fix work-order and hands it to the user's OWN Claude Code session.
  if (gates.length === 0) {
    console.log(pc.green("\n  ✅ No blocking issues. Shepherd says: shipshape.\n"));
    return 0;
  }

  phase(5, "Hand-off", "Maintainer");
  let orderPath = ".shepherd/fix-order.md";
  try {
    orderPath = writeFixOrder(root, buildFixOrder(gates, ts));
  } catch {
    /* best-effort */
  }
  const sessionLive = claudeSessionRunning();

  console.log(
    pc.dim(
      `  Shepherd doesn't edit your code — it wrote a fix work-order for your Claude Code\n` +
        `  session to execute, so every change stays under your review.\n`,
    ),
  );
  console.log(`  📝 Work-order: ${pc.bold(orderPath.replace(/\\/g, "/"))} (${gates.length} blocking)`);
  console.log(
    pc.bold("\n  Hand it to your Claude Code session:") +
      (sessionLive ? pc.green("  (a Claude session is running ✓)") : "") +
      "\n" +
      pc.dim("    • In your open session, say:  ") +
      pc.whiteBright(`apply the fixes in ${orderPath.replace(/\\/g, "/")}`) +
      "\n" +
      pc.dim("    • Or, if Shepherd's MCP is wired (`shepherd init`):  ") +
      pc.whiteBright("ask Claude to “get the shepherd fix order and apply it”") +
      "\n",
  );
  return 1;
}
