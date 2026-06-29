import { claudeJsonArray } from "../claude-json.js";
import { recordTriage, type TriageStatus } from "./triage.js";
import type { Finding } from "../report.js";

// Conversational triage. The user dismisses findings in plain language —
// "the security one in api/chat is a false positive, the limiter's in middleware"
// — and Shepherd maps that to the actual findings and records the decision (with
// the reason) into triage.json. Next run, suppression + the memory brief keep it
// from coming back. This is the precision loop closing through conversation
// instead of a command.

interface RawTriage {
  index?: number; // 1-based index into the findings list we showed
  status?: string;
  scope?: string;
  reason?: string;
}

export interface TriageResult {
  status: TriageStatus;
  id: string;
  file: string;
  scope: "exact" | "file";
  reason: string;
}

function normStatus(s?: string): TriageStatus {
  return s === "false-positive" || s === "wontfix" || s === "accept" ? s : "wontfix";
}

// Map a free-text dismissal onto the recent findings and persist it. Low-context
// (no file reads) — it only needs the findings list + the user's sentence.
export function triageFromText(
  root: string,
  statement: string,
  findings: Finding[],
  ts: string,
): TriageResult[] {
  const list = findings
    .slice(0, 40)
    .map((f, i) => `${i + 1}. [${f.id}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message}`)
    .join("\n");

  const prompt = [
    `The user wants to DISMISS (triage away) one or more findings. Match their statement`,
    `to the numbered findings below and return the matching decisions BY NUMBER.`,
    ``,
    `Findings:`,
    list || "(none)",
    ``,
    `User statement: "${statement}"`,
    ``,
    `Return ONLY a JSON array of`,
    `{"index":number,"status":"false-positive"|"wontfix"|"accept","scope":"exact"|"file","reason":string}.`,
    `- index: the NUMBER of the matched finding from the list above (1-based).`,
    `- status: false-positive = the finding is wrong; wontfix = real but not now;`,
    `  accept = acknowledged/intentional.`,
    `- scope: "exact" for that one specific finding; "file" to dismiss the whole check`,
    `  in that file (use when the user says "all the X in this file").`,
    `- reason: the user's reason, paraphrased if needed. One line.`,
    `Return [] if you cannot confidently match any finding.`,
  ].join("\n");

  const raw = claudeJsonArray<RawTriage>(prompt, root) ?? [];
  const out: TriageResult[] = [];
  for (const r of raw) {
    if (!r || typeof r.index !== "number") continue;
    const f = findings[r.index - 1]; // we own the lookup — no copy errors
    if (!f) continue;
    const status = normStatus(r.status);
    const scope = r.scope === "file" ? "file" : "exact";
    recordTriage(root, { status, id: f.id, file: f.file, reason: r.reason ?? "", scope, message: f.message, ts });
    out.push({ status, id: f.id, file: f.file, scope, reason: r.reason ?? "" });
  }
  return out;
}
