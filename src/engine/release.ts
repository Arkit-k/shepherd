import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import pc from "picocolors";
import { loadProject } from "./project.js";
import { readCertRecord, type CertRecord } from "./certify.js";

// THE RELEASE GATE — "gate the deploy, don't do it." Shepherd never pushes a
// deploy (that's the editor problem again, and a foot-gun). Instead it answers the
// one question before a release: is what you're about to ship actually PROVEN?
//
// A deploy is clear only when there's a fresh Shepherd CERTIFICATE that (1) says
// certified, (2) attests to the exact commit you're deploying (HEAD), and (3) has
// no uncommitted drift since. That binds the certificate to the artifact. Shepherd
// also authors the CI/CD pipeline (with its own gate baked in) as a work-order, and
// can verify a deployed URL is actually healthy — but the user's pipeline deploys.

function git(root: string, args: string[]): string | null {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  if (res.status !== 0) return null;
  return res.stdout ?? "";
}

export function gitHead(root: string): string | null {
  return git(root, ["rev-parse", "HEAD"])?.trim() || null;
}

// Dirty = uncommitted changes to the APP/source — Shepherd's own `.shepherd/`
// artifacts (the certificate, objectives ledger, reports) don't count; writing the
// certificate would otherwise always mark the tree dirty right after certifying.
export function isDirty(root: string): boolean {
  const s = git(root, ["status", "--porcelain"]);
  if (!s) return false;
  const dirty = s
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^"|"$/g, "")) // strip the 2 status cols + space (and quotes)
    .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p)) // rename → use the new path
    .filter((p) => p && !p.startsWith(".shepherd/"));
  return dirty.length > 0;
}

// Does this repo have ANY deploy automation? Used to nudge toward a gated pipeline.
function detectDeployPipeline(root: string): boolean {
  const wf = fg.sync([".github/workflows/*.yml", ".github/workflows/*.yaml", ".gitlab-ci.yml"], { cwd: root, dot: true });
  for (const w of wf) {
    try {
      const t = readFileSync(path.join(root, w), "utf8");
      if (/deploy|release|publish|vercel|netlify|fly(ctl| )|flyio|render|railway|kubectl|helm|docker push|aws |gcloud |serverless deploy/i.test(t)) return true;
    } catch {
      /* skip */
    }
  }
  return ["vercel.json", "netlify.toml", "fly.toml", "render.yaml", "Procfile", "app.yaml", "Dockerrun.aws.json"].some((n) => existsSync(path.join(root, n)));
}

export interface ReleaseReadiness {
  ready: boolean;
  reason: string;
  cert: CertRecord | null;
  head?: string;
  dirty: boolean;
  hasPipeline: boolean;
  isRepo: boolean;
}

export function releaseReadiness(root: string): ReleaseReadiness {
  const head = gitHead(root) ?? undefined;
  const isRepo = head !== undefined;
  const dirty = isRepo ? isDirty(root) : false;
  const cert = readCertRecord(root);
  const hasPipeline = detectDeployPipeline(root);

  let ready = false;
  let reason: string;
  if (!cert) {
    reason = "no certificate yet — run /certify to prove the build before you ship it";
  } else if (!cert.certified) {
    reason = "the latest certificate is NOT certified — close the open objectives and get the tests green, then /certify";
  } else if (head && cert.commit && cert.commit !== head) {
    reason = `the certificate attests to ${cert.commit.slice(0, 7)}, but HEAD is ${head.slice(0, 7)} — re-certify so the proof matches what you're deploying`;
  } else if (dirty) {
    reason = "there are uncommitted changes since the certificate — commit them and re-certify, so what you deploy is exactly what was proven";
  } else {
    ready = true;
    reason = `certified${cert.commit ? ` for ${cert.commit.slice(0, 7)}` : ""}, working tree clean — clear to deploy`;
  }

  return { ready, reason, cert, head, dirty, hasPipeline, isRepo };
}

