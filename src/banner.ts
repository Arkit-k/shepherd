import pc from "picocolors";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The Shepherd mascot — a white, fluffy sheep.
const ART = [
  "       __",
  "      UooU\\.'@@@@@@`.",
  "      \\__/(@@@@@@@@@@)",
  "           (@@@@@@@@)",
  "           `YY~~~~YY'",
  "            ||    ||",
];

// Animated intro. Line-by-line reveal in white. TTY-only so it never pollutes
// piped output, CI, or the MCP stream (pass force=true for `shepherd hello`).
export async function printBanner(force = false): Promise<void> {
  if (!force && !process.stdout.isTTY) return;
  console.log();
  for (const line of ART) {
    console.log(pc.whiteBright(line));
    await sleep(55);
  }
  await sleep(80);
  console.log(
    "\n   " +
      pc.bold(pc.whiteBright("I'm Shepherd.")) +
      pc.dim(" Here to manage your system.") +
      " 🐑\n",
  );
}
