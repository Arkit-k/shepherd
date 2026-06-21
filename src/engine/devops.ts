import { readFileSync } from "node:fs";
import fg from "fast-glob";
import path from "node:path";
import type { Repo } from "./ingest.js";
import type { Finding } from "./report.js";

// DevOps / infra-as-code review. The deployment config lives IN the repo —
// GitHub Actions, Jenkinsfiles, nginx, Terraform/CloudFormation/Bicep,
// docker-compose — and it's where production gets breached: open security
// groups, public buckets, unpinned CI actions, untrusted-input command
// injection, weak TLS, version disclosure. Deterministic checks grounded in
// current best practice (GitHub/Wiz/StepSecurity, nginx hardening guides,
// Checkov/Terraform DevSecOps). These files aren't in repo.files (not JS/TS),
// so this module globs and reads them itself.

function read(root: string, globs: string[], cap = 40): { rel: string; content: string }[] {
  const files = fg.sync(globs, { cwd: root, ignore: ["**/node_modules/**", "**/.git/**"], dot: true, absolute: true });
  const out: { rel: string; content: string }[] = [];
  for (const abs of files.slice(0, cap)) {
    try {
      const content = readFileSync(abs, "utf8");
      if (content.length < 2_000_000) out.push({ rel: path.relative(root, abs), content });
    } catch {
      /* skip */
    }
  }
  return out;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}
const gate = (id: string, file: string, message: string, line?: number): Finding => ({ id, severity: "critical", disposition: "gate", file, line, message });
const advise = (id: string, file: string, message: string, line?: number, sev: Finding["severity"] = "warn"): Finding => ({ id, severity: sev, disposition: "advise", file, line, message });

// ── GitHub Actions ──────────────────────────────────────────────────────────
function githubActions(root: string): Finding[] {
  const out: Finding[] = [];
  for (const { rel, content } of read(root, [".github/workflows/*.{yml,yaml}"])) {
    // untrusted input interpolated into a run step → command injection
    const inj = content.match(/\$\{\{\s*github\.event\.(?:issue|pull_request|comment|review|discussion)\.[\w.]*(?:title|body|name|email|label|ref)[\w.]*\s*\}\}|\$\{\{\s*github\.head_ref\s*\}\}/);
    if (inj && /run:/.test(content)) {
      out.push(gate("gha-script-injection", rel, "Untrusted input (github.event.*.title/body, github.head_ref) is interpolated into a workflow — if it reaches a `run:` step it's a command-injection vector. Pass it through an `env:` variable and quote it, never inline `${{ … }}` in a shell.", lineOf(content, inj.index ?? 0)));
    }

    // pull_request_target + checkout of PR code = the classic RCE
    if (/pull_request_target/.test(content) && /actions\/checkout/.test(content)) {
      const m = content.match(/pull_request_target/);
      out.push(gate("gha-pr-target-checkout", rel, "`pull_request_target` runs with repo secrets AND checks out PR code — an attacker's fork PR can exfiltrate your secrets. Don't check out untrusted PR code under pull_request_target.", lineOf(content, m?.index ?? 0)));
    }

    // unpinned actions (not a 40-char commit SHA)
    const usesRe = /uses:\s*([\w.\-]+\/[\w.\-]+)@(\S+)/g;
    let u: RegExpExecArray | null;
    let unpinned = 0;
    while ((u = usesRe.exec(content))) {
      if (!/^[0-9a-f]{40}$/.test(u[2])) unpinned++;
    }
    if (unpinned > 0) {
      out.push(advise("gha-unpinned-action", rel, `${unpinned} action(s) referenced by tag/branch, not a commit SHA — a compromised tag (the tj-actions style supply-chain attack) silently runs in your pipeline. Pin every \`uses:\` to a full 40-char SHA.`, undefined, "warn"));
    }

    // no explicit permissions → GITHUB_TOKEN defaults broad
    if (!/^\s*permissions:/m.test(content)) {
      out.push(advise("gha-no-permissions", rel, "No `permissions:` block — GITHUB_TOKEN gets broad default scopes. Set least privilege (`permissions: { contents: read }`) and elevate only where a job needs it.", undefined, "info"));
    }
  }
  return out;
}

