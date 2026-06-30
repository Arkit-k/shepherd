import { readLedger, computeStats, type LedgerStats } from "./ledger.js";
import type { Finding } from "./report.js";

// THE DATA FLYWHEEL — the read side. The ledger has always RECORDED every scan
// (engine/ledger.ts), but nothing consumed it: the moat was being filled and never
// spent. This closes the loop — every scan's findings are ranked by how often they
// actually occur across the repos Shepherd has seen, and that prevalence is folded
// back into reviews ("seen in 41% of repos you've scanned — #2 most common"). The
// more you scan, the sharper the prioritization; a code-cloner starts at zero data.
//
// Scope note (honest): the ledger is local-first (~/.shepherd/ledger.jsonl), so the
// prevalence is "across the repos YOU'VE scanned on this machine." That's still the
// compounding flywheel — it gets richer with use — and it's the truthful denominator
// (a global, cross-user dataset is the GitHub-App/server story, not this).
//
// We deliberately do NOT auto-change a finding's SEVERITY from its frequency —
// frequency ≠ severity (a rare bug can be critical). Prevalence is a prioritization
// and priming signal layered on top, not a severity override.

const MIN_REPOS = 3; // below this, "% of repos" is noise
const MIN_SCANS = 5;
const NOTABLE_PCT = 0.3; // only annotate a finding when it's genuinely common

export interface Insights {
  ready: boolean; // enough data for prevalence to mean something
  stats: LedgerStats;
  prevalence: Map<string, { pct: number; repos: number; rank: number }>;
}

export function loadInsights(): Insights {
  const stats = computeStats(readLedger());
  const ready = stats.repos >= MIN_REPOS && stats.scans >= MIN_SCANS;
  const prevalence = new Map<string, { pct: number; repos: number; rank: number }>();
  stats.checkFrequency.forEach((c, i) => {
    prevalence.set(c.id, { pct: stats.repos ? c.repos / stats.repos : 0, repos: c.repos, rank: i + 1 });
  });
  return { ready, stats, prevalence };
}

// Append a prevalence note to genuinely-common findings — display only. Callers
// keep the RAW findings for gating/certify; this is a copy for printing.
export function annotate(findings: Finding[], ins: Insights = loadInsights()): Finding[] {
  if (!ins.ready) return findings;
  return findings.map((f) => {
    const p = ins.prevalence.get(f.id);
    if (!p || p.pct < NOTABLE_PCT || f.message.includes("📊")) return f;
    const pct = Math.round(p.pct * 100);
    return { ...f, message: `${f.message} · 📊 seen in ${pct}% of repos you've scanned (#${p.rank} most common)` };
  });
}

// A one-line priming note for the boot/audit summary (or "" if not ready).
export function prevalenceNote(findings: Finding[], ins: Insights = loadInsights()): string {
  if (!ins.ready) return "";
  const top = findings
    .map((f) => ({ f, p: ins.prevalence.get(f.id) }))
    .filter((x): x is { f: Finding; p: { pct: number; repos: number; rank: number } } => !!x.p && x.p.pct >= NOTABLE_PCT)
    .sort((a, b) => b.p.pct - a.p.pct)[0];
  if (!top) return "";
  return `📊 ${top.f.id} here is a recurring AI-code failure — seen in ${Math.round(top.p.pct * 100)}% of the ${ins.stats.repos} repos you've scanned.`;
}

// The `/insights` leaderboard — the ranked "most common AI failures" from the ledger.
export function insightsCard(ins: Insights = loadInsights()): string {
  const s = ins.stats;
  if (s.scans === 0) {
    return "📊 No scan history yet. I build this ranking as you scan — each run sharpens it, and a code-cloner starts at zero data.";
  }
  const lines = [`📊 Shepherd insights — ${s.scans} scan(s) across ${s.repos} repo(s) you've scanned · ${s.totalFindings} findings logged`];
  if (!ins.ready) lines.push(`   (early data — prevalence stabilizes after ~${MIN_REPOS} repos / ${MIN_SCANS} scans)`);
  lines.push("", "   Most common findings (by share of repos):");
  s.checkFrequency.slice(0, 12).forEach((c, i) => {
    const pct = s.repos ? Math.round((c.repos / s.repos) * 100) : 0;
    lines.push(`   ${String(i + 1).padStart(2)}.  ${c.id.padEnd(28)} ${String(pct).padStart(3)}% of repos · ${c.total} total`);
  });
  lines.push("", "   This is the moat: the more you (and your team) scan, the sharper Shepherd's priorities get.");
  return lines.join("\n");
}
