import { readTriage } from "./triage.js";

// RECALL — the bridge from memory into the agent reviewer's context. Before the
// reviewer judges a file, we assemble a short brief of prior decisions that touch
// it and inject it into the prompt. This is the Hermes idea applied to Shepherd:
// recall the relevant memory into context BEFORE acting, so the agent doesn't
// re-derive (and re-raise) something the team already settled.
//
// Suppression (triage.suppressDismissed) is the belt: it hard-drops dismissed
// findings post-hoc by key. The brief is the suspenders: it stops the agent
// wasting a turn re-investigating them, and — because the agent reads the REASON
// — it won't dodge the key match by rephrasing a known false-positive.

// Build the brief for one file (the reviewer works file-by-file). Returns null
// when there's nothing relevant, so callers can skip the prompt section cleanly.
export function memoryBrief(root: string, file: string): string | null {
  const store = readTriage(root);
  const relevant = Object.values(store).filter((e) => e.file === file);
  if (relevant.length === 0) return null;

  const lines = relevant.map((e) => {
    const what = e.scope === "file" ? `all "${e.id}" findings` : `the "${e.id}" finding`;
    return `- [${e.status}] ${what} here — reason: ${e.reason || "(none given)"}`;
  });

  return [
    `MEMORY — prior decisions the team made about THIS file. Respect them:`,
    ...lines,
    `Do NOT re-raise a dismissed item unless the code has MATERIALLY changed since;`,
    `if you believe a "false-positive" decision is now wrong, say so explicitly in`,
    `the message and explain what changed.`,
  ].join("\n");
}
