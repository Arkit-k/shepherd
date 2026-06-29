import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Finding } from "../report.js";
import {
  findingKey,
  fileScopeKey,
  msgSlug,
  slugTokens,
  jaccard,
  SAME_FINDING_THRESHOLD,
} from "./identity.js";

// FEEDBACK memory — what the team decided about a finding. This is Shepherd's
// richer successor to the flat baseline.json: instead of a binary "accepted",
// each entry carries a STATUS and a REASON, so the agent reviewer can recall
// *why* something was dismissed and not waste a turn re-deriving it.
//
// Stored as a plain, hand-editable JSON object at .shepherd/triage.json — keyed
// by either the exact finding key or the coarser file-scope key (see identity.ts).

export type TriageStatus =
  | "accept" // acknowledged, a known/intentional issue — don't surface as new
  | "wontfix" // real, but the team chose not to fix now — suppress the noise
  | "false-positive"; // the detector/agent was wrong — never raise again

export interface TriageEntry {
  status: TriageStatus;
  reason: string;
  ts: string;
  id: string;
  file: string;
  scope: "exact" | "file";
  slug?: string; // the message slug at record time — used for fuzzy exact-match
}

type TriageStore = Record<string, TriageEntry>;

function triagePath(root: string): string {
  return path.join(root, ".shepherd", "triage.json");
}

export function readTriage(root: string): TriageStore {
  const p = triagePath(root);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as TriageStore;
  } catch {
    return {}; // a malformed triage file should never crash a scan
  }
}

function writeTriage(root: string, store: TriageStore): void {
  const dir = path.join(root, ".shepherd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(triagePath(root), JSON.stringify(store, null, 2) + "\n");
}

// Record (or overwrite) a triage decision. `message` is only needed for exact
// scope — it's what the stable key is derived from.
export function recordTriage(
  root: string,
  input: { status: TriageStatus; id: string; file: string; reason: string; scope: "exact" | "file"; message?: string; ts: string },
): string {
  const store = readTriage(root);
  const key =
    input.scope === "exact"
      ? findingKey({ id: input.id, file: input.file, message: input.message ?? "" })
      : fileScopeKey({ id: input.id, file: input.file });
  store[key] = {
    status: input.status,
    reason: input.reason,
    ts: input.ts,
    id: input.id,
    file: input.file,
    scope: input.scope,
    ...(input.scope === "exact" ? { slug: msgSlug(input.message ?? "") } : {}),
  };
  writeTriage(root, store);
  return key;
}

// Does a prior decision cover this finding?
//   1. file-scope (whole-category) decision — exact O(1) key match;
//   2. exact decision — fuzzy: same id + file AND message tokens overlap enough
//      that it's clearly the same issue despite the agent's run-to-run rephrasing.
export function matchTriage(store: TriageStore, f: Finding): TriageEntry | null {
  const fileScoped = store[fileScopeKey(f)];
  if (fileScoped) return fileScoped;

  const fast = store[findingKey(f)];
  if (fast) return fast;

  const tokens = slugTokens(msgSlug(f.message));
  for (const e of Object.values(store)) {
    if (e.scope !== "exact" || e.id !== f.id || e.file !== f.file || !e.slug) continue;
    if (jaccard(tokens, slugTokens(e.slug)) >= SAME_FINDING_THRESHOLD) return e;
  }
  return null;
}

// Drop findings the team has already triaged away (any status) so re-runs surface
// only what's genuinely new — the lint-baseline pattern, but reason-aware. Pure +
// defensive: if there's no triage file, returns the list unchanged.
export function suppressDismissed(findings: Finding[], root: string): Finding[] {
  const store = readTriage(root);
  if (Object.keys(store).length === 0) return findings;
  return findings.filter((f) => matchTriage(store, f) === null);
}

export function listTriage(root: string): TriageEntry[] {
  return Object.values(readTriage(root)).sort((a, b) => (a.ts < b.ts ? 1 : -1));
}
