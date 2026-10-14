#!/usr/bin/env node
import { printBanner } from "./banner.js";
import { interactive } from "./interactive.js";
import { runAgent } from "./agent.js";
import { gitCheck, printGitCheck } from "./engine/gitcheck.js";

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
  const args = process.argv.slice(2);

  // Two things genuinely are commands rather than conversation, because they
  // change machine state outside any repo: wiring Shepherd into Claude Code, and
  // choosing which running sessions share a board. Everything else is "just ask".
  // The token is spliced out of argv so each module parses its own flags as if it
  // had been invoked directly.
  const sub = args[0];
  if (sub === "setup" || sub === "connect") {
    process.argv.splice(2, 1);
    await import(sub === "setup" ? "./setup.js" : "./connect.js");
    return;
  }

  const path = args[0] && !args[0].startsWith("-") ? args[0] : ".";

  // `--git-check` is internal plumbing for the pre-push hook (not a user-facing
  // subcommand): review only what's about to be pushed and exit non-zero on a
  // gate so git blocks the push. The autonomous gate, run automatically by git.
  if (args.includes("--git-check")) {
    const result = await gitCheck(path, { deep: false });
    process.exitCode = printGitCheck(result);
    return;
  }

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
