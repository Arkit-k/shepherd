import { spawnSync } from "node:child_process";

export interface ClaudeJsonOptions {
  // Let the call research the live internet (WebSearch/WebFetch) before
  // answering — like a principal engineer looking up current best practice.
  // Slower + costlier, so use sparingly on LOW context (no file dumps).
  web?: boolean;
  timeoutMs?: number;
}

// Scan a string for the first balanced, parseable top-level JSON array. Bracket
// depth aware and string-literal aware, so stray brackets in prose (e.g. a
// "[[wiki-link]]") don't derail it the way a greedy /\[[\s\S]*\]/ match would.
function scanJsonArray<T>(s: string): T[] | null {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "[") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(s.slice(i, j + 1));
            if (Array.isArray(v)) return v as T[];
          } catch {
            /* not valid here — try the next opening bracket */
          }
          break;
        }
      }
    }
  }
  return null;
}

// Pull the first JSON array out of a headless-Claude run. The `--output-format
// json` envelope wraps the model's final text in `.result`; we unwrap that, then
// prefer a fenced ```json block (the model often wraps its answer), falling back
// to a balanced-bracket scan of the whole text. Returns null if nothing parses.
function parseJsonArray<T>(stdout: string): T[] | null {
  let text = stdout;
  try {
    const env = JSON.parse(stdout);
    if (typeof env.result === "string") text = env.result;
  } catch {
    /* raw stdout (not the json envelope) — fall through */
  }

  // Fenced code blocks first — the model usually puts the real answer there,
  // away from any reasoning prose (which may contain stray brackets).
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const arr = scanJsonArray<T>(m[1]);
    if (arr) return arr;
  }
  return scanJsonArray<T>(text);
}

// Shared helper: run a headless Claude call whose prompt asks for a JSON array,
// and return the parsed array (or null). Centralizes the spawn + envelope-unwrap
// + array-extraction the Tier-2 reviewers all need. Prompt goes via STDIN
// (passing it as a CLI arg hangs cmd.exe on Windows).
//
// NOTE: this is the NON-agentic call — no file tools. The model only sees what's
// in the prompt. Use it for low-context judgment (research, structural summaries).
// For a reviewer that should explore the repo and verify its own findings, use
// `claudeAgentJsonArray` below.
export function claudeJsonArray<T = unknown>(
  prompt: string,
  root: string,
  opts: ClaudeJsonOptions = {},
): T[] | null {
  const args = ["-p", "--output-format", "json"];
  if (opts.web) args.push("--allowedTools", "WebSearch", "WebFetch");

  const res = spawnSync("claude", args, {
    input: prompt,
    cwd: root,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? (opts.web ? 240_000 : 150_000),
    maxBuffer: 8 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (res.status !== 0 || !res.stdout) return null;
  return parseJsonArray<T>(res.stdout);
}

export interface AgentLoopOptions {
  // Read-only tools the reviewer may use to explore the repo. Defaults to the
  // safe read-only set. We deliberately NEVER allow Edit/Write/Bash here:
  // Shepherd is the maintainer, not the editor, and in headless `-p` mode any
  // tool not on this allow-list is auto-denied — so the agent CANNOT mutate the
  // repo even if it tried. That enforces "we hand off, we don't edit" at the
  // permission layer, not just by convention.
  tools?: string[];
  // Also allow web research (current versions / advisories) during the loop.
  web?: boolean;
  // Hard ceiling on the loop's cost (passed to `--max-budget-usd`). Bounds the
  // think → tool → observe loop so an agent can't run away on a big repo.
  budgetUsd?: number;
  timeoutMs?: number;
}

const DEFAULT_AGENT_TOOLS = ["Read", "Grep", "Glob"];

// The AGENTIC reviewer primitive. Unlike `claudeJsonArray`, this hands the
// headless model real read-only tools and lets it run its own
// think → call-tool → observe loop: open the file, grep the repo for mitigations
// or call-sites, confirm line numbers — then return ONLY findings it has
// verified. The agent loop lives inside Claude Code (which is already the
// dependency); we just configure and BOUND it (budget cap + read-only tools).
//
// cwd is the repo root, so Read/Grep/Glob are naturally scoped to the project.
// Prompt goes via STDIN (a CLI arg hangs cmd.exe on Windows). Returns the parsed
// JSON array the prompt asked for, or null on failure/non-zero exit.
export function claudeAgentJsonArray<T = unknown>(
  prompt: string,
  root: string,
  opts: AgentLoopOptions = {},
): T[] | null {
  const tools = [...(opts.tools ?? DEFAULT_AGENT_TOOLS)];
  if (opts.web) tools.push("WebSearch", "WebFetch");

  // Comma-separated is unambiguous (the variadic form can swallow the next flag).
  const args = ["-p", "--output-format", "json", "--allowedTools", tools.join(",")];
  if (opts.budgetUsd != null) args.push("--max-budget-usd", String(opts.budgetUsd));

  const res = spawnSync("claude", args, {
    input: prompt,
    cwd: root,
    encoding: "utf8",
    // Agentic loops take longer than a single judgment call — they read files
    // and may grep several times before answering.
    timeout: opts.timeoutMs ?? (opts.web ? 300_000 : 240_000),
    maxBuffer: 8 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (res.status !== 0 || !res.stdout) return null;
  return parseJsonArray<T>(res.stdout);
}
