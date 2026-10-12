#!/usr/bin/env node
// UserPromptSubmit hook.
//
// Claude Code runs this on every message the human types, in every session that
// has it configured, and pipes the event in as JSON on stdin. It appends what
// was typed to the shared board, so sessions the human is NOT talking to can
// still see what they said.
//
// That is the whole point. Agent-team style orchestration shares tasks between
// agents; teammates never see the lead's conversation. Here the human's own
// words are the shared context, which is what makes a session that tracks what
// the user actually wants possible at all.
//
// The session label comes from SHEPHERD_SESSION_LABEL, set when the terminal is
// launched. Without it the message is still captured, just attributed to the
// working directory.
//
// It must never block the user's turn: any failure exits 0 silently.
import * as board from "./engine/board.js";
import path from "node:path";

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let prompt = "";
  let cwd = process.cwd();
  try {
    const e = JSON.parse(raw || "{}");
    prompt = e.prompt ?? e.user_prompt ?? e.message ?? "";
    cwd = e.cwd ?? cwd;
  } catch {
    prompt = raw.trim(); // not JSON — treat the whole payload as the message
  }
  if (!prompt.trim()) return;

  const label =
    process.env.SHEPHERD_SESSION_LABEL?.trim() || path.basename(cwd) || "unknown";

  board.append(board.boardRoot(cwd), {
    kind: "user",
    at: board.now(),
    label,
    text: prompt,
  });
}

main().catch(() => {}).finally(() => process.exit(0));
