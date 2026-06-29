#!/usr/bin/env node
import { printBanner } from "./banner.js";
import { interactive } from "./interactive.js";
import { runAgent } from "./agent.js";

// Shepherd is an AGENT, not a set of programs. There are no subcommands to learn.
//
//   npx shepherd            → start Shepherd and talk to it (architecture review,
//                             code/function review, full audit, fixes — just ask).
//   npx shepherd ./some/dir → same, pointed at another repo.
//
// In a non-interactive context (CI, a pipe, no TTY) there's no one to talk to, so
// Shepherd falls back to doing the whole job autonomously once — survey, audit,
// stress-test, hand off — and exits non-zero if it's not production-ready.
async function main(): Promise<void> {
  const path = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : ".";
  const interactiveTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  await printBanner();

  if (interactiveTTY) {
    process.exitCode = await interactive(path);
  } else {
    process.exitCode = await runAgent(path);
  }
}

main().catch((err: unknown) => {
  // never dump a raw stack at the user — a clean message + non-zero exit.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nshepherd: ${msg}`);
  console.error("If this looks like a bug, please open an issue at https://github.com/Arkit-k/shepherd/issues\n");
  process.exit(1);
});
