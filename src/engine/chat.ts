import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

// The conversational brain. Shepherd doesn't hand-roll an agent loop — the loop
// IS headless Claude Code (already the dependency). Each turn we run `claude -p`
// with read-only tools so Shepherd can open files, grep the repo, and reason like
// a principal engineer reviewing live code. Continuity is kept server-side via
// the session id (`--resume`), so we don't re-send the whole transcript.
//
// Read-only tools only (Read/Grep/Glob): Shepherd is a maintainer, not an editor.
// In `-p` mode any tool not on this list is auto-denied, so Shepherd structurally
// cannot mutate the user's code mid-conversation — it guides and hands off.
//
// GROUNDED reviews: we also wire in Shepherd's OWN MCP server (dist/mcp.js), so
// the brain can call `mcp__shepherd__scan` to run the real deterministic detectors
// and `mcp__shepherd__fix_order` to produce a work-order — its conversational
// reviews are backed by the same checks the engine runs, not vibes.

export interface ChatReply {
  text: string;
  sessionId?: string;
}

const TOOLS = "Read,Grep,Glob,mcp__shepherd__scan,mcp__shepherd__fix_order";

// Point a headless `claude` at Shepherd's own MCP server. We write the config to
// a temp FILE (not an inline string) to sidestep Windows shell-quoting of JSON,
// and use the running node binary + absolute mcp.js path so it works under npx.
let _mcpConfig: string | null = null;
function mcpConfig(): string {
  if (_mcpConfig) return _mcpConfig;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mcpJs = path.resolve(here, "../mcp.js"); // dist/engine/chat.js → dist/mcp.js
  const cfg = { mcpServers: { shepherd: { command: process.execPath, args: [mcpJs] } } };
  const dir = mkdtempSync(path.join(os.tmpdir(), "shepherd-mcp-"));
  _mcpConfig = path.join(dir, "mcp.json");
  writeFileSync(_mcpConfig, JSON.stringify(cfg));
  return _mcpConfig;
}

function runClaude(input: string, root: string, resume?: string): ChatReply | null {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--allowedTools",
    TOOLS,
    "--mcp-config",
    mcpConfig(),
    "--strict-mcp-config", // only Shepherd's server — don't inherit the user's MCP setup
  ];
  if (resume) args.push("--resume", resume);

  const res = spawnSync("claude", args, {
    input,
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (res.status !== 0 || !res.stdout) return null;

  try {
    const env = JSON.parse(res.stdout);
    const text = typeof env.result === "string" ? env.result : res.stdout;
    return { text: text.trim(), sessionId: typeof env.session_id === "string" ? env.session_id : resume };
  } catch {
    return { text: res.stdout.trim(), sessionId: resume };
  }
}

// Send one turn. On the FIRST turn (no sessionId) `preamble` — the soul + memory
// brief — is prepended so Shepherd boots up as itself with the project context in
// mind; later turns ride the resumed session. If a resume fails (stale session),
// we transparently restart with the preamble so the conversation never dies.
export function askShepherd(
  message: string,
  opts: { root: string; preamble: string; sessionId?: string },
): ChatReply | null {
  if (!opts.sessionId) {
    return runClaude(`${opts.preamble}\n\n---\n\nThe user says:\n${message}`, opts.root);
  }
  const resumed = runClaude(message, opts.root, opts.sessionId);
  if (resumed) return resumed;
  // session went stale — reboot with full context.
  return runClaude(`${opts.preamble}\n\n---\n\nThe user says:\n${message}`, opts.root);
}