// ── nginx ───────────────────────────────────────────────────────────────────
function nginx(root: string): Finding[] {
  const out: Finding[] = [];
  // nginx files are named anything (.conf, in conf.d/sites-*/); gate by content.
  const files = read(root, ["**/*.conf", "**/*.nginx", "**/sites-available/**", "**/sites-enabled/**"]).filter(
    (f) => /\b(listen|server_name|proxy_pass|location\s+[\/~]|ssl_protocols|fastcgi_pass)\b/.test(f.content),
  );
  for (const { rel, content } of files) {
    const weakTls = content.match(/ssl_protocols[^;]*\b(SSLv3|TLSv1|TLSv1\.1)\b/);
    if (weakTls) out.push(gate("nginx-weak-tls", rel, "Weak TLS protocol enabled (SSLv3/TLSv1/TLSv1.1) — vulnerable to downgrade/BEAST. Use `ssl_protocols TLSv1.2 TLSv1.3;` only.", lineOf(content, weakTls.index ?? 0)));

    if (/proxy_buffering\s+off/.test(content)) {
      const m = content.match(/proxy_buffering\s+off/);
      out.push(advise("nginx-proxy-buffering-off", rel, "`proxy_buffering off` ties up a worker for the whole upstream response and invites slow-client DoS — a common detrimental misconfig. Leave buffering on unless you truly stream.", lineOf(content, m?.index ?? 0)));
    }
    if (!/server_tokens\s+off/.test(content)) {
      out.push(advise("nginx-version-disclosure", rel, "`server_tokens off` not set — nginx leaks its exact version in the Server header, handing attackers a CVE shopping list. Add `server_tokens off;`.", undefined, "info"));
    }
    if (!/limit_req/.test(content)) {
      out.push(advise("nginx-no-rate-limit", rel, "No `limit_req` anywhere — no rate limiting at the edge leaves login/API/forms open to brute-force and DoS. Add a `limit_req_zone` + `limit_req` on sensitive locations."));
    }
    if (!/add_header\s+X-Frame-Options|add_header\s+Content-Security-Policy|add_header\s+Strict-Transport-Security/i.test(content)) {
      out.push(advise("nginx-no-security-headers", rel, "No security headers (X-Frame-Options / CSP / HSTS / X-Content-Type-Options). Add them at the server level to defend against clickjacking, MIME-sniffing, and downgrade.", undefined, "info"));
    }
  }
  return out;
}

