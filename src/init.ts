import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

// `shepherd init` — register Shepherd's MCP server with Claude Code so Claude
// can drive it as a tool. Uses Claude Code's own `mcp add` so it lands in the
// right config; falls back to printing the manual command.
export function registerMcp(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mcpJs = path.join(here, "mcp.js"); // sibling of cli.js once built
  const addCmd = `claude mcp add shepherd -- node "${mcpJs}"`;

  if (!existsSync(mcpJs)) {
    console.log("⚠️  Built MCP server not found. Run `npm run build` first, then `shepherd init`.");
    console.log(`   (expected: ${mcpJs})`);
    return;
  }

  // is Claude Code on PATH?
  try {
    execSync(process.platform === "win32" ? "where claude" : "command -v claude", {
      stdio: "ignore",
    });
  } catch {
    console.log("⚠️  Claude Code CLI not found on PATH.");
    console.log("   Install Claude Code, then run `shepherd init` again — or add it manually:");
    console.log("   " + addCmd);
    return;
  }

  try {
    execSync(addCmd, { stdio: "inherit" });
    console.log("\n✅ Shepherd is wired into Claude Code.");
    console.log('   In Claude Code, ask: "scan and harden this repo with shepherd".');
  } catch {
    console.log("⚠️  Auto-registration failed. Add it manually:");
    console.log("   " + addCmd);
  }
}