// Print the release verdict. Returns the exit code a CI release job should use.
export function printReleaseReadiness(r: ReleaseReadiness): number {
  const bar = "═".repeat(52);
  console.log("\n  " + pc.dim(bar));
  const head = r.ready ? pc.green("🟢 CLEAR TO DEPLOY") : pc.red("🔴 HOLD THE DEPLOY");
  console.log("   " + pc.bold("RELEASE GATE:  ") + pc.bold(head));
  console.log("  " + pc.dim(bar));
  console.log("   " + r.reason);
  if (r.cert) {
    console.log(
      pc.dim(
        `   certificate: ${r.cert.certified ? "certified" : "not certified"} · ` +
          `${r.cert.proven} proven / ${r.cert.failed} failed / ${r.cert.pending} pending · ` +
          `tests ${r.cert.testsRan ? (r.cert.testsPassed ? "green" : "red") : "absent"}`,
      ),
    );
  }
  if (!r.hasPipeline) {
    console.log(pc.dim("   ⚠ no deploy pipeline detected — say “/release-check pipeline” and I'll write a gated CI/CD work-order."));
  }
  console.log("  " + pc.dim(bar) + "\n");
  return r.ready ? 0 : 1;
}

// The CI/CD pipeline work-order — Shepherd describes a deploy pipeline with its own
// gate baked in; the user's Claude Code writes the YAML. Maintainer model.
export function buildDeployOrder(ts: string, deployTarget?: string): string {
  return [
    `# Shepherd — deploy pipeline work-order`,
    ``,
    `_Generated ${ts}. Shepherd describes the gated CI/CD pipeline; you create it in your Claude Code session._`,
    ...(deployTarget ? [``, `**Deploy target:** ${deployTarget} — write the deploy stage for this platform.`] : []),
    ``,
    `Goal: **never deploy an unproven build.** The pipeline runs the gate before it ships, so a red`,
    `suite or an open production blocker stops the release automatically — not just on your machine.`,
    ``,
    `## Create \`.github/workflows/deploy.yml\` (adapt to your platform)`,
    ``,
    `A pipeline with three ordered stages — each gates the next:`,
    ``,
    `1. **Build & test** — install, build, and run the test suite. Fail the job on any red test.`,
    `2. **Shepherd gate** — run \`npx shepherd .\` (non-interactive). It exits non-zero if the repo`,
    `   isn't production-ready (open gates) — which fails the job and blocks the deploy. This is the`,
    `   same certificate logic you get from \`/certify\`, enforced server-side.`,
    `3. **Deploy** — only \`needs:\` the gate job, so it runs **only when the gate passed**. Put your`,
    `   real deploy step here (Vercel / Fly / Render / Docker push + kubectl / etc.).`,
    ``,
    `## Constraints`,
    ``,
    `- The deploy job MUST declare \`needs: [gate]\` so it cannot run unless the gate succeeded.`,
    `- Run on push to your release branch (and optionally a manual \`workflow_dispatch\`).`,
    `- Pin action versions to a SHA; grant the workflow the least \`permissions:\` it needs.`,
    `- Keep secrets in the CI secret store, never in the workflow file.`,
    `- After deploy, hit your \`/health\` (or \`/readyz\`) endpoint and fail the release if it isn't 2xx`,
    `  (Shepherd's \`/release-check <url>\` does this check locally too).`,
    ``,
    `When the workflow is in place, every push to your release branch is gated: proven, then shipped.`,
    ``,
  ].join("\n");
}

export function writeDeployOrder(root: string, order: string): string {
  const project = loadProject(root);
  const abs = path.join(project.dir, "deploy-order.md");
  writeFileSync(abs, order);
  return path.relative(root, abs);
}

export interface HealthResult {
  ok: boolean;
  url?: string;
  status?: number;
  detail: string;
}

// Post-deploy verification — hit a deployed URL and confirm it's actually serving.
// Bounded (per-request timeout), read-only, tries the common health paths.
export async function checkDeployedHealth(baseUrl: string): Promise<HealthResult> {
  const base = baseUrl.replace(/\/+$/, "");
  const paths = ["/health", "/healthz", "/readyz", "/api/health", "/"];
  let lastErr = "";
  for (const p of paths) {
    const url = base + p;
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 8000);
      const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
      clearTimeout(to);
      if (res.ok) return { ok: true, url, status: res.status, detail: `${res.status} from ${p}` };
      lastErr = `${res.status} from ${p}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, detail: `no endpoint returned 2xx (last: ${lastErr || "unreachable"})` };
}
