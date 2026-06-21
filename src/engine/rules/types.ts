import type { Severity } from "../report.js";

// A data-driven pattern rule. This is the OPEN format that powers the
// AI-tool-specific rule packs (#2) and community contributions (#5):
// anyone can ship a JSON pack of these; the engine loads and applies them.
export interface PatternRule {
  id: string;
  pattern: string; // regex matched against file content
  filePattern?: string; // optional regex matched against the file path
  severity?: Severity; // default "warn"
  gate?: boolean; // default false (advise)
  message: string;
  tool?: string; // which AI builder this pattern is typical of (lovable/bolt/cursor/ai/…)
}

export interface RulePack {
  name: string;
  description?: string;
  rules: PatternRule[];
}
