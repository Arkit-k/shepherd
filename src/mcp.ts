#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { watch, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { scan } from "./engine/run.js";
import { buildFixOrder, writeFixOrder } from "./engine/handoff.js";
import * as board from "./engine/board.js";

// Shepherd as an MCP server — this is how Claude Code "wires in".
//
// Two ways it works:
//  • PULL — Claude Code calls `scan` / `fix_order`, gets a compact work-order,
//    and applies the fixes itself.
//  • PUSH (Channels, research preview) — Shepherd declares a channel capability
//    and watches `.shepherd/fix-order.md`. When any `npx shepherd` run writes a
//    new work-order, Shepherd PUSHES it into the running Claude Code session, so
//    it wakes up and applies the fixes with zero typing.
//
// Shepherd never edits code itself — it is the maintainer that hands off work.
const server = new McpServer(
  { name: "shepherd", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} }, // makes this a push channel
    },
    instructions:
      'Shepherd is a production-readiness maintainer. Work orders arrive as ' +
      '<channel source="shepherd" ...> messages pointing at .shepherd/fix-order.md. ' +
      "When one arrives, read that file and apply the listed fixes as minimal diffs, " +
      "then call the `scan` tool with only_blocking=true to verify the gates are closed.",
  },
);

server.tool(
  "scan",
  "Scan a repository for production-readiness issues — security (cost-bomb endpoints, exposed secrets, unauthed API routes, hardcoded localhost) and code quality / measurable SOLID smells (oversized files, overly long functions, god-classes). Returns structured findings. Workflow: run scan, fix every finding where gate=true, then run scan again to verify it's shipshape.",
  {
    path: z.string().default(".").describe("Path to the repo to scan (default: current directory)."),
    only_blocking: z
      .boolean()
      .default(false)
      .describe("Return only blocking (gate=true) findings — use when re-verifying after a fix to keep context minimal."),
  },
  async ({ path: p, only_blocking }) => {
    const { repo, findings } = await scan(p);
    const blocking = findings.filter((f) => f.disposition === "gate");
    const shown = only_blocking ? blocking : findings;

    const payload = {
      summary: {
        files_scanned: repo.files.length,
        total_findings: findings.length,
        blocking: blocking.length,
        shipshape: blocking.length === 0,
      },
      findings: shown.map((f) => ({
        id: f.id,
        severity: f.severity,
        gate: f.disposition === "gate",
        file: f.file,
        line: f.line,
        message: f.message,
      })),
    };

    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },
);

// The hand-off tool. Shepherd is the maintainer: it never edits code. This tool
// scans the repo and returns a precise fix WORK-ORDER (the prompt) for THIS
// Claude Code session to execute itself, then it should re-run `scan` to verify.
server.tool(
  "fix_order",
  "Get Shepherd's fix work-order for a repo: scans for blocking (gate) production-readiness issues and returns precise, file-by-file instructions for YOU (this Claude Code session) to apply. Shepherd does not edit code — it hands you the order. After applying, call `scan` with only_blocking=true to verify the gates are closed. Also writes the order to .shepherd/fix-order.md.",
  {
    path: z.string().default(".").describe("Path to the repo (default: current directory)."),
  },
  async ({ path: p }) => {
    const { repo, findings } = await scan(p);
    const gates = findings.filter((f) => f.disposition === "gate");
    if (gates.length === 0) {
      return { content: [{ type: "text", text: "✅ No blocking issues — nothing to fix." }] };
    }
    const ts = new Date().toISOString();
    const order = buildFixOrder(gates, ts);
    try {
      writeFixOrder(repo.root, order);
    } catch {
      /* still return the order even if the file write fails */
    }
    return { content: [{ type: "text", text: order }] };
  },
);

// ── Multi-session board ──────────────────────────────────────────────────────
// Several Claude sessions, each running its own copy of this server, coordinate
// through an append-only log on disk. A session publishes what it found, reads
// what everyone else found, and can ask another session to dig further.

let me: { id: string; label: string } | null = null;
const root = () => board.boardRoot(process.cwd());

function requireJoin(): { id: string; label: string } {
  if (!me) throw new Error("Call `join` first so the other sessions know who you are.");
  return me;
}

server.tool(
  "join",
  "Register THIS Claude session on the shared board so other sessions can see it and address requests to it. Call this once at the start. Pick a short label describing what this session is for, e.g. 'research', 'frontend', 'reviewer'.",
  {
    label: z.string().describe("Short name for this session, e.g. 'research' or 'frontend'. Other sessions address you by this."),
  },
  async ({ label }) => {
    // Rejoining under a label you already used RESUMES that identity. A one-shot
    // client (claude -p) is a new process every turn; minting a fresh id each
    // time would orphan any request already addressed to the earlier one, so
    // `inbox` would come back empty for work that is genuinely waiting.
    const prior = board.read(root()).sessions.find(
      (x) => x.label.toLowerCase() === label.toLowerCase(),
    );
    const id = prior?.id ?? board.newId();
    me = { id, label };
    if (!prior) {
      board.append(root(), { kind: "join", at: board.now(), session: id, label });
    }
    const st = board.read(root());
    const others = st.sessions.filter((s) => s.id !== id).map((s) => s.label);
    return {
      content: [{
        type: "text",
        text: `${prior ? "Resumed" : "Joined"} as "${label}" (${id.slice(0, 8)}).\n` +
          (others.length ? `Other sessions on the board: ${others.join(", ")}` : "You are the first session here.") +
          `\n\nHuman-readable view: ${board.mirrorPath(root())}`,
      }],
    };
  },
);

