#!/usr/bin/env node
// `shepherd setup` — wire Shepherd into Claude Code.
//
//   npx claude-shepherd setup
//   npx claude-shepherd setup --uninstall
//
// Also published as @arkit-k/shepherd; `npm i -g` either one gives you the plain
// `shepherd` and `shepherd-connect` commands.
//
// Two things have to be true before the multi-session board works, and both of
// them used to be a paragraph of README asking people to hand-edit JSON with an
// absolute path to their own clone. Nobody does that, so nobody ran it.
//
//   1. the UserPromptSubmit hook is registered in ~/.claude/settings.json
//   2. the MCP server is registered with Claude Code
//
// This is deliberately careful with settings.json: people have their own hooks in
// there, and a tool that eats them is worse than one that never installed. It
// backs the file up, merges rather than replaces, and is idempotent.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const tick = green("✔");

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");

/** Where this package actually landed — node_modules, a global prefix, a clone. */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_JS = path.join(PKG_ROOT, "dist", "hook.js");
const MCP_JS = path.join(PKG_ROOT, "dist", "mcp.js");

// `|| true` so a failure here can never block someone's prompt. 2>/dev/null keeps
// a stray stack trace out of their terminal.
const HOOK_CMD = `node ${HOOK_JS} 2>/dev/null || true`;

type HookEntry = { type: string; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookEntry[] };

const isOurs = (c: string) => c.includes("shepherd") && c.includes("hook.js");

function readSettings(): Record<string, any> {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch (e) {
    // Do NOT overwrite a file we failed to parse — that is someone's config.
    console.error(red(`\n  ${SETTINGS} is not valid JSON, so I will not touch it.`));
    console.error(`  ${String((e as Error).message)}`);
    console.error(`  Fix the file and run setup again.\n`);
    process.exit(1);
  }
}

function backup(): string | null {
  if (!existsSync(SETTINGS)) return null;
  const to = `${SETTINGS}.bak-${Date.now()}`;
  copyFileSync(SETTINGS, to);
  return to;
}

function installHook(): "added" | "updated" | "unchanged" {
  const s = readSettings();
  s.hooks ??= {};
  const groups: HookGroup[] = (s.hooks.UserPromptSubmit ??= []);

  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (!isOurs(h.command)) continue;
      if (h.command === HOOK_CMD) return "unchanged";
      h.command = HOOK_CMD; // a clone that moved, or an npm install replacing it
      h.timeout ??= 10;
      writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
      return "updated";
    }
  }

  groups.push({ hooks: [{ type: "command", command: HOOK_CMD, timeout: 10 }] });
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
  return "added";
}

function removeHook(): boolean {
  const s = readSettings();
  const groups: HookGroup[] | undefined = s?.hooks?.UserPromptSubmit;
  if (!groups) return false;
  let removed = false;
  for (const g of groups) {
    const before = g.hooks?.length ?? 0;
    g.hooks = (g.hooks ?? []).filter((h) => !isOurs(h.command));
    if (g.hooks.length !== before) removed = true;
  }
  s.hooks.UserPromptSubmit = groups.filter((g) => g.hooks.length); // drop empties
  if (!s.hooks.UserPromptSubmit.length) delete s.hooks.UserPromptSubmit;
  if (removed) writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
  return removed;
}

const haveClaude = () => spawnSync("which", ["claude"], { stdio: "ignore" }).status === 0;

function installMcp(): "added" | "exists" | "no-cli" | "failed" {
  if (!haveClaude()) return "no-cli";
  const listed = spawnSync("claude", ["mcp", "list"], { encoding: "utf8", timeout: 30000 });
  if (listed.stdout?.includes("shepherd:")) return "exists";
  const r = spawnSync("claude", ["mcp", "add", "-s", "user", "shepherd", "--", "node", MCP_JS], {
    encoding: "utf8",
    timeout: 30000,
  });
  return r.status === 0 ? "added" : "failed";
}

function uninstall() {
  const b = backup();
  const removed = removeHook();
  console.log(`\n  ${removed ? tick : "–"} hook ${removed ? "removed from" : "not found in"} ${dim(SETTINGS)}`);
  if (b) console.log(`  ${dim(`backup: ${b}`)}`);
  if (haveClaude()) {
    const r = spawnSync("claude", ["mcp", "remove", "-s", "user", "shepherd"], { encoding: "utf8" });
    console.log(`  ${r.status === 0 ? tick : "–"} MCP server ${r.status === 0 ? "removed" : "not registered"}`);
  }
  console.log(`\n  Boards in ${dim("~/.shepherd")} were left alone. Delete that folder to remove them too.\n`);
}

function install() {
  if (!existsSync(HOOK_JS)) {
    console.error(red(`\n  dist/ is missing — this package was not built.`));
    console.error(`  From a clone: ${bold("npm install && npm run build")}\n`);
    process.exit(1);
  }

  const b = backup();
  const hook = installHook();
  const mcp = installMcp();

  console.log(`\n  ${bold("Shepherd")} ${dim(`· ${PKG_ROOT}`)}\n`);
  console.log(
    `  ${hook === "unchanged" ? "–" : tick} hook ${hook} ${dim(`· ${SETTINGS}`)}`,
  );
  if (b) console.log(`    ${dim(`backup: ${b}`)}`);

  if (mcp === "added") console.log(`  ${tick} MCP server registered`);
  else if (mcp === "exists") console.log(`  – MCP server already registered`);
  else if (mcp === "no-cli") {
    console.log(`  ${red("✗")} the \`claude\` CLI is not on your PATH, so I could not register the MCP server.`);
    console.log(`    Run this once it is:\n    ${bold(`claude mcp add -s user shepherd -- node ${MCP_JS}`)}`);
  } else {
    console.log(`  ${red("✗")} registering the MCP server failed. Try it by hand:`);
    console.log(`    ${bold(`claude mcp add -s user shepherd -- node ${MCP_JS}`)}`);
  }

  console.log(`
  ${bold("Restart any Claude sessions you already have open")} — they read hooks at
  startup, so a running session will not pick this up.

  Then, with a few sessions running:

    ${bold("shepherd-connect")}      tick the ones that should share a board

  Each ticked session sees what you type in the others.
  ${dim("Undo all of this with `shepherd setup --uninstall`.")}
`);
}

function help() {
  console.log(`
shepherd setup

  shepherd setup              wire Shepherd into Claude Code
  shepherd setup --uninstall  remove only what setup added

Writes the UserPromptSubmit hook into ~/.claude/settings.json (merging, with a
backup) and registers the MCP server. Safe to run twice.
`);
}

const args = process.argv.slice(2).filter((a) => a !== "setup");
const flags = args.filter((a) => a.startsWith("-"));
const known = new Set(["--uninstall", "--remove", "--help", "-h"]);
const unknown = flags.filter((f) => !known.has(f));

// An unrecognised flag must NOT fall through to install(). Touching someone's
// settings.json because they typed a flag we do not understand is not a
// defensible default.
if (unknown.length) {
  console.error(`\n  Unknown option: ${unknown.join(", ")}`);
  help();
  process.exit(1);
} else if (flags.includes("--help") || flags.includes("-h")) {
  help();
} else if (flags.includes("--uninstall") || flags.includes("--remove")) {
  uninstall();
} else {
  install();
}
