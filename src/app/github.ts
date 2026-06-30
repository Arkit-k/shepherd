import type { Octokit } from "octokit";

// Thin GitHub helpers on an installation-authenticated Octokit. Kept dumb — all the
// review logic lives in review.ts; this just talks to the Checks / PR-files / Comments
// APIs. The summary comment is found and updated by a hidden marker so we never spam
// a new comment per push.

export const COMMENT_MARKER = "<!-- shepherd -->";
const CHECK_NAME = "Shepherd — Go-Live Gate";

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  message: string;
  title?: string;
}

export interface CheckOutput {
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  annotations: CheckAnnotation[];
}

export async function createCheckRun(octokit: Octokit, owner: string, repo: string, headSha: string): Promise<number> {
  const res = await octokit.rest.checks.create({
    owner,
    repo,
    name: CHECK_NAME,
    head_sha: headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
  });
  return res.data.id;
}

export async function completeCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkRunId: number,
  out: CheckOutput,
): Promise<void> {
  await octokit.rest.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
    status: "completed",
    conclusion: out.conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: out.title.slice(0, 255),
      summary: out.summary.slice(0, 65000),
      annotations: out.annotations.slice(0, 50), // GitHub caps at 50 per request
    },
  });
}

// Changed source files in the PR (skip deletions — nothing to review there).
export async function listChangedFiles(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<string[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return files.filter((f) => f.status !== "removed").map((f) => f.filename);
}

// Create or update the single Shepherd summary comment (found by the marker).
export async function upsertSummaryComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const mine = comments.find((c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER));
  if (mine) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  }
}

// The installation token for cloning the PR head over HTTPS.
export async function installationToken(octokit: Octokit): Promise<string> {
  const auth = (await octokit.auth({ type: "installation" })) as { token?: string };
  if (!auth?.token) throw new Error("could not obtain an installation token");
  return auth.token;
}
