import type { Repo, SourceFile } from "../ingest.js";
import type { Finding } from "../report.js";
import { claudeAvailable } from "../fixers/claude.js";
import { claudeJsonArray } from "../claude-json.js";

// Frontend that must serve ~1M daily users. AI tools ship components that work
// for one user and melt for a million: giant client bundles, no code-splitting,
// raw <img>, client-side fetch waterfalls, unmemoized lists. Tier-1 heuristics
// + a Claude pass on the heaviest components.

function isComponent(p: string): boolean {
  return /\.(tsx|jsx)$/.test(p) && !/\.(test|spec|stories)\./.test(p);
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function heuristics(f: SourceFile): Finding[] {
  const out: Finding[] = [];
  const c = f.content;
  if (!isComponent(f.path)) return out;

  // raw <img> in a Next app — ships unoptimized images to every user.
  const img = c.match(/<img\s/);
  if (img && !/next\/image/.test(c)) {
    out.push({
      id: "unoptimized-image",
      severity: "warn",
      disposition: "advise",
      file: f.path,
      line: lineOf(c, img.index ?? 0),
      message: "Raw <img> — ships full-size images to every visitor. Use next/image (or a CDN + srcset) for automatic resize/lazy-load.",
    });
  }

  // a 'use client' component that's also large — pushes JS to every user.
  if (/^["']use client["']/m.test(c) && f.lines > 250) {
    out.push({
      id: "heavy-client-component",
      severity: "warn",
      disposition: "advise",
      file: f.path,
      message: `Large client component (${f.lines} lines) — all of this ships to the browser. Split it, move logic server-side, or dynamic-import the heavy parts.`,
    });
  }

  // client-side fetch in a component with no caching layer (waterfalls at scale).
  if (/useEffect\([^)]*\)\s*=>\s*\{[\s\S]{0,200}fetch\(/.test(c) && !/swr|react-query|@tanstack\/react-query|useQuery/.test(c)) {
    const m = c.match(/useEffect/);
    out.push({
      id: "client-fetch-waterfall",
      severity: "warn",
      disposition: "advise",
      file: f.path,
      line: m ? lineOf(c, m.index ?? 0) : undefined,
      message: "Data fetched in useEffect with no caching/dedup — every mount re-hits the API. Move to a server component or use SWR/React Query.",
    });
  }

  // long list render with no virtualization.
  if (/\.map\(/.test(c) && /(items|rows|data|list|results)\.map\(/.test(c) && !/react-window|react-virtual|virtuoso|FlashList/.test(c) && f.lines > 200) {
    out.push({
      id: "unvirtualized-list",
      severity: "info",
      disposition: "advise",
      file: f.path,
      message: "Rendering a list with .map and no virtualization — fine for 20 rows, janky for thousands. Consider react-window/react-virtual for large lists.",
    });
  }

  return out;
}

function deepReview(repo: Repo): Finding[] {
  if (!claudeAvailable()) return [];
  const targets = repo.files
    .filter((f) => isComponent(f.path))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 3);
  if (targets.length === 0) return [];

  const out: Finding[] = [];
  for (const f of targets) {
    const prompt = [
      `You are a frontend performance engineer for a site with ~1,000,000 daily users.`,
      `Review this component for things that hurt at that scale: oversized client bundle,`,
      `missing code-splitting/dynamic import, render-blocking work, unmemoized expensive`,
      `renders, client fetch waterfalls, no SSR/streaming where it would help, layout`,
      `thrash, shipping server-only deps to the client. Give concrete fixes. Respond with`,
      `ONLY a JSON array of {"id":string,"severity":"critical"|"warn","gate":boolean,"line":number|null,"message":string}.`,
      `Return [] if it's already built to scale.`,
      ``,
      `File: ${f.path}`,
      "```",
      f.content.slice(0, 12000),
      "```",
    ].join("\n");

    const raw = claudeJsonArray<{ id?: string; severity?: string; gate?: boolean; line?: number | null; message?: string }>(
      prompt,
      repo.root,
    );
    if (!raw) continue;
    for (const r of raw) {
      if (!r || !r.message) continue;
      out.push({
        id: r.id ? `fe-${r.id}`.slice(0, 28) : "fe-scale",
        severity: r.severity === "critical" ? "critical" : r.severity === "info" ? "info" : "warn",
        disposition: r.gate === true ? "gate" : "advise",
        file: f.path,
        line: typeof r.line === "number" ? r.line : undefined,
        message: String(r.message),
      });
    }
  }
  return out;
}

// Tier 1 always; Tier 2 (Claude) when `deep`. Returns [] if there's no frontend.
export function frontendScale(repo: Repo, opts: { deep?: boolean } = {}): Finding[] {
  const hasFrontend = repo.files.some((f) => isComponent(f.path));
  if (!hasFrontend) return [];
  const out: Finding[] = [];
  for (const f of repo.files) out.push(...heuristics(f));
  if (opts.deep) out.push(...deepReview(repo));
  return out;
}