// ── Jenkins (Groovy pipelines) ──────────────────────────────────────────────
function jenkins(root: string): Finding[] {
  const out: Finding[] = [];
  for (const { rel, content } of read(root, ["**/Jenkinsfile", "**/Jenkinsfile.*", "**/*.jenkinsfile"])) {
    // interpolating params into sh → shell injection (Groovy "" double-quote in sh)
    const sh = content.match(/sh\s+"[^"]*\$\{?(params|env|GIT_BRANCH|CHANGE_|ghprb)/);
    if (sh) out.push(advise("jenkins-sh-injection", rel, "`sh \"...${params...}...\"` interpolates build input into the shell (Groovy double-quotes) — a script-injection vector. Use single-quoted `sh '...'` with the value passed via an environment variable.", lineOf(content, sh.index ?? 0)));

    const cred = content.match(/(password|passwd|secret|api[_-]?key|token)\s*=\s*['"][^'"\n]{6,}['"]/i);
    if (cred && !/credentials\(|withCredentials/.test(content.slice(Math.max(0, (cred.index ?? 0) - 80), (cred.index ?? 0) + 80))) {
      out.push(gate("jenkins-hardcoded-cred", rel, "Hardcoded credential in the pipeline — use Jenkins Credentials (`withCredentials`/`credentials()`), never a plaintext secret in the Jenkinsfile.", lineOf(content, cred.index ?? 0)));
    }
    if (!/timeout\s*\(/.test(content)) {
      out.push(advise("jenkins-no-timeout", rel, "No `timeout(...)` wrapper — a hung step can pin an executor indefinitely. Wrap stages in `timeout(time: N, unit: 'MINUTES')`.", undefined, "info"));
    }
  }
  return out;
}

// ── Terraform / CloudFormation / Bicep ──────────────────────────────────────
function iac(root: string): Finding[] {
  const out: Finding[] = [];
  const tf = read(root, ["**/*.tf"]);
  const cfn = read(root, ["**/*.{yaml,yml,json}"]).filter((f) => /AWSTemplateFormatVersion|Type:\s*['"]?AWS::/.test(f.content));
  const bicep = read(root, ["**/*.bicep"]);
  const all = [...tf, ...cfn, ...bicep];

  for (const { rel, content } of all) {
    // security group / firewall open to the world
    const open = content.match(/0\.0\.0\.0\/0/);
    if (open && /(ingress|cidr_blocks|security[_-]?group|CidrIp|sourceAddressPrefix)/i.test(content)) {
      const sshRdp = /(?:from_port\s*=\s*(?:22|3389)|FromPort:\s*(?:22|3389)|destinationPortRange['"\s:]+(?:22|3389))/.test(content);
      out.push(gate("iac-open-to-world", rel, `Resource allows ingress from 0.0.0.0/0${sshRdp ? " on SSH/RDP (22/3389)" : ""} — open to the entire internet. Restrict the CIDR to known ranges; never expose management ports to 0.0.0.0/0.`, lineOf(content, open.index ?? 0)));
    }
    // public storage bucket
    const pub = content.match(/acl\s*=\s*['"]public-read|"PublicAccessBlockConfiguration"[\s\S]{0,200}false|block_public_acls\s*=\s*false|allowBlobPublicAccess\s*:\s*true/i);
    if (pub) out.push(gate("iac-public-bucket", rel, "Public storage bucket / blob access enabled — public buckets are the #1 cloud data-leak source. Block public access and serve via signed URLs or a CDN.", lineOf(content, pub.index ?? 0)));
    // IAM wildcard
    const wildcard = content.match(/"Action"\s*:\s*"\*"|actions\s*=\s*\[\s*"\*"\s*\]|"Resource"\s*:\s*"\*"/);
    if (wildcard) out.push(advise("iac-iam-wildcard", rel, "IAM policy grants Action/Resource `*` — violates least privilege; a leaked role becomes full account access. Scope to the specific actions and ARNs needed.", lineOf(content, wildcard.index ?? 0)));
    // explicitly unencrypted
    const unenc = content.match(/encrypted\s*=\s*false|StorageEncrypted:\s*false|enableHttpsTrafficOnly\s*:\s*false/i);
    if (unenc) out.push(advise("iac-unencrypted", rel, "Encryption explicitly disabled — enable encryption at rest/in transit (it's free and usually default).", lineOf(content, unenc.index ?? 0)));
    // hardcoded cloud key
    const key = content.match(/AKIA[0-9A-Z]{16}|aws_secret_access_key\s*=\s*['"][^'"\n]{20,}/);
    if (key) out.push(gate("iac-hardcoded-key", rel, "Hardcoded cloud credential in IaC — move it to a secrets manager / variables and ROTATE it. Anything in git history is compromised.", lineOf(content, key.index ?? 0)));
  }
  return out;
}

// ── docker-compose ──────────────────────────────────────────────────────────
function compose(root: string): Finding[] {
  const out: Finding[] = [];
  for (const { rel, content } of read(root, ["**/docker-compose*.{yml,yaml}", "**/compose.{yml,yaml}"])) {
    if (/privileged:\s*true/.test(content)) {
      const m = content.match(/privileged:\s*true/);
      out.push(advise("compose-privileged", rel, "A service runs `privileged: true` — that's near-root on the host. Drop it; grant only the specific `cap_add` capabilities needed.", lineOf(content, m?.index ?? 0)));
    }
    const dbPort = content.match(/ports:[\s\S]{0,120}["']?(?:0\.0\.0\.0:)?(5432|3306|27017|6379):/);
    if (dbPort) out.push(advise("compose-db-exposed", rel, "A database/cache port (Postgres/MySQL/Mongo/Redis) is published to the host — don't expose datastores publicly; keep them on the internal compose network only.", lineOf(content, dbPort.index ?? 0)));
  }
  return out;
}

export function devopsChecks(repo: Repo): Finding[] {
  const root = repo.root;
  return [...githubActions(root), ...nginx(root), ...jenkins(root), ...iac(root), ...compose(root)];
}
