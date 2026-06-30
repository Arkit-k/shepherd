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
import { readChoices, writeChoices, summarizeChoices, type LoopChoices, type TargetScale } from "./engine/intent.js";
import type { InfraPrescription } from "./engine/backend/architect.js";
import { ingest } from "./engine/ingest.js";
import { designTests } from "./engine/testgen.js";
import { printReport, type Finding } from "./engine/report.js";
import { appendTurn, learnImportantTests } from "./engine/memory/conversation.js";
import { listTriage, suppressDismissed } from "./engine/memory/triage.js";
import { triageFromText } from "./engine/memory/triage-parse.js";
import { readTestLog } from "./engine/memory/tests-log.js";

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

type Intent = "exit" | "audit" | "autopilot" | "certify" | "release" | "design" | "rightsize" | "scale" | "cost" | "gitcheck" | "scaffold" | "fingerprint" | "fix" | "tests" | "learn" | "evolve" | "triage" | "help" | "chat";

function intentOf(s: string): Intent {
  const t = s.trim().toLowerCase();
  if (/^(exit|quit|bye|:q|q)$/.test(t)) return "exit";
  // Autopilot — the consultative loop. Ask the user what they want, then run
  // design → right-size → certify → release end to end. Checked first so "run the
  // whole loop" isn't swallowed by audit/design/certify.
  if (/\b(autopilot|auto[- ]?pilot|run (the )?(whole|full|entire|complete) (thing|loop|pipeline|flow)|the (whole|full) loop|do everything|run all|end[- ]to[- ]end|ship me to production|take me to production)\b/.test(t))
    return "autopilot";
  // Certify — the closed proof loop: re-scan + run the tests, prove the fixes,
  // emit a reproducible certificate. Checked before audit/tests so "prove it's
  // fixed" / "certify this" isn't read as a plain audit or test-design request.
  if (/\b(certif(y|ied|icate)|prove it|prove the fix|verify the fix|is it (actually )?fixed|re[- ]?verify|proof|are the gates? (closed|fixed)|sign off|shepherd[- ]?certif)\b/.test(t))
    return "certify";
  // Release gate — clear-to-deploy check (cert fresh + matches HEAD + clean).
  // Before audit so "ship it"/"deploy" routes here, not to a full audit.
  if (/\b(release|deploy|ship it|cut a release|go to prod(uction)?|pre[- ]?deploy|ready to (deploy|ship)|clear to (deploy|ship)|release gate|deploy gate)\b/.test(t))
    return "release";
  // SPEC-FIRST design — author the architecture blueprint to BUILD from (forward-
  // looking), distinct from "review the architecture" (diagnostic). Requires a
  // design/spec/blueprint verb so "design the tests" still routes to tests.
  if (/\b(architecture spec|arch spec|design spec|blueprint|spec[- ]?first|design (the |my |our )?(architecture|system|app|backend|service)|how (should|do) i (build|architect|structure)|build it right|greenfield)\b/.test(t))
    return "design";
  // Right-sizing / YAGNI — the over-engineering counterweight. "Am I over-
  // engineering?", "is this too complex?", "do I really need this abstraction?"
  if (/\b(over[- ]?engineer\w*|right[- ]?siz\w*|yagni|too (complex|abstract|much abstraction)|premature (optimi|abstraction)|unnecessary abstraction|over[- ]?abstract|gold[- ]?plat|am i over|do i (really |actually )?need (this|a|an|the)|simpler version)\b/.test(t))
    return "rightsize";
  // AI-provenance fingerprint — which builder made this repo. Checked early so a
  // tool name ("is this a lovable app?") isn't swallowed by another intent.
  if (/\b(fingerprint|provenance|who (built|made|wrote)|what (built|made|tool)|built by|which (ai|tool|builder)|is this (a )?(lovable|bolt|v0|replit|cursor|copilot|windsurf)|(lovable|bolt\.new|v0\.dev) app)\b/.test(t))
    return "fingerprint";
  // Project-hygiene scaffolding — missing tooling/config files (Husky, linter, …).
  if (/\b(scaffold|hygiene|tooling|husky|lint(er|ing)?|prettier|formatter|editorconfig|dependabot|renovate|codeowners|missing (files?|config|tooling)|production[- ]?(level |grade )?files?|setup files?)\b/.test(t))
    return "scaffold";
  // Pre-push gate — review only what's about to be pushed. Checked early so
  // "check before I push" isn't read as a full audit.
  if (/\b(git[- ]?check|check before (i )?push|safe to push|ready to push|pre[- ]?push|review my (changes|diff|commit)|check my (changes|diff)|gate my push)\b/.test(t))
    return "gitcheck";
  // FinOps — the dollar story. Checked before scale/audit so "how much will this
  // cost" doesn't get read as a scaling or audit request.
  if (/\b(cost|costs?|finops|how much|\$|dollars?|expensive|cost ?bomb|bill|budget|cloud (bill|cost)|spend|burn rate|pricing|how much .* (cost|spend|pay))\b/.test(t))
    return "cost";
  // Scale-architecture advisor — the road to 1M users / heavy traffic. Checked
  // before "audit" so "scale to a million" doesn't get swallowed by "ready".
  if (/\b(scale|scaling|infra(structure)?|1 ?m(illion)?|million users?|billions? of (traffic|requests?)|high traffic|handle .* (load|traffic|users?)|(do i|where do i|what) .* (need|use) .*(redis|kafka|rabbit ?mq|queue|cache)|road ?map to|what (infra|do i need to scale))\b/.test(t))
    return "scale";
  if (/\b(false[- ]?positive|won'?t[- ]?fix|wontfix|not an issue|not a (real )?(bug|problem|issue)|dismiss (that|this|it|the)|ignore (that|this|the)|that's (fine|intentional|expected)|mark .* (accepted|wontfix))\b/.test(t))
    return "triage";
  if (/\b((write|generate|create|add|design|make|draft) (me )?(some |a |an |the )?(unit |integration |contract |load |e2e |smoke )?tests?|test cases?|cover .* with tests?|test (this|that|it|the))\b/.test(t))
    return "tests";
  if (/\b(full audit|audit|production[- ]?ready|prod[- ]?ready|go ?live|check everything|scan everything|ship it|is it ready)\b/.test(t))
    return "audit";
  if (/\b(work[- ]?order|hand ?off|apply the fix|generate (the )?fix|write the fix|fix it)\b/.test(t)) return "fix";
  if (/\b(evolve|promote (the |a )?rules?|learn (new |the )?rules?|new rules?|self[- ]?improve)\b/.test(t)) return "evolve";
  if (/\b(learn|what tests matter|important tests|update memory)\b/.test(t)) return "learn";
  if (/^(help|what can you do|commands?)\??$/.test(t)) return "help";
  return "chat";
}

