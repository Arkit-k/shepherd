import type { Repo } from "./ingest.js";
import type { Finding } from "./report.js";
import { claudeAvailable } from "./fixers/claude.js";
import { claudeAgentJsonArray } from "./claude-json.js";
import { detectStack } from "./tech-stack.js";
import type { InfraPrescription } from "./backend/architect.js";

// THE FINOPS LENS — money is what makes founders act. Two questions, both in
// dollars:
//   1. EXPOSURE — what does abuse cost? AI tools love to leave an expensive
//      endpoint (LLM completion, transactional email, SMS, a paid third-party
//      API) public and unthrottled. Shepherd already flags the cost-bomb; this
//      puts a number on it: "≈$1.2k/day if scripted".
//   2. INFRA BILL — what does the road to ~1M cost to run? A rough monthly
//      estimate for the infrastructure the scale architect prescribed (managed
//      cache, queue worker, search, replicas…), so the plan has a price tag.
//
// Numbers are deliberately rough order-of-magnitude — grounded in CURRENT
// provider pricing via a live web pass, not a 2021 memory. Advisory only; you
// don't gate a merge on a cloud bill.

export type CostKind = "exposure" | "infra";

export interface CostItem {
  kind: CostKind;
  // exposure fields
  where?: string; // file/route the spend lives in
  operation?: string; // what costs money (e.g. "LLM completion")
  protected?: boolean; // is it behind auth + a rate limit?
  unitCost?: string; // "≈$0.01 / call"
  abuseEstimate?: string; // "≈$1.2k/day if scripted" (worst case while unprotected)
  // infra fields
  component?: string; // "cache" | "task-queue" | ...
  tool?: string; // "Valkey"
  monthlyEstimate?: string; // "≈$30/mo"
  assumption?: string; // "1 small managed node @ 1M users"
  // shared
  note?: string;
  source?: string; // a real pricing URL
}

interface Raw extends Partial<CostItem> {}

function prompt(repo: Repo, prescriptions: InfraPrescription[]): string {
  const tech = detectStack(repo);
  const planned = prescriptions.length
    ? prescriptions
        .map((p) => `- ${p.component}: ${p.recommendation}${p.priority ? ` (${p.priority})` : ""}`)
        .join("\n")
    : "(no scale plan provided — infer the likely infra from the code)";

  return [
    `You are a FINOPS / cost engineer. Put DOLLAR figures on this app, two ways. Use your`,
    `tools to read the repo for evidence, and RESEARCH THE WEB for CURRENT (2026) provider`,
    `pricing — token costs, email/SMS rates, managed cache/queue/search/db prices. Keep`,
    `numbers rough order-of-magnitude but realistic; always capture a pricing source URL.`,
    ``,
    `Stack: ${tech.language}; frameworks: ${tech.frameworks.join(", ") || "—"}; ` +
      `databases: ${tech.databases.join(", ") || "—"}.`,
    ``,
    `PART 1 — ABUSE EXPOSURE (kind:"exposure"):`,
    `Find every operation that costs real money per call: LLM/AI completions, transactional`,
    `email, SMS, image/video processing, paid third-party APIs, large egress. For each, check`,
    `(grep/read) whether it is behind BOTH authentication AND a rate limit. If it is public or`,
    `unthrottled, estimate the worst-case daily spend if a script hammered it. This is the`,
    `cost-bomb in dollars.`,
    ``,
    `PART 2 — INFRA RUN-COST AT ~1M USERS (kind:"infra"):`,
    `Estimate the rough MONTHLY cost to run the infrastructure this app needs at ~1,000,000`,
    `users. Prefer the items below if given; otherwise infer them. State the sizing assumption.`,
    `Planned infra:`,
    planned,
    ``,
    `Respond with ONLY a JSON array (no prose). Each element is one of:`,
    `{"kind":"exposure","where":"file/route","operation":"what costs money","protected":true|false,`,
    `"unitCost":"≈$X / call","abuseEstimate":"≈$Y/day if abused","note":"one line","source":"pricing URL"}`,
    `{"kind":"infra","component":"cache","tool":"Valkey","monthlyEstimate":"≈$X/mo",`,
    `"assumption":"sizing at 1M","note":"one line","source":"pricing URL"}`,
    `Order exposures worst-first. Return [] only if there is genuinely nothing that costs money.`,
  ].join("\n");
}

