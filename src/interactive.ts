import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import pc from "picocolors";
import { scan } from "./engine/run.js";
import { loadProject, recordRun } from "./engine/project.js";
import { detectStack } from "./engine/tech-stack.js";
import { loadSoul } from "./engine/soul.js";
import { updateProfile, readProfile } from "./engine/memory/profile.js";
import { recordForEvolution, promoteRules } from "./engine/memory/evolution.js";
import type { Repo } from "./engine/ingest.js";
import { askShepherd } from "./engine/chat.js";
import { claudeAvailable } from "./engine/fixers/claude.js";
import { goLiveVerdict, printVerdict } from "./engine/gate.js";
import { buildFixOrder, writeFixOrder, buildScalePlan, writeScalePlan, writeCostReport, writeScaffoldOrder } from "./engine/handoff.js";
import { hygieneItems, buildScaffoldOrder } from "./engine/hygiene.js";
import { scaleArchitect } from "./engine/backend/architect.js";
import { estimateCost, buildCostReport } from "./engine/finops.js";
import { gitCheck, printGitCheck, installPrePushHook } from "./engine/gitcheck.js";
import { detectProvenance, buildFingerprintCard } from "./engine/provenance.js";
import { runTests } from "./engine/testrun.js";
import { certify, openObjectives, printCertificate, buildCertificateMarkdown, writeCertificate } from "./engine/certify.js";
import { architectureSpec, writeArchitectureSpec } from "./engine/spec.js";
import { rightSizing } from "./engine/rightsizing.js";
import { releaseReadiness, printReleaseReadiness, buildDeployOrder, writeDeployOrder, checkDeployedHealth } from "./engine/release.js";
import { runLoop } from "./engine/pipeline.js";
import { recommendedTarget } from "./engine/spec.js";
import type { InfraPrescription } from "./engine/backend/architect.js";
import { ingest } from "./engine/ingest.js";
import { designTests } from "./engine/testgen.js";
import { printReport, type Finding } from "./engine/report.js";
import { appendTurn, learnImportantTests } from "./engine/memory/conversation.js";
import { listTriage, suppressDismissed } from "./engine/memory/triage.js";
import { triageFromText } from "./engine/memory/triage-parse.js";
import { readTestLog } from "./engine/memory/tests-log.js";
import { recordScan } from "./engine/ledger.js";
import { annotate, prevalenceNote, insightsCard } from "./engine/insights.js";
import { devopsBlueprint, writeDevopsOrder } from "./engine/devops-scaffold.js";
import { type Intent, intentOf, translateSlash, HELP, SLASH_HELP } from "./interactive-router.js";
import { runIntake } from "./interactive-intake.js";

// Shepherd is an AGENT, not a set of programs. You start it and you talk to it.
// It boots as a 200-year-old principal engineer (soul.md), already holding this
// project's memory, autonomously takes stock, then guides you — architecture
// review, code/function review, a full production-readiness audit — and hands you
// the fixes. There are no subcommands to learn; you just ask.

// Build the preamble injected on the first turn: the soul + this project's
// memory, so Shepherd wakes up as itself with the context already in mind.
function preamble(root: string): string {
  const triage = listTriage(root);
  const triageLines = triage.length
    ? triage.map((t) => `- [${t.status}] ${t.id} in ${t.file}: ${t.reason || "(no reason)"}`).join("\n")
    : "- (none yet)";

  const testLog = readTestLog(root);
  const lessons = testLog
    .split("\n")
    .filter((l) => l.startsWith("- ") && !l.includes("nothing learned"))
    .slice(0, 12)
    .join("\n");

  const profile = readProfile(root).trim();

  return [
    loadSoul(),
    ``,
    `---`,
    ...(profile ? [profile, ``, `---`] : []),
    `# This project's memory (recall before you judge)`,
    ``,
    `Prior triage decisions — respect them, don't re-litigate unless code changed:`,
    triageLines,
    ``,
    `Tests this team treats as important:`,
    lessons || "- (none learned yet)",
    ``,
    `Tools you have:`,
    `- Read / Grep / Glob — open and inspect any file for architecture, code, or function reviews.`,
    `- mcp__shepherd__scan — runs Shepherd's OWN deterministic production-readiness detectors`,
    `  on this repo. GROUND every audit / security / production-readiness claim by calling it`,
    `  instead of guessing; quote its findings.`,
    `- mcp__shepherd__fix_order — produces a precise fix work-order for the user's Claude Code`,
    `  session to apply.`,
    `You cannot edit code — when something must change, describe the precise fix or write the`,
    `work-order; the user applies it. You are a maintainer, not an editor.`,
  ].join("\n");
}

