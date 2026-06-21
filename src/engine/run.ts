import pc from "picocolors";
import { ingest, type Repo } from "./ingest.js";
import { buildModel, type CodeModel } from "./ast.js";
import { codeQuality } from "./detectors/code-quality.js";
import { security } from "./detectors/security.js";
import { loadRules, applyRules } from "./rules/registry.js";
import { operationsChecks } from "./operations.js";
import { analyzeStructure } from "./structure.js";
import { betterPatterns } from "./idioms.js";
import { designPatterns } from "./design-patterns.js";
import { scaleAndResilience } from "./backend/scale.js";
import { frontendScale } from "./frontend/scale.js";
import { devopsChecks } from "./devops.js";
import { recordScan } from "./ledger.js";
import { printReport, dedupeFindings, type Finding } from "./report.js";

export interface ScanOptions {
  deep?: boolean;
}

export interface ScanResult {
  repo: Repo;
  model: CodeModel;
  findings: Finding[];
}

export async function scan(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const repo = await ingest(root);
  const model = buildModel(repo);

  // The canonical DETERMINISTIC sweep — every Tier-1 check, no network, no
  // Claude. This is what `shepherd scan`, the MCP tool, and fix-verification all
  // run, so they're complete and consistent. The full `shepherd` run layers the
  // Claude + empirical + network passes on top.
  const findings: Finding[] = dedupeFindings([
    ...security(repo), // secrets, cost-bomb, unauthed routes, localhost
    ...codeQuality(repo, model), // measurable SOLID (size, complexity, god-class)
    ...applyRules(repo, loadRules()), // community / AI-tool rule packs
    ...operationsChecks(repo, { audit: false }), // observability, .env hygiene, CI, Dockerfile
    ...analyzeStructure(repo).findings, // layer-vs-feature organization
    ...betterPatterns(repo, { deep: false }), // modern-idiom upgrades
    ...designPatterns(repo, { deep: false }), // design patterns + trade-offs
    ...scaleAndResilience(repo, { deep: false }), // scale/resilience heuristics
    ...frontendScale(repo, { deep: false }), // frontend-at-scale heuristics
    ...devopsChecks(repo), // DevOps: GitHub Actions, nginx, Jenkins, IaC, compose
  ]);

  if (opts.deep) {
    const { deepReview } = await import("./detectors/deep-review.js"); // tier 2 — Claude
    findings.push(...deepReview(repo));
  }

  return { repo, model, findings };
}

export async function run(root: string, opts: ScanOptions = {}): Promise<Finding[]> {
  const { repo, model, findings } = await scan(root, opts);

  console.log(
    pc.dim(
      `Scanned ${repo.files.length} files · ${model.functions.length} functions · ${model.classes.length} classes` +
        (repo.hasNext ? " · Next.js" : "") +
        (repo.hasSupabase ? " · Supabase" : "") +
        (opts.deep ? " · deep (Claude)" : ""),
    ),
  );
  printReport(findings);

  // feed the data flywheel (opt out with SHEPHERD_NO_LEDGER=1)
  try {
    if (!process.env.SHEPHERD_NO_LEDGER) recordScan(repo, findings);
  } catch {
    /* ledger is best-effort, never block a scan */
  }

  return findings;
}
