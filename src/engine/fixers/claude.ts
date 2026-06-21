import { execSync } from "node:child_process";

// Is Claude Code installed and on PATH? Used to decide whether the Tier-2
// (Claude-powered) reviews can run. NOTE: Shepherd never spawns Claude to EDIT
// code — it is the maintainer and hands a fix work-order to the user's own
// running Claude Code session (see engine/handoff.ts).
export function claudeAvailable(): boolean {
  try {
    execSync(process.platform === "win32" ? "where claude" : "command -v claude", {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
