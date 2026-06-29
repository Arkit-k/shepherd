import type { Finding } from "../report.js";

// Shepherd's memory has to recognize "the same finding" across runs — to recall a
// prior triage decision, or to track a finding's lifecycle. The naive key
// (`id:file:line`, used by the old baseline) breaks the moment a line shifts:
// one reformat and every finding looks brand new. And the agent reviewer
// rephrases its messages run-to-run, so the raw message isn't stable either.
//
// So we key on what's actually stable: the check id, the file, and a NORMALIZED
// slug of the message — digits, line refs and our own evidence/source suffixes
// stripped, lowercased, whitespace collapsed. Two runs flagging the same issue
// land on the same key even if the wording drifts a little.

// Normalize a finding message down to its stable core.
export function msgSlug(message: string): string {
  return message
    .replace(/\[(verified|source):[^\]]*\]/gi, "") // drop our appended evidence/source tags
    .replace(/`[^`]*`/g, "") // drop inline code spans (names/paths vary)
    .toLowerCase()
    .replace(/\d+/g, "") // drop line numbers, counts, versions
    .replace(/[^a-z\s]/g, " ") // keep words only
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 12) // first dozen words carry the meaning; tail varies
    .join(" ");
}

// Exact identity: this specific issue, in this file. Survives line drift and
// minor rephrasing. Used to recall a precise triage decision.
export function findingKey(f: Pick<Finding, "id" | "file" | "message">): string {
  return `${f.id}::${f.file}::${msgSlug(f.message)}`;
}

// Coarse identity: this CHECK in this file, regardless of message. Lets a user
// dismiss a whole category in a generated/legacy file in one go
// (e.g. "all 'architecture' findings in src/legacy/big.ts are won't-fix").
export function fileScopeKey(f: Pick<Finding, "id" | "file">): string {
  return `${f.id}::${f.file}`;
}

// Exact-key equality is brittle: the agent rephrases run-to-run, and one extra
// trailing word breaks a string compare. So for matching a precise (exact-scope)
// decision we compare the message slugs by token OVERLAP instead. "god object
// mixes auth email and billing" vs "...and billing concerns" → Jaccard 0.88 →
// still the same finding.
export function slugTokens(slug: string): Set<string> {
  return new Set(slug.split(" ").filter(Boolean));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Same finding if a clear majority of the meaningful tokens overlap.
export const SAME_FINDING_THRESHOLD = 0.6;
