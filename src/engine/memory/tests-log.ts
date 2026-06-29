import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// TEST memory — the per-project `test.md`. Shepherd's creed is that everything
// essential deserves a test; this is where it keeps score of the tests it has
// designed/run, and the distilled "what matters here" lessons the learning loop
// feeds in (see conversation.learnImportantTests).

function testMdPath(root: string): string {
  return path.join(root, ".shepherd", "test.md");
}

const LESSONS_HEADER = "## What matters here (learned)";

function ensure(root: string): string {
  const p = testMdPath(root);
  if (!existsSync(p)) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(
      p,
      "# Shepherd — test ledger\n\n" +
        "_Everything essential deserves a test. Shepherd logs the tests it designs/runs\n" +
        "here, and learns which ones matter most for this codebase._\n\n" +
        "## Tests done\n\n" +
        "| When | Kind | Target | Test | Result |\n" +
        "|------|------|--------|------|--------|\n\n" +
        LESSONS_HEADER +
        "\n\n",
    );
  }
  return p;
}

export type TestKind = "unit" | "integration" | "contract" | "load" | "probe" | "regression";

export function recordTest(
  root: string,
  t: { kind: TestKind; target: string; test: string; result: string; ts?: string },
): void {
  try {
    const p = ensure(root);
    const when = (t.ts ?? new Date().toISOString()).slice(0, 16).replace("T", " ");
    const row = `| ${when} | ${t.kind} | ${t.target} | ${t.test} | ${t.result} |\n`;
    // insert the row just under the table header, before the lessons section.
    const body = readFileSync(p, "utf8");
    const marker = "|------|------|--------|------|--------|\n";
    const idx = body.indexOf(marker);
    if (idx === -1) {
      appendFileSync(p, row);
      return;
    }
    const at = idx + marker.length;
    writeFileSync(p, body.slice(0, at) + row + body.slice(at));
  } catch {
    /* best-effort */
  }
}

// Append distilled "these are the tests that matter here" lessons (from the
// learning loop) under the lessons header, de-duplicated against what's there.
export function appendTestLessons(root: string, lessons: string[]): void {
  if (lessons.length === 0) return;
  try {
    const p = ensure(root);
    const body = readFileSync(p, "utf8");
    const existing = new Set(
      body
        .split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2).trim().toLowerCase()),
    );
    const fresh = lessons.filter((l) => !existing.has(l.trim().toLowerCase()));
    if (fresh.length === 0) return;
    appendFileSync(p, fresh.map((l) => `- ${l}`).join("\n") + "\n");
  } catch {
    /* best-effort */
  }
}

export function readTestLog(root: string): string {
  const p = testMdPath(root);
  if (!existsSync(p)) return "";
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
