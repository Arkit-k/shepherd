import { spawnSync } from "node:child_process";
import type { Repo } from "./ingest.js";
import type { CodeModel } from "./ast.js";
import { detectStack } from "./tech-stack.js";
import { claudeAvailable } from "./fixers/claude.js";

// A compact, cheap structural map — this is what we give Claude, NOT the repo.
function buildMap(repo: Repo, model: CodeModel): string {
  const tech = detectStack(repo);

  const dirCounts = new Map<string, number>();
  for (const f of repo.files) {
    const seg = f.path.split("/").slice(0, 3).join("/");
    dirCounts.set(seg, (dirCounts.get(seg) ?? 0) + 1);
  }
  const dirs = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([d, n]) => `  ${d} (${n})`)
    .join("\n");

  const apiRoutes = repo.files
    .filter((f) => /\/api\/.*route\.(ts|js)$/.test(f.path) || /pages\/api\//.test(f.path))
    .slice(0, 40)
    .map((f) => `  ${f.path}`)
    .join("\n");

  const pages = repo.files
    .filter((f) => /app\/.*page\.(tsx|jsx)$/.test(f.path))
    .slice(0, 30)
    .map((f) => `  ${f.path}`)
    .join("\n");

  const biggest = [...repo.files]
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 8)
    .map((f) => `  ${f.path} (${f.lines} lines)`)
    .join("\n");

  return [
    `TECH: ${tech.language}, ${tech.frameworks.join(", ") || "—"}`,
    `DATABASES: ${tech.databases.join(", ") || "none detected"}`,
    `KEY VERSIONS: ${tech.notable.map((n) => `${n.name}@${n.version}`).join(", ")}`,
    `SIZE: ${repo.files.length} files, ${model.functions.length} functions, ${model.classes.length} classes`,
    ``,
    `TOP DIRECTORIES:\n${dirs}`,
    ``,
    `API ROUTES:\n${apiRoutes || "  none"}`,
    ``,
    `PAGES:\n${pages || "  none"}`,
    ``,
    `LARGEST FILES:\n${biggest}`,
  ].join("\n");
}

// Tier 2 — Claude reads the map and explains the architecture + soft spots.
// One call, on the user's account, over the map (not the codebase).
export function understandArchitecture(repo: Repo, model: CodeModel): string | null {
  if (!claudeAvailable()) {
    console.log("⚠️  architecture summary needs Claude Code on PATH; skipping.");
    return null;
  }

  const prompt = [
    `You are a staff engineer reviewing a codebase you've never seen. Below is a structural`,
    `map of a repository (tech, directories, routes, largest files). Based on it:`,
    `1) In 3-5 sentences, explain what this application IS and how it's architected.`,
    `2) List the main architectural soft spots / risks worth investigating (concise bullets).`,
    `Be concrete and brief. Do not ask for more files.`,
    ``,
    buildMap(repo, model),
  ].join("\n");

  const res = spawnSync("claude", ["-p", "--output-format", "json"], {
    input: prompt,
    cwd: repo.root,
    encoding: "utf8",
    timeout: 150_000,
    maxBuffer: 8 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (res.status !== 0 || !res.stdout) return null;

  try {
    const env = JSON.parse(res.stdout);
    if (typeof env.result === "string") return env.result;
  } catch {
    /* fall through */
  }
  return res.stdout;
}
