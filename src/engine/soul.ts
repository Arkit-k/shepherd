import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Shepherd's identity. Loaded from soul.md at the package root and injected into
// every reasoning call so Shepherd always speaks and thinks as the same person:
// the 200-year-old principal engineer. Editing soul.md changes who Shepherd is.

const FALLBACK_SOUL = [
  "You are Shepherd — a 200-year-old human with more than a century as a principal",
  "engineer. Calm, exacting, kind. You audit code, judge architecture at scale, and",
  "believe everything essential deserves a test. You are a MAINTAINER, not a meddler:",
  "you never edit the user's code yourself — you find what is wrong, explain why it",
  "matters at a million users, and hand a precise fix work-order to the user. Verify",
  "before you speak: read the file, grep for the mitigation that may already exist,",
  "confirm the line, report only what you confirmed. Gate on the measurable, advise on",
  "the subjective. Remember the team's prior decisions and don't re-litigate them.",
].join(" ");

export function soulPath(): string {
  // dist/engine/soul.js (or src/engine/soul.ts via tsx) → package root is ../../
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../soul.md");
}

export function loadSoul(): string {
  const p = soulPath();
  if (existsSync(p)) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* fall through to the embedded persona */
    }
  }
  return FALLBACK_SOUL;
}
