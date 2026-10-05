import { test } from "node:test";
import assert from "node:assert/strict";
import { shallowClone, errorOutput } from "./review.js";

// The PR gate clones the head commit and scans the checkout. If the clone fails
// and we return an empty directory anyway, the scan finds nothing and the gate
// reports a PASS — the worst possible failure mode for a gate. It must fail loudly.
test("shallowClone rejects instead of returning an empty checkout when the clone fails", async () => {
  await assert.rejects(
    () => shallowClone("https://invalid.invalid/nope/nope.git", "main", "0".repeat(40), "token"),
    /clone/i,
    "a failed clone must surface as an error, never as an empty directory",
  );
});

test("shallowClone never puts the token in the thrown message", async () => {
  const token = "ghs_supersecrettoken";
  const err = await shallowClone("https://invalid.invalid/n/n.git", "main", "0".repeat(40), token).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err, "expected a rejection");
  assert.ok(
    !String(err instanceof Error ? err.message : err).includes(token),
    "the installation token must never appear in an error message",
  );
});

// A gate must fail CLOSED. GitHub branch protection treats a `neutral` check
// conclusion as PASSING for a required check, so reporting `neutral` when the
// review could not run lets the merge through — the same silent-pass bug as an
// empty checkout, one level up.
test("a review that could not run reports failure, not neutral", () => {
  const out = errorOutput(new Error("could not clone the PR head"), "");
  assert.equal(
    out.conclusion,
    "failure",
    "neutral passes branch protection — an un-run gate must block",
  );
});

test("the error check output never contains the installation token", () => {
  const token = "ghs_anothersecret";
  const out = errorOutput(new Error(`fatal: auth failed for https://x-access-token:${token}@host/r.git`), token);
  assert.ok(!out.summary.includes(token), "token must be redacted from the PR-visible summary");
  assert.ok(out.summary.includes("***"), "redaction should be visible");
});
