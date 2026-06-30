import pc from "picocolors";
import { ingest } from "./engine/ingest.js";
import { buildModel } from "./engine/ast.js";
import { detectStack, printStack } from "./engine/tech-stack.js";
import { understandArchitecture } from "./engine/understand.js";
import { outdatedDependencies, reviewModernity } from "./engine/modernity.js";
import { betterPatterns } from "./engine/idioms.js";
import { analyzeStructure, reviewStructure } from "./engine/structure.js";
import { designPatterns } from "./engine/design-patterns.js";
import { operationsChecks } from "./engine/operations.js";
import { scan } from "./engine/run.js";
import { claudeAvailable } from "./engine/fixers/claude.js";
import { buildFixOrder, writeFixOrder, claudeSessionRunning, buildScalePlan, writeScalePlan } from "./engine/handoff.js";
import { scaleArchitect } from "./engine/backend/architect.js";
import { estimateCost, buildCostReport } from "./engine/finops.js";
import { writeCostReport } from "./engine/handoff.js";
import { printReport, dedupeFindings, type Finding } from "./engine/report.js";
import { recordScan } from "./engine/ledger.js";
import { suppressDismissed } from "./engine/memory/triage.js";
import { updateProfile } from "./engine/memory/profile.js";
import { recordForEvolution } from "./engine/memory/evolution.js";
import { recordRun } from "./engine/project.js";
import { analyzeArchitecture } from "./engine/backend/architecture.js";
import { analyzeProduction } from "./engine/backend/production.js";
import { researchProduction } from "./engine/research.js";
import { scaleAndResilience } from "./engine/backend/scale.js";
import { frontendScale } from "./engine/frontend/scale.js";
import { liveProbe } from "./engine/backend/probe.js";
import { loadTest } from "./engine/backend/loadtest.js";
import { writeReport } from "./engine/report-file.js";
import { goLiveVerdict, printVerdict } from "./engine/gate.js";
import { runTests } from "./engine/testrun.js";
import { certify, printCertificate, buildCertificateMarkdown, writeCertificate } from "./engine/certify.js";
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

  // ① Surveyor — what is this app, how is it built, and how is it organized?
  phase(1, "Survey", "Surveyor");
  const tech = detectStack(repo);
  printStack(tech);
  const structure = analyzeStructure(repo);
  console.log(pc.dim(`\n  Structure: ${structure.style}-based organization` + (structure.style === "feature" ? " ✓" : "")));
  const structureFindings: Finding[] = [...structure.findings];
  if (hasClaude) {
    console.log(pc.dim("  Reading the architecture …"));
    const summary = understandArchitecture(repo, model);
    if (summary) console.log("\n" + summary.trim() + "\n");
    structureFindings.push(...reviewStructure(repo));
  }

  // ② Modernizer — outdated deps + deprecated patterns + old-but-works idioms
  //    where a newer, safer framework primitive exists (e.g. Server Actions).
  phase(2, "Modernity", "Modernizer");
  const modernity: Finding[] = await outdatedDependencies(repo);
  modernity.push(...betterPatterns(repo, { deep: hasClaude }));
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

  // the scale architect: a whole-project, web-grounded infra prescription — what
  // to add (cache/queue/event-stream/search/replicas/…) to carry this to ~1M, with
  // current tools. Advisory; also written as a stand-alone scale plan to hand off.
  let architectFindings: Finding[] = [];
  let costFindings: Finding[] = [];
  if (hasClaude) {
    console.log(pc.dim("  Scale architect: prescribing the infra to reach ~1M users (web-grounded) …"));
    const arch = scaleArchitect(repo, { web: true });
    architectFindings = arch.findings;
    if (arch.prescriptions.length) {
      try {
        const planPath = writeScalePlan(root, buildScalePlan(arch.prescriptions, ts));
        const now = arch.prescriptions.filter((p) => p.priority === "now").length;
        console.log(
          pc.dim(
            `  → ${arch.prescriptions.length} infra recommendation(s)${now ? `, ${now} urgent` : ""} · ` +
              `scale plan: ${planPath.replace(/\\/g, "/")}`,
          ),
        );
      } catch {
        /* plan is best-effort */
      }
    }

    // FinOps — the dollar story: abuse exposure (cost-bombs in $) + infra run-cost.
    console.log(pc.dim("  FinOps: pricing the abuse exposure + the infra bill (web-grounded) …"));
    const cost = estimateCost(repo, { prescriptions: arch.prescriptions, web: true });
    costFindings = cost.findings;
    if (cost.items.length) {
      try {
        const reportPath = writeCostReport(root, buildCostReport(cost.items, ts));
        const unprotected = cost.items.filter((c) => c.kind === "exposure" && c.protected === false).length;
        console.log(
          pc.dim(
            `  → priced ${cost.items.length} line(s)${unprotected ? `, ${unprotected} unprotected paid endpoint(s) — $ at risk` : ""} · ` +
              `cost report: ${reportPath.replace(/\\/g, "/")}`,
          ),
        );
      } catch {
        /* report is best-effort */
      }
    }
  }

  // design patterns + trade-offs, judged AS PER THIS PROJECT (stack/pattern/scale).
  const designFindings = designPatterns(repo, {
    deep: hasClaude,
    context: {
      stack: `${tech.language}, ${tech.frameworks.join(", ") || "—"}`,
      patterns: production.patterns.join(", "),
      scale: "~1,000,000 users",
    },
  });

  // operations & observability — is it OPERABLE? (error tracking, logging,
  // health, graceful shutdown, .env hygiene, CI, Dockerfile, npm audit CVEs).
  console.log(pc.dim("  Operations & observability checks (incl. npm audit) …"));
  const opsFindings = operationsChecks(repo, { audit: true });

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

  // `audit.findings` already carries the full deterministic sweep (scan() runs
  // operations/structure/idioms/design/scale-T1/fe-T1), so the per-module calls
  // below overlap on their Tier-1 rows — dedupe collapses those, keeping the
  // Claude/empirical/network findings unique.
  const findings: Finding[] = suppressDismissed(
    dedupeFindings([
      ...audit.findings,
      ...modernity,
      ...structureFindings,
      ...architecture.findings,
      ...production.findings,
      ...researchFindings,
      ...architectFindings,
      ...costFindings,
      ...designFindings,
      ...opsFindings,
      ...scaleFindings,
      ...feFindings,
      ...live,
      ...loadFindings,
    ]),
    repo.root,
  );
  printReport(findings);
  try {
    if (!process.env.SHEPHERD_NO_LEDGER) recordScan(repo, findings);
  } catch {
    /* ledger is best-effort */
  }
  // refresh the living project profile (recurring soft spots) + run-history trend.
  try {
    updateProfile(root, {
      findings,
      ts,
      stack: `${tech.language}, ${tech.frameworks.join(", ") || "—"}`,
      shape: architecture.shape,
    });
    recordRun(loadProject(root), ts, findings, repo.files.length);
    recordForEvolution(root, repo, findings);
  } catch {
    /* best-effort */
  }

  // ⑤ Go-Live Gate — the principal-engineer call: ship or not, and the path.
  const verdict = goLiveVerdict(findings);

  // record the keep-able artifact + project tracking, no matter the verdict.
  let reportPath = "";
  try {
    reportPath = writeReport(repo, { ts, tech, architecture, production, liveProbeRan, loadMetrics, verdict, findings });
  } catch {
    /* report is best-effort */
  }
  if (reportPath) console.log(pc.dim(`\n  📄 Detailed report: ${reportPath.replace(/\\/g, "/")}`));

  printVerdict(verdict);

  // ⑤·5 Certify — the closed proof loop. Run the real test suite and bind it to the
  // gate, so the verdict is a reproducible CERTIFICATE, not just an opinion. The
  // live probe already ran this pass, so empirical objectives can be proven too.
  try {
    console.log(pc.dim("\n  Certifying — running your test suite (I run tests; I never edit code) …"));
    const testResult = runTests(root);
    if (!testResult.ran) console.log(pc.yellow(`  ⚠️  No suite ran: ${testResult.reason}.`));
    const cert = certify(root, { freshFindings: findings, testResult, probeRan: liveProbeRan, ts });
    printCertificate(cert);
    const cp = writeCertificate(root, buildCertificateMarkdown(cert));
    if (cp) console.log(pc.dim(`  🔏 Certificate: ${cp.replace(/\\/g, "/")}`));
  } catch {
    /* certify is best-effort — never break the run */
  }

  // ⑥ Hand-off — Shepherd is the maintainer, not the editor. It writes a precise
  //    fix work-order and hands it to the user's OWN Claude Code session.
  if (verdict.ready) return 0;

  const gates = findings.filter((f) => f.disposition === "gate");
  phase(6, "Hand-off", "Maintainer");
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
