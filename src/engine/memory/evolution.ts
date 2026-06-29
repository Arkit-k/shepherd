import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { claudeJsonArray } from "../claude-json.js";
import { msgSlug } from "./identity.js";
import type { Finding } from "../report.js";
import type { Repo } from "../ingest.js";
import type { PatternRule, RulePack } from "../rules/types.js";

// SELF-EVOLUTION — Shepherd's analog to Hermes' skill-evolution loop, but grounded
// in confirmed findings instead of prompt mutation. Judgment findings (the things
// regex CAN'T catch today — security/perf/arch/logic from the deep review) are
// logged with the offending code. When the SAME class recurs enough times,
// Shepherd asks: "can this be reduced to a deterministic rule?" If yes, it drafts
// a candidate rule into .shepherd/candidate-rules/ — which is NOT a pack load
// path. Nothing auto-applies; the human reviews and moves it into ~/.shepherd/packs/
// to activate. That's the guardrail: learning proposes, the human commits.

const JUDGMENT_IDS = new Set(["security", "performance", "architecture", "logic", "deep-review"]);
const DEFAULT_THRESHOLD = 3;

interface FindingMemo {
  id: string;
  slug: string;
  message: string;
  file: string;
  snippet: string;
  ts: string;
}

function logPath(root: string): string {
  return path.join(root, ".shepherd", "findings.jsonl");
}
function candidatesDir(root: string): string {
  return path.join(root, ".shepherd", "candidate-rules");
}

// Record the judgment findings (with the offending line) as raw material for
// later promotion. Best-effort; only the ids regex doesn't already cover.
export function recordForEvolution(root: string, repo: Repo, findings: Finding[]): void {
  try {
    const rows: string[] = [];
    for (const f of findings) {
      if (!JUDGMENT_IDS.has(f.id) || !f.line) continue;
      const src = repo.files.find((x) => x.path === f.file);
      const snippet = src ? (src.content.split("\n")[f.line - 1] ?? "").trim().slice(0, 200) : "";
      const memo: FindingMemo = { id: f.id, slug: msgSlug(f.message), message: f.message, file: f.file, snippet, ts: new Date().toISOString() };
      rows.push(JSON.stringify(memo));
    }
    if (rows.length === 0) return;
    mkdirSync(path.dirname(logPath(root)), { recursive: true });
    appendFileSync(logPath(root), rows.join("\n") + "\n");
  } catch {
    /* best-effort */
  }
}

function readLog(root: string): FindingMemo[] {
  const p = logPath(root);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FindingMemo);
  } catch {
    return [];
  }
}

export interface Candidate {
  signature: string;
  count: number;
  rule: PatternRule;
  path: string; // where the candidate pack was written (relative)
}

function safeName(sig: string): string {
  return sig.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60).toLowerCase();
}

// Promote recurring judgment findings into candidate (human-gated) rules.
export function promoteRules(root: string, opts: { threshold?: number } = {}): Candidate[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const memos = readLog(root);
  if (memos.length === 0) return [];

  // group by id + message-slug so distinct issues stay distinct.
  const groups = new Map<string, FindingMemo[]>();
  for (const m of memos) {
    const sig = `${m.id}::${m.slug}`;
    const arr = groups.get(sig) ?? [];
    arr.push(m);
    groups.set(sig, arr);
  }

  const dir = candidatesDir(root);
  const existing = existsSync(dir) ? new Set(readdirSync(dir)) : new Set<string>();
  const out: Candidate[] = [];

  for (const [sig, items] of groups) {
    if (items.length < threshold) continue;
    const fname = `${safeName(sig)}.json`;
    if (existing.has(fname)) continue; // already proposed — don't nag

    const examples = items
      .slice(0, 5)
      .map((m, i) => `${i + 1}. ${m.message}\n   code: ${m.snippet || "(no snippet)"}  [${m.file}]`)
      .join("\n");

    const prompt = [
      `Shepherd keeps finding this same class of issue (${items.length} times) — a JUDGMENT`,
      `finding its regex/AST detectors don't yet catch. Decide: can it be reduced to a`,
      `RELIABLE deterministic rule (a regex over file content) with an acceptable false-positive`,
      `rate? Many judgment issues CANNOT — if so, return [] (be honest, don't force it).`,
      ``,
      `Examples:`,
      examples,
      ``,
      `If — and only if — a precise regex would catch this class without flooding false`,
      `positives, return a JSON array with ONE rule:`,
      `[{"id":"learned-${safeName(sig).slice(0, 30)}","pattern":"<regex over file content>",`,
      `"filePattern":"<optional regex over file path>","severity":"critical"|"warn"|"info",`,
      `"gate":false,"message":"<one-line explanation>","tool":"learned"}]`,
      `IMPORTANT: "pattern" must be valid JavaScript RegExp syntax — it is compiled with`,
      `new RegExp(pattern) and NO flags. Do NOT use inline flags like (?i) or (?s) (JS`,
      `rejects them); for case-insensitivity use character classes, e.g. [Tt]oken.`,
      `Keep gate=false (a learned rule advises until a human upgrades it). Return [] if not regex-able.`,
    ].join("\n");

    const raw = claudeJsonArray<PatternRule>(prompt, root);
    const rule = raw && raw[0];
    if (!rule || !rule.pattern || !rule.message) continue;
    try {
      new RegExp(rule.pattern); // must compile, or it's useless
    } catch {
      continue;
    }
    rule.gate = false; // enforce the guardrail regardless of what came back

    const pack: RulePack = {
      name: `learned-${safeName(sig)}`,
      description: `Candidate rule Shepherd distilled from ${items.length} recurring findings. Review, then move to ~/.shepherd/packs/ to activate.`,
      rules: [rule],
    };
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, fname), JSON.stringify(pack, null, 2) + "\n");
      out.push({ signature: sig, count: items.length, rule, path: path.relative(root, path.join(dir, fname)) });
    } catch {
      /* best-effort */
    }
  }
  return out;
}
