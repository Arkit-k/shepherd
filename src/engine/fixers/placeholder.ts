import type { Fixer, FixResult } from "./types.js";
import type { Finding } from "../report.js";

// Used only when Claude Code isn't on PATH. Reports what it would do and makes
// no change, so the loop halts honestly instead of faking a fix.
export class PlaceholderFixer implements Fixer {
  readonly name = "placeholder";

  async fixFile(file: string, findings: Finding[], _root: string): Promise<FixResult> {
    return {
      changed: false,
      reason: `Claude Code not found — would hand ${findings.length} issue(s) in ${file} to Claude`,
    };
  }
}
