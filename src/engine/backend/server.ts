import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Repo } from "../ingest.js";
import { loadProject, saveConfig, type Project } from "../project.js";

// Boots the user's app for the live probe, tells us when it's ready, and tears
// it down. Reads `.shepherd/config.json` first (learned command/port); only
// auto-detects when that's empty, then writes back what it learned.

export interface RunningServer {
  baseUrl: string;
  port: number;
  stop: () => void;
}

const SERVER_FRAMEWORKS = ["next", "express", "fastify", "@nestjs/core", "hono", "koa"];
const READY_MARKERS = [/ready/i, /listening/i, /started server/i, /localhost:\d+/i, /compiled/i];
const DEFAULT_PORT = 3000;

interface Candidate {
  dir: string; // absolute dir containing the package.json
  script: string; // the dev/start command line
  scriptName: string; // "dev" | "start"
  port: number;
  framework?: string;
}

function detectPackageManager(root: string): string {
  if (existsSync(path.join(root, "bun.lockb")) || existsSync(path.join(root, "bun.lock"))) return "bun";
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

function portFromScript(script: string): number | null {
  // `--port 3001`, `-p 3001`, `PORT=3001`
  const m = script.match(/(?:--port|-p)[ =](\d{2,5})/) || script.match(/PORT[ =](\d{2,5})/);
  return m ? Number(m[1]) : null;
}

// Find the best package to run: a non-root package with a server framework and
// a dev/start script wins (the actual app), else the root package.
function findCandidate(repo: Repo): Candidate | null {
  const pkgPaths = fg.sync("**/package.json", {
    cwd: repo.root,
    ignore: ["**/node_modules/**"],
    absolute: true,
  });

  const candidates: Candidate[] = [];
  for (const pp of pkgPaths) {
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(pp, "utf8"));
    } catch {
      continue;
    }
    const scripts = pkg.scripts ?? {};
    const scriptName = scripts.dev ? "dev" : scripts.start ? "start" : null;
    if (!scriptName) continue;

    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const framework = SERVER_FRAMEWORKS.find((f) => f in deps);
    const isRoot = path.dirname(pp) === path.resolve(repo.root);
    const script = scripts[scriptName];

    candidates.push({
      dir: path.dirname(pp),
      script,
      scriptName,
      port: portFromScript(script) ?? DEFAULT_PORT,
      framework,
    });
    // de-prioritize turbo/concurrently roots that fan out to many apps
    void isRoot;
  }

  if (candidates.length === 0) return null;

  // Prefer: has a real server framework, runs a single app (not turbo), `dev`.
  candidates.sort((a, b) => {
    const score = (c: Candidate) =>
      (c.framework ? 2 : 0) +
      (/turbo|concurrently/.test(c.script) ? -2 : 0) +
      (c.scriptName === "dev" ? 1 : 0);
    return score(b) - score(a);
  });
  return candidates[0];
}

function ping(url: string): Promise<boolean> {
  return fetch(url, { method: "GET", signal: AbortSignal.timeout(3000) })
    .then(() => true)
    .catch(() => false);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Start the dev server and resolve once it answers HTTP (or prints a ready
// marker). Returns null if it can't start within the timeout — the caller then
// skips the live probe and records why. Never hangs.
export async function startServer(repo: Repo): Promise<RunningServer | null> {
  const project: Project = loadProject(repo.root);

  // 1. learned config wins; else auto-detect.
  let dir = repo.root;
  let port = project.config.port ?? DEFAULT_PORT;
  let command = project.config.startCommand;

  if (!command) {
    const cand = findCandidate(repo);
    if (!cand) return null;
    const pm = detectPackageManager(repo.root);
    dir = cand.dir;
    port = cand.port;
    command = `${pm} run ${cand.scriptName}`;
    saveConfig(project, { startCommand: command, port, framework: cand.framework });
  }

  const baseUrl = `http://localhost:${port}`;
  const [cmd, ...args] = command.split(" ");

  const child: ChildProcess = spawn(cmd, args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: { ...process.env, PORT: String(port), BROWSER: "none" },
  });

  let ready = false;
  const watch = (buf: Buffer) => {
    const s = buf.toString();
    if (!ready && READY_MARKERS.some((re) => re.test(s))) ready = true;
  };
  child.stdout?.on("data", watch);
  child.stderr?.on("data", watch);

  const stop = () => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      child.kill("SIGKILL");
    }
  };

  // 2. wait up to 60s for the server to actually answer.
  let exited = false;
  child.on("exit", () => (exited = true));

  const start = await waitReady(baseUrl, () => ready, () => exited, 60_000);
  if (!start) {
    stop();
    return null;
  }

  return { baseUrl, port, stop };
}

// Poll until the URL answers or the ready marker fired; bail if the process
// exits or the timeout elapses. Uses a counted loop (no Date.now in the body
// so behaviour is deterministic across the bounded number of polls).
async function waitReady(
  baseUrl: string,
  readyMarkerHit: () => boolean,
  hasExited: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const intervalMs = 1000;
  const maxPolls = Math.ceil(timeoutMs / intervalMs);
  for (let i = 0; i < maxPolls; i++) {
    if (hasExited()) return false;
    if (await ping(baseUrl)) return true;
    if (readyMarkerHit() && (await ping(baseUrl))) return true;
    await sleep(intervalMs);
  }
  return false;
}
