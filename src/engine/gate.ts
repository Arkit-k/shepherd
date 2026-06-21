import pc from "picocolors";
import type { Finding } from "./report.js";
import { isReCheckable } from "./verify.js";

// The Go-Live Gate. A principal engineer doesn't hand you a pile of findings —
// they make the call: ship or don't, and if not, the shortest path to green.
// This collapses overlapping findings (the same root issue flagged by several
// detectors) into distinct BLOCKERS, orders them by how much they stand between
// you and production, and returns one verdict.

export interface Blocker {
  title: string; // canonical, human description of the blocker
  priority: number; // lower = more urgent (sorts the critical path)
  weight: number; // rough effort, summed into the estimate
  findings: Finding[]; // the raw findings collapsed into this blocker
  files: string[];
  judgment: boolean; // true = no re-checkable anchor (model judgment only)
}

export interface GoLiveVerdict {
  ready: boolean;
  status: "READY" | "READY WITH NOTES" | "NOT READY";
  blockers: Blocker[]; // ordered critical path (gates only)
  advisoryCount: number;
  estimate: string; // loose, honest effort-to-green
  summary: string;
}

interface Rule {
  title: string;
  priority: number;
  weight: number;
  match: (f: Finding) => boolean;
}

const has = (f: Finding, re: RegExp) => re.test(f.id) || re.test(f.message);

