#!/usr/bin/env node
import { Command } from "commander";
import { run } from "./engine/run.js";
import { fixLoop } from "./engine/loop.js";
import { claudeAvailable, ClaudeFixer } from "./engine/fixers/claude.js";
import { PlaceholderFixer } from "./engine/fixers/placeholder.js";
import { registerMcp } from "./init.js";
import { printBanner } from "./banner.js";
import type { Finding } from "./engine/report.js";

const program = new Command();
program
  .name("shepherd")
  .description("Production-readiness gate for AI-written code")
  .version("0.0.1");

// shepherd scan [path]   (default)
program
  .command("scan [path]", { isDefault: true })
  .description("Scan a repo for production-readiness issues")
  .option("--deep", "add a Claude-powered aggressive review of security-sensitive files")
  .action(async (p = ".", opts: { deep?: boolean }) => {
    await printBanner();
    const findings = await run(p, { deep: Boolean(opts.deep) });
    process.exitCode = findings.some((f) => f.disposition === "gate") ? 1 : 0;
  });

// shepherd fix [path] --with-tests
program
  .command("fix [path]")
  .description("Run the agent loop: detect → Claude fixes → re-verify until shipshape")
  .option("--max-iterations <n>", "max loop iterations", "5")
  .option("--with-tests", "also run the project's test suite as a gate")
  .option("--deep", "add a Claude-powered aggressive review each iteration")
  .action(async (p = ".", opts: { maxIterations: string; withTests?: boolean; deep?: boolean }) => {
    await printBanner();
    const fixer = claudeAvailable() ? new ClaudeFixer() : new PlaceholderFixer();
    if (fixer.name === "placeholder") {
      console.log("⚠️  Claude Code not found on PATH — running the loop in dry mode (no fixes applied).");
    }
    const gates: Finding[] = await fixLoop(p, fixer, {
      maxIterations: Number(opts.maxIterations),
      withTests: Boolean(opts.withTests),
      deep: Boolean(opts.deep),
    });
    process.exitCode = gates.some((f) => f.disposition === "gate") ? 1 : 0;
  });

// shepherd understand [path] [--deep]   (orient: tech stack + Claude architecture summary)
program
  .command("understand [path]")
  .description("Walk the codebase: tech stack (+ --deep for a Claude architecture summary)")
  .option("--deep", "add a Claude-written architecture summary + soft spots")
  .action(async (p = ".", opts: { deep?: boolean }) => {
    await printBanner();
    const { ingest } = await import("./engine/ingest.js");
    const { detectStack, printStack } = await import("./engine/tech-stack.js");
    const repo = await ingest(p);
    console.log(`Scanned ${repo.files.length} source files.`);
    printStack(detectStack(repo));

    if (opts.deep) {
      const { buildModel } = await import("./engine/ast.js");
      const { understandArchitecture } = await import("./engine/understand.js");
      console.log("\n🏗️  Architecture (Claude):\n");
      const summary = understandArchitecture(repo, buildModel(repo));
      if (summary) console.log(summary.trim() + "\n");
    }
  });

// shepherd modernity [path] [--deep]   (outdated deps + old code patterns)
program
  .command("modernity [path]")
  .description("Check for outdated dependencies (+ --deep for deprecated code patterns)")
  .option("--deep", "add a Claude review for old/deprecated code patterns")
  .action(async (p = ".", opts: { deep?: boolean }) => {
    const { ingest } = await import("./engine/ingest.js");
    const { outdatedDependencies, reviewModernity } = await import("./engine/modernity.js");
    const { printReport } = await import("./engine/report.js");
    const repo = await ingest(p);
    console.log("Checking dependency freshness against the npm registry …");
    const findings = await outdatedDependencies(repo);
    if (opts.deep) findings.push(...reviewModernity(repo));
    printReport(findings);
  });

// shepherd stats   (the data flywheel — what Shepherd has learned)
program
  .command("stats")
  .description("Show what Shepherd has learned across all scans (the data moat)")
  .action(async () => {
    const { readLedger, computeStats } = await import("./engine/ledger.js");
    const s = computeStats(readLedger());
    if (!s.scans) {
      console.log("No scans recorded yet. Run `shepherd scan` to start building the flywheel.");
      return;
    }
    console.log(`\n📈 Shepherd has run ${s.scans} scans across ${s.repos} repos — ${s.totalFindings} findings logged.`);
    console.log("\nMost common findings (the checklist, ranked by real-world frequency):");
    for (const c of s.checkFrequency.slice(0, 15)) {
      console.log(`  ${String(c.total).padStart(6)}  ${c.id.padEnd(22)} seen in ${c.scans} scan(s)`);
    }
    console.log("\nThis ranking is the moat: a code-cloner starts at zero.\n");
  });

// shepherd init   (register the MCP server with Claude Code)
program
  .command("init")
  .description("Register Shepherd's MCP server with Claude Code")
  .action(() => registerMcp());

program
  .command("hello")
  .description("Meet Shepherd 🐑")
  .action(() => printBanner(true));

program.parseAsync();
