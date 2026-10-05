import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { security } from "./security.js";
import type { Repo, SourceFile } from "../ingest.js";

// Fixture corpus for the deterministic security detectors.
//
// A gate's credibility IS its false-positive rate, so this file is organised as
// two halves: TRUE POSITIVES (must fire) and FALSE-POSITIVE GUARDS (must not
// fire). Every guard here is a shape that appears in ordinary production repos.

function repo(files: Record<string, string>): Repo {
  const out: SourceFile[] = Object.entries(files).map(([p, content]) => ({
    path: p,
    abs: path.join("/fixture", p),
    content,
    lines: content.split("\n").length,
  }));
  return { root: "/fixture", files: out, hasNext: true, hasSupabase: false };
}

const ids = (fs: ReturnType<typeof security>): string[] => fs.map((f) => f.id);
const find = (fs: ReturnType<typeof security>, id: string) => fs.find((f) => f.id === id);

// ───────────────────────── true positives ─────────────────────────

test("reports cost-bomb for a public AI route with no rate limiting", () => {
  const out = security(
    repo({
      "app/api/chat/route.ts": [
        `import OpenAI from "openai";`,
        `const client = new OpenAI();`,
        `export async function POST(req: Request) {`,
        `  const r = await client.chat.completions.create({ model: "gpt-4", messages: [] });`,
        `  return Response.json(r);`,
        `}`,
      ].join("\n"),
    }),
  );
  assert.ok(ids(out).includes("cost-bomb"));
});

test("reports exposed-secret for a hardcoded JWT", () => {
  const out = security(
    repo({
      "lib/db.ts": `const key = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghij";`,
    }),
  );
  assert.ok(ids(out).includes("exposed-secret"));
});

// ─────────── bug 1: a comment must not silence a critical finding ───────────

test("reports cost-bomb even when a comment merely mentions throttling", () => {
  const out = security(
    repo({
      "app/api/chat/route.ts": [
        `// TODO: add throttling before launch`,
        `import OpenAI from "openai";`,
        `const client = new OpenAI();`,
        `export async function POST(req: Request) {`,
        `  return Response.json(await client.chat.completions.create({ model: "gpt-4", messages: [] }));`,
        `}`,
      ].join("\n"),
    }),
  );
  assert.ok(
    ids(out).includes("cost-bomb"),
    "a TODO comment about throttling must not suppress the cost-bomb gate",
  );
});

test("reports cost-bomb even when a comment asks for a rate-limit", () => {
  const out = security(
    repo({
      "app/api/chat/route.ts": [
        `// FIXME: no rate-limit on this yet, add upstash before launch`,
        `import OpenAI from "openai";`,
        `const client = new OpenAI();`,
        `export async function POST(req: Request) {`,
        `  return Response.json(await client.chat.completions.create({ model: "gpt-4", messages: [] }));`,
        `}`,
      ].join("\n"),
    }),
  );
  assert.ok(
    ids(out).includes("cost-bomb"),
    "a comment naming a rate limiter must not satisfy the rate-limit check",
  );
});

test("does not report cost-bomb when a rate limiter is actually wired up", () => {
  const out = security(
    repo({
      "app/api/chat/route.ts": [
        `import { Ratelimit } from "@upstash/ratelimit";`,
        `const limiter = new Ratelimit({ limiter: Ratelimit.slidingWindow(5, "1 m") });`,
        `import OpenAI from "openai";`,
        `export async function POST(req: Request) {`,
        `  const { success } = await limiter.limit("ip");`,
        `  if (!success) return new Response("slow down", { status: 429 });`,
        `  return Response.json({});`,
        `}`,
      ].join("\n"),
    }),
  );
  assert.ok(!ids(out).includes("cost-bomb"));
});

test("does not report cost-bomb when the AI provider is only named in a comment", () => {
  const out = security(
    repo({
      "app/api/health/route.ts": [
        `// we deliberately do not call openai from this endpoint`,
        `export async function GET() {`,
        `  return Response.json({ ok: true });`,
        `}`,
      ].join("\n"),
    }),
  );
  assert.ok(
    !ids(out).includes("cost-bomb"),
    "mentioning a provider in a comment is not an AI call",
  );
});

// ─────────── bug 2: severity/disposition must track real risk ───────────

test("hardcoded-localhost advises rather than blocking the push", () => {
  const out = security(
    repo({ "lib/api.ts": `export const base = "http://localhost:3000";` }),
  );
  const f = find(out, "hardcoded-localhost");
  assert.ok(f, "expected a hardcoded-localhost finding");
  assert.equal(
    f.disposition,
    "advise",
    "a cosmetic string must not gate the push while real security findings only advise",
  );
});

// ─────────── bug 3: findings need a line to become PR comments ───────────

test("cost-bomb finding carries a line number", () => {
  const out = security(
    repo({
      "app/api/chat/route.ts": [
        `import OpenAI from "openai";`,
        `const client = new OpenAI();`,
        `export async function POST() {`,
        `  return Response.json(await client.chat.completions.create({ model: "x", messages: [] }));`,
        `}`,
      ].join("\n"),
    }),
  );
  const f = find(out, "cost-bomb");
  assert.ok(f);
  assert.equal(typeof f.line, "number", "a file-only finding cannot become an inline PR comment");
});

test("unauthed-route finding carries a line number", () => {
  const out = security(
    repo({
      "app/api/items/route.ts": [
        `export async function GET() {`,
        `  return Response.json([]);`,
        `}`,
      ].join("\n"),
    }),
  );
  const f = find(out, "unauthed-route");
  assert.ok(f);
  assert.equal(typeof f.line, "number");
});

// ───────────────────── false-positive guards ─────────────────────

test("does not flag a webhook route that verifies a signature", () => {
  const out = security(
    repo({
      "app/api/webhooks/stripe/route.ts": [
        `import Stripe from "stripe";`,
        `export async function POST(req: Request) {`,
        `  const sig = req.headers.get("stripe-signature");`,
        `  const event = stripe.webhooks.constructEvent(await req.text(), sig, secret);`,
        `  return Response.json({ received: true });`,
        `}`,
      ].join("\n"),
    }),
  );
  assert.ok(
    !ids(out).includes("unauthed-route"),
    "HMAC signature verification is authentication — webhooks are not unauthed routes",
  );
});

test("does not flag localhost inside a config or test file", () => {
  const out = security(
    repo({
      "vitest.config.ts": `export default { test: { environment: "http://localhost:5173" } };`,
      "e2e/login.spec.ts": `await page.goto("http://localhost:3000/login");`,
    }),
  );
  assert.deepEqual(
    out.filter((f) => f.id === "hardcoded-localhost"),
    [],
    "dev-only files are supposed to point at localhost",
  );
});

test("ignores secrets in .example files", () => {
  const out = security(
    repo({
      ".env.example": `OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwxyz"`,
    }),
  );
  assert.ok(!ids(out).includes("exposed-secret"));
});
