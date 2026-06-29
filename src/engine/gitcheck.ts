import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { scan } from "./run.js";
import { goLiveVerdict, printVerdict, type GoLiveVerdict } from "./gate.js";
import { printReport, type Finding } from "./report.js";

// GIT-CHECK — the pre-push gate. A full audit reviews the whole repo; this
// reviews only what you're ABOUT TO PUSH (staged + working tree + unpushed
// commits) and gives a go/no-go on the diff. It's the honest last question
// before code leaves your machine: "is what I'm pushing production-ready?"
//
// It powers both `/git-check` in the agent and a real git `pre-push` hook, so the
// autonomous gate runs automatically whenever you push — Shepherd standing at the
// door. Shepherd never edits; a blocked push is a heads-up, and `--no-verify`
// always lets a human override.

function git(root: string, args: string[]): string | null {
  const res = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) return null;
  return res.stdout ?? "";
}

export function isGitRepo(root: string): boolean {
  return git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

// The files that would leave your machine on the next push: anything staged,
// anything modified in the working tree, and the net change of commits that are
// ahead of the upstream. Falls back to the last commit when there's no upstream.
export function changedFiles(root: string): string[] {
  const out = new Set<string>();
  const add = (s: string | null) =>
    s
      ?.split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((f) => out.add(f.replace(/\\/g, "/")));

  add(git(root, ["diff", "--cached", "--name-only"])); // staged
  add(git(root, ["diff", "--name-only"])); // unstaged working tree

  const up = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (up && up.trim()) {
    add(git(root, ["diff", "--name-only", up.trim(), "HEAD"])); // unpushed commits
  } else {
    add(git(root, ["diff", "--name-only", "HEAD~1", "HEAD"])); // best-effort: last commit
  }
  return [...out];
}

export interface GitCheckResult {
  isRepo: boolean;
  changed: string[]; // changed source files we actually reviewed
  findings: Finding[]; // findings scoped to the changed files
  verdict: GoLiveVerdict;
}

// Run a production-readiness check scoped to the changed files. Reuses the full
// engine scan, then keeps only findings that live in a file you're pushing — so
// whole-project advisories (architecture/infra/cost, which have synthetic
// "files") don't block a focused diff push.
export async function gitCheck(root = ".", opts: { deep?: boolean } = {}): Promise<GitCheckResult> {
  const empty: GoLiveVerdict = goLiveVerdict([]);
  if (!isGitRepo(root)) {
    return { isRepo: false, changed: [], findings: [], verdict: empty };
  }

  const changedSet = new Set(changedFiles(root));
  const { repo, findings } = await scan(root, { deep: opts.deep ?? false });

  // keep only real source files we actually ingested AND that are being pushed.
  const reviewed = repo.files
    .map((f) => f.path.replace(/\\/g, "/"))
    .filter((p) => changedSet.has(p));
  const reviewedSet = new Set(reviewed);

  const scoped = findings.filter((f) => reviewedSet.has(f.file.replace(/\\/g, "/")));
  return { isRepo: true, changed: reviewed, findings: scoped, verdict: goLiveVerdict(scoped) };
}

// Pretty-print a git-check to the terminal. Returns the exit code a hook should
// use: 1 when the diff is NOT ready (block the push), 0 otherwise.
export function printGitCheck(r: GitCheckResult): number {
  if (!r.isRepo) {
    console.log(pc.yellow("\n  Not a git repository — nothing to check before pushing.\n"));
    return 0;
  }
  if (r.changed.length === 0) {
    console.log(pc.dim("\n  Nothing staged, modified, or unpushed — clean. Nothing to gate.\n"));
    return 0;
  }
  console.log(
    pc.bold(`\n🐑  Git-check — reviewing ${r.changed.length} file(s) you're about to push`) +
      "\n" +
      pc.dim("  " + r.changed.slice(0, 8).join(", ") + (r.changed.length > 8 ? ", …" : "")) +
      "\n",
  );
  printReport(r.findings);
  printVerdict(r.verdict);
  return r.verdict.ready ? 0 : 1;
}

// ── pre-push hook ──────────────────────────────────────────────────────────

function hookPath(root: string): string | null {
  const dir = git(root, ["rev-parse", "--git-path", "hooks"]);
  if (!dir) return null;
  const hooks = path.isAbsolute(dir.trim()) ? dir.trim() : path.join(root, dir.trim());
  return path.join(hooks, "pre-push");
}

// Install a git pre-push hook that runs Shepherd's git-check and blocks the push
// if the diff isn't production-ready. Baked to the CURRENT cli entry so it works
// without a global install. A human can always bypass with `git push --no-verify`.
export function installPrePushHook(root: string): { ok: boolean; path?: string; reason?: string } {
  if (!isGitRepo(root)) return { ok: false, reason: "not a git repository" };
  const target = hookPath(root);
  if (!target) return { ok: false, reason: "couldn't resolve .git/hooks" };

  // The CLI entry (dist/cli.js) we're running from — resolve to an absolute path
  // so the hook calls the same Shepherd, no global install required.
  const cli = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const runner = cli
    ? `node "${cli.replace(/\\/g, "/")}" --git-check`
    : `npx --no-install shepherd --git-check`;

  const script = [
    `#!/bin/sh`,
    `# Shepherd pre-push gate — installed by Shepherd. Reviews what you're about to`,
    `# push and blocks if it isn't production-ready. Bypass once with: git push --no-verify`,
    `if [ -n "$SHEPHERD_SKIP_HOOK" ]; then exit 0; fi`,
    runner,
    `status=$?`,
    `if [ $status -ne 0 ]; then`,
    `  echo ""`,
    `  echo "🐑  Shepherd blocked this push — the diff isn't production-ready (see above)."`,
    `  echo "    Fix the gates, or override once with: git push --no-verify"`,
    `  exit 1`,
    `fi`,
    `exit 0`,
    ``,
  ].join("\n");

  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const existed = existsSync(target);
    writeFileSync(target, script, { mode: 0o755 });
    try {
      chmodSync(target, 0o755);
    } catch {
      /* chmod is a no-op / may fail on Windows — git for-windows still runs sh hooks */
    }
    return { ok: true, path: path.relative(root, target).replace(/\\/g, "/"), reason: existed ? "overwrote existing pre-push hook" : undefined };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
