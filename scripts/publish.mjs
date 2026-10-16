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
// Unscoped first: it needs no org, so it is the one that will certainly work.
// The scoped name 403s until a free npm org named "arkit" exists.
const ALIASES = ["claude-shepherd", "@arkit/shepherd"];
const original = readFileSync(PKG, "utf8");
const dry = process.argv.includes("--dry-run");

const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit" }).status === 0;

if (!run("npm", ["run", "build"]) || !run("npm", ["test"])) {
  console.error("\nbuild or tests failed — nothing published.\n");
  process.exit(1);
}

const done = [];
const failed = [];
try {
  for (const name of ALIASES) {
    const pkg = JSON.parse(original);
    pkg.name = name;
    writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");

    console.log(`\n── publishing ${name} ${dry ? "(dry run)" : ""}`);
    // --ignore-scripts: prepublishOnly would re-run build+test for each name.
    const args = ["publish", "--access", "public", "--ignore-scripts"];
    if (dry) args.push("--dry-run");
    // Carry on rather than aborting. One name failing (usually a missing org)
    // is no reason to withhold the one that works.
    if (run("npm", args)) done.push(name);
    else failed.push(name);
  }
} finally {
  writeFileSync(PKG, original); // always leave the repo name as @arkit/shepherd
}

if (done.length) console.log(`\n✔ published: ${done.join(", ")}`);
if (failed.length) {
  console.log(`\n✗ not published: ${failed.join(", ")}`);
  if (failed.some((n) => n.startsWith("@")))
    console.log(`  A scoped name needs an npm org you own. Create one free at`);
    console.log(`  https://www.npmjs.com/org/create , then re-run — the version does`);
    console.log(`  NOT need bumping for a name that never published.`);
}
if (done.includes("claude-shepherd")) console.log(`\n  npx claude-shepherd setup`);
console.log("");
process.exit(done.length ? 0 : 1);
