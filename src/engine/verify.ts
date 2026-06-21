import type { Finding } from "./report.js";

// How can a finding actually be RE-VERIFIED after a fix? This is the trust
// question. Three kinds have a hard anchor; one is judgment-only — and a passing
// deterministic scan does NOT prove a judgment finding was fixed. We classify
// findings so the work-order and verdict can be honest about which is which.
export type VerifyMethod =
  | "deterministic" // a Tier-1 regex/AST check re-runs and flips → `shepherd scan`
  | "empirical" // measured by the live probe / load test → re-run the probe
  | "inventory" // anchored to a dependency/file presence → `shepherd scan` re-detects
  | "claude"; // pure model judgment, no re-checkable fact → needs `--deep` re-review

// Claude-generated finding ids (no deterministic anchor of their own).
const CLAUDE_IDS = new Set(["security", "performance", "architecture", "logic", "service-communication", "outdated-pattern"]);
const CLAUDE_PREFIXES = [/^scale-/, /^fe-/, /^idiom-/, /^structure-[a-z]/, /^research-/, /^design-review/];

export function verifyMethod(f: Finding): VerifyMethod {
  const id = f.id;
  // empirical — produced by hitting/measuring a running server
  if (f.file.startsWith("live:") || f.file === "(load test)" || /^live-/.test(id) || /^load-/.test(id)) {
    return "empirical";
  }
  // inventory — the prod-engineer findings are anchored to dep/file presence
  if (/^prod-/.test(id)) return "inventory";
  // claude — judgment, no re-checkable fact
  if (CLAUDE_IDS.has(id) || CLAUDE_PREFIXES.some((re) => re.test(id))) return "claude";
  // everything else is a Tier-1 deterministic check (regex/AST/file presence)
  return "deterministic";
}

// Re-checkable = a fact re-runs and confirms the fix. Judgment = only a model
// re-review can confirm; a plain deterministic scan passing means nothing.
export function isReCheckable(f: Finding): boolean {
  return verifyMethod(f) !== "claude";
}

export function verifyHint(m: VerifyMethod): string {
  switch (m) {
    case "deterministic":
      return "re-run `npx shepherd scan` — the same check re-confirms the fix";
    case "empirical":
      return "re-run `npx shepherd probe` — confirmed by hitting the running app";
    case "inventory":
      return "re-run `npx shepherd scan` — confirmed once the dependency/config is present";
    case "claude":
      return "needs `npx shepherd scan --deep` or human review — a plain scan does NOT prove this is fixed";
  }
}
