#!/usr/bin/env node
// `shepherd session <label> [dir]` — launch a Claude session already wired to the
// board.
//
// Until now a session had to be started by hand with SHEPHERD_SESSION_LABEL set
// and the right working directory, which meant something outside Shepherd had to
// do the wiring. This does it: picks the board, sets the label, opens a terminal.
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const [, , label, dirArg] = process.argv;

if (!label || label === "--help" || label === "-h") {
  console.log(`
shepherd session <label> [dir]

  Opens a Claude session joined to a shared board.

    shepherd session main
    shepherd session research ~/Projects/foo
    SHEPHERD_BOARD=~/boards/x shepherd session reviewer

  <label>  how other sessions address this one ("main", "research", "intent")
  [dir]    working directory; defaults to the current one

  The board is SHEPHERD_BOARD if set, otherwise the working directory. Sessions
  sharing a board can see each other — that is how two sessions in DIFFERENT
  project folders are connected.
`);
  process.exit(label ? 0 : 1);
}

const dir = path.resolve(dirArg ?? process.cwd());
const boardDir = path.resolve(process.env.SHEPHERD_BOARD ?? dir);
if (!existsSync(dir)) {
  console.error(`No such directory: ${dir}`);
  process.exit(1);
}
mkdirSync(path.join(boardDir, ".shepherd"), { recursive: true });

const prompt =
  `Join the shepherd board as '${label}'. Then tell me who else is on the board ` +
  `and wait. You can read what I type into OTHER sessions with the \`said\` tool — ` +
  `those messages never appear in your own transcript.`;

// Everything the child needs, as shell-quoted exports: the label attributes this
// session's prompts, and SHEPHERD_BOARD keeps sessions in different project
// folders pointed at one board.
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const cmd =
  `cd ${q(dir)} && ` +
  `export SHEPHERD_SESSION_LABEL=${q(label)} && ` +
  `export SHEPHERD_BOARD=${q(boardDir)} && ` +
  `claude ${q(prompt)}`;

const isMac = process.platform === "darwin";
const hasOsascript = isMac && spawnSync("which", ["osascript"]).status === 0;

if (hasOsascript) {
  const script = `tell application "Terminal"\n activate\n do script ${JSON.stringify(cmd)}\nend tell`;
  const r = spawnSync("osascript", ["-e", script], { stdio: "ignore" });
  if (r.status === 0) {
    console.log(`Opened a Terminal window: session "${label}"`);
    console.log(`  dir   ${dir}`);
    console.log(`  board ${boardDir}`);
    process.exit(0);
  }
}

// No windowing available — run it here instead of failing.
console.log(`Starting session "${label}" (board: ${boardDir})`);
const child = spawn("sh", ["-c", cmd], { stdio: "inherit" });
child.on("exit", (c) => process.exit(c ?? 0));
