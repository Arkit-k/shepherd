// The command router for the interactive agent: natural-language intent matching
// and the Claude-style slash layer. Pure string logic (no engine deps) — extracted
// from interactive.ts so the REPL file stays focused on the conversation loop.

export type Intent =
  | "exit"
  | "audit"
  | "autopilot"
  | "certify"
  | "release"
  | "design"
  | "rightsize"
  | "insights"
  | "devops"
  | "scale"
  | "cost"
  | "gitcheck"
  | "scaffold"
  | "fingerprint"
  | "fix"
  | "tests"
  | "learn"
  | "evolve"
  | "triage"
  | "help"
  | "chat";

export function intentOf(s: string): Intent {
  const t = s.trim().toLowerCase();
  if (/^(exit|quit|bye|:q|q)$/.test(t)) return "exit";
  // DevOps scaffolder — generate the actual infra deck (CI/CD, Docker, proxy, k8s,
  // observability). Before scale so "set up docker/k8s/ci" isn't read as "scale".
  if (/\b(devops|ci[ /-]?cd|cicd|dockeri[sz]e|container(ize|ise)|kubernetes|k8s|kube|nginx|caddy|reverse proxy|prometheus|grafana|observability stack|helm chart|infra(structure)? (setup|files?|config|manifests?)|set ?up (the )?(devops|docker|k8s|kubernetes|ci|pipeline|nginx|caddy|monitoring)|generate (the )?(docker|k8s|ci|pipeline|nginx))\b/.test(t))
    return "devops";
  // Insights — the data flywheel: which findings are most common across the repos
  // you've scanned. Checked early so "what's most common" isn't read as something else.
  if (/\b(insights?|stats|statistics|ledger|trends?|most common|how common|prevalence|leaderboard|what (do|does) .*(usually|commonly) (break|fail))\b/.test(t))
    return "insights";
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

export const HELP = [
  "I'm an agent — just talk to me. Things you can ask:",
  "  • “review the architecture”            — I read the repo and assess the design at scale",
  "  • “design the architecture” / /design   — I author the BLUEPRINT to build from (target pattern, boundaries, design patterns, principles, infra plan)",
  "  • “am I over-engineering?” / /rightsize  — the YAGNI counterweight: I flag abstractions/infra you don't need yet (high- and low-level)",
  "  • “what's most common?” / /insights      — the data flywheel: which findings recur most across the repos you've scanned (gets sharper every run)",
  "  • “set up devops” / /devops              — I generate the infra deck (CI/CD, Husky, Docker, Caddy/nginx, k8s, Prometheus/Grafana), right-sized to your scale",
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
export const SLASH_HELP = [
  "Slash commands — shortcuts for what I do (plain English works too):",
  "  /autopilot        (/pipeline, /run-all)  — consultative loop: I ASK (scale/architecture/infra/deploy), then design → right-size → certify → release",
  "  /go-live-checks   (/audit, /ship)        — full audit (deterministic + deep + scale + cost) → go-live verdict",
  "  /certify          (/prove, /verify)      — re-scan + RUN the tests, prove each gate closed → a reproducible certificate",
  "  /release-check    (/ship-it, /deploy)    — release gate: deploy only a PROVEN build; “pipeline” writes a gated CI/CD work-order; “<url>” health-checks a deploy",
  "  /architecture-review (/arch)             — design review at scale: layering, coupling, boundaries, data flow (diagnostic)",
  "  /design           (/spec, /blueprint)    — author the architecture BLUEPRINT to build from (prescriptive): target pattern, boundaries, patterns, principles, infra",
  "  /rightsize        (/yagni, /simplify)    — the YAGNI counterweight: flag over-engineering you don't need yet (premature infra, single-impl interfaces, …)",
  "  /insights         (/stats, /ledger)      — the data flywheel: most common findings across the repos you've scanned (sharpens every run)",
  "  /security-review  (/security, /sec)      — focused security pass (authz, injection, secrets, exposure)",
  "  /review <file|function>                  — focused code/function review",
  "  /scale            (/scale-plan, /infra)  — infra roadmap to ~1M users + a written scale plan",
  "  /infra-cost       (/cost, /finops)       — $ abuse exposure (cost-bombs) + infra bill at 1M, web-grounded",
  "  /git-check        (/git-check install)   — review what you're about to push (verdict); 'install' wires a pre-push hook",
  "  /devops           (/cicd, /infra-setup)  — generate the infra deck (CI/CD, Husky, Docker, Caddy/nginx, k8s, Prometheus/Grafana), right-sized to your scale",
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

export type Slash =
  | { intent: Intent; line: string }
  | { special: "help" | "profile" }
  | { unknown: string };

// Translate a "/command [arg]" line into an intent (+ the text downstream
// handlers expect) or a special in-loop action. Unknown commands fall through
// to a helpful list rather than the chat brain.
export function translateSlash(raw: string): Slash {
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
    case "insights": case "stats": case "ledger": case "trends": case "trend":
      return { intent: "insights", line: raw };
    case "devops": case "cicd": case "ci-cd": case "infra-setup": case "k8s": case "docker": case "scaffold-infra":
      return { intent: "devops", line: raw };
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
