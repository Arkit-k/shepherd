import type { Repo } from "./ingest.js";
import type { Finding } from "./report.js";
import { claudeAvailable } from "./fixers/claude.js";
import { claudeJsonArray } from "./claude-json.js";

// How the repo is organized. Top-tier teams colocate by FEATURE (a vertical
// slice — `billing/` owns its route + service + model + tests) rather than by
// LAYER (every model in `models/`, every controller in `controllers/`), because
// features change together and layers force shotgun edits across the tree.
// This detects the layer-based smell and recommends the feature-based structure
// a million-dollar codebase would use. Advisory — structure doesn't block a ship.

export type StructureStyle = "feature" | "layer" | "mixed" | "flat";

export interface StructureResult {
  style: StructureStyle;
  findings: Finding[];
}

// Folder names that signal LAYER-based organization (grouping by technical role).
const LAYER_DIRS = new Set([
  "models",
  "model",
  "controllers",
  "controller",
  "services",
  "service",
  "repositories",
  "repository",
  "views",
  "schemas",
  "schema",
  "entities",
  "dtos",
  "dto",
  "interfaces",
  "types",
  "handlers",
  "reducers",
]);

function segments(p: string): string[] {
  return p.replace(/\\/g, "/").split("/");
}

export function analyzeStructure(repo: Repo): StructureResult {
  // count how many source files live under a folder of each layer name.
  const layerHits = new Map<string, number>();
  let layerFileCount = 0;

  for (const f of repo.files) {
    const segs = segments(f.path);
    // ignore the filename itself; look at the directory segments
    for (const seg of segs.slice(0, -1)) {
      const s = seg.toLowerCase();
      if (LAYER_DIRS.has(s)) {
        layerHits.set(s, (layerHits.get(s) ?? 0) + 1);
        layerFileCount++;
        break; // count each file once toward the layer total
      }
    }
  }

  const total = repo.files.length || 1;
  const layerShare = layerFileCount / total;
  const distinctLayers = layerHits.size;

  let style: StructureStyle = "flat";
  if (distinctLayers >= 2 && layerShare >= 0.25) style = "layer";
  else if (distinctLayers >= 1 && layerShare >= 0.15) style = "mixed";
  else if (total > 12) style = "feature"; // no dominant layer folders in a non-trivial repo

  const findings: Finding[] = [];
  if (style === "layer" || style === "mixed") {
    const layers = [...layerHits.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}/ (${c})`);
    findings.push({
      id: "layer-based-structure",
      severity: "warn",
      disposition: "advise",
      file: "(structure)",
      message:
        `Code is organized by LAYER (${layers.slice(0, 5).join(", ")}). Top teams colocate by FEATURE: ` +
        `one folder per feature (e.g. features/billing/ holding its route, service, model, and tests together), ` +
        `so a change touches one folder instead of being scattered across models/, controllers/, services/. ` +
        `It scales better, keeps boundaries explicit (SOLID), and makes ownership obvious.`,
    });
  }

  return { style, findings };
}

// Low-context Claude pass: send just the directory tree (no code) and ask for a
// concrete feature-based reorganization with SOLID module boundaries.
export function reviewStructure(repo: Repo): Finding[] {
  if (!claudeAvailable()) return [];

  const dirCounts = new Map<string, number>();
  for (const f of repo.files) {
    const dir = segments(f.path).slice(0, -1).join("/") || ".";
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }
  const tree = [...dirCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 60)
    .map(([d, n]) => `  ${d} (${n})`)
    .join("\n");

  const prompt = [
    `You are a staff engineer reviewing how a repository is ORGANIZED (not the code).`,
    `Below is the directory tree with file counts. Assess whether it is organized by`,
    `feature (vertical slices) or by layer (models/, controllers/, services/...).`,
    `Recommend the structure a top-tier company would use: feature/domain folders that`,
    `own their full slice, clear module boundaries (SOLID), and a sensible high-level`,
    `system-design split. Give concrete folder moves. Be concise.`,
    `Respond with ONLY a JSON array of {"id":string,"message":string}. [] if already clean.`,
    ``,
    tree,
  ].join("\n");

  const raw = claudeJsonArray<{ id?: string; message?: string }>(prompt, repo.root);
  if (!raw) return [];
  return raw
    .filter((r) => r && r.message)
    .map<Finding>((r) => ({
      id: r.id ? `structure-${r.id}`.slice(0, 28) : "structure",
      severity: "info",
      disposition: "advise",
      file: "(structure)",
      message: String(r.message),
    }));
}
