import readline from "node:readline/promises";
import pc from "picocolors";
import { readChoices, writeChoices, summarizeChoices, type LoopChoices, type TargetScale } from "./engine/intent.js";
import type { InfraPrescription } from "./engine/backend/architect.js";

// The consultative INTAKE — Shepherd interviews its user before the loop runs.
// At each step it shows its own recommendation as the default; the user accepts or
// overrides. Choices are persisted so the next run can reuse them. Uses the REPL's
// own readline, so this only runs in an interactive session (CI reuses saved intent).
export async function runIntake(
  rl: readline.Interface,
  root: string,
  recommended: string,
  prescriptions: InfraPrescription[],
): Promise<LoopChoices> {
  const saved = readChoices(root);
  if (saved) {
    console.log(pc.dim("\n  I have your saved choices:\n   ") + summarizeChoices(saved));
    const use = (await rl.question(pc.cyan("  Use these? [Y/edit] "))).trim().toLowerCase();
    if (use === "" || use === "y" || use === "yes") return saved;
  }

  console.log(pc.bold("\n  A few questions before I run the loop — accept my recommendation or override.\n"));

  // 1. target scale — the call that decides whether infra is "needed" or "premature".
  const scaleAns = (await rl.question(
    pc.cyan("  Building for?  1) small / just starting   2) growing (thousands)   3) ~1M+   [1] "),
  )).trim();
  const scale: TargetScale =
    scaleAns.startsWith("3") || /1\s*m|million|large|high traffic/i.test(scaleAns)
      ? "large"
      : scaleAns.startsWith("2") || /grow|thousand/i.test(scaleAns)
        ? "growing"
        : "small";

  // 2. architecture — Shepherd's recommendation is the default.
  console.log(pc.dim(`\n  Architecture — I recommend: `) + pc.bold(recommended) + pc.dim("."));
  const archAns = (await rl.question(
    pc.cyan("  [enter] to accept, or 1) modular monolith  2) microservices  3) serverless  4) event-driven  "),
  )).trim();
  const ARCH = ["modular monolith", "microservices", "serverless", "event-driven"];
  const architecture = archAns === "" ? undefined : /^[1-4]$/.test(archAns) ? ARCH[Number(archAns) - 1] : archAns;

  // 3. infrastructure — show what Shepherd would add; user keeps all / none / a subset.
  let infraAll = false;
  let infra: string[] = [];
  if (prescriptions.length) {
    console.log(pc.dim("\n  Infrastructure I'd add for this workload:"));
    prescriptions.forEach((p, i) => console.log(`   ${i + 1}) ${pc.bold(p.component)} — ${p.recommendation}`));
    const ans = (await rl.question(pc.cyan("  Include which? [enter]=all, 'none', or comma numbers (e.g. 1,3)  "))).trim().toLowerCase();
    if (ans === "" || ans === "all") {
      infraAll = true;
      infra = prescriptions.map((p) => p.component);
    } else if (ans === "none") {
      infra = [];
    } else {
      const picks = ans.split(/[,\s]+/).map(Number).filter((n) => n >= 1 && n <= prescriptions.length);
      infra = picks.map((n) => prescriptions[n - 1].component);
    }
  } else {
    console.log(pc.dim("\n  No extra infrastructure warranted for what I can see — keeping it lean."));
  }

  // 4. deploy target — tunes the deploy work-order + post-deploy health check.
  const depAns = (await rl.question(
    pc.cyan("\n  Deploy target? 1) Vercel 2) Fly.io 3) Render 4) Docker+k8s 5) other/skip   [5] "),
  )).trim();
  const DEP = ["Vercel", "Fly.io", "Render", "Docker + Kubernetes"];
  const deployTarget = /^[1-4]$/.test(depAns) ? DEP[Number(depAns) - 1] : depAns && !/^5|skip/i.test(depAns) ? depAns : undefined;

  // 5. open note.
  const note = (await rl.question(pc.cyan("\n  Anything else I should know? (enter to skip)  "))).trim() || undefined;

  const choices: LoopChoices = { scale, architecture, infraAll, infra, deployTarget, note, ts: new Date().toISOString() };
  writeChoices(root, choices);
  console.log(pc.dim("\n  Saved to .shepherd/intent.json — I'll reuse this next time (say “/autopilot” and pick 'edit' to change it).\n"));
  return choices;
}
