import { spawnSync } from "node:child_process";

export interface ClaudeJsonOptions {
  // Let the call research the live internet (WebSearch/WebFetch) before
  // answering — like a principal engineer looking up current best practice.
  // Slower + costlier, so use sparingly on LOW context (no file dumps).
  web?: boolean;
  timeoutMs?: number;
}

// Shared helper: run a headless Claude call whose prompt asks for a JSON array,
// and return the parsed array (or null). Centralizes the spawn + envelope-unwrap
// + array-extraction the Tier-2 reviewers all need. Prompt goes via STDIN
// (passing it as a CLI arg hangs cmd.exe on Windows).
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

  let text = res.stdout;
  try {
    const env = JSON.parse(res.stdout);
    if (typeof env.result === "string") text = env.result;
  } catch {
    /* raw stdout */
  }
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T[];
  } catch {
    return null;
  }
}
