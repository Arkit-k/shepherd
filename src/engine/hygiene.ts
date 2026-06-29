import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Repo } from "./ingest.js";
import type { Finding } from "./report.js";

// PROJECT HYGIENE — the "maintainable by a team" axis. operations.ts covers
// RUNTIME readiness (observability, health, shutdown, CVEs); this covers the
// REPO-hygiene / developer-tooling scaffolding that keeps a codebase sane when
// many people work on it: git hooks (Husky), a linter, a formatter, automated
// dependency updates, ownership, a license, a readme, strict types. AI builders
// almost never scaffold these — they ship app code, not the guardrails around it.
//
// All deterministic presence checks (no Claude, no network — the moat). Every
// finding is ADVISORY: missing hygiene never blocks a merge, it's a nudge. The
// `/scaffold` command turns these into a work-order the user's Claude Code fills.

export interface HygieneItem {
  id: string;
  file: string; // the file/dir we recommend adding
  severity: Finding["severity"];
  message: string; // why it matters (shown as the finding)
  scaffold: string; // one-line instruction for the work-order
}

function rootPkg(root: string): { deps: Record<string, string>; raw: any | null } {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    return { deps: { ...(raw.dependencies ?? {}), ...(raw.devDependencies ?? {}) }, raw };
  } catch {
    return { deps: {}, raw: null };
  }
}

const hasDep = (deps: Record<string, string>, re: RegExp) => Object.keys(deps).some((d) => re.test(d));
const anyExists = (root: string, names: string[]) => names.some((n) => existsSync(path.join(root, n)));
const glob = (root: string, patterns: string[]) =>
  fg.sync(patterns, { cwd: root, dot: true, ignore: ["**/node_modules/**"] }).length > 0;

