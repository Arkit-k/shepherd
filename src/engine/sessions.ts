// Reads Claude Code's own registry of running sessions.
//
// ~/.claude/sessions/<pid>.json is written by Claude Code itself and holds the
// session id, working directory, a friendly name and a liveness status. That is
// far better than scraping `ps` and `lsof`, and it gives us the stable session id
// the board keys on.
//
// `claude agents --json` returns the same data, but shelling out costs ~1s of CLI
// startup per call, so read the files and keep the CLI as a fallback.
//
// Note the files are keyed by PID, not session id: a resumed session gets a new
// file. Always read sessionId from inside rather than inferring it.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

export type LiveSession = {
  sessionId: string;
  pid: number;
  cwd: string;
  name?: string;
  status?: string;
  startedAt?: number;
  kind?: string;
};

const REGISTRY = path.join(os.homedir(), ".claude", "sessions");
const SOCKETS = "/tmp/cc-socks";

/** Is that process still around? A registry file outlives the session it describes. */
function alive(pid: number): boolean {
  if (existsSync(path.join(SOCKETS, `${pid}.sock`))) return true;
  try {
    process.kill(pid, 0); // signal 0 tests for existence without touching it
    return true;
  } catch (e) {
    // EPERM means the process is there but belongs to someone else — still alive.
    // Only ESRCH means no such process.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function fromRegistry(): LiveSession[] {
  if (!existsSync(REGISTRY)) return [];
  const out: LiveSession[] = [];
  for (const f of readdirSync(REGISTRY)) {
    if (!f.endsWith(".json")) continue; // the directory also holds per-session .key files
    try {
      const j = JSON.parse(readFileSync(path.join(REGISTRY, f), "utf8"));
      if (!j.sessionId || !j.pid) continue;
      if (!alive(j.pid)) continue;
      out.push({
        sessionId: j.sessionId,
        pid: j.pid,
        cwd: j.cwd ?? "",
        name: j.name,
        status: j.status,
        startedAt: j.startedAt,
        kind: j.kind,
      });
    } catch {
      continue; // a half-written file is not worth failing over
    }
  }
  return out;
}

function fromCli(): LiveSession[] {
  try {
    const r = spawnSync("claude", ["agents", "--json"], { encoding: "utf8", timeout: 15000 });
    if (r.status !== 0 || !r.stdout) return [];
    const arr = JSON.parse(r.stdout);
    return Array.isArray(arr) ? arr.filter((s) => s?.sessionId && s?.pid) : [];
  } catch {
    return [];
  }
}

/** Every Claude session currently running on this machine, newest first. */
export function liveSessions(): LiveSession[] {
  const found = fromRegistry();
  const list = found.length ? found : fromCli();
  return list.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** The friendly name Claude Code gave a session, if we can see it. */
export function nameOf(sessionId: string): string | undefined {
  return liveSessions().find((s) => s.sessionId === sessionId)?.name;
}

/**
 * This process's own session id.
 *
 * Claude Code exports CLAUDE_CODE_SESSION_ID into every process it spawns —
 * hooks, MCP servers, Bash — and it equals the `sessionId` in the registry file
 * and the transcript's filename. That is what lets the MCP server resolve the
 * same board its session's hook writes to, and what lets `connect` leave itself
 * out of the list.
 */
export function selfSessionId(): string | undefined {
  return (
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID || // older/alternate harnesses
    undefined
  );
}