server.tool(
  "share",
  "Publish a finding, result or piece of research to the shared board so every other Claude session can read it. Use this whenever you learn something the other sessions would need to know.",
  {
    title: z.string().describe("One line describing what this is."),
    content: z.string().describe("The finding itself. Be specific — another session will act on this without seeing your conversation."),
    tags: z.array(z.string()).default([]).describe("Optional tags, e.g. ['api', 'auth']."),
  },
  async ({ title, content, tags }) => {
    const m = requireJoin();
    const id = board.newId();
    board.append(root(), { kind: "share", at: board.now(), id, session: m.id, title, content, tags });
    return { content: [{ type: "text", text: `Shared "${title}" as ${id.slice(0, 8)}. Every session can now read it via \`board\`.` }] };
  },
);

server.tool(
  "board",
  "Read the shared board: which sessions are active, everything they have shared, and any open requests. Call this to see what the other Claude sessions have found before doing work yourself — they may already have the answer.",
  {
    tag: z.string().optional().describe("Only return findings carrying this tag."),
  },
  async ({ tag }) => {
    const st = board.read(root());
    const shares = tag ? st.shares.filter((s) => s.tags.includes(tag)) : st.shares;
    const open = st.asks.filter((a) => !a.answer);
    const payload = {
      sessions: st.sessions.map((s) => ({ label: s.label, id: s.id.slice(0, 8), you: s.id === me?.id })),
      shared: shares.map((s) => ({ id: s.id.slice(0, 8), by: s.label, title: s.title, tags: s.tags, content: s.content, at: s.at })),
      open_requests: open.map((a) => ({ id: a.id.slice(0, 8), from: a.fromLabel, to: st.sessions.find((x) => x.id === a.to)?.label, request: a.request })),
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  "ask",
  "Ask ANOTHER Claude session to do more work and hand the result back to you. The other session gets woken up with your request. Use when a different session owns that context — e.g. the 'research' session should dig deeper on something it already looked at.",
  {
    to: z.string().describe("Label of the session to ask, e.g. 'research'. Use `board` to see who is available."),
    request: z.string().describe("What you want them to do. Be explicit — they cannot see your conversation."),
  },
  async ({ to, request }) => {
    const m = requireJoin();
    const st = board.read(root());
    const target = board.resolve(st, to);
    if (!target) {
      return { content: [{ type: "text", text: `No session called "${to}". On the board: ${st.sessions.map((s) => s.label).join(", ") || "(none)"}` }] };
    }
    if (target.id === m.id) {
      return { content: [{ type: "text", text: "That is this session. Pick a different one." }] };
    }
    const id = board.newId();
    board.append(root(), { kind: "ask", at: board.now(), id, from: m.id, to: target.id, request });
    return { content: [{ type: "text", text: `Asked "${target.label}": ${request}\nRequest ${id.slice(0, 8)}. They will be notified; their answer appears in \`board\` and \`inbox\`.` }] };
  },
);

server.tool(
  "inbox",
  "Show requests other Claude sessions have addressed to THIS session and that you have not answered yet. Check this when you are notified, or before going idle.",
  {},
  async () => {
    const m = requireJoin();
    const st = board.read(root());
    const mine = st.asks.filter((a) => a.to === m.id && !a.answer);
    if (!mine.length) return { content: [{ type: "text", text: "Nothing waiting for you." }] };
    return {
      content: [{
        type: "text",
        text: JSON.stringify(mine.map((a) => ({ id: a.id.slice(0, 8), from: a.fromLabel, request: a.request, at: a.at })), null, 2),
      }],
    };
  },
);

server.tool(
  "answer",
  "Hand a result back to the session that asked you for it. Answer the request id from `inbox`.",
  {
    request_id: z.string().describe("The request id from `inbox` (the short 8-character form is fine)."),
    content: z.string().describe("The result. Write it so the asking session can act on it without seeing your conversation."),
  },
  async ({ request_id, content }) => {
    const m = requireJoin();
    const st = board.read(root());
    const a = st.asks.find((x) => x.id === request_id || x.id.startsWith(request_id));
    if (!a) return { content: [{ type: "text", text: `No request matching "${request_id}". Check \`inbox\`.` }] };
    board.append(root(), { kind: "answer", at: board.now(), id: board.newId(), ask: a.id, from: m.id, content });
    return { content: [{ type: "text", text: `Answered ${a.id.slice(0, 8)} back to ${a.fromLabel}.` }] };
  },
);

server.tool(
  "said",
  "Read what the HUMAN has typed across ALL sessions, including sessions you are not part of. Captured by a UserPromptSubmit hook, so it is their actual words rather than another session's summary. Use this to work out what they want, what they have decided, and what they have changed their mind about.",
  {
    limit: z.number().default(40).describe("How many of the most recent messages to return."),
    from: z.string().optional().describe("Only messages typed into this session label."),
  },
  async ({ limit, from }) => {
    const st = board.read(root());
    let said = st.said;
    if (from) said = said.filter((m) => m.label.toLowerCase() === from.toLowerCase());
    if (!said.length) {
      return { content: [{ type: "text", text: "Nothing captured. The UserPromptSubmit hook is probably not installed — see README." }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(said.slice(-limit), null, 2) }],
    };
  },
);

server.tool(
  "spawn",
  "Launch ANOTHER Claude session, joined to this same board, in its own terminal window. Use when a job needs a second pair of hands the user can also talk to — a 'research' session to dig while you keep working, or a second 'main'. The new session shares this board, so whatever it finds is visible here and the user's messages to it are visible to you.",
  {
    label: z.string().describe("Label for the new session, e.g. 'research' or 'reviewer'. Must not already be taken."),
    task: z.string().optional().describe("What the new session should start on. It is told this as its first instruction."),
  },
  async ({ label, task }) => {
    const st = board.read(root());
    if (board.resolve(st, label)) {
      return { content: [{ type: "text", text: `A session called "${label}" is already on this board. Pick another label or use \`ask\` to give it work.` }] };
    }
    const dir = process.cwd();
    const boardDir = root();
    const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
    const prompt =
      `Join the shepherd board as '${label}'.` +
      (task ? ` Your task: ${task}` : "") +
      ` Share what you find with \`share\` so the other sessions can see it, and check \`inbox\` for requests.`;
    const cmd =
      `cd ${q(dir)} && export SHEPHERD_SESSION_LABEL=${q(label)} && ` +
      `export SHEPHERD_BOARD=${q(boardDir)} && claude ${q(prompt)}`;

    if (process.platform !== "darwin") {
      return { content: [{ type: "text", text: `Cannot open a window on this platform. Run this yourself:\n\n  ${cmd}` }] };
    }
    const script = `tell application "Terminal"\n activate\n do script ${JSON.stringify(cmd)}\nend tell`;
    const r = spawnSync("osascript", ["-e", script], { stdio: "ignore" });
    if (r.status !== 0) {
      return { content: [{ type: "text", text: `Could not open a terminal. Run this yourself:\n\n  ${cmd}` }] };
    }
    return {
      content: [{
        type: "text",
        text: `Opened a new terminal running session "${label}"${task ? `, started on: ${task}` : ""}.\n` +
          `It shares this board, so use \`board\` to see what it finds and \`ask\` to send it work.`,
      }],
    };
  },
);

// ── Channels push: watch .shepherd/fix-order.md and push when it changes ──────
function startChannelWatch(): void {
  const projectDir = process.cwd();
  const shepherdDir = path.join(projectDir, ".shepherd");
  const orderPath = path.join(shepherdDir, "fix-order.md");
  let lastMtime = 0;
  const dbg = (m: string) => {
    if (process.env.SHEPHERD_DEBUG) console.error(`[shepherd-channel] ${m}`);
  };
  dbg(`watching ${orderPath}`);

  const push = () => {
    try {
      if (!existsSync(orderPath)) return dbg("push: no order file");
      const mtime = statSync(orderPath).mtimeMs;
      if (mtime === lastMtime) return dbg("push: unchanged mtime"); // dedupe repeated fs events
      lastMtime = mtime;
      dbg("push: sending channel notification");
      // fire-and-forget; if the session isn't listening it drops silently.
      void server.server.notification({
        method: "notifications/claude/channel",
        params: {
          content:
            "Shepherd produced a new fix work-order. Read `.shepherd/fix-order.md` and apply the " +
            "listed fixes as minimal diffs, then call the `scan` tool with only_blocking=true to verify.",
          meta: { source: "shepherd", order: ".shepherd/fix-order.md" },
        },
      });
    } catch {
      /* channels are best-effort / research preview */
    }
  };

  let timer: NodeJS.Timeout | null = null;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(push, 500);
  };

  const arm = () => {
    if (!existsSync(shepherdDir)) {
      dbg(".shepherd missing — retry in 5s");
      setTimeout(arm, 5000); // wait for the folder to appear, then watch
      return;
    }
    try {
      watch(shepherdDir, (_event, filename) => {
        dbg(`fs event: ${filename}`);
        if (filename === "fix-order.md") debounced();
      });
      dbg("armed watch on .shepherd");
      push(); // push once if an order already exists at startup
    } catch (e) {
      dbg(`watch failed: ${String(e)}`);
    }
  };
  arm();
}

const transport = new StdioServerTransport();
await server.connect(transport);
startChannelWatch();
