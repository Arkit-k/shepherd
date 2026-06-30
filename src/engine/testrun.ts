import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// REAL TEST EXECUTION — the hard gate behind the guarantee. A certificate that
// says "tests pass" must have RUN them. This runs the project's own suite and
// reports the truth: exit code is the verdict (0 = green), counts are best-effort
// for the human-readable "147 passed" line.
//
// This is the ONE place Shepherd executes the user's code — and it's measurement,
// not editing, so it doesn't break the maintainer model. It's only invoked when
// the user asks Shepherd to certify/prove (never silently), bounded by a timeout,
// and always prints the exact command so the user can re-run it themselves.

export interface TestResult {
  ran: boolean; // did a real suite actually execute?
  passed: boolean; // exit code 0
  command?: string; // the exact, reproducible command
  framework?: string;
  total?: number;
  passedCount?: number;
  failedCount?: number;
  durationMs?: number;
  outputTail: string; // last slice of combined stdout+stderr
  reason?: string; // why it didn't run / didn't pass (honest)
}

function pkgScripts(root: string): { scripts: Record<string, string>; devDeps: Record<string, string> } {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    return {
      scripts: raw.scripts ?? {},
      devDeps: { ...(raw.dependencies ?? {}), ...(raw.devDependencies ?? {}) },
    };
  } catch {
    return { scripts: {}, devDeps: {} };
  }
}

// Prefer an integration/ci script over a plain unit `test` when present — the
// guarantee is about integration behaviour, not just units.
const SCRIPT_PREFERENCE = ["test:integration", "integration", "test:ci", "test:e2e", "e2e", "test:all", "test"];

function pickScript(scripts: Record<string, string>): string | null {
  for (const name of SCRIPT_PREFERENCE) if (scripts[name]) return name;
  return null;
}

function frameworkOf(devDeps: Record<string, string>): string | undefined {
  if (devDeps.vitest) return "Vitest";
  if (devDeps.jest || devDeps["ts-jest"]) return "Jest";
  if (devDeps["@playwright/test"]) return "Playwright";
  if (devDeps.mocha) return "Mocha";
  if (devDeps.ava) return "AVA";
  return undefined;
}

// Best-effort parse of pass/fail counts across the common reporters. The exit code
// is the source of truth; these numbers just make the certificate readable.
function parseCounts(out: string): { total?: number; passed?: number; failed?: number } {
  let m: RegExpMatchArray | null;
  // Vitest:  "Tests  1 failed | 10 passed (11)"  /  "Tests  10 passed (10)"
  if ((m = out.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed[^()]*\((\d+)\)/i))) {
    return { failed: Number(m[1] ?? 0), passed: Number(m[2]), total: Number(m[3]) };
  }
  // Jest:  "Tests:  1 failed, 2 skipped, 10 passed, 13 total"
  if ((m = out.match(/Tests:\s+(?:(\d+)\s+failed,\s*)?(?:\d+\s+skipped,\s*)?(\d+)\s+passed,\s*(\d+)\s+total/i))) {
    return { failed: Number(m[1] ?? 0), passed: Number(m[2]), total: Number(m[3]) };
  }
  // Mocha:  "10 passing" / "1 failing"
  const passing = out.match(/(\d+)\s+passing/i);
  const failing = out.match(/(\d+)\s+failing/i);
  if (passing) {
    const p = Number(passing[1]);
    const f = failing ? Number(failing[1]) : 0;
    return { passed: p, failed: f, total: p + f };
  }
  // Playwright:  "10 passed (3.2s)"  +  "1 failed"
  const pwPass = out.match(/(\d+)\s+passed\b/i);
  const pwFail = out.match(/(\d+)\s+failed\b/i);
  if (pwPass) {
    const p = Number(pwPass[1]);
    const f = pwFail ? Number(pwFail[1]) : 0;
    return { passed: p, failed: f, total: p + f };
  }
  return {};
}

export function runTests(root: string, opts: { timeoutMs?: number } = {}): TestResult {
  const { scripts, devDeps } = pkgScripts(root);
  const name = pickScript(scripts);
  if (!name) {
    return { ran: false, passed: false, outputTail: "", reason: "no test script in package.json" };
  }
  const body = scripts[name];
  // The npm-init placeholder isn't a real suite — calling it green would be a lie.
  if (/no test specified|exit\s+1/i.test(body) && /echo/i.test(body)) {
    return { ran: false, passed: false, outputTail: "", reason: `the "${name}" script is the npm placeholder, not a real suite` };
  }

  const command = `npm run ${name}`;
  const start = Date.now();
  const res = spawnSync("npm", ["run", name], {
    cwd: root,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 300_000,
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
    // CI=true makes watch-mode runners (vitest) execute once and exit; no colour.
    env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
  });
  const durationMs = Date.now() - start;
  const out = ((res.stdout ?? "") + "\n" + (res.stderr ?? "")).trim();
  const outputTail = out.slice(-2000);

  if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { ran: true, passed: false, command, framework: frameworkOf(devDeps), durationMs, outputTail, reason: "the test suite timed out" };
  }

  const counts = parseCounts(out);
  const passed = res.status === 0;
  return {
    ran: true,
    passed,
    command,
    framework: frameworkOf(devDeps),
    total: counts.total,
    passedCount: counts.passed,
    failedCount: counts.failed,
    durationMs,
    outputTail,
    reason: passed ? undefined : `the suite exited non-zero (${res.status ?? "killed"})`,
  };
}

// One-line human summary for the certificate.
export function testSummary(t: TestResult): string {
  if (!t.ran) return `no tests run — ${t.reason}`;
  const n = t.total ?? t.passedCount;
  const count = n != null ? `${n} test${n === 1 ? "" : "s"}` : "suite";
  const fw = t.framework ? ` (${t.framework})` : "";
  if (t.passed) return `${count}${fw} green · ${t.command}`;
  return `${t.failedCount ? `${t.failedCount} failing` : "suite failed"}${fw} — ${t.reason} · ${t.command}`;
}
