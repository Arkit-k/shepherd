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
