import fg from "fast-glob";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface SourceFile {
  path: string; // relative to repo root
  abs: string;
  content: string;
  lines: number;
}

export interface Repo {
  root: string;
  files: SourceFile[];
  hasNext: boolean;
  hasSupabase: boolean;
}

// Layer 0 — read the repo, collect source files, detect the stack.
export async function ingest(root: string): Promise<Repo> {
  const rel = await fg(["**/*.{ts,tsx,js,jsx}"], {
    cwd: root,
    ignore: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/*.d.ts",
    ],
    dot: false,
  });

  const files: SourceFile[] = rel.map((p) => {
    const abs = path.join(root, p);
    const content = readFileSync(abs, "utf8");
    return { path: p, abs, content, lines: content.split("\n").length };
  });

  let pkg = "";
  try {
    pkg = readFileSync(path.join(root, "package.json"), "utf8");
  } catch {
    // no package.json — fine
  }

  return {
    root,
    files,
    hasNext: /"next"\s*:/.test(pkg),
    hasSupabase: /@supabase\//.test(pkg),
  };
}