const HELP = [
  "I'm an agent — just talk to me. Things you can ask:",
  "  • “review the architecture”            — I read the repo and assess the design at scale",
  "  • “design the architecture” / /design   — I author the BLUEPRINT to build from (target pattern, boundaries, design patterns, principles, infra plan)",
  "  • “am I over-engineering?” / /rightsize  — the YAGNI counterweight: I flag abstractions/infra you don't need yet (high- and low-level)",
  "  • “review the function handleLogin in auth.ts”  — a focused code/function review",
  "  • “run the whole loop” / /autopilot    — I ASK what you want (scale, architecture, infra, deploy), then run design → right-size → certify → release",
  "  • “is it production ready?” / “audit”  — the full deterministic + deep audit + verdict",
  "  • “prove it's fixed” / /certify        — I re-scan, RUN your tests, and prove each gate closed → a reproducible certificate",
  "  • “clear to deploy?” / /release-check   — the release gate: ship only a proven build (cert is fresh + matches HEAD + clean); writes a gated CI/CD pipeline; checks a live URL's health",
  "  • “how do I scale to 1M users?”         — I survey the system + research current infra (Redis/queue/Kafka/…) and write a scale plan",
  "  • “how much will this cost?”            — I price the abuse exposure (cost-bombs in $) + the infra bill at 1M, web-grounded",
  "  • “who built this?” / /fingerprint      — I detect the AI builder (Lovable/Bolt/v0/…) and load that tool's known failure modes",
  "  • “check before I push” / /git-check    — I review only what you're about to push and give a go/no-go (install a pre-push hook with “/git-check install”)",
  "  • “write the fix work-order”           — I hand your Claude Code session a precise fix order",
  "  • “write tests for handler.js”         — I design the essential tests + a work-order to add them",
  "  • “that's a false positive because…”   — I remember your decision and stop raising it",
  "  • “learn what tests matter”            — I distill our chat into the tests that matter here",
  "  • “evolve / promote rules”             — I distill recurring findings into candidate detectors (you approve)",
  "  • “exit”                               — leave",
  "",
  "Prefer shortcuts? Type “/” for slash commands (/go-live-checks, /architecture-review, /infra-cost, …).",
].join("\n");

