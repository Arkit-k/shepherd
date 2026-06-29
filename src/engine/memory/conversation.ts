import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { claudeJsonArray } from "../claude-json.js";
import { appendTestLessons } from "./tests-log.js";

// CONVERSATION memory — the per-project `user.md`. Every exchange between the user
// and Shepherd is appended here. It is both user-facing (read what Shepherd
// remembers) and training material (distill what the team cares about). The
// `learnImportantTests` function reads it back to learn which tests matter here.

function userMdPath(root: string): string {
  return path.join(root, ".shepherd", "user.md");
}

function ensure(root: string): string {
  const p = userMdPath(root);
  if (!existsSync(p)) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(
      p,
      "# Shepherd — user memory\n\n" +
        "_Conversation log + what Shepherd has learned about this team. " +
        "`U:` is you, `S:` is Shepherd._\n\n## Conversation log\n\n",
    );
  }
  return p;
}

export function appendTurn(root: string, role: "user" | "shepherd", text: string): void {
  try {
    const p = ensure(root);
    const tag = role === "user" ? "U" : "S";
    appendFileSync(p, `${tag}: ${text.replace(/\n+/g, " ").trim()}\n\n`);
  } catch {
    /* memory is best-effort — never break the conversation over a write */
  }
}

export function readConversation(root: string): string {
  const p = userMdPath(root);
  if (!existsSync(p)) return "";
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// THE LEARNING FUNCTION. Reads the conversation log and distills which tests this
// team treats as important — then writes those lessons into BOTH user.md (what we
// learned about the user) and test.md (the "what matters here" section). This is
// Shepherd's closed loop: talk → remember → learn what to test → test it next time.
export function learnImportantTests(root: string): string[] {
  const convo = readConversation(root);
  if (convo.trim().length < 40) return []; // nothing to learn from yet

  const prompt = [
    `Below is a log of conversations between a user and Shepherd (a principal-engineer`,
    `code auditor). From it, infer which TESTS matter most to this team — the risks they`,
    `keep returning to, the files/flows they worry about, the kinds of tests they ask for`,
    `(unit, integration, contract, load, adversarial probe, regression).`,
    `Respond with ONLY a JSON array of short strings, each one a concrete, important test`,
    `area phrased as guidance, e.g. "Load-test the AI chat endpoint for rate-limit under`,
    `burst" or "Contract test the BFF proxy against the upstream schema". Max 8. Return []`,
    `if the log doesn't reveal clear testing priorities.`,
    ``,
    `--- conversation log ---`,
    convo.slice(-12000), // recent context is enough; keep the call cheap
  ].join("\n");

  const lessons = (claudeJsonArray<string>(prompt, root) ?? []).filter(
    (l): l is string => typeof l === "string" && l.trim().length > 0,
  );
  if (lessons.length === 0) return [];

  // write into test.md ("what matters here") …
  appendTestLessons(root, lessons);
  // … and into user.md ("learned about this team").
  try {
    const p = ensure(root);
    appendFileSync(
      p,
      `\n## Learned (${new Date().toISOString().slice(0, 10)}) — tests that matter here\n` +
        lessons.map((l) => `- ${l}`).join("\n") +
        "\n",
    );
  } catch {
    /* best-effort */
  }
  return lessons;
}
