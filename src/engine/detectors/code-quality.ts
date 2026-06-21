import type { Repo } from "../ingest.js";
import type { CodeModel } from "../ast.js";
import type { Finding } from "../report.js";

// Measurable SOLID smells (Layer 2, family 2). Numbers gate; the abstract
// "is this good design?" judgment is the LLM analyzer in family 3 (later).
const FILE_MAX_LINES = 800;
const FN_MAX_LINES = 80;
const CLASS_MAX_METHODS = 20;

export function codeQuality(repo: Repo, model: CodeModel): Finding[] {
  const out: Finding[] = [];

  // SRP smell: oversized files (the 5000-line problem)
  for (const f of repo.files) {
    if (f.lines > FILE_MAX_LINES) {
      out.push({
        id: "file-too-long",
        severity: "warn",
        disposition: "gate",
        file: f.path,
        message: `File is ${f.lines} lines (max ${FILE_MAX_LINES}). Likely doing too much (SRP smell) — split it.`,
      });
    }
  }

  // long functions — maintainability
  for (const fn of model.functions) {
    if (fn.lines > FN_MAX_LINES) {
      out.push({
        id: "function-too-long",
        severity: "warn",
        disposition: "advise",
        file: fn.file,
        line: fn.line,
        message: `Function "${fn.name}" is ${fn.lines} lines (max ${FN_MAX_LINES}). Consider breaking it up.`,
      });
    }
  }

  // god-class: too many methods = SRP violation
  for (const cls of model.classes) {
    if (cls.methods > CLASS_MAX_METHODS) {
      out.push({
        id: "god-class",
        severity: "warn",
        disposition: "advise",
        file: cls.file,
        line: cls.line,
        message: `Class "${cls.name}" has ${cls.methods} methods (max ${CLASS_MAX_METHODS}). SRP smell — split responsibilities.`,
      });
    }
  }

  return out;
}