function toFinding(c: CostItem): Finding {
  if (c.kind === "exposure") {
    const unprotected = c.protected === false;
    const tag = unprotected ? "UNPROTECTED" : "protected";
    const abuse = c.abuseEstimate ? ` — ${c.abuseEstimate}` : "";
    const unit = c.unitCost ? ` (${c.unitCost})` : "";
    const src = c.source ? ` [src: ${c.source}]` : "";
    return {
      id: "cost-exposure",
      // An unprotected paid endpoint is a real, critical financial risk; a
      // protected one is just FYI context.
      severity: unprotected ? "critical" : "info",
      disposition: "advise",
      file: c.where || "(spend)",
      message: `${c.operation || "Paid operation"}${unit}${abuse} — ${tag}.${c.note ? ` ${c.note}` : ""}${src}`,
    };
  }
  const month = c.monthlyEstimate ? ` ≈ ${c.monthlyEstimate}` : "";
  const asmpt = c.assumption ? ` (${c.assumption})` : "";
  const src = c.source ? ` [src: ${c.source}]` : "";
  return {
    id: "cost-infra",
    severity: "info",
    disposition: "advise",
    file: "(infra)",
    message: `${c.tool || c.component || "Infra"}${month}${asmpt}.${c.note ? ` ${c.note}` : ""}${src}`,
  };
}

export interface FinOpsResult {
  items: CostItem[];
  findings: Finding[];
}

// Run the FinOps pass. Agentic + web by default (pricing must be current).
export function estimateCost(
  repo: Repo,
  opts: { prescriptions?: InfraPrescription[]; web?: boolean; budgetUsd?: number } = {},
): FinOpsResult {
  if (!claudeAvailable()) {
    console.log("⚠️  the FinOps lens needs Claude Code logged in on PATH; skipping.");
    return { items: [], findings: [] };
  }

  const raw = claudeAgentJsonArray<Raw>(prompt(repo, opts.prescriptions ?? []), repo.root, {
    web: opts.web ?? true,
    budgetUsd: opts.budgetUsd ?? 0.5,
  });
  if (!raw) return { items: [], findings: [] };

  const items: CostItem[] = raw
    .filter((r): r is Raw => !!r && (r.kind === "exposure" || r.kind === "infra"))
    .map((r) => ({
      kind: r.kind as CostKind,
      where: str(r.where),
      operation: str(r.operation),
      protected: typeof r.protected === "boolean" ? r.protected : undefined,
      unitCost: str(r.unitCost),
      abuseEstimate: str(r.abuseEstimate),
      component: str(r.component),
      tool: str(r.tool),
      monthlyEstimate: str(r.monthlyEstimate),
      assumption: str(r.assumption),
      note: str(r.note),
      source: str(r.source),
    }))
    // worst exposures first, then infra.
    .sort((a, b) => rank(a) - rank(b));

  return { items, findings: items.map(toFinding) };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// unprotected exposures first, then protected exposures, then infra lines.
function rank(c: CostItem): number {
  if (c.kind === "exposure") return c.protected === false ? 0 : 1;
  return 2;
}

// Render the FinOps report — the dollar story, hand-off friendly.
export function buildCostReport(items: CostItem[], ts: string): string {
  const exposures = items.filter((c) => c.kind === "exposure");
  const infra = items.filter((c) => c.kind === "infra");

  const expLines = exposures.length
    ? exposures.map((c) => {
        const flag = c.protected === false ? "🔴 UNPROTECTED" : "🟢 protected";
        return [
          `- **${c.operation || "Paid operation"}** — ${flag}${c.where ? ` · \`${c.where}\`` : ""}`,
          ...(c.unitCost ? [`  - Unit: ${c.unitCost}`] : []),
          ...(c.abuseEstimate ? [`  - **Worst case:** ${c.abuseEstimate}`] : []),
          ...(c.note ? [`  - ${c.note}`] : []),
          ...(c.source ? [`  - Pricing: ${c.source}`] : []),
        ].join("\n");
      })
    : ["- (nothing in the code costs money per call — no abuse exposure found.)"];

  const infraLines = infra.length
    ? infra.map((c) => {
        return [
          `- **${c.tool || c.component}**${c.monthlyEstimate ? ` — ${c.monthlyEstimate}` : ""}`,
          ...(c.assumption ? [`  - Assumption: ${c.assumption}`] : []),
          ...(c.note ? [`  - ${c.note}`] : []),
          ...(c.source ? [`  - Pricing: ${c.source}`] : []),
        ].join("\n");
      })
    : ["- (no scale infra priced — run the scale plan first.)"];

  return [
    `# Shepherd — cost report (FinOps)`,
    ``,
    `_Generated ${ts}. Rough order-of-magnitude, grounded in current provider pricing._`,
    ``,
    `## 💸 Abuse exposure — what abuse costs you`,
    `The expensive operations in this repo, and whether anything stops a script from draining your account.`,
    ``,
    ...expLines,
    ``,
    `## 🧾 Infra run-cost at ~1M users`,
    `A rough monthly bill for the infrastructure on the road to a million users.`,
    ``,
    ...infraLines,
    ``,
    `_Numbers are estimates to size decisions, not quotes. Protect the 🔴 endpoints first — that's free money saved._`,
    ``,
  ].join("\n");
}
