#!/usr/bin/env node
// Publish the same build under both names:
//
//   @arkit/shepherd    the brand, matches arkit.live
//   claude-shepherd    unscoped, so `npx claude-shepherd setup` works with no
//                      org and no install, and it is findable in npm search
//
// npm has no first-class aliasing, so this publishes twice, swapping the `name`
// field in between. package.json is restored in a finally block — a half-renamed
// package.json left behind by a failed publish is the one unacceptable outcome.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PKG = new URL("../package.json", import.meta.url);
const ALIASES = ["@arkit/shepherd", "claude-shepherd"];
const original = readFileSync(PKG, "utf8");
const dry = process.argv.includes("--dry-run");

const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit" }).status === 0;

if (!run("npm", ["run", "build"]) || !run("npm", ["test"])) {
  console.error("\nbuild or tests failed — nothing published.\n");
  process.exit(1);
}

const done = [];
try {
  for (const name of ALIASES) {
    const pkg = JSON.parse(original);
    pkg.name = name;
    writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");

    console.log(`\n── publishing ${name} ${dry ? "(dry run)" : ""}`);
    // --ignore-scripts: prepublishOnly would re-run build+test for each name.
    const args = ["publish", "--access", "public", "--ignore-scripts"];
    if (dry) args.push("--dry-run");
    if (!run("npm", args)) {
      console.error(`\n${name} failed.`);
      if (done.length) console.error(`Already published: ${done.join(", ")} — bump the version before retrying.`);
      process.exit(1);
    }
    done.push(name);
  }
} finally {
  writeFileSync(PKG, original); // always leave the repo name as @arkit/shepherd
}

console.log(`\n✔ published: ${done.join(", ")}`);
console.log(`\n  npx claude-shepherd setup`);
console.log(`  npm i -g @arkit/shepherd  →  shepherd setup, shepherd connect\n`);
