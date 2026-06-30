import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadProject } from "./project.js";
import type { Finding } from "./report.js";
import { goLiveVerdict, type Blocker } from "./gate.js";
import { verifyMethod, type VerifyMethod } from "./verify.js";
import { type TestResult, testSummary } from "./testrun.js";

// THE CLOSED VERIFY-WITH-PROOF LOOP — the foundation of the guarantee.
//
// Shepherd no longer just finds → writes order → done. It holds the open gates as
// STATE (the objectives ledger, .shepherd/objectives.json), and after the user's
// Claude Code applies the fixes, Shepherd RE-CHECKS each one against fresh evidence
// (a fresh scan, and the real test suite). Only objectives with fresh passing
// evidence flip to ✅. The result is a CERTIFICATE: N objective checks proven, each
// with the exact command to reproduce it — a measurement the user can re-run, not
// an opinion. That reproducibility is what earns trust.

export type ObjectiveState = "open" | "passed" | "failed" | "unverifiable";

export interface Evidence {
  command?: string; // the reproducible command that produced this evidence
  passed: boolean;
  detail: string;
  ts: string;
  method: VerifyMethod;
}

export interface Objective {
  id: string; // stable slug of the blocker title
  title: string;
  method: VerifyMethod; // how this objective can be re-checked
  files: string[];
  findingIds: string[];
  state: ObjectiveState;
  openedTs: string;
  verifiedTs?: string;
  evidence: Evidence[];
}

export interface Ledger {
  objectives: Objective[];
  updatedTs: string;
}

const FILE = "objectives.json";

function ledgerPath(root: string): string {
  return path.join(loadProject(root).dir, FILE);
}

export function loadLedger(root: string): Ledger {
  const p = ledgerPath(root);
  if (!existsSync(p)) return { objectives: [], updatedTs: "" };
  try {
    const l = JSON.parse(readFileSync(p, "utf8")) as Ledger;
    if (!Array.isArray(l.objectives)) return { objectives: [], updatedTs: "" };
    return l;
  } catch {
    return { objectives: [], updatedTs: "" };
  }
}

function saveLedger(root: string, l: Ledger): void {
  try {
    writeFileSync(ledgerPath(root), JSON.stringify(l, null, 2) + "\n");
  } catch {
    /* ledger is best-effort — never break a certify run */
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 64);
}

// A blocker collapses several findings; its objective is verified by the EASIEST
// re-checkable of them (deterministic is the most trustworthy anchor).
const RANK: Record<VerifyMethod, number> = { deterministic: 0, inventory: 1, empirical: 2, claude: 3 };
function blockerMethod(b: Blocker): VerifyMethod {
  let best: VerifyMethod = "claude";
  for (const f of b.findings) {
    const m = verifyMethod(f);
    if (RANK[m] < RANK[best]) best = m;
  }
  return best;
}

const REPRO: Record<VerifyMethod, string> = {
  deterministic: "npx shepherd  (re-scan re-runs the same check)",
  inventory: "npx shepherd  (re-scan confirms the dep/config is present)",
  empirical: "npx shepherd  (re-runs the live probe against the running app)",
  claude: "npx shepherd  (a fresh deep re-review — no deterministic anchor)",
};

// Open (or refresh) objectives from a verdict's blockers. Called at audit time so
// the gates are tracked the moment they're found; re-callable to register newly
// appeared blockers (regressions) without losing the proven history.
export function openObjectives(root: string, blockers: Blocker[], ts: string): Ledger {
  const l = loadLedger(root);
  const byId = new Map(l.objectives.map((o) => [o.id, o]));
  for (const b of blockers) {
    const id = slug(b.title);
    const existing = byId.get(id);
    if (existing) {
      // a previously proven objective that reappears = a regression.
      if (existing.state === "passed") {
        existing.state = "failed";
        existing.verifiedTs = ts;
        existing.evidence.push({ passed: false, detail: "regressed — this blocker reappeared after being proven closed", ts, method: existing.method });
      }
      continue;
    }
    const o: Objective = {
      id,
      title: b.title,
      method: blockerMethod(b),
      files: b.files,
      findingIds: [...new Set(b.findings.map((f) => f.id))],
      state: "open",
      openedTs: ts,
      evidence: [],
    };
    l.objectives.push(o);
    byId.set(id, o);
  }
  l.updatedTs = ts;
  saveLedger(root, l);
  return l;
}

export interface CertifyInput {
  freshFindings: Finding[]; // from a FRESH scan (deep, ideally)
  testResult: TestResult;
  probeRan?: boolean; // did this pass actually re-run the live probe?
  ts: string;
}

export interface Certificate {
  certified: boolean;
  objectives: Objective[];
  tests: TestResult;
  proven: number;
  failed: number;
  pending: number;
  summary: string;
  ts: string;
}

