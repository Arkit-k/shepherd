import type { Repo, SourceFile } from "./ingest.js";
import type { Finding } from "./report.js";
import { claudeAvailable } from "./fixers/claude.js";
import { claudeJsonArray } from "./claude-json.js";

// "It works, but there's a newer, safer way." AI tools reach for yesterday's
// idioms — manual form POSTs instead of Server Actions, class components,
// getServerSideProps, deprecated lifecycles. When the modern primitive is a
// genuine upgrade (safer / less code / framework-recommended), say so. These
// are advisories, not blockers — you can ship, but you shouldn't keep building
// on the old pattern.

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function isComponent(p: string): boolean {
  return /\.(tsx|jsx)$/.test(p) && !/\.(test|spec|stories)\./.test(p);
}

function advise(id: string, file: string, message: string, line?: number): Finding {
  return { id, severity: "info", disposition: "advise", file, line, message };
}

function tier1(repo: SourceFile[], hasNext: boolean): Finding[] {
  const out: Finding[] = [];

  for (const f of repo) {
    const c = f.content;

    // Next.js: a form submitting via client fetch/onSubmit when Server Actions
    // are the modern, safer default for mutations.
    if (
      hasNext &&
      isComponent(f.path) &&
      /<form[\s>]/.test(c) &&
      /(onSubmit|fetch\(|axios|XMLHttpRequest)/.test(c) &&
      !/['"]use server['"]/.test(c) &&
      !/\baction=\{/.test(c)
    ) {
      const m = c.match(/<form[\s>]/);
      out.push(
        advise(
          "use-server-action",
          f.path,
          "Form submits through a client fetch to an API route. Next.js Server Actions ('use server') are the modern, safer default for mutations — no public endpoint to abuse, built-in CSRF protection, progressive enhancement, and less client JS.",
          m ? lineOf(c, m.index ?? 0) : undefined,
        ),
      );
    }

    // Pages-router data fetching → App Router server components.
    const legacy = c.match(/\b(getServerSideProps|getStaticProps|getInitialProps)\b/);
    if (legacy) {
      out.push(
        advise(
          "legacy-data-fetching",
          f.path,
          `${legacy[1]} is the pages-router pattern. App Router server components (async components that fetch directly) are the current default — simpler, streamable, no prop plumbing.`,
          lineOf(c, legacy.index ?? 0),
        ),
      );
    }

    // React class components → function components + hooks.
    const klass = c.match(/class\s+\w+\s+extends\s+(React\.)?(Pure)?Component\b/);
    if (klass) {
      out.push(
        advise(
          "class-component",
          f.path,
          "Class component — function components with hooks are the modern React standard (less boilerplate, better tree-shaking, the direction the ecosystem builds for).",
          lineOf(c, klass.index ?? 0),
        ),
      );
    }

    // Deprecated/unsafe lifecycles.
    const lifecycle = c.match(/\b(componentWillMount|componentWillReceiveProps|componentWillUpdate)\b/);
    if (lifecycle) {
      out.push(
        advise(
          "deprecated-lifecycle",
          f.path,
          `${lifecycle[1]} is deprecated (UNSAFE_ in React 18+) and breaks with concurrent rendering. Move to hooks (useEffect / derived state).`,
          lineOf(c, lifecycle.index ?? 0),
        ),
      );
    }

    // Heavy date lib → lighter modern alternative.
    const moment = c.match(/from\s+['"]moment['"]|require\(['"]moment['"]\)/);
    if (moment) {
      out.push(
        advise(
          "heavy-date-lib",
          f.path,
          "moment.js is in maintenance mode and ships a large, mutable bundle. Prefer date-fns, Day.js, or the native Temporal API.",
          lineOf(c, moment.index ?? 0),
        ),
      );
    }
  }

  return out;
}

// Optional Tier-2: a low-context Claude pass on the heaviest components for
// framework idiom upgrades the regexes can't see. Gated by --deep.
function deepIdioms(repo: Repo): Finding[] {
  if (!claudeAvailable()) return [];
  const targets = repo.files
    .filter((f) => isComponent(f.path) || /route\.(ts|js)$/.test(f.path))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 3);
  if (targets.length === 0) return [];

  const out: Finding[] = [];
  for (const f of targets) {
    const prompt = [
      `Review this file for OLD-BUT-WORKING patterns where the framework now offers a`,
      `better/safer modern primitive (e.g. manual fetch where a Server Action fits,`,
      `client data fetching that should be a server component, old routing/data APIs,`,
      `deprecated idioms). Only flag where the modern way is a genuine upgrade. Concise.`,
      `Respond with ONLY a JSON array of {"id":string,"line":number|null,"message":string}.`,
      `Return [] if it already uses current idioms.`,
      ``,
      `File: ${f.path}`,
      "```",
      f.content.slice(0, 12000),
      "```",
    ].join("\n");

    const raw = claudeJsonArray<{ id?: string; line?: number | null; message?: string }>(prompt, repo.root);
    if (!raw) continue;
    for (const r of raw) {
      if (!r || !r.message) continue;
      out.push(
        advise(r.id ? `idiom-${r.id}`.slice(0, 28) : "idiom-upgrade", f.path, String(r.message), typeof r.line === "number" ? r.line : undefined),
      );
    }
  }
  return out;
}

export function betterPatterns(repo: Repo, opts: { deep?: boolean } = {}): Finding[] {
  const out = tier1(repo.files, repo.hasNext);
  if (opts.deep) out.push(...deepIdioms(repo));
  return out;
}
