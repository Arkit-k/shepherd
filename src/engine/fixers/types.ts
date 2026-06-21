import type { Finding } from "../report.js";

export interface FixResult {
  changed: boolean; // did the fixer actually modify the file?
  reason?: string; // why not, if it didn't
}

// A Fixer turns a file's worth of findings into a code change.
// Operating per-FILE (not per-finding) keeps Claude's context minimal:
// the file is read once and all its issues are fixed in a single call.
// The loop is fixer-agnostic — placeholder today, Claude Code today-ish,
// our Anthropic API in the GitHub App. Swapping it never touches the loop.
export interface Fixer {
  readonly name: string;
  fixFile(file: string, findings: Finding[], root: string): Promise<FixResult>;
}
