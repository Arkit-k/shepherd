import pc from "picocolors";
import { ingest } from "./ingest.js";
import { scan } from "./run.js";
import { architectureSpec, writeArchitectureSpec } from "./spec.js";
import { rightSizing } from "./rightsizing.js";
import { runTests } from "./testrun.js";
import { certify, buildCertificateMarkdown, writeCertificate, printCertificate, type Certificate } from "./certify.js";
import { releaseReadiness, printReleaseReadiness, buildDeployOrder, writeDeployOrder, type ReleaseReadiness } from "./release.js";
import type { Finding } from "./report.js";
import type { InfraPrescription } from "./backend/architect.js";
import type { LoopChoices } from "./intent.js";

// THE AUTONOMOUS LOOP — design → right-size → certify → release, run end to end
// against the user's declared intent. The intake (in the shell) gathers the user's
// choices; this runs the four stages with them. Shepherd still never writes the
// code — between "design" and "certify" the user's Claude Code does the building.

function header(n: string, title: string): void {
  console.log("\n" + pc.bold(pc.whiteBright(`  ${n}  ${title}`)));
  console.log(pc.dim("  " + "─".repeat(50)));
}

export interface LoopResult {
  specPath: string;
  overeng: Finding[];
  certificate: Certificate;
  release: ReleaseReadiness;
  findings: Finding[];
}

export async function runLoop(
  root: string,
  opts: { web?: boolean; choices?: LoopChoices; prescriptions?: InfraPrescription[] } = {},
): Promise<LoopResult> {
  const web = opts.web ?? true;
  const choices = opts.choices;
  const repo = await ingest(root);
  const ts = new Date().toISOString();

  // ① DESIGN — author the blueprint, built to the user's chosen architecture + infra.
  header("①", "Design — the blueprint to build to");
  const spec = architectureSpec(repo, { web, choices, prescriptions: opts.prescriptions });
  const specPath = writeArchitectureSpec(root, spec.markdown);
  console.log(`  🏗  Target: ${pc.bold(spec.targetPattern)}`);
  if (spec.prescriptions.length) console.log(pc.dim(`  Infra in the plan: ${spec.prescriptions.map((p) => p.component).join(", ")}`));
  console.log(pc.dim(`  spec → ${specPath.replace(/\\/g, "/")}`));

  // ② RIGHT-SIZE — don't over-build it; calibrated to the declared scale.
  header("②", "Right-size — don't over-build it");
  const overeng = rightSizing(repo, { deep: web, scale: choices?.scale });
  if (overeng.length === 0) {
    console.log(pc.green("  Right-sized — nothing flagged as over-engineering for this scale."));
  } else {
    for (const f of overeng) console.log(`  ${f.severity === "warn" ? "🟡" : "🔵"} ${pc.dim(f.file)} ${f.message.split(/[.—]/)[0]}.`);
  }

  // ③ CERTIFY — prove it (fresh deep scan + run the real test suite).
  header("③", "Certify — prove it");
  const scanRes = await scan(root, { deep: web });
  const testResult = runTests(root);
  console.log(
    testResult.ran
      ? testResult.passed
        ? pc.green(`  ✓ tests green (${testResult.command})`)
        : pc.red(`  ✗ tests red (${testResult.command})`)
      : pc.yellow(`  ⚠ no tests run — ${testResult.reason}`),
  );
  const certificate = certify(root, { freshFindings: scanRes.findings, testResult, probeRan: false, ts });
  printCertificate(certificate);
  try {
    writeCertificate(root, buildCertificateMarkdown(certificate));
  } catch {
    /* best-effort */
  }

  // ④ RELEASE — ship only the proven build.
  header("④", "Release — ship only the proven build");
  const release = releaseReadiness(root);
  printReleaseReadiness(release);
  if (!release.hasPipeline && release.isRepo) {
    try {
      const dp = writeDeployOrder(root, buildDeployOrder(ts, choices?.deployTarget));
      console.log(pc.dim(`  No deploy pipeline yet → wrote a gated CI/CD work-order to ${dp.replace(/\\/g, "/")}.`));
    } catch {
      /* best-effort */
    }
  }

  return { specPath, overeng, certificate, release, findings: scanRes.findings };
}
