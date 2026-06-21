import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Fixer, FixResult } from "./types.js";
import type { Finding } from "../report.js";

// Is Claude Code installed and on PATH? It runs on the user's own logged-in
// session (their subscription), so inference costs us nothing.
export function claudeAvailable(): boolean {
  try {
    execSync(process.platform === "win32" ? "where claude" : "command -v claude", {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// Hands work to the user's Claude Code in a fresh, scoped, headless call.
// Context stays minimal — we paste nothing; Claude reads only what it needs.
export class ClaudeFixer implements Fixer {
  readonly name = "claude-code";

  async fixFile(file: string, findings: Finding[], root: string): Promise<FixResult> {
    // failing tests need a different prompt (no single file to diff).
    if (findings[0]?.id === "tests-failing") {
      const ok = await this.invoke(testPrompt(findings[0].message), root);
      return { changed: ok, reason: ok ? undefined : "Claude run failed/timed out" };
    }

    const abs = path.join(root, file);
    let before = "";
    try {
      before = readFileSync(abs, "utf8");
    } catch {
      /* new/unreadable */
    }

    const ok = await this.invoke(filePrompt(file, findings), root);

    let after = "";
    try {
      after = readFileSync(abs, "utf8");
    } catch {
      /* possibly split/moved */
    }

    if (after !== before) return { changed: true };
    return { changed: false, reason: ok ? "Claude made no change" : "Claude run failed/timed out" };
  }

  // One short-lived headless Claude Code invocation. The prompt goes via STDIN
  // (passing it as a CLI arg hangs cmd.exe on Windows). Fresh context every call.
  private invoke(prompt: string, root: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("claude", ["-p", "--permission-mode", "acceptEdits"], {
        cwd: root,
        stdio: ["pipe", "ignore", "ignore"],
        shell: process.platform === "win32",
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 180_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  }
}

function filePrompt(file: string, findings: Finding[]): string {
  const list = findings
    .map((f) => `- [${f.id}${f.line ? ` line ${f.line}` : ""}] ${f.message}`)
    .join("\n");
  return [
    `Fix these production-readiness issues in \`${file}\`. Apply ONLY these fixes —`,
    `do not refactor, reformat, or change anything unrelated. Read the file, make`,
    `the minimal change for each issue, and save.`,
    ``,
    `Issues:`,
    list,
  ].join("\n");
}

function testPrompt(output: string): string {
  return [
    `The project's test suite is failing. Fix the source code so all tests pass.`,
    `Change the code, not the tests — unless a test is clearly asserting wrong behaviour.`,
    `Run the tests yourself to confirm they pass before finishing.`,
    ``,
    `Failing output:`,
    output,
  ].join("\n");
}
