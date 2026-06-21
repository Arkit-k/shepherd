import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Finding } from "./report.js";
import type { Repo } from "./ingest.js";

// The data moat. Every scan appends an entry. Over thousands of scans this
// becomes a proprietary, ranked model of how AI-built code actually fails —
// the one thing a code-cloner can't copy (they start at zero data).
const DIR = path.join(homedir(), ".shepherd");
const LEDGER = path.join(DIR, "ledger.jsonl");

export interface LedgerEntry {
  ts: string;
  repo: string; // anonymized hash of the repo path — no code, no identity
  files: number;
  blocking: number;
  checks: Record<string, number>; // check id -> occurrences this scan
}

function anonId(repoRoot: string): string {
  return createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 12);
}

export function recordScan(repo: Repo, findings: Finding[]): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const checks: Record<string, number> = {};
  for (const f of findings) checks[f.id] = (checks[f.id] ?? 0) + 1;

  const entry: LedgerEntry = {
    ts: new Date().toISOString(),
    repo: anonId(repo.root),
    files: repo.files.length,
    blocking: findings.filter((f) => f.disposition === "gate").length,
    checks,
  };
  appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
}

export function readLedger(): LedgerEntry[] {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as LedgerEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is LedgerEntry => e !== null);
}

export interface LedgerStats {
  scans: number;
  repos: number;
  totalFindings: number;
  checkFrequency: { id: string; total: number; scans: number }[];
}

export function computeStats(entries: LedgerEntry[]): LedgerStats {
  const repos = new Set(entries.map((e) => e.repo));
  const byCheck = new Map<string, { total: number; scans: number }>();
  let totalFindings = 0;

  for (const e of entries) {
    for (const [id, n] of Object.entries(e.checks)) {
      const cur = byCheck.get(id) ?? { total: 0, scans: 0 };
      cur.total += n;
      cur.scans += 1;
      byCheck.set(id, cur);
      totalFindings += n;
    }
  }

  const checkFrequency = [...byCheck.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.total - a.total);

  return { scans: entries.length, repos: repos.size, totalFindings, checkFrequency };
}
