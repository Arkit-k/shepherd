#!/usr/bin/env node
// `shepherd-connect` — tick the running Claude sessions you want on one board.
//
//   shepherd-connect            pick sessions, connect to the default board
//   shepherd-connect work       ... to the board called "work"
//   shepherd-connect --status   what is connected where
//   shepherd-connect --disconnect
//
// Nothing is injected into a running session — there is no way to do that. The
// UserPromptSubmit hook is already firing in every session on this machine; this
// only changes which board that hook writes to, by session id.
import { liveSessions, selfSessionId, type LiveSession } from "./engine/sessions.js";
import {
  DEFAULT_BOARD,
  ensureBoard,
  readConnections,
  writeConnections,
  type ConnectMap,
} from "./engine/boards.js";
import path from "node:path";
import os from "node:os";

const ESC = "\x1b";
const CTRL_C = "\x03";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const short = (p: string) => p.replace(os.homedir(), "~");
const labelFor = (s: LiveSession) => s.name || path.basename(s.cwd) || s.sessionId.slice(0, 8);

const args = process.argv.slice(2);

function help() {
  console.log(`
shepherd-connect [board]

  shepherd-connect            pick sessions, connect to "${DEFAULT_BOARD}"
  shepherd-connect work       ... to the board called "work"
  shepherd-connect --status   show what is connected where
  shepherd-connect --disconnect  pick sessions to remove from their board

Connected sessions share what you type and what they find. Connecting routes
FUTURE prompts — it does not move history onto the board.
`);
}

function status() {
  const map = readConnections();
  const live = new Map(liveSessions().map((s) => [s.sessionId, s]));
  const ids = Object.keys(map);
  if (!ids.length) return console.log("Nothing connected. Run `shepherd-connect`.");

  const byBoard = new Map<string, string[]>();
  const dead: string[] = [];
  for (const id of ids) {
    const c = map[id];
    const alive = live.has(id);
    if (!alive) dead.push(id);
    const line = `    ${c.label.padEnd(18)} ${dim(short(c.cwd))}${alive ? "" : yellow("  (session gone)")}`;
    byBoard.set(c.board, [...(byBoard.get(c.board) ?? []), line]);
  }
  for (const [b, rows] of byBoard) {
    console.log(`\n  ${bold(b)}`);
    rows.forEach((r) => console.log(r));
  }
  if (dead.length) {
    console.log(`\n  ${dead.length} entry(s) for sessions that have exited.`);
    console.log(`  ${dim("shepherd-connect --prune removes them.")}`);
  }
  console.log();
}

function prune() {
  const map = readConnections();
  const live = new Set(liveSessions().map((s) => s.sessionId));
  const next: ConnectMap = {};
  let removed = 0;
  for (const [id, c] of Object.entries(map)) {
    if (live.has(id)) next[id] = c;
    else removed++;
  }
  writeConnections(next);
  console.log(removed ? `Removed ${removed} dead entry(s).` : "Nothing to prune.");
}

/**
 * Arrow keys to move, space to toggle, `a` for all, enter to confirm.
 * Raw-mode readline rather than a dependency — this is the only interactive
 * surface in the project and it does not justify one.
 */
