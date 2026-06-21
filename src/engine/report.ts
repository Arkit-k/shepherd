import pc from "picocolors";

export type Severity = "critical" | "warn" | "info";
export type Disposition = "gate" | "advise";

export interface Finding {
  id: string; // check id, e.g. "file-too-long"
  severity: Severity;
  disposition: Disposition; // gate = blocks merge; advise = suggestion only
  file: string;
  line?: number;
  message: string;
}

// Collapse exact-duplicate findings (same check, same place, same message) —
// the full run layers a deterministic scan + per-module passes that can overlap.
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.id}|${f.file}|${f.line ?? ""}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

const icon: Record<Severity, (s: string) => string> = {
  critical: (s) => pc.red("🔴 " + s),
  warn: (s) => pc.yellow("🟡 " + s),
  info: (s) => pc.cyan("🔵 " + s),
};

export function printReport(findings: Finding[]): void {
  if (findings.length === 0) {
    console.log(pc.green("\n✅ No issues found — shipshape.\n"));
    return;
  }

  console.log(pc.bold("\nShepherd — findings\n"));
  for (const f of findings) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    const tag = f.disposition === "gate" ? pc.dim("[gate]") : pc.dim("[advise]");
    console.log(`${icon[f.severity](f.id)} ${tag} ${pc.dim(loc)}`);
    console.log(`   ${f.message}\n`);
  }

  const gates = findings.filter((f) => f.disposition === "gate").length;
  console.log(
    pc.bold(`${findings.length} findings — `) +
      (gates > 0 ? pc.red(`${gates} blocking`) : pc.green("0 blocking")) +
      pc.bold(".\n"),
  );
}