// Verify the open objectives against fresh evidence and produce the certificate.
// An objective passes only if its blocker is ABSENT from a fresh scan — and, for
// empirical objectives, only if the live probe actually re-ran this pass (else we
// stay honest: "not seen, but unproven without the probe").
export function certify(root: string, input: CertifyInput): Certificate {
  const { freshFindings, testResult, probeRan, ts } = input;
  const verdict = goLiveVerdict(freshFindings);
  const liveTitles = new Set(verdict.blockers.map((b) => b.title));

  // Register current blockers (covers cold-start certify with no prior audit, and
  // newly appeared regressions). Then verify every non-passed objective.
  let l = openObjectives(root, verdict.blockers, ts);

  for (const o of l.objectives) {
    if (o.state === "passed") continue;
    const stillThere = liveTitles.has(o.title);
    if (stillThere) {
      o.state = "failed";
      o.verifiedTs = ts;
      o.evidence.push({ command: REPRO[o.method], passed: false, detail: "still detected in a fresh scan", ts, method: o.method });
      continue;
    }
    // Absent from a fresh scan. Whether that PROVES the fix depends on the method.
    if (o.method === "empirical" && !probeRan) {
      o.state = "unverifiable";
      o.verifiedTs = ts;
      o.evidence.push({
        command: REPRO.empirical,
        passed: false,
        detail: "not seen in the static pass, but this needs a live-probe re-run to prove — run `npx shepherd`",
        ts,
        method: "empirical",
      });
      continue;
    }
    o.state = "passed";
    o.verifiedTs = ts;
    o.evidence.push({
      command: REPRO[o.method],
      passed: true,
      detail: o.method === "claude" ? "absent on a fresh deep re-review (model judgment — verify with a human for full certainty)" : "absent on a fresh re-scan",
      ts,
      method: o.method,
    });
  }
  l.updatedTs = ts;
  saveLedger(root, l);

  const objectives = l.objectives;
  const proven = objectives.filter((o) => o.state === "passed").length;
  const failed = objectives.filter((o) => o.state === "failed").length;
  const pending = objectives.filter((o) => o.state === "open" || o.state === "unverifiable").length;
  const testsGreen = testResult.ran && testResult.passed;

  // The guarantee: every objective proven closed AND a real suite ran green.
  // No tests = no certificate (you can't certify what you can't measure).
  const certified = failed === 0 && pending === 0 && testsGreen;

  let summary: string;
  if (certified) {
    summary = `Shepherd-certified — ${proven} objective(s) proven closed and the test suite is green. Reproducible.`;
  } else {
    const reasons: string[] = [];
    if (failed) reasons.push(`${failed} objective(s) still failing`);
    if (pending) reasons.push(`${pending} unproven (needs a fix or a live-probe re-run)`);
    if (!testResult.ran) reasons.push("no test suite ran — can't certify without one");
    else if (!testResult.passed) reasons.push("the test suite is red");
    summary = `Not certified — ${reasons.join("; ")}.`;
  }

  return { certified, objectives, tests: testResult, proven, failed, pending, summary, ts };
}

const STATE_ICON: Record<ObjectiveState, string> = { passed: "✅", failed: "❌", open: "⏳", unverifiable: "⏳" };

// The terminal certificate card.
export function printCertificate(c: Certificate): void {
  const pc = (s: string) => s; // plain; the agent prints colour around this
  const bar = "═".repeat(54);
  const head = c.certified ? "✅ SHEPHERD-CERTIFIED" : "❌ NOT CERTIFIED";
  console.log("\n  " + bar);
  console.log("   🔏 " + head + "        " + c.ts.slice(0, 10));
  console.log("  " + bar);

  if (c.objectives.length) {
    console.log("   Objectives (proof of fixes):");
    for (const o of c.objectives) {
      console.log(`     ${STATE_ICON[o.state]} ${o.title}`);
      const last = o.evidence[o.evidence.length - 1];
      if (last) console.log(`        ${last.detail}${last.command ? `  ·  re-run: ${last.command}` : ""}`);
    }
  } else {
    console.log("   No blocking objectives — nothing to prove closed.");
  }

  console.log("");
  const t = c.tests;
  const tIcon = !t.ran ? "⚠️ " : t.passed ? "✅" : "❌";
  console.log(`   Integration tests: ${tIcon} ${testSummary(t)}`);
  console.log("");
  console.log(`   ${c.proven} proven · ${c.failed} failed · ${c.pending} pending`);
  console.log("   " + c.summary);
  console.log("  " + bar + "\n");
  void pc;
}

// The keepable artifact — written to .shepherd/certificate.md so the certificate
// can be committed / shown in a PR / linked as the proof.
export function buildCertificateMarkdown(c: Certificate): string {
  const head = c.certified ? "✅ SHEPHERD-CERTIFIED" : "❌ NOT CERTIFIED";
  const lines: string[] = [
    `# Shepherd certificate`,
    ``,
    `**${head}** — _${c.ts}_`,
    ``,
    c.summary,
    ``,
    `> A certificate is a reproducible measurement, not an opinion. Every line below`,
    `> names the exact command to re-run the proof yourself.`,
    ``,
  ];

  if (c.objectives.length) {
    lines.push(`## Objectives`, ``);
    for (const o of c.objectives) {
      const last = o.evidence[o.evidence.length - 1];
      lines.push(`- ${STATE_ICON[o.state]} **${o.title}**  _(${o.method})_`);
      if (o.files.length) lines.push(`  - files: ${o.files.slice(0, 5).map((f) => `\`${f}\``).join(", ")}`);
      if (last) lines.push(`  - ${last.detail}`);
      if (last?.command) lines.push(`  - re-run: \`${last.command}\``);
    }
    lines.push(``);
  }

  lines.push(
    `## Integration tests`,
    ``,
    c.tests.ran
      ? `${c.tests.passed ? "✅" : "❌"} ${testSummary(c.tests)}`
      : `⚠️ ${testSummary(c.tests)} — add a real suite (ask Shepherd to design the tests) before this build can be certified.`,
    ``,
    `_${c.proven} proven · ${c.failed} failed · ${c.pending} pending._`,
    ``,
  );
  return lines.join("\n");
}

export function writeCertificate(root: string, markdown: string): string {
  const project = loadProject(root);
  const abs = path.join(project.dir, "certificate.md");
  writeFileSync(abs, markdown);
  return path.relative(root, abs);
}