function pick(rows: { text: string; preselected: boolean }[]): Promise<number[] | null> {
  return new Promise((resolve) => {
    const chosen = rows.map((r) => r.preselected);
    let cur = 0;
    const stdin = process.stdin;
    const canRaw = stdin.isTTY && typeof stdin.setRawMode === "function";

    if (!canRaw) {
      // Piped or non-interactive: take everything rather than hanging on input.
      console.log(dim("(not a terminal — selecting all)"));
      return resolve(rows.map((_, i) => i));
    }

    const draw = (first = false) => {
      if (!first) process.stdout.write(`\x1b[${rows.length + 2}A`);
      process.stdout.write(
        dim("  ↑↓ move · space toggle · a all · enter confirm · esc cancel") + "\x1b[K\n\n",
      );
      rows.forEach((r, i) => {
        const box = chosen[i] ? green("◉") : "◯";
        const cursor = i === cur ? "❯" : " ";
        process.stdout.write(` ${cursor} ${box} ${r.text}\x1b[K\n`);
      });
    };

    const finish = (result: number[] | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(result);
    };

    const onData = (buf: Buffer) => {
      const k = buf.toString();
      if (k === CTRL_C || k === ESC) return finish(null); // ctrl-c / esc
      if (k === "\r" || k === "\n") {
        const sel = chosen.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
        return finish(sel);
      }
      if (k === " ") chosen[cur] = !chosen[cur];
      else if (k === "a" || k === "A") {
        const all = chosen.every(Boolean);
        chosen.fill(!all);
      } else if (k === ESC + "[A" || k === "k") cur = (cur - 1 + rows.length) % rows.length;
      else if (k === ESC + "[B" || k === "j") cur = (cur + 1) % rows.length;
      else return;
      draw();
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    draw(true);
  });
}

async function main() {
  if (args[0] === "--help" || args[0] === "-h") return help();
  if (args[0] === "--status" || args[0] === "-s") return status();
  if (args[0] === "--prune") return prune();

  const disconnecting = args[0] === "--disconnect";
  const boardName = (disconnecting ? args[1] : args[0]) ?? DEFAULT_BOARD;

  const map = readConnections();
  // Do NOT exclude this session. The common way to run this is `!shepherd-connect`
  // from inside a Claude session — leaving yourself out would tick everyone else
  // onto a board you are not on, which is never what was meant. It is listed
  // first, marked, and preselected.
  const self = selfSessionId();
  let sessions = liveSessions();
  sessions.sort((a, b) => Number(b.sessionId === self) - Number(a.sessionId === self));

  if (disconnecting) sessions = sessions.filter((s) => map[s.sessionId]);

  if (!sessions.length) {
    console.log(
      disconnecting
        ? "No connected sessions are running."
        : "No Claude sessions found. Is ~/.claude/sessions readable?",
    );
    return;
  }

  console.log(
    disconnecting
      ? `\n  Disconnect which sessions?\n`
      : `\n  Connect which sessions to board ${bold(boardName)}?\n`,
  );

  const rows = sessions.map((s) => {
    const c = map[s.sessionId];
    const on = c ? dim(`  · on "${c.board}"`) : "";
    const isSelf = s.sessionId === self;
    return {
      text: `${labelFor(s).padEnd(18)} ${dim(short(s.cwd))}${isSelf ? dim("  (this session)") : ""}${on}`,
      preselected: disconnecting ? true : isSelf || c?.board === boardName,
    };
  });

  const picked = await pick(rows);
  if (picked === null) return console.log("Cancelled.");
  if (!picked.length) return console.log("Nothing selected.");

  if (disconnecting) {
    for (const i of picked) delete map[sessions[i].sessionId];
    writeConnections(map);
    console.log(`\nDisconnected ${picked.length} session(s). Their prompts stop reaching the board.`);
    return;
  }

  ensureBoard(boardName);
  const moved: string[] = [];
  for (const i of picked) {
    const s = sessions[i];
    const was = map[s.sessionId]?.board;
    if (was && was !== boardName) moved.push(`${labelFor(s)} (was on "${was}")`);
    map[s.sessionId] = {
      board: boardName,
      label: map[s.sessionId]?.label ?? labelFor(s),
      cwd: s.cwd,
      at: new Date().toISOString(),
    };
  }
  writeConnections(map);

  console.log(`\n  Connected to ${bold(boardName)}:`);
  for (const i of picked) console.log(`    ${green("◉")} ${labelFor(sessions[i])}  ${dim(short(sessions[i].cwd))}`);
  if (moved.length) {
    console.log(`\n  ${yellow("Moved")}: ${moved.join(", ")}`);
    console.log(`  ${dim("Their history stays on the old board; they just stop writing there.")}`);
  }
  console.log(
    `\n  Takes effect on each session's NEXT message — that is when its hook fires.\n` +
      `  ${dim(`Board: ~/.shepherd/boards/${boardName}/.shepherd/board/board.md`)}\n`,
  );
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
