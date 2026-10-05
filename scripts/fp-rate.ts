// Measure the deterministic security tier on a real repo: how many findings,
// how many BLOCK a push, and how many carry a line (i.e. can become a PR comment).
import { ingest } from "../src/engine/ingest.js";
import { security } from "../src/engine/detectors/security.js";

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) throw new Error("usage: tsx scripts/fp-rate.ts <repo>");
  const repo = await ingest(target);
  const f = security(repo);
  const by = new Map<string, { gate: number; advise: number; withLine: number }>();
  for (const x of f) {
    const e = by.get(x.id) ?? { gate: 0, advise: 0, withLine: 0 };
    if (x.disposition === "gate") e.gate++;
    else e.advise++;
    if (typeof x.line === "number") e.withLine++;
    by.set(x.id, e);
  }
  console.log(`files scanned : ${repo.files.length}`);
  console.log(`findings      : ${f.length}`);
  console.log(`BLOCKING      : ${f.filter((x) => x.disposition === "gate").length}`);
  for (const [id, e] of [...by].sort()) {
    console.log(`  ${id.padEnd(22)} gate=${e.gate}  advise=${e.advise}  with-line=${e.withLine}`);
  }
  console.log("");
  for (const x of f) {
    console.log(`${x.disposition.toUpperCase().padEnd(7)} ${x.id.padEnd(20)} ${x.file}:${x.line ?? "?"}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