// Slash commands — Claude-style shortcuts for the same capabilities. Natural
// language still works; these are the discoverable, fast path. They are NOT CLI
// subcommands — they live inside the one agent session. Each maps to an existing
// intent (so there's one code path) or to a framed review the brain answers.
const SLASH_HELP = [
  "Slash commands — shortcuts for what I do (plain English works too):",
  "  /autopilot        (/pipeline, /run-all)  — consultative loop: I ASK (scale/architecture/infra/deploy), then design → right-size → certify → release",
  "  /go-live-checks   (/audit, /ship)        — full audit (deterministic + deep + scale + cost) → go-live verdict",
  "  /certify          (/prove, /verify)      — re-scan + RUN the tests, prove each gate closed → a reproducible certificate",
  "  /release-check    (/ship-it, /deploy)    — release gate: deploy only a PROVEN build; “pipeline” writes a gated CI/CD work-order; “<url>” health-checks a deploy",
  "  /architecture-review (/arch)             — design review at scale: layering, coupling, boundaries, data flow (diagnostic)",
  "  /design           (/spec, /blueprint)    — author the architecture BLUEPRINT to build from (prescriptive): target pattern, boundaries, patterns, principles, infra",
  "  /rightsize        (/yagni, /simplify)    — the YAGNI counterweight: flag over-engineering you don't need yet (premature infra, single-impl interfaces, …)",
  "  /security-review  (/security, /sec)      — focused security pass (authz, injection, secrets, exposure)",
  "  /review <file|function>                  — focused code/function review",
  "  /scale            (/scale-plan, /infra)  — infra roadmap to ~1M users + a written scale plan",
  "  /infra-cost       (/cost, /finops)       — $ abuse exposure (cost-bombs) + infra bill at 1M, web-grounded",
  "  /git-check        (/git-check install)   — review what you're about to push (verdict); 'install' wires a pre-push hook",
  "  /scaffold         (/hygiene, /tooling)   — find missing prod-grade files (Husky, linter, formatter, license…) + a work-order",
  "  /fingerprint      (/provenance, /built-by) — detect the AI builder (Lovable/Bolt/v0/Replit/…) + that tool's known failure modes",
  "  /tests <target>   (/test)                — design the essential tests + a work-order",
  "  /fix              (/work-order)          — write the fix work-order for your Claude Code session",
  "  /triage <what>                           — record a won't-fix / false-positive (I stop raising it)",
  "  /evolve           (/promote)             — distill recurring findings into candidate detectors (you approve)",
  "  /learn                                   — distill our chat into the tests that matter here",
  "  /profile          (/memory, /status)     — show what I remember about this project",
  "  /help             (/?)                   — this list",
  "  /exit             (/quit)                — leave",
].join("\n");

const ARCH_REVIEW_PROMPT =
  "Do a grounded ARCHITECTURE review of this repository at production scale. Read the structure " +
  "and the key modules first (use your tools), then assess: layering and separation of concerns, " +
  "coupling and dependency direction, where business logic lives, data flow and boundaries, the " +
  "domain/feature organization, and the top architectural risks at ~1M users. For each issue give " +
  "the concrete change. Ground every claim in files you actually read.";

const SECURITY_REVIEW_PROMPT =
  "Do a focused SECURITY review of this repository. Use mcp__shepherd__scan to ground it in the " +
  "real detectors, then read the security-sensitive paths (auth, API routes, data access, anything " +
  "handling secrets or user input). Report concrete, confirmed issues — broken authorization/IDOR, " +
  "injection, secrets exposure, missing rate limits on expensive/public endpoints, unsafe input — " +
  "each with the exact fix. Quote the scan findings; don't guess.";

