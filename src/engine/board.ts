// A shared board that lets several Claude sessions see each other's work and
// ask each other for more.
//
// Each session runs its OWN copy of the MCP server (stdio spawns one process per
// client), so there is no shared memory to coordinate through — the filesystem is
// the bus.
//
// The log is APPEND-ONLY, one JSON object per line. Several processes writing the
// same mutable JSON file would silently lose each other's updates; small appends
// with O_APPEND do not collide. State is derived by replaying the log, which also
// means the whole history is auditable, which is the point — the user should be
// able to see what every session did.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { boardPath, connectionFor } from "./boards.js";

export type Event =
  | { kind: "join"; at: string; session: string; label: string; cwd?: string }
  | { kind: "share"; at: string; id: string; session: string; title: string; content: string; tags: string[] }
  | { kind: "ask"; at: string; id: string; from: string; to: string; request: string }
  | { kind: "answer"; at: string; id: string; ask: string; from: string; content: string }
  // What the HUMAN typed, captured by a UserPromptSubmit hook rather than by a
  // model choosing to log it. This is the part no agent-orchestration layer has:
  // every session sees the user's actual words, not another session's summary.
  | { kind: "user"; at: string; label: string; text: string };

export type Session = { id: string; label: string; joinedAt: string; cwd?: string };
export type Share = { id: string; session: string; label: string; title: string; content: string; tags: string[]; at: string };
export type Ask = { id: string; from: string; fromLabel: string; to: string; request: string; at: string; answer?: { content: string; from: string; at: string } };

export type Said = { label: string; text: string; at: string };

export type BoardState = {
  sessions: Session[];
  shares: Share[];
  asks: Ask[];
  said: Said[];
};

function dir(root: string) {
  return path.join(root, ".shepherd", "board");
}
export function logPath(root: string) {
  return path.join(dir(root), "events.jsonl");
}
export function mirrorPath(root: string) {
  return path.join(dir(root), "board.md");
}

function ensure(root: string) {
  const d = dir(root);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  const l = logPath(root);
  if (!existsSync(l)) writeFileSync(l, "");
}

export function append(root: string, e: Event): void {
  ensure(root);
  appendFileSync(logPath(root), JSON.stringify(e) + "\n");
  writeMirror(root); // keep the human-readable view current
}

export function read(root: string): BoardState {
  ensure(root);
  const lines = readFileSync(logPath(root), "utf8").split("\n").filter(Boolean);
  const state: BoardState = { sessions: [], shares: [], asks: [], said: [] };
  const labelOf = new Map<string, string>();

  for (const line of lines) {
    let e: Event;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a torn write from a concurrent append — skip it, don't crash
    }
    if (e.kind === "join") {
      labelOf.set(e.session, e.label);
      if (!state.sessions.some((s) => s.id === e.session)) {
        state.sessions.push({ id: e.session, label: e.label, joinedAt: e.at, cwd: e.cwd });
      }
    } else if (e.kind === "share") {
      state.shares.push({
        id: e.id,
        session: e.session,
        label: labelOf.get(e.session) ?? e.session.slice(0, 8),
        title: e.title,
        content: e.content,
        tags: e.tags,
        at: e.at,
      });
    } else if (e.kind === "ask") {
      state.asks.push({
        id: e.id,
        from: e.from,
        fromLabel: labelOf.get(e.from) ?? e.from.slice(0, 8),
        to: e.to,
        request: e.request,
        at: e.at,
      });
    } else if (e.kind === "user") {
      state.said.push({ label: e.label, text: e.text, at: e.at });
    } else if (e.kind === "answer") {
      const a = state.asks.find((x) => x.id === e.ask);
      if (a) a.answer = { content: e.content, from: e.from, at: e.at };
    }
  }
  return state;
}

/** Resolve a label like "research" (or an id prefix) to a session id. */
export function resolve(state: BoardState, who: string): Session | undefined {
  const w = who.toLowerCase();
  return (
    state.sessions.find((s) => s.label.toLowerCase() === w) ??
    state.sessions.find((s) => s.id.startsWith(who)) ??
    state.sessions.find((s) => s.label.toLowerCase().includes(w))
  );
}

/**
 * A plain-markdown mirror of the board, rewritten on every append. This is the
 * part the human watches — open it in an editor and it updates as the sessions
 * work.
 */
export function writeMirror(root: string): void {
  const s = read(root);
  const open = s.asks.filter((a) => !a.answer);
  const lines: string[] = [
    "# Shepherd board",
    "",
    `_${new Date().toISOString()} — ${s.sessions.length} session(s), ${s.shares.length} shared, ${open.length} open request(s), ${s.said.length} user message(s)_`,
    "",
    "## Sessions",
    "",
  ];
  if (!s.sessions.length) lines.push("_none yet_", "");
  for (const x of s.sessions)
    lines.push(
      `- **${x.label}** \`${x.id.slice(0, 8)}\`${x.cwd ? ` — \`${x.cwd}\`` : ""} — joined ${x.joinedAt}`,
    );

  lines.push("", "## Open requests", "");
  if (!open.length) lines.push("_none_", "");
  for (const a of open) {
    const to = s.sessions.find((x) => x.id === a.to);
    lines.push(`- \`${a.id.slice(0, 8)}\` **${a.fromLabel} → ${to?.label ?? a.to.slice(0, 8)}**: ${a.request}`);
  }

  lines.push("", "## What the human said", "");
  if (!s.said.length) lines.push("_nothing captured yet — is the UserPromptSubmit hook installed?_", "");
  for (const u of s.said.slice(-25)) {
    lines.push(`- **[${u.label}]** ${u.text.replace(/\n+/g, " ").slice(0, 300)}`);
  }

  lines.push("", "## Shared findings", "");
  if (!s.shares.length) lines.push("_nothing shared yet_", "");
  for (const sh of [...s.shares].reverse()) {
    lines.push(`### ${sh.title}`, "", `_${sh.label} · ${sh.at}${sh.tags.length ? ` · ${sh.tags.join(", ")}` : ""}_`, "", sh.content, "");
  }

  const answered = s.asks.filter((a) => a.answer);
  if (answered.length) {
    lines.push("## Answered requests", "");
    for (const a of answered) {
      lines.push(`- **${a.fromLabel}** asked: ${a.request}`, `  - answered: ${a.answer!.content}`, "");
    }
  }

  writeFileSync(mirrorPath(root), lines.join("\n"));
}

/**
 * Which board does this session write to?
 *
 * This is the only place that decision is made, which is what lets `shepherd
 * connect` work at all: connecting a running session does not inject anything
 * into it — the hook is already firing there — it just changes the answer here.
 *
 * Order matters. An explicit SHEPHERD_BOARD beats everything because the
 * launcher and `spawn` set it deliberately; a connection beats the directory
 * walk because the user picked it; the walk is the fallback for a session nobody
 * has said anything about.
 */
export function boardRoot(from: string, sessionId?: string): string {
  if (process.env.SHEPHERD_BOARD) return path.resolve(process.env.SHEPHERD_BOARD);

  const conn = connectionFor(sessionId);
  if (conn) return boardPath(conn.board);

  // Walk up for a project that already has a board. Stop at the home directory:
  // ~/.shepherd is Shepherd's own home (boards, connect.json), not a project
  // board, and matching it would quietly put every unconnected session on this
  // machine onto one shared board — which is the exact thing `connect` is meant
  // to be a deliberate choice about.
  const home = path.resolve(os.homedir());
  let d = path.resolve(from);
  for (let i = 0; i < 12; i++) {
    if (d === home) break;
    if (existsSync(path.join(d, ".shepherd"))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.resolve(from);
}

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
