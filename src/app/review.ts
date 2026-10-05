import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Octokit } from "octokit";
import { scan } from "../engine/run.js";
import { goLiveVerdict, verdictMarkdown, type GoLiveVerdict } from "../engine/gate.js";
import type { Finding } from "../engine/report.js";
import {
  type CheckAnnotation,
  type CheckOutput,
  COMMENT_MARKER,
  createCheckRun,
  completeCheckRun,
  listChangedFiles,
  upsertSummaryComment,
  installationToken,
} from "./github.js";

// The Shepherd App's PR review. The PURE core (`reviewCheckout`) runs the same
// deterministic engine the CLI uses, scoped to the PR's changed files, and produces
// a Check conclusion + line annotations + a summary — with NO GitHub calls, so it's
// unit-testable. `handlePullRequest` is the thin glue that clones, calls the core,
// and posts the results.

export interface ReviewResult {
  conclusion: "success" | "failure";
  verdict: GoLiveVerdict;
  annotations: CheckAnnotation[];
  summary: string;
  scopedCount: number;
  changedCount: number;
  title: string;
}

const norm = (p: string) => p.replace(/\\/g, "/");

// Findings with a real line become inline annotations; gate→failure, advisory
// warn→warning, info→notice. Capped at the GitHub per-request limit.
function toAnnotations(findings: Finding[]): CheckAnnotation[] {
  const out: CheckAnnotation[] = [];
  for (const f of findings) {
    if (!f.line || f.line < 1) continue; // GitHub annotations require a line number
    out.push({
      path: norm(f.file),
      start_line: f.line,
      end_line: f.line,
      annotation_level: f.disposition === "gate" ? "failure" : f.severity === "warn" ? "warning" : "notice",
      message: f.message.slice(0, 600),
      title: `Shepherd: ${f.id}`,
    });
    if (out.length >= 50) break;
  }
  return out;
}

function titleFor(v: GoLiveVerdict): string {
  if (v.ready) return v.advisoryCount ? `Ready to ship — ${v.advisoryCount} advisory note(s)` : "Ready to ship";
  return `Not ready — ${v.blockers.length} blocker(s)`;
}

function buildSummary(v: GoLiveVerdict, findings: Finding[], changedCount: number): string {
  const advise = findings.filter((f) => f.disposition === "advise");
  const lines: string[] = [COMMENT_MARKER, `## 🐑 Shepherd — Go-Live Gate`, ``, verdictMarkdown(v)];
  if (advise.length) {
    lines.push(``, `<details><summary>${advise.length} advisory note(s)</summary>`, ``);
    for (const f of advise.slice(0, 25)) lines.push(`- \`${norm(f.file)}${f.line ? `:${f.line}` : ""}\` — ${f.message}`);
    lines.push(``, `</details>`);
  }
  lines.push(
    ``,
    `<sub>Reviewed ${changedCount} changed file(s) with Shepherd's deterministic engine (free). ` +
      `Run \`npx shepherd\` locally for the full deep review + scale + cost audit.</sub>`,
  );
  return lines.join("\n");
}

// PURE: review a checked-out repo, scoped to the changed files. No network.
export async function reviewCheckout(dir: string, changedFiles: string[]): Promise<ReviewResult> {
  const { findings } = await scan(dir, { deep: false }); // deterministic only — ~$0
  const changed = new Set(changedFiles.map(norm));
  // keep only findings that live in a file the PR actually changes; whole-repo
  // synthetic findings (e.g. file "(architecture)") drop out of a PR-scoped gate.
  const scoped = findings.filter((f) => changed.has(norm(f.file)));
  const verdict = goLiveVerdict(scoped);
  return {
    conclusion: verdict.ready ? "success" : "failure",
    verdict,
    annotations: toAnnotations(scoped),
    summary: buildSummary(verdict, scoped, changedFiles.length),
    scopedCount: scoped.length,
    changedCount: changedFiles.length,
    title: titleFor(verdict),
  };
}

