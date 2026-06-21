import pc from "picocolors";
import { ingest, type Repo } from "./ingest.js";
import { buildModel, type CodeModel } from "./ast.js";
import { codeQuality } from "./detectors/code-quality.js";
import { security } from "./detectors/security.js";
import { loadRules, applyRules } from "./rules/registry.js";
import { recordScan } from "./ledger.js";
import { printReport, type Finding } from "./report.js";

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

  const findings: Finding[] = [
    ...security(repo), // tier 1 — pattern
    ...codeQuality(repo, model), // tier 1 — measurable SOLID
    ...applyRules(repo, loadRules()), // tier 1 — community / AI-tool rule packs
  ];

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