// First matching rule wins; identical titles collapse into one blocker. Matchers
// are deliberately broad — the same root issue is flagged by hyphenated ids
// (cost-bomb) AND by Claude in natural language ("no authentication"), and both
// must land in the same blocker so the critical path isn't noisy.
const RULES: Rule[] = [
  {
    title: "Secrets committed to git (.env tracked)",
    priority: 1,
    weight: 1,
    match: (f) => has(f, /env-committed|\.env is committed|secrets are in history/i),
  },
  {
    title: "Exposed secret in source",
    priority: 1,
    weight: 1,
    match: (f) => has(f, /exposed-secret|hardcoded secret|secret.*(commit|source|env)|leaked? .*key/i),
  },
  {
    title: "Known CVE in dependencies (npm audit)",
    priority: 2,
    weight: 1,
    match: (f) => has(f, /npm-audit|npm audit|known.*vulnerab|critical.*vulnerab|\bcve\b/i),
  },
  {
    title: "Unprotected expensive/AI endpoint (needs auth + rate limit)",
    priority: 2,
    weight: 2,
    match: (f) =>
      has(
        f,
        /cost-bomb|rate.?limit|no-auth-rate|llm-call-inline|wallet|drain|quota abuse|cost\/quota|unbounded.*(cost|abuse|token)|no auth(entication)?.*(endpoint|abuse|cost|quota|model|openai)/i,
      ),
  },
  {
    title: "Falls over / breaks under load",
    priority: 2,
    weight: 3,
    match: (f) => has(f, /load-breaks|breaks under load|errors? .*at .*concurrent/i),
  },
  {
    title: "Broken access control (auth not enforced server-side)",
    priority: 3,
    weight: 2,
    match: (f) =>
      has(f, /auth-bypass|unauthed|broken access|billing bypass|idor|no authentication or authorization|without auth|access control/i),
  },
  {
    title: "Error/stack-trace leakage to clients",
    priority: 4,
    weight: 1,
    match: (f) => has(f, /error-leakage|leaks?[- ]st|stack[- ]?trace|leak.*internal|raw exception|verbose error/i),
  },
  {
    title: "Request input not validated",
    priority: 5,
    weight: 1,
    match: (f) => has(f, /input-validation|unvalidated|no schema|validate.*body|(no|zero|without|missing) .{0,12}validation/i),
  },
  {
    title: "No request-size limits (large-payload / memory-exhaustion DoS)",
    priority: 5,
    weight: 1,
    match: (f) => has(f, /unbounded request body|memory[- ]exhaustion|oversized payload|no size limit|body.*no.*limit/i),
  },
  {
    title: "No error handling / missing timeouts (resilience)",
    priority: 6,
    weight: 1,
    match: (f) => has(f, /error[- ]?handling|no-timeout|fetch-no-timeout|try\/?-?catch|unhandled|no try|missing timeout/i),
  },
  {
    title: "Event-driven with no real broker (events lost at scale)",
    priority: 7,
    weight: 4,
    match: (f) => has(f, /event-bus-no-broker|in-process eventemitter|in-memory.*event|events?.*(lost|restart)|no .*broker/i),
  },
  {
    title: "Background work with no queue/worker (runs in request path)",
    priority: 8,
    weight: 3,
    match: (f) => has(f, /task-queue|no-queue|inline-wo|worker.*queue|idempotency|runs in the .*request path|request path/i),
  },
  {
    title: "No health checks / graceful shutdown (can't deploy zero-downtime)",
    priority: 9,
    weight: 1,
    match: (f) => has(f, /health-check|graceful|readyz|healthz|sigterm|health\/readiness|liveness/i),
  },
  {
    title: "In-memory state (breaks horizontal scaling)",
    priority: 10,
    weight: 2,
    match: (f) => has(f, /in-memory-state|module-level.*state|won't survive.*scal/i),
  },
  {
    title: "No cache on a read-heavy path",
    priority: 11,
    weight: 1,
    match: (f) => has(f, /no-cache|no cache|cache layer|read offload/i),
  },
];

function categorize(f: Finding): { title: string; priority: number; weight: number } {
  for (const r of RULES) if (r.match(f)) return { title: r.title, priority: r.priority, weight: r.weight };
  // fallback: the finding stands alone — use a trimmed message as its title.
  const short = f.message.replace(/\s*\[source:.*$/, "").split(/[.!?]/)[0].slice(0, 70);
  return { title: short || f.id, priority: 50, weight: 1 };
}

function estimate(weight: number): string {
  if (weight <= 2) return "an hour or two";
  if (weight <= 4) return "roughly half a day";
  if (weight <= 8) return "~1–2 days";
  if (weight <= 14) return "a few days";
  return "about a week";
}

export function goLiveVerdict(findings: Finding[]): GoLiveVerdict {
  const gates = findings.filter((f) => f.disposition === "gate" && f.id !== "load-projection");
  const advisoryCount = findings.filter((f) => f.disposition === "advise").length;

  // collapse gates into canonical blockers.
  const byTitle = new Map<string, Blocker>();
  for (const f of gates) {
    const { title, priority, weight } = categorize(f);
    const cur =
      byTitle.get(title) ?? { title, priority, weight, findings: [], files: [] as string[], judgment: false };
    cur.findings.push(f);
    if (f.file && !cur.files.includes(f.file)) cur.files.push(f.file);
    byTitle.set(title, cur);
  }
  // a blocker is "judgment" only if NONE of its findings has a re-checkable anchor.
  for (const b of byTitle.values()) b.judgment = !b.findings.some(isReCheckable);
  const blockers = [...byTitle.values()].sort((a, b) => a.priority - b.priority);
  const totalWeight = blockers.reduce((s, b) => s + b.weight, 0);

  if (blockers.length === 0) {
    return {
      ready: true,
      status: advisoryCount > 0 ? "READY WITH NOTES" : "READY",
      blockers: [],
      advisoryCount,
      estimate: "—",
      summary:
        advisoryCount > 0
          ? `No blockers — clear to ship. ${advisoryCount} advisory improvement(s) noted for later.`
          : "No blockers — clear to ship. Shipshape.",
    };
  }

  return {
    ready: false,
    status: "NOT READY",
    blockers,
    advisoryCount,
    estimate: estimate(totalWeight),
    summary: `Blocked on ${blockers.length} must-fix. Green after these — about ${estimate(totalWeight)} of work.`,
  };
}

const STATUS_ICON: Record<GoLiveVerdict["status"], string> = {
  READY: "✅ READY TO SHIP",
  "READY WITH NOTES": "✅ READY (with notes)",
  "NOT READY": "🔴 NOT READY",
};

export function printVerdict(v: GoLiveVerdict): void {
  const bar = "═".repeat(52);
  console.log("\n  " + pc.dim(bar));
  const head = v.ready ? pc.green(STATUS_ICON[v.status]) : pc.red(STATUS_ICON[v.status]);
  console.log("   " + pc.bold("GO-LIVE VERDICT:  ") + pc.bold(head));
  console.log("  " + pc.dim(bar));

  if (v.blockers.length) {
    console.log("   " + pc.bold(`Blocked on ${v.blockers.length} must-fix (in order):`));
    v.blockers.forEach((b, i) => {
      const where = b.files.length ? pc.dim(`  (${b.files.slice(0, 3).join(", ")}${b.files.length > 3 ? ", …" : ""})`) : "";
      const tag = b.judgment ? pc.yellow(" ⚠ judgment") : "";
      console.log(`     ${pc.bold(String(i + 1) + ".")} ${b.title}${tag}${where}`);
    });
    const adv = `${v.advisoryCount} ${v.advisoryCount === 1 ? "advisory" : "advisories"}`;
    console.log("   " + pc.dim(`+ ${adv}. Estimated ${v.estimate} to green.`));
    if (v.blockers.some((b) => b.judgment))
      console.log("   " + pc.dim("⚠ = model judgment, no deterministic re-check — verify with a full `shepherd` re-run or a human."));
  } else {
    console.log("   " + pc.green(v.summary));
  }
  console.log("  " + pc.dim(bar) + "\n");
}

export function verdictMarkdown(v: GoLiveVerdict): string {
  const lines: string[] = [`**${STATUS_ICON[v.status]}** — ${v.summary}`, ``];
  if (v.blockers.length) {
    lines.push(`**Critical path to green:**`, ``);
    v.blockers.forEach((b, i) => {
      const where = b.files.length ? ` — \`${b.files.slice(0, 4).join("`, `")}\`` : "";
      const tag = b.judgment ? " ⚠️ _(judgment — verify with a full re-run / human)_" : "";
      lines.push(`${i + 1}. ${b.title}${tag}${where}`);
    });
    lines.push(``, `_${v.advisoryCount} advisory improvement(s) noted separately. Estimated ${v.estimate} to green. ⚠️ = model judgment with no deterministic re-check._`);
  }
  return lines.join("\n") + "\n";
}