type Slash =
  | { intent: Intent; line: string }
  | { special: "help" | "profile" }
  | { unknown: string };

// Translate a "/command [arg]" line into an intent (+ the text downstream
// handlers expect) or a special in-loop action. Unknown commands fall through
// to a helpful list rather than the chat brain.
function translateSlash(raw: string): Slash {
  const body = raw.slice(1).trim();
  const sp = body.indexOf(" ");
  const cmd = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? "" : body.slice(sp + 1).trim();

  switch (cmd) {
    case "help": case "h": case "?": case "commands": return { special: "help" };
    case "profile": case "memory": case "status": return { special: "profile" };
    case "exit": case "quit": case "q": return { intent: "exit", line: raw };
    case "audit": case "go-live": case "go-live-checks": case "golive": case "ship":
      return { intent: "audit", line: raw };
    case "autopilot": case "pipeline": case "run-all": case "runall": case "loop":
      return { intent: "autopilot", line: raw };
    case "certify": case "prove": case "verify": case "certificate":
      return { intent: "certify", line: raw };
    case "release-check": case "release": case "ship-it": case "shipit": case "deploy-check": case "deploy":
      return { intent: "release", line: arg || raw };
    case "design": case "spec": case "blueprint": case "design-spec":
      return { intent: "design", line: raw };
    case "rightsize": case "right-size": case "yagni": case "overengineering": case "over-engineering": case "simplify":
      return { intent: "rightsize", line: raw };
    case "scale": case "scale-plan": case "infra": case "infrastructure":
      return { intent: "scale", line: raw };
    case "infra-cost": case "infracost": case "cost": case "finops":
      return { intent: "cost", line: raw };
    case "git-check": case "gitcheck": case "checkpush": case "prepush":
      // arg "install" wires the pre-push hook; otherwise run the check now.
      return { intent: "gitcheck", line: arg.toLowerCase() === "install" ? "install" : raw };
    case "scaffold": case "hygiene": case "tooling":
      return { intent: "scaffold", line: raw };
    case "fingerprint": case "provenance": case "built-by": case "builtby": case "whobuilt":
      return { intent: "fingerprint", line: raw };
    case "fix": case "work-order": case "workorder": case "handoff":
      return { intent: "fix", line: raw };
    case "evolve": case "promote": return { intent: "evolve", line: raw };
    case "learn": return { intent: "learn", line: raw };
    case "triage": return { intent: "triage", line: arg || raw };
    case "tests": case "test":
      return { intent: "tests", line: arg ? `write tests for ${arg}` : "design the essential tests for this repo" };
    case "architecture-review": case "architectural-review": case "arch": case "arch-review":
      return { intent: "chat", line: ARCH_REVIEW_PROMPT };
    case "security-review": case "security": case "sec":
      return { intent: "chat", line: SECURITY_REVIEW_PROMPT };
    case "review":
      return {
        intent: "chat",
        line: arg
          ? `Do a focused, grounded code review of ${arg}. Read it and any related files, then report ` +
            `concrete issues across correctness, security, performance, and design — each with the exact fix.`
          : "Do a focused code review of the most important file here — pick it by reading the structure first.",
      };
    default:
      return { unknown: cmd };
  }
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

// The consultative INTAKE — Shepherd interviews its user before the loop runs.
// At each step it shows its own recommendation as the default; the user accepts or
// overrides. Choices are persisted so the next run can reuse them. Uses the REPL's
// own readline, so this only runs in an interactive session (CI reuses saved intent).
async function runIntake(
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
    // Fingerprint who built it the moment we wake up — it primes the whole review.
    try {
      const prov = detectProvenance(result.repo);
      if (prov.top) console.log("  " + buildFingerprintCard(prov).replace(/\n/g, "\n  ") + "\n");
    } catch {
      /* fingerprint is best-effort */
    }
    const verdict = goLiveVerdict(lastFindings);
    printVerdict(verdict);
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
        printReport(lastFindings);
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