// ── git clone of the PR head (token in the URL; never logged) ─────────────────
//
// Async on purpose. This runs inside a webhook handler: a synchronous clone with
// a 120s timeout blocks the event loop, so one PR review stalls every other
// request on the server and GitHub's redelivery piles up behind it.
//
// It also throws rather than returning a half-built directory. The old version
// ignored the fallback's exit codes, so a failed clone yielded an EMPTY temp dir,
// the scan found nothing, and the gate reported a pass — a silent false PASS.
async function git(args: string[], timeout: number, token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`git ${args[0]} failed: ${redact(err.message, token)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`git ${args[0]} timed out after ${timeout}ms`));
      if (code !== 0) {
        return reject(new Error(`git ${args[0]} exited ${code}: ${redact(stderr.trim(), token)}`));
      }
      resolve();
    });
  });
}

// The token is embedded in the clone URL, so it can appear in git's stderr.
function redact(s: string, token: string): string {
  return token ? s.split(token).join("***") : s;
}

export async function shallowClone(
  cloneUrl: string,
  headRef: string,
  sha: string,
  token: string,
): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shep-pr-"));
  const authUrl = cloneUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`);

  try {
    // a branch clone lands directly on the head tip (== sha for synchronize).
    await git(["clone", "--depth", "1", "--no-tags", "--branch", headRef, authUrl, dir], 120_000, token);
    return dir;
  } catch {
    // fallback: default clone, then fetch + checkout the exact sha.
    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      await git(["clone", "--depth", "1", "--no-tags", authUrl, dir], 120_000, token);
      await git(["-C", dir, "fetch", "--depth", "1", "origin", sha], 60_000, token);
      await git(["-C", dir, "checkout", sha], 30_000, token);
      return dir;
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`could not clone the PR head (${redact(msg, token)})`);
    }
  }
}

// A gate must fail CLOSED.
//
// This used to report `conclusion: "neutral"` so as not to "crash the webhook",
// but GitHub branch protection counts `neutral` as PASSING for a required check.
// So any error on the path to the review — clone failure, token failure, API
// failure — quietly let the PR merge. That is the same silent-pass bug as
// returning an empty checkout, just one level further up.
//
// `failure` is correct here: Shepherd is asserting "I could not establish that
// this PR is safe", and for a gate that is a block, not a shrug. The next push
// re-runs it.
export function errorOutput(err: unknown, token: string): CheckOutput {
  const raw = err instanceof Error ? err.message : String(err);
  return {
    conclusion: "failure",
    title: "Shepherd couldn't complete the review",
    summary:
      `${COMMENT_MARKER}\nShepherd hit an error reviewing this PR: \`${redact(raw, token)}\`.\n\n` +
      `The gate fails closed: a review that could not run is not a pass. ` +
      `Push again to retry, or re-run this check.`,
    annotations: [],
  };
}

// The webhook context we actually use (structurally typed to avoid octokit's heavy
// event generics).
export interface PRContext {
  octokit: Octokit;
  payload: {
    repository: { name: string; clone_url: string; owner: { login: string } };
    pull_request: {
      number: number;
      head: { sha: string; ref: string; repo: { clone_url: string } | null };
    };
  };
}

export async function handlePullRequest(ctx: PRContext): Promise<void> {
  const { octokit, payload } = ctx;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pr = payload.pull_request;
  const headSha = pr.head.sha;
  const cloneUrl = pr.head.repo?.clone_url ?? payload.repository.clone_url; // fork-safe

  const checkId = await createCheckRun(octokit, owner, repo, headSha);
  let tmp: string | null = null;
  // hoisted so the catch below can redact it out of anything user-visible.
  let token = "";
  try {
    const changed = await listChangedFiles(octokit, owner, repo, pr.number);
    token = await installationToken(octokit);
    tmp = await shallowClone(cloneUrl, pr.head.ref, headSha, token);

    const result = await reviewCheckout(tmp, changed);
    const out: CheckOutput = {
      conclusion: result.conclusion,
      title: result.title,
      summary: result.summary,
      annotations: result.annotations,
    };
    await completeCheckRun(octokit, owner, repo, checkId, out);
    await upsertSummaryComment(octokit, owner, repo, pr.number, result.summary);
  } catch (err) {
    // never crash the webhook, but never pass the gate either — see errorOutput.
    await completeCheckRun(octokit, owner, repo, checkId, errorOutput(err, token));
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* temp cleanup is best-effort */
      }
    }
  }
}
