// Where boards live, and which session is connected to which.
//
// A board is a NAME, not a path — ~/.shepherd/boards/<name>. Sessions join each
// other by naming the same board, so nobody has to type or agree on a filesystem
// path, and the directory you are working in stays independent of the board you
// are on.
//
// The connect map is keyed by SESSION ID rather than working directory. That is
// what lets two sessions in the same folder sit on different boards, and stops a
// session changing board just because it cd'd.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const SHEPHERD_HOME = path.join(os.homedir(), ".shepherd");
export const BOARDS = path.join(SHEPHERD_HOME, "boards");
export const CONNECT_FILE = path.join(SHEPHERD_HOME, "connect.json");
export const DEFAULT_BOARD = "default";

export type Connection = {
  board: string;
  label: string;
  cwd: string;
  at: string;
};
export type ConnectMap = Record<string, Connection>; // sessionId -> connection

export function boardPath(name: string): string {
  return path.join(BOARDS, name);
}

export function ensureBoard(name: string): string {
  const p = boardPath(name);
  mkdirSync(path.join(p, ".shepherd"), { recursive: true });
  return p;
}

export function readConnections(): ConnectMap {
  try {
    return JSON.parse(readFileSync(CONNECT_FILE, "utf8"));
  } catch {
    return {}; // missing or malformed — an unconnected machine is the normal case
  }
}

export function writeConnections(map: ConnectMap): void {
  if (!existsSync(SHEPHERD_HOME)) mkdirSync(SHEPHERD_HOME, { recursive: true });
  writeFileSync(CONNECT_FILE, JSON.stringify(map, null, 2) + "\n");
}

/** The connection for a session, if it has been connected. */
export function connectionFor(sessionId?: string): Connection | undefined {
  if (!sessionId) return undefined;
  return readConnections()[sessionId];
}
