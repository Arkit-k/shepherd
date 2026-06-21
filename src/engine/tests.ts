import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface TestResult {
  ran: boolean;
  passed: boolean;
  output: string;
}

// Does the repo have a real test script?
export function hasTestScript(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const t = pkg?.scripts?.test;
    return Boolean(t) && !/no test specified/i.test(t);
  } catch {
    return false;
  }
}

// Run the project's own test suite. A failing suite is treated as a gate, so the
// agent verifies its fixes against real tests — not just Shepherd's detectors.
export function runTests(root: string): TestResult {
  if (!hasTestScript(root)) return { ran: false, passed: true, output: "" };
  try {
    const out = execSync("npm test --silent", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ran: true, passed: true, output: out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const output = ((err.stdout ?? "") + "\n" + (err.stderr ?? "")).trim();
    // keep only the tail — minimal context for the fixer
    return { ran: true, passed: false, output: output.slice(-4000) };
  }
}
