#!/usr/bin/env node
// UserPromptSubmit hook.
//
// Claude Code runs this on every message the human types, in every session that
// has it configured, and pipes the event in as JSON on stdin. It appends what was
// typed to the shared board, so sessions the human is NOT talking to can still
// see what they said.
//
// That is the whole point. Agent-team style orchestration shares tasks between
// agents; teammates never see the lead's conversation. Here the human's own words
// are the shared context, which is what makes a session that tracks what the user
// actually wants possible at all.
//
// It is also what makes `shepherd connect` work. Because this is installed
// globally, it is already firing in every session on the machine — connecting a
// running session changes where it writes, rather than injecting anything into a
// process we cannot reach.
//
// It must never block the user's turn: any failure exits 0 silently.
import * as board from "./engine/board.js";
import { connectionFor } from "./engine/boards.js";
import { nameOf } from "./engine/sessions.js";
import path from "node:path";

/** The session's name on the board, most specific source first. */
function resolveLabel(sessionId: string | undefined, cwd: string): string {
  // Chosen when the session was connected — the user's own words for it.
  const conn = connectionFor(sessionId);
  if (conn?.label) return conn.label;

  // Set by `shepherd-session` or `spawn` at launch.
  const env = process.env.SHEPHERD_SESSION_LABEL?.trim();
  if (env) return env;

  // Claude Code's own friendly name for the session ("arkitk-50"). Better than
  // the directory, because two sessions in one folder get distinct names.
  try {
    const n = sessionId ? nameOf(sessionId) : undefined;
    if (n) return n;
  } catch {
    /* registry unreadable — fall through */
  }

  return path.basename(cwd) || "unknown";
}

/**
 * Put the session on the board if it is not already there.
 *
 * A connected session never calls `join` — nobody typed a tool call, that is the
 * point of connecting. Without this it would show up as disembodied messages:
 * visible in `said`, but absent from `board` and impossible to `ask`. Shape must
 * match what mcp.ts `join` writes, including the label@folder qualification, or
 * the two paths would disagree about who is who.
 */
function registerIfNeeded(root: string, label: string, cwd: string): void {
  const state = board.read(root);
  const mine = state.sessions.find(
    (s) => s.label.toLowerCase() === label.toLowerCase() && (s.cwd ?? cwd) === cwd,
  );
  if (mine) return;

  const clash = state.sessions.find((s) => s.label.toLowerCase() === label.toLowerCase());
  const effective = clash ? `${label}@${path.basename(cwd)}` : label;

  board.append(root, {
    kind: "join",
    at: board.now(),
    session: board.newId(),
    label: effective,
    cwd,
  });
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let prompt = "";
  let cwd = process.cwd();
  let sessionId: string | undefined;
  try {
    const e = JSON.parse(raw || "{}");
    // `prompt` is the live field; the others are documented or cross-tool aliases.
    prompt = e.prompt ?? e.user_prompt ?? e.message ?? "";
    cwd = e.cwd ?? cwd;
    sessionId = e.session_id ?? e.conversation_id;
  } catch {
    prompt = raw.trim(); // not JSON — treat the whole payload as the message
  }
  if (!prompt.trim()) return;

  const root = board.boardRoot(cwd, sessionId);
  const label = resolveLabel(sessionId, cwd);

  registerIfNeeded(root, label, cwd);
  board.append(root, { kind: "user", at: board.now(), label, text: prompt });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
