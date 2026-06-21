import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { initProject } from "./engine/project.js";

// `shepherd init` — install the `.shepherd/` tracking folder into the project
// and register Shepherd's MCP server with Claude Code so Claude can drive it.
export function registerMcp(root = "."): void {
  const project = initProject(root);
  console.log(`✅ Installed ${path.relative(root, project.dir) || ".shepherd"}/ — Shepherd will track this project here.`);
  console.log("   (config.json, SHEPHERD.md tracked in git; history + reports gitignored.)\n");

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
    console.log('   • Pull:  in Claude Code, ask "get the shepherd fix order and apply it".');
    console.log("   • Push (zero-touch, research preview): start your session with");
    console.log("       claude --dangerously-load-development-channels server:shepherd");
    console.log("     Then any `npx shepherd` run pushes the fix work-order straight into");
    console.log("     that session — it wakes up and applies it. No typing.");
  } catch {
    console.log("⚠️  Auto-registration failed. Add it manually:");
    console.log("   " + addCmd);
  }
}