// Persist what we learned this run: regenerate the living profile (recurring soft
// spots) and append to the run-history trend. Best-effort — never breaks the chat.
function remember(root: string, repo: Repo, findings: Finding[]): void {
  try {
    const ts = new Date().toISOString();
    const tech = detectStack(repo);
    updateProfile(root, { findings, ts, stack: `${tech.language}, ${tech.frameworks.join(", ") || "—"}` });
    recordRun(loadProject(root), ts, findings, repo.files.length);
    recordForEvolution(root, repo, findings); // raw material for rule promotion
  } catch {
    /* best-effort */
  }
}

export async function interactive(root = "."): Promise<number> {
  const hasClaude = claudeAvailable();
  loadProject(root); // installs .shepherd/ on first run

  console.log(pc.bold("\n🐑  Shepherd") + pc.dim(" — 200 years on the job. I maintain; I never edit.\n"));
  console.log(
    pc.dim(
      "I read code, judge it at a million users, and write the tests that keep you honest.\n" +
        "Ask me for an architecture review, a code or function review, or a full audit.\n" +
        (hasClaude ? "" : pc.yellow("Claude Code isn't on PATH — I can still run the deterministic audit, but not converse.\n")),
    ),
  );

  // Autonomously take stock on start — the fast, free deterministic pass + verdict.
  let lastFindings: Finding[] = [];
  try {
    console.log(pc.dim("  Taking stock of the repo …\n"));
    const result = await scan(root, { deep: false });
    lastFindings = result.findings;
    remember(root, result.repo, lastFindings); // refresh the living profile + trend
    try {
      if (!process.env.SHEPHERD_NO_LEDGER) recordScan(result.repo, lastFindings); // feed the data flywheel from interactive use too
    } catch {
      /* ledger is best-effort */
    }
    // Fingerprint who built it the moment we wake up — it primes the whole review.
    try {
      const prov = detectProvenance(result.repo);
      if (prov.top) console.log("  " + buildFingerprintCard(prov).replace(/\n/g, "\n  ") + "\n");
    } catch {
      /* fingerprint is best-effort */
    }
    const verdict = goLiveVerdict(lastFindings);
    printVerdict(verdict);
    const note = prevalenceNote(lastFindings);
    if (note) console.log(pc.dim("  " + note + "\n"));
    console.log(
      pc.dim(
        `  (${lastFindings.length} findings from the quick pass. Try /go-live-checks for the full audit, ` +
          `/scale for the infra roadmap, /infra-cost for the dollar story — or just ask. “/” lists all.)\n`,
      ),
    );
  } catch {
    /* a failed initial scan shouldn't stop the conversation */
  }

  if (!hasClaude) {
    console.log(pc.yellow("Install Claude Code and log in to chat with me. Bye for now.\n"));
    return 0;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let sessionId: string | undefined;

  console.log(pc.dim("Type “help” (or “/”) for what I can do, or “exit” to leave.\n"));

  try {
    for (;;) {
      const raw = (await rl.question(pc.bold(pc.cyan("you ▸ ")))).trim();
      if (!raw) continue;

      // Slash commands — Claude-style shortcuts. Resolve them to an intent (+ the
      // text the handler expects) before the normal flow; unknown/special ones are
      // handled right here.
      let line = raw;
      let intent: Intent;
      if (raw.startsWith("/")) {
        const s = translateSlash(raw);
        if ("unknown" in s) {
          console.log(pc.yellow(`\n  Unknown command “/${s.unknown}”.\n`) + SLASH_HELP + "\n");
          continue;
        }
        if ("special" in s) {
          appendTurn(root, "user", raw);
          if (s.special === "help") {
            console.log("\n" + SLASH_HELP + "\n");
          } else {
            const prof = readProfile(root).trim();
            const triage = listTriage(root);
            const tLines = triage.length
              ? triage.map((x) => `  • [${x.status}] ${x.id} in ${x.file}${x.reason ? ` — ${x.reason}` : ""}`).join("\n")
              : "  • (no triage decisions yet)";
            console.log("\n" + (prof || "No project profile yet — run an audit and I'll build one.") +
              "\n\nTriage I'm honoring:\n" + tLines + "\n");
          }
          continue;
        }
        intent = s.intent;
        line = s.line;
        appendTurn(root, "user", raw);
      } else {
        appendTurn(root, "user", raw);
        intent = intentOf(raw);
      }

      if (intent === "exit") {
        console.log(pc.dim("\n  Until next time. Ship safely.\n"));
        break;
      }

      if (intent === "help") {
        console.log("\n" + HELP + "\n");
        continue;
      }

      if (intent === "learn") {
        console.log(pc.dim("  Distilling what we've discussed into the tests that matter …"));
        const lessons = learnImportantTests(root);
        const msg = lessons.length
          ? "Learned and saved to .shepherd/test.md:\n" + lessons.map((l) => `  • ${l}`).join("\n")
          : "Not enough in our history yet to learn from — talk to me a while first.";
        console.log("\n" + msg + "\n");
        appendTurn(root, "shepherd", msg);
        continue;
      }

      if (intent === "triage") {
        if (lastFindings.length === 0) {
          const msg = "I don't have findings in front of me yet — run an “audit” first, then tell me what to dismiss.";
          console.log("\n" + msg + "\n");
          appendTurn(root, "shepherd", msg);
          continue;
        }
        process.stdout.write(pc.dim("  noting your decision …\r"));
        const results = triageFromText(root, line, lastFindings, new Date().toISOString());
        process.stdout.write("                        \r");
        if (results.length === 0) {
          const msg = "I couldn't tell which finding you meant — name the check id or the file and I'll record it.";
          console.log("\n" + msg + "\n");
          appendTurn(root, "shepherd", msg);
          continue;
        }
        // apply immediately so it's gone from what's in front of us.
        lastFindings = suppressDismissed(lastFindings, root);
        const lines = results
          .map((r) => `  • [${r.status}] ${r.id} in ${r.file} (${r.scope})${r.reason ? ` — ${r.reason}` : ""}`)
          .join("\n");
        const msg = `Noted, and remembered for next time:\n${lines}\nI won't raise these again unless the code materially changes.`;
        console.log("\n" + msg + "\n");
        appendTurn(root, "shepherd", msg);
        continue;
      }

      if (intent === "evolve") {
        console.log(pc.dim("  Looking for recurring findings worth a deterministic rule …"));
        const candidates = promoteRules(root);
        const msg = candidates.length
          ? "Drafted candidate rule(s) — review them, then move to ~/.shepherd/packs/ to activate:\n" +
            candidates.map((c) => `  • ${c.rule.id} (from ${c.count}× “${c.signature.split("::")[0]}”) → ${c.path.replace(/\\/g, "/")}`).join("\n")
          : "Nothing recurs often enough yet (or what recurs can't be reduced to a reliable regex). I only promote what I'm sure of.";
        console.log("\n" + msg + "\n");
        appendTurn(root, "shepherd", msg);
        continue;
      }

      if (intent === "tests") {
        process.stdout.write(pc.dim("  designing the essential tests …\r"));
        const design = designTests(root, line, { preamble: preamble(root), sessionId });
        process.stdout.write("                                    \r");
        if (!design) {
          console.log(pc.yellow("\n  (I couldn't reach Claude Code to design tests — try again.)\n"));
          continue;
        }
        sessionId = design.sessionId;
        console.log("\n" + pc.bold("🐑 Shepherd ▸ ") + design.order + "\n");
        const note =
          `Wrote a test work-order to ${design.orderPath.replace(/\\/g, "/")} ` +
          `(${design.tests.length} test(s), logged to .shepherd/test.md). I design tests, I don't write your ` +
          `files — apply it in your Claude Code session: “apply the tests in ${design.orderPath.replace(/\\/g, "/")}”.`;
        console.log(pc.dim("  " + note) + "\n");
        appendTurn(root, "shepherd", design.order + "\n" + note);
        continue;
      }

      if (intent === "autopilot") {
        console.log(
          pc.bold("\n  🐑 Autopilot") +
            pc.dim(" — I'll ask what you want, then run the whole loop: design → right-size → certify → release.\n"),
        );
        const repo = await ingest(root);
        const recommended = recommendedTarget(repo).targetPattern;
        // the infra Shepherd would prescribe — shown in the intake, reused in the loop.
        let prescriptions: InfraPrescription[] = [];
        process.stdout.write(pc.dim("  (sizing up the infrastructure this needs …)\r"));
        try {
          prescriptions = scaleArchitect(repo, { web: true }).prescriptions;
        } catch {
          /* no infra prescription — fine */
        }
        process.stdout.write("                                          \r");

        const choices = await runIntake(rl, root, recommended, prescriptions);
        const res = await runLoop(root, { web: true, choices, prescriptions });
        lastFindings = res.findings;

        const certified = res.certificate.certified;
        const ready = res.release.ready;
        const msg =
          `Loop complete — ${certified ? "✅ certified" : "not certified"}, ${ready ? "🟢 clear to deploy" : "🔴 hold the deploy"}. ` +
          `Spec, certificate${res.release.hasPipeline ? "" : ", and a gated deploy work-order"} are in .shepherd/. ` +
          (certified && ready
            ? "Build it to the spec, then ship."
            : "Build/fix against the spec, then say “/autopilot” again (or “/certify”) to re-prove.");
        console.log("  " + msg + "\n");
        appendTurn(root, "shepherd", msg);
        continue;
      }

      if (intent === "audit") {
        console.log(pc.dim("\n  Running the full audit (deterministic + deep review + scale architect) …\n"));
        const result = await scan(root, { deep: true });
        lastFindings = result.findings;
        // The full audit also runs the web-grounded scale architect and writes a
        // scale plan, so "is it production ready?" answers both "is it correct?"
        // and "will it hold at 1M?".
        let scalePlanNote = "";
        try {
          const arch = scaleArchitect(result.repo, { web: true });
          if (arch.prescriptions.length) {
            lastFindings = [...lastFindings, ...arch.findings];
            const planPath = writeScalePlan(root, buildScalePlan(arch.prescriptions, new Date().toISOString()));
            const now = arch.prescriptions.filter((p) => p.priority === "now").length;
            scalePlanNote =
              `  + ${arch.prescriptions.length} infra recommendation(s)${now ? `, ${now} urgent` : ""} — ` +
              `scale plan at ${planPath.replace(/\\/g, "/")}.`;
          }
          // the dollar story: abuse exposure + the bill to run the prescribed infra.
          const cost = estimateCost(result.repo, { prescriptions: arch.prescriptions, web: true });
          if (cost.items.length) {
            lastFindings = [...lastFindings, ...cost.findings];
            const reportPath = writeCostReport(root, buildCostReport(cost.items, new Date().toISOString()));
            const unprotected = cost.items.filter((c) => c.kind === "exposure" && c.protected === false).length;
            scalePlanNote +=
              `\n  + cost report at ${reportPath.replace(/\\/g, "/")}` +
              (unprotected ? ` (${unprotected} unprotected paid endpoint(s) — $ at risk)` : "") + ".";
          }
        } catch {
          /* architect/finops are best-effort — never break the audit */
        }
        remember(root, result.repo, lastFindings); // refresh the living profile + trend
        try {
          if (!process.env.SHEPHERD_NO_LEDGER) recordScan(result.repo, lastFindings); // feed the flywheel
        } catch {
          /* best-effort */
        }
        printReport(annotate(lastFindings)); // display copy carries prevalence; lastFindings stays raw
        if (scalePlanNote) console.log(pc.dim(scalePlanNote) + "\n");
        const verdict = goLiveVerdict(lastFindings);
        printVerdict(verdict);
        // Track the blockers as objectives so the proof loop can later prove them
        // closed. "Fix them, then say /certify and I'll prove each one."
        try {
          if (verdict.blockers.length) {
            openObjectives(root, verdict.blockers, new Date().toISOString());
            console.log(pc.dim(`  Tracking ${verdict.blockers.length} objective(s). Fix them, then say “/certify” and I'll prove each one closed.\n`));
          }
        } catch {
          /* objectives ledger is best-effort */
        }
        // Let Shepherd comment on the result in persona, grounded in the findings.
        const summary = lastFindings
          .slice(0, 25)
          .map((f) => `- [${f.disposition}] ${f.id} (${f.file}${f.line ? `:${f.line}` : ""}): ${f.message}`)
          .join("\n");
        const reply = askShepherd(
          `I just ran a full audit. Findings:\n${summary}\n\nGive me your principal-engineer read: ` +
            `the critical path to green, and which tests would lock each fix down.`,
          { root, preamble: preamble(root), sessionId },
        );
        if (reply) {
          sessionId = reply.sessionId;
          console.log("\n" + pc.bold("🐑 Shepherd ▸ ") + reply.text + "\n");
          appendTurn(root, "shepherd", reply.text);
        }
        continue;
      }

      if (intent === "design") {
        // SPEC-FIRST: author the architecture blueprint to BUILD from. Composes the
        // deterministic classifiers (skeleton + principles) and, with Claude, a
        // web-grounded blueprint narrative for this app + the infra plan.
        console.log(pc.dim("\n  Authoring the architecture spec — target pattern, boundaries, design patterns, principles, infra plan …\n"));
        const repo = await ingest(root);
        const spec = architectureSpec(repo, { web: true });
        console.log(pc.bold(`  🏗  Target: ${spec.targetPattern}`));
        console.log("   " + spec.rationale + "\n");
        console.log(pc.dim(`  Structure: ${spec.inputs.structure}-based today · pattern(s): ${spec.inputs.patterns.join(", ")}`));
        if (spec.prescriptions.length) {
          const now = spec.prescriptions.filter((p) => p.priority === "now").length;
          console.log(pc.dim(`  Infra to build in: ${spec.prescriptions.length} component(s)${now ? `, ${now} from the start` : ""}`));
        }
        if (spec.blueprint.length) console.log(pc.dim(`  Blueprint: ${spec.blueprint.length} section(s) authored for this app`));
        const specPath = writeArchitectureSpec(root, spec.markdown);
        const msg =
          `\n  Wrote the architecture spec to ${specPath.replace(/\\/g, "/")}. ` +
          `I designed it; you build from it — hand it to your Claude Code session ` +
          `(“scaffold the architecture in ${specPath.replace(/\\/g, "/")}”, or build one feature module at a time). ` +
          `When a slice is built, say “/certify” and I'll prove it matches.`;
        console.log(pc.dim(msg) + "\n");
        appendTurn(root, "shepherd", `Architecture spec → ${spec.targetPattern}.` + msg);
        continue;
      }

      if (intent === "insights") {
        console.log("\n" + insightsCard() + "\n");
        continue;
      }

      if (intent === "rightsize") {
        // The YAGNI counterweight — knowing when to STOP optimizing.
        console.log(pc.dim("\n  Right-sizing — looking for what's over-engineered (abstractions for problems you don't have yet) …\n"));
        const repo = await ingest(root);
        const items = rightSizing(repo, { deep: true });
        if (items.length === 0) {
          const msg = "Nothing over-engineered that I can see — the complexity here looks earned. Right-sized.";
          console.log("  " + pc.green(msg) + "\n");
          appendTurn(root, "shepherd", msg);
          continue;
        }
        const high = items.filter((f) => /infra|microservice|layering/.test(f.id));
        const low = items.filter((f) => !/infra|microservice|layering/.test(f.id));
        const show = (label: string, fs: Finding[]) => {
          if (!fs.length) return;
          console.log(pc.bold(`  ${label}`));
          for (const f of fs) {
            const dot = f.severity === "warn" ? "🟡" : "🔵";
            console.log(`   ${dot} ${pc.dim(f.line ? `${f.file}:${f.line}` : f.file)} ${pc.dim(`(${f.id})`)}`);
            console.log(`      ${f.message}`);
          }
          console.log("");
        };
        show("High-level (architecture / infra)", high);
        show("Low-level (code abstractions)", low);
        // fold into the session so a follow-up can act on them.
        const ids = new Set(lastFindings.map((f) => f.id + f.file));
        lastFindings = [...lastFindings, ...items.filter((f) => !ids.has(f.id + f.file))];
        const msg =
          `${items.length} thing(s) that may be solving a problem you don't have yet — all advisory (over-engineering is complexity-debt, not a blocker). ` +
          `The call is yours: keep it only if the workload in front of you needs it. The skill is knowing when to stop.`;
        console.log(pc.dim("  " + msg) + "\n");
        appendTurn(root, "shepherd", msg);
        continue;
      }

      if (intent === "certify") {
        // The closed proof loop: re-scan fresh (deep, so judgment gates re-review
        // too), run the real test suite, then prove each tracked objective closed.
        console.log(pc.dim("\n  Proving it — re-scanning, then running your test suite (I execute tests; I never edit code) …\n"));
        const result = await scan(root, { deep: true });
        lastFindings = result.findings;
        console.log(pc.dim("  Running the tests now — this runs your project's own suite …"));
        const testResult = runTests(root);
        if (!testResult.ran) {
          console.log(pc.yellow(`  ⚠️  No suite ran: ${testResult.reason}.`));
        } else {
          console.log(
            (testResult.passed ? pc.green("  ✓ tests green") : pc.red("  ✗ tests red")) +
              pc.dim(`  (${testResult.command}${testResult.durationMs ? `, ${Math.round(testResult.durationMs / 1000)}s` : ""})`),
          );
        }
        const cert = certify(root, { freshFindings: result.findings, testResult, probeRan: false, ts: new Date().toISOString() });
        // colourize the card head/states by reprinting through pc where it matters.
        printCertificate(cert);
        let certPath = ".shepherd/certificate.md";
        try {
          certPath = writeCertificate(root, buildCertificateMarkdown(cert));
        } catch {
          /* best-effort */
        }
        const msg = cert.certified
          ? `${pc.green("Shepherd-certified.")} ${cert.proven} objective(s) proven closed and the suite is green — certificate written to ${certPath.replace(/\\/g, "/")} (commit it; it's reproducible).`
          : `${pc.yellow("Not certified yet.")} ${cert.summary} Certificate (with the open items + how to re-prove each) at ${certPath.replace(/\\/g, "/")}.` +
            (cert.tests.ran ? "" : " Add a real test suite — say “write tests” and I'll design it.") +
            (cert.objectives.some((o) => o.method === "empirical" && o.state === "unverifiable")
              ? " Some need the live probe — run the full “npx shepherd” to re-prove those."
              : "");
        console.log("  " + msg + "\n");
        appendTurn(root, "shepherd", cert.summary + "\n" + msg);
        continue;
      }

      if (intent === "release") {
        // A URL arg → post-deploy health check; "pipeline" → write the CI work-order;
        // otherwise the release gate (is the build proven + matches HEAD + clean?).
        if (/^https?:\/\//i.test(line.trim())) {
          const url = line.trim();
          console.log(pc.dim(`\n  Checking the deployed app at ${url} …`));
          const h = await checkDeployedHealth(url);
          console.log((h.ok ? pc.green(`  🟢 healthy — ${h.detail}`) : pc.red(`  🔴 not healthy — ${h.detail}`)) + "\n");
          appendTurn(root, "shepherd", `Post-deploy health for ${url}: ${h.ok ? "healthy" : "unhealthy"} (${h.detail}).`);
          continue;
        }
        if (/\b(pipeline|workflow|ci\/?cd|ci)\b/i.test(line)) {
          const orderPath = writeDeployOrder(root, buildDeployOrder(new Date().toISOString()));
          const msg =
            `Wrote a gated CI/CD pipeline work-order to ${orderPath.replace(/\\/g, "/")} — a deploy workflow with the Shepherd gate baked in ` +
            `(build → test → gate → deploy, where deploy only runs if the gate passed). I describe it; your Claude Code session writes the YAML.`;
          console.log("\n  " + msg + "\n");
          appendTurn(root, "shepherd", msg);
          continue;
        }
        const r = releaseReadiness(root);
        printReleaseReadiness(r);
        if (!r.ready) {
          const hint = !r.cert
            ? `Say “/certify” to prove the build first.`
            : !r.cert.certified
              ? `Close the gates, then “/certify”.`
              : `Re-run “/certify” so the proof matches what you're shipping.`;
          console.log(pc.dim("  " + hint) + "\n");
          appendTurn(root, "shepherd", r.reason + " — " + hint);
        } else {
          appendTurn(root, "shepherd", r.reason);
        }
        if (!r.hasPipeline && r.isRepo) {
          console.log(pc.dim("  (No deploy pipeline yet — “/release-check pipeline” writes a gated CI/CD work-order so this gate runs on every push.)\n"));
        }
        continue;
      }

      if (intent === "scale") {
        console.log(
          pc.dim("\n  Surveying the system and researching current infra (road to ~1M users) …\n"),
        );
        const repo = await ingest(root);
        const { prescriptions } = scaleArchitect(repo, { web: true });
        if (prescriptions.length === 0) {
          const msg =
            "I don't see a scaling pressure that needs new infrastructure yet — either the app is already " +
            "wired for it, or there's no evidence of the workload that would justify it. I only prescribe what " +
            "the code shows it needs. (If Claude Code isn't logged in, I can't run this pass.)";
          console.log(msg + "\n");
          appendTurn(root, "shepherd", msg);
          continue;
        }
        // Surface the prescriptions in-line, most urgent first.
        const pri: Record<string, string> = { now: "🔴", soon: "🟡", later: "🔵" };
        for (const p of prescriptions) {
          console.log(
            `${pri[p.priority] ?? "🔵"} ${pc.bold(p.recommendation)} ${pc.dim(`(${p.component}${p.effort ? `, ~${p.effort}` : ""})`)}`,
          );
          console.log(`   ${p.need}`);
          if (p.where) console.log(pc.dim(`   plugs into: ${p.where}`));
          if (p.alternatives?.length) console.log(pc.dim(`   alternatives: ${p.alternatives.join(", ")}`));
          if (p.source) console.log(pc.dim(`   ref: ${p.source}`));
          console.log("");
        }
        const planPath = writeScalePlan(root, buildScalePlan(prescriptions, new Date().toISOString()));
        const now = prescriptions.filter((p) => p.priority === "now").length;
        const msg =
          `Wrote a scale plan to ${planPath.replace(/\\/g, "/")} (${prescriptions.length} recommendation(s)` +
          `${now ? `, ${now} urgent` : ""}). I prescribe the infrastructure; you wire it — hand it to your ` +
          `Claude Code session, one minimal change at a time.`;
        console.log(pc.dim("  " + msg) + "\n");
        appendTurn(root, "shepherd", msg);
        continue;
      }

      if (intent === "cost") {
        console.log(pc.dim("\n  Putting dollars on it — abuse exposure + infra run-cost (web-grounded) …\n"));
        const repo = await ingest(root);
        // price the prescribed infra too, so the bill matches the plan.
        const { prescriptions } = scaleArchitect(repo, { web: true });
        const { items } = estimateCost(repo, { prescriptions, web: true });
        if (items.length === 0) {
          const msg =
            "I couldn't put a number on it — either nothing here costs money per call and there's no infra to " +
            "price, or Claude Code isn't logged in for the web-grounded pass.";
          console.log(msg + "\n");
          appendTurn(root, "shepherd", msg);
          continue;
        }
        const exposures = items.filter((c) => c.kind === "exposure");
        const infra = items.filter((c) => c.kind === "infra");
        if (exposures.length) {
          console.log(pc.bold("  💸 Abuse exposure"));
          for (const c of exposures) {
            const flag = c.protected === false ? pc.red("UNPROTECTED") : pc.green("protected");
            console.log(
              `   ${c.protected === false ? "🔴" : "🟢"} ${pc.bold(c.operation || "paid op")} ` +
                pc.dim(`${c.where ? `(${c.where}) ` : ""}[${flag}]`),
            );
            if (c.abuseEstimate) console.log(`      ${pc.yellow(c.abuseEstimate)}${c.unitCost ? pc.dim(` · ${c.unitCost}`) : ""}`);
            if (c.source) console.log(pc.dim(`      ref: ${c.source}`));
          }
          console.log("");
        }
        if (infra.length) {
          console.log(pc.bold("  🧾 Infra run-cost @ ~1M users"));
          for (const c of infra) {
            console.log(`   • ${pc.bold(c.tool || c.component || "infra")} ${pc.dim(c.monthlyEstimate || "")}`);
            if (c.assumption) console.log(pc.dim(`      ${c.assumption}`));
          }
          console.log("");
        }
        const reportPath = writeCostReport(root, buildCostReport(items, new Date().toISOString()));
        const unprotected = exposures.filter((c) => c.protected === false).length;
        const msg =
          `Wrote a cost report to ${reportPath.replace(/\\/g, "/")} (${exposures.length} exposure(s)` +
          `${unprotected ? `, ${unprotected} unprotected — protect those first, it's free money saved` : ""}; ` +
          `${infra.length} infra line(s) priced). Estimates to size decisions, not quotes.`;
        console.log(pc.dim("  " + msg) + "\n");
        appendTurn(root, "shepherd", msg);
        continue;
      }

      if (intent === "gitcheck") {
        if (line === "install") {
          const res = installPrePushHook(root);
          const msg = res.ok
            ? `Installed a pre-push gate at ${res.path}${res.reason ? ` (${res.reason})` : ""}. ` +
              `From now on, every \`git push\` runs the git-check first and blocks if the diff isn't ` +
              `production-ready. Override once with \`git push --no-verify\`.`
            : `Couldn't install the hook: ${res.reason}.`;
          console.log("\n  " + msg + "\n");
          appendTurn(root, "shepherd", msg);
          continue;
        }
        console.log(pc.dim("\n  Reviewing what you're about to push …"));
        const result = await gitCheck(root, { deep: false });
        printGitCheck(result);
        if (result.isRepo && result.changed.length > 0) {
          lastFindings = result.findings; // focus the session on the diff
          const v = result.verdict;
          const msg = v.ready
            ? `Your diff (${result.changed.length} file(s)) is clear to push${v.advisoryCount ? ` — ${v.advisoryCount} advisory note(s) for later` : ""}.`
            : `Hold the push — ${v.blockers.length} blocker(s) in the diff. Say “fix” for a work-order, or \`git push --no-verify\` to override. Want me to install a pre-push hook? say “/git-check install”.`;
          appendTurn(root, "shepherd", msg);
          if (!v.ready) console.log(pc.dim("  " + msg) + "\n");
        }
        continue;
      }

      if (intent === "devops") {
        const repo = await ingest(root);
        const bp = devopsBlueprint(repo, {});
        console.log(pc.bold(`\n  🛠  DevOps deck — right-sized for ${pc.bold(bp.scale)} scale:\n`));
        for (const inc of bp.included) console.log(`   • ${inc}`);
        if (bp.scale !== "large") {
          console.log(
            pc.dim(
              `\n  (Held back Kubernetes + Prometheus/Grafana — that's ops weight you don't need at ${bp.scale} scale. ` +
                `Run “/autopilot” and pick ~1M, or set scale in .shepherd/intent.json, to get the full deck.)`,
            ),
          );
        }
        const orderPath = writeDevopsOrder(root, bp.markdown);
        const msg =
          `\n  Wrote a DevOps work-order to ${orderPath.replace(/\\/g, "/")} with ready-to-adapt config (real YAML/Dockerfile/proxy, ` +
          `tailored to your stack + selected infra + deploy target). I describe it; you drop the files in — ` +
          `or tell your Claude Code session “create the files in ${orderPath.replace(/\\/g, "/")}”. These close the security-header + rate-limit findings the probe raises.`;
        console.log(pc.dim(msg) + "\n");
        appendTurn(root, "shepherd", msg);
        continue;
      }

      if (intent === "scaffold") {
        const repo = await ingest(root);
        const items = hygieneItems(repo);
        if (items.length === 0) {
          const msg = "Your scaffolding is solid — Husky, linter, formatter, license, README and friends are all present. Nothing to add.";
          console.log("\n  " + msg + "\n");
          appendTurn(root, "shepherd", msg);
          continue;
        }
        console.log(pc.bold(`\n  🧱 Missing production-grade scaffolding (${items.length}):\n`));
        for (const it of items) {
          const dot = it.severity === "warn" ? "🟡" : "🔵";
          console.log(`   ${dot} ${pc.bold(it.file)} ${pc.dim(`(${it.id})`)}`);
          console.log(`      ${it.message}`);
        }
        const orderPath = writeScaffoldOrder(root, buildScaffoldOrder(items, new Date().toISOString()));
        const msg =
          `\n  Wrote a scaffold work-order to ${orderPath.replace(/\\/g, "/")} (${items.length} file(s)). ` +
          `I describe them; I don't write your files — apply it in your Claude Code session: ` +
          `“create the files in ${orderPath.replace(/\\/g, "/")}”. None of these block a merge; they're the team guardrails.`;
        console.log(pc.dim(msg) + "\n");
        appendTurn(root, "shepherd", msg);
        continue;
      }

      if (intent === "fingerprint") {
        const repo = await ingest(root);
        const prov = detectProvenance(repo);
        console.log("\n" + buildFingerprintCard(prov) + "\n");
        if (prov.findings.length) {
          // fold the builder's failure-mode priors into what's in front of us, so a
          // follow-up review/fix is primed by who built it.
          const ids = new Set(lastFindings.map((f) => f.id));
          lastFindings = [...lastFindings, ...prov.findings.filter((f) => !ids.has(f.id))];
        }
        const msg = prov.top
          ? `Fingerprinted as ${prov.top.name} (${Math.round(prov.top.confidence * 100)}% confidence). ` +
            (prov.top.klass === "generator"
              ? `I've loaded ${prov.top.name}'s known failure modes as priors — ask me to “review security” and I'll check them against this repo specifically.`
              : `That's an AI-assist marker, so I'll watch for drift and partial refactors during review.`)
          : "No AI-builder fingerprint — I'll review on general priors.";
        appendTurn(root, "shepherd", buildFingerprintCard(prov) + "\n" + msg);
        continue;
      }

      if (intent === "fix") {
        const gates = lastFindings.filter((f) => f.disposition === "gate");
        if (gates.length === 0) {
          const msg = "Nothing is blocking right now — run an “audit” first, or there's simply nothing to fix.";
          console.log("\n" + msg + "\n");
          appendTurn(root, "shepherd", msg);
          continue;
        }
        const orderPath = writeFixOrder(root, buildFixOrder(gates, new Date().toISOString()));
        const msg =
          `I wrote a fix work-order to ${orderPath.replace(/\\/g, "/")} (${gates.length} blocking). ` +
          `I don't edit your code — hand it to your Claude Code session: “apply the fixes in ${orderPath.replace(/\\/g, "/")}”.`;
        console.log("\n" + msg + "\n");
        appendTurn(root, "shepherd", msg);
        continue;
      }

      // Everything else — architecture / code / function review, questions — goes to
      // the conversational brain, which can read the repo to answer.
      process.stdout.write(pc.dim("  thinking …\r"));
      const reply = askShepherd(line, { root, preamble: preamble(root), sessionId });
      process.stdout.write("                 \r");
      if (!reply) {
        console.log(pc.yellow("\n  (I couldn't reach Claude Code just now — try again.)\n"));
        continue;
      }
      sessionId = reply.sessionId;
      console.log("\n" + pc.bold("🐑 Shepherd ▸ ") + reply.text + "\n");
      appendTurn(root, "shepherd", reply.text);
    }
  } finally {
    rl.close();
  }
  return 0;
}