// The core: what production-grade scaffolding is missing from this repo.
export function hygieneItems(repo: Repo): HygieneItem[] {
  const root = repo.root;
  const { deps, raw } = rootPkg(root);
  const isNode = raw !== null;
  const items: HygieneItem[] = [];

  // ── git hooks (Husky) — run lint/format/test before code is committed ──────
  // Note: Shepherd's own `/git-check install` writes a pre-push hook, but that's
  // local; Husky commits the hooks so the WHOLE TEAM gets them.
  if (isNode) {
    const hasHusky = hasDep(deps, /^husky$|simple-git-hooks|pre-commit|lefthook/) || existsSync(path.join(root, ".husky"));
    if (!hasHusky) {
      items.push({
        id: "no-git-hooks",
        file: ".husky/",
        severity: "warn",
        message:
          "No committed git hooks (Husky/lefthook) — lint, format, and tests don't run automatically before a commit/push, so broken or unformatted code lands in main. Add Husky so the whole team gets the guardrails, not just whoever set them up locally.",
        scaffold:
          "Add Husky (`npx husky init`) with a pre-commit hook running lint-staged, and a pre-push hook running the test suite (and optionally `npx shepherd --git-check`).",
      });
    }
    // lint-staged pairs with Husky — only run changed files through the linter.
    const hasLintStaged = hasDep(deps, /^lint-staged$/) || anyExists(root, [".lintstagedrc", ".lintstagedrc.json", ".lintstagedrc.js", ".lintstagedrc.cjs"]) || Boolean(raw?.["lint-staged"]);
    if (!hasLintStaged && !hasHusky) {
      items.push({
        id: "no-lint-staged",
        file: ".lintstagedrc.json",
        severity: "info",
        message: "No lint-staged — pre-commit hooks would lint/format the entire repo instead of just staged files (slow). Add lint-staged to run tools only on what changed.",
        scaffold: 'Add lint-staged config running the linter + formatter on staged files, e.g. {"*.{ts,tsx,js,jsx}": ["eslint --fix", "prettier --write"]}.',
      });
    }
  }

  // ── linter (ESLint / Biome) ───────────────────────────────────────────────
  if (isNode) {
    const hasLinter =
      hasDep(deps, /eslint|@biomejs\/biome|oxlint|^xo$/) ||
      glob(root, [".eslintrc", ".eslintrc.*", "eslint.config.*", "biome.json", "biome.jsonc"]);
    if (!hasLinter) {
      items.push({
        id: "no-linter",
        file: "eslint.config.js",
        severity: "warn",
        message:
          "No linter (ESLint/Biome) configured — common bugs (unused vars, floating promises, == vs ===, accidental any) ship unflagged, and style drifts across contributors. Add a linter and run it in CI.",
        scaffold: "Add ESLint (flat config `eslint.config.js`) or Biome, with sensible defaults for the stack, and wire it into the CI build and the pre-commit hook.",
      });
    }
  }

  // ── formatter (Prettier / Biome) ──────────────────────────────────────────
  if (isNode) {
    const hasFormatter =
      hasDep(deps, /^prettier$|@biomejs\/biome|^dprint$/) ||
      glob(root, [".prettierrc", ".prettierrc.*", "prettier.config.*", "biome.json"]);
    if (!hasFormatter) {
      items.push({
        id: "no-formatter",
        file: ".prettierrc.json",
        severity: "info",
        message: "No code formatter (Prettier/Biome) — formatting becomes a per-person preference and diffs fill with whitespace churn. Add a formatter so style is automatic and uniform.",
        scaffold: "Add Prettier (`.prettierrc.json`) or Biome formatting, plus a `format` script, and run it via lint-staged on commit.",
      });
    }
  }

  // ── .editorconfig — consistent indentation/EOL across editors ─────────────
  if (!existsSync(path.join(root, ".editorconfig"))) {
    items.push({
      id: "no-editorconfig",
      file: ".editorconfig",
      severity: "info",
      message: "No .editorconfig — contributors' editors disagree on indentation, charset, and line endings (you've already seen LF/CRLF churn). Add one to normalize the basics editor-agnostically.",
      scaffold: "Add a .editorconfig setting charset=utf-8, end_of_line=lf, indent_style/size, insert_final_newline=true, trim_trailing_whitespace=true.",
    });
  }

  // ── automated dependency updates (Dependabot / Renovate) ──────────────────
  if (isNode) {
    const hasBot =
      existsSync(path.join(root, ".github", "dependabot.yml")) ||
      existsSync(path.join(root, ".github", "dependabot.yaml")) ||
      anyExists(root, ["renovate.json", ".renovaterc", ".renovaterc.json"]) ||
      hasDep(deps, /renovate/);
    if (!hasBot) {
      items.push({
        id: "no-dep-updates",
        file: ".github/dependabot.yml",
        severity: "info",
        message: "No automated dependency updates (Dependabot/Renovate) — security patches and version bumps depend on someone remembering. Enable one so CVEs get a PR the day they're disclosed.",
        scaffold: "Add .github/dependabot.yml (or renovate.json) configured for the npm ecosystem on a weekly schedule, grouping minor/patch updates.",
      });
    }
  }

  // ── CODEOWNERS — review routing for a multi-dev repo ──────────────────────
  if (!anyExists(root, ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"])) {
    items.push({
      id: "no-codeowners",
      file: ".github/CODEOWNERS",
      severity: "info",
      message: "No CODEOWNERS — with many contributors, PRs don't auto-request the right reviewers and ownership is unclear. Add CODEOWNERS to route reviews to the people responsible for each area.",
      scaffold: "Add .github/CODEOWNERS mapping top-level dirs/globs to the responsible team(s) or user(s).",
    });
  }

  // ── SECURITY.md — how to report a vulnerability ───────────────────────────
  if (!anyExists(root, ["SECURITY.md", ".github/SECURITY.md", "docs/SECURITY.md"])) {
    items.push({
      id: "no-security-policy",
      file: "SECURITY.md",
      severity: "info",
      message: "No SECURITY.md — there's no documented way to report a vulnerability privately, so researchers may disclose publicly instead. Add a short security policy with a contact and disclosure window.",
      scaffold: "Add SECURITY.md with supported versions, a private reporting contact (email/security advisory), and an expected response time.",
    });
  }

  // ── LICENSE — legal clarity for any user/contributor ──────────────────────
  const hasLicense = anyExists(root, ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"]) || Boolean(raw?.license);
  if (!hasLicense) {
    items.push({
      id: "no-license",
      file: "LICENSE",
      severity: "info",
      message: "No LICENSE file or package.json `license` field — without one the code is legally 'all rights reserved', which blocks adoption and contribution. Add an explicit license.",
      scaffold: "Add a LICENSE file (e.g. MIT/Apache-2.0) and set the `license` field in package.json to match.",
    });
  }

  // ── README — the front door ───────────────────────────────────────────────
  if (!glob(root, ["README", "README.*", "readme.*"])) {
    items.push({
      id: "no-readme",
      file: "README.md",
      severity: "warn",
      message: "No README — a new developer can't tell what this is, how to run it, or how to contribute. Add a README with setup, scripts, and architecture at a glance.",
      scaffold: "Add README.md covering what the project is, prerequisites, install/run/test commands, env vars, and a one-paragraph architecture overview.",
    });
  }

  // ── .dockerignore — only relevant when there's a Dockerfile ───────────────
  const hasDockerfile = glob(root, ["**/Dockerfile", "**/Dockerfile.*"]);
  if (hasDockerfile && !existsSync(path.join(root, ".dockerignore"))) {
    items.push({
      id: "no-dockerignore",
      file: ".dockerignore",
      severity: "info",
      message: "Dockerfile present but no .dockerignore — node_modules, .git, and .env get copied into the build context (slow builds, bloated images, and possible secret leakage). Add a .dockerignore.",
      scaffold: "Add .dockerignore excluding node_modules, .git, .env*, dist/build output, and local tooling files.",
    });
  }

  // ── TypeScript strict mode ────────────────────────────────────────────────
  const tsconfigPath = path.join(root, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    try {
      // tolerate comments/trailing commas crudely by stripping line comments.
      const txt = readFileSync(tsconfigPath, "utf8").replace(/\/\/.*$/gm, "");
      const cfg = JSON.parse(txt);
      const strict = cfg?.compilerOptions?.strict;
      const extendsBase = Boolean(cfg?.extends);
      if (strict === false || (strict === undefined && !extendsBase)) {
        items.push({
          id: "no-ts-strict",
          file: "tsconfig.json",
          severity: "warn",
          message:
            "TypeScript `strict` is not enabled — null/undefined bugs, implicit any, and unchecked indexing slip through the very type system you're paying for. Turn on `strict: true`.",
          scaffold: 'Set `"strict": true` in tsconfig.json compilerOptions (consider also noUncheckedIndexedAccess), then fix the surfaced errors.',
        });
      }
    } catch {
      /* unparseable tsconfig — skip */
    }
  }

  return items;
}

// Map the hygiene items to advisory findings for the report / git-check / audit.
export function projectHygiene(repo: Repo): Finding[] {
  return hygieneItems(repo).map((it) => ({
    id: it.id,
    severity: it.severity,
    disposition: "advise",
    file: it.file,
    message: it.message,
  }));
}

// Turn the missing-scaffolding into a hand-off work-order. Shepherd describes the
// files and what goes in them; the user's own Claude Code session creates them,
// following the project's conventions. Maintainer model — Shepherd never writes
// the files itself.
export function buildScaffoldOrder(items: HygieneItem[], ts: string): string {
  const sections = items.map((it, i) => {
    return [`${i + 1}. **\`${it.file}\`** — ${it.id}`, `   - ${it.scaffold}`].join("\n");
  });

  return [
    `# Shepherd — scaffold work-order (project hygiene)`,
    ``,
    `_Generated ${ts}. ${items.length} production-grade tooling/config file(s) this repo is missing._`,
    `_Shepherd describes them; you create them in your Claude Code session, matching this project's conventions._`,
    ``,
    `These are the guardrails that keep a codebase maintainable as the team grows — none block a merge,`,
    `but a serious production repo has them. Add each below (skip any that don't fit your workflow):`,
    ``,
    ...sections,
    ``,
    `Tip: after adding Husky, you can also have the pre-push hook run \`npx shepherd --git-check\` to gate pushes.`,
    `When done, re-run \`npx shepherd\` (or ask me to "audit") for a fresh read.`,
    ``,
  ].join("\n");
}
