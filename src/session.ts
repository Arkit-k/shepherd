#!/usr/bin/env node
// Launch a Claude session joined to a board.
//
//   shepherd-session                  join the default board, labelled after this folder
//   shepherd-session main             join the default board as "main"
//   shepherd-session main work        join the board called "work" as "main"
//   shepherd-session --list           show boards and who is on them
//
// Boards are NAMES, not paths. They live under ~/.shepherd/boards/<name>, so two
// sessions connect by naming the same board — no paths to type, no environment
// variables to export, and the directory you are working in stays independent of
// the board you are on. That separation is the point: you can have a session in
// each of three projects, all on one board.
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SESSION_TOOLS } from "./engine/session-tools.js";
import { BOARDS, boardPath, DEFAULT_BOARD, ensureBoard } from "./engine/boards.js";

const args = process.argv.slice(2);

if (args[0] === "--help" || args[0] === "-h") {
  console.log(`
shepherd-session [label] [board]

  shepherd-session                  default board, labelled after this folder
  shepherd-session main             default board, as "main"
  shepherd-session main work        board "work", as "main"
  shepherd-session --list           show boards and who is on them

Boards live in ~/.shepherd/boards/<name>. Sessions on the same board see each
other's findings and each other's prompts, whatever directory they are working in.
Two sessions using the same label in different folders are kept distinct
automatically (the second becomes "main@folder").
`);
  process.exit(0);
}

if (args[0] === "--list" || args[0] === "-l") {
  if (!existsSync(BOARDS)) {
    console.log("No boards yet. `shepherd-session main` creates one.");
    process.exit(0);
  }
  const names = readdirSync(BOARDS).filter((n) => !n.startsWith("."));
  if (!names.length) console.log("No boards yet.");
  for (const n of names) {
    const log = path.join(boardPath(n), ".shepherd", "board", "events.jsonl");
    let who: string[] = [];
    let msgs = 0;
    try {
      for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
        const e = JSON.parse(line);
        if (e.kind === "join") who.push(e.label);
        if (e.kind === "user") msgs++;
      }
    } catch {
      /* board exists but nothing in it yet */
    }
    console.log(`  ${n.padEnd(16)} ${who.length ? who.join(", ") : "(empty)"}${msgs ? `  · ${msgs} messages` : ""}`);
  }
  process.exit(0);
}

const label = args[0] ?? path.basename(process.cwd());
const boardName = args[1] ?? DEFAULT_BOARD;
const board = ensureBoard(boardName);
const dir = process.cwd();

const prompt =
  `Join the shepherd board as '${label}'. Then tell me who else is on the board and wait. ` +
  `Use the \`said\` tool to read what I type into OTHER sessions — those never appear in your transcript.`;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
// Pre-allow the board tools. Without this the session opens and then sits at a
// permission prompt before it can even join, which looks like a hang.
// The `--` below matters: --allowedTools is variadic and will otherwise eat the
// prompt, launching a session that was never told what it is for.
const BOARD_TOOLS = SESSION_TOOLS.join(",");

const cmd =
  `cd ${q(dir)} && export SHEPHERD_SESSION_LABEL=${q(label)} && ` +
  `export SHEPHERD_BOARD=${q(board)} && ` +
  `claude --allowedTools ${q(BOARD_TOOLS)} -- ${q(prompt)}`;

const canWindow =
  process.platform === "darwin" && spawnSync("which", ["osascript"]).status === 0;

if (canWindow) {
  // Via a file, not `osascript -e`: -e chokes on any non-ASCII in the command.
  const script = `tell application "Terminal"\n activate\n do script ${JSON.stringify(cmd)}\nend tell`;
  const f = path.join(os.tmpdir(), `shepherd-session-${Date.now()}.applescript`);
  writeFileSync(f, script, "utf8");
  const launched = spawnSync("osascript", [f], { stdio: "ignore" }).status === 0;
  try { unlinkSync(f); } catch { /* best effort */ }
  if (launched) {
    console.log(`session "${label}" on board "${boardName}"  ·  working in ${dir}`);
    process.exit(0);
  }
}

console.log(`session "${label}" on board "${boardName}"`);
const child = spawn("sh", ["-c", cmd], { stdio: "inherit" });
child.on("exit", (c) => process.exit(c ?? 0));
