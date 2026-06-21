import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import type { Repo } from "../ingest.js";
import type { Finding } from "../report.js";
import type { PatternRule, RulePack } from "./types.js";

// Where packs live: built-in (shipped with Shepherd) + user/community
// (~/.shepherd/packs/*.json). Drop a JSON pack in either and it just loads.
function packDirs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/engine/rules or src/engine/rules
  const builtin = path.join(here, "..", "..", "..", "packs");
  const user = path.join(homedir(), ".shepherd", "packs");
  return [builtin, user].filter((d) => existsSync(d));
}

export function loadRules(): PatternRule[] {
  const rules: PatternRule[] = [];
  for (const dir of packDirs()) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        const pack = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as RulePack;
        if (Array.isArray(pack.rules)) rules.push(...pack.rules);
      } catch {
        /* skip malformed pack */
      }
    }
  }
  return rules;
}

export function applyRules(repo: Repo, rules: PatternRule[]): Finding[] {
  const out: Finding[] = [];
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern);
    } catch {
      continue; // bad regex in a pack — skip, don't crash
    }
    const fileRe = rule.filePattern ? new RegExp(rule.filePattern) : null;

    for (const f of repo.files) {
      if (fileRe && !fileRe.test(f.path)) continue;
      const m = re.exec(f.content);
      if (m) {
        out.push({
          id: rule.id,
          severity: rule.severity ?? "warn",
          disposition: rule.gate ? "gate" : "advise",
          file: f.path,
          line: f.content.slice(0, m.index).split("\n").length,
          message: rule.tool ? `${rule.message} [${rule.tool}]` : rule.message,
        });
      }
    }
  }
  return out;
}
