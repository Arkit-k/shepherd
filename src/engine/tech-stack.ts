import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Repo } from "./ingest.js";

export interface TechStack {
  language: string;
  packageManager: string;
  frameworks: string[];
  databases: string[];
  testing: string[];
  notable: { name: string; version: string }[];
}

const FRAMEWORKS: Record<string, string> = {
  next: "Next.js",
  react: "React",
  vue: "Vue",
  "@angular/core": "Angular",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  express: "Express",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  hono: "Hono",
  koa: "Koa",
  "react-native": "React Native",
  expo: "Expo",
  "@trpc/server": "tRPC",
  "@grpc/grpc-js": "gRPC",
  graphql: "GraphQL",
  "@apollo/server": "Apollo GraphQL",
  bullmq: "BullMQ",
  kafkajs: "Kafka",
};

const DATABASES: Record<string, string> = {
  "@supabase/supabase-js": "Supabase",
  "@prisma/client": "Prisma",
  "drizzle-orm": "Drizzle",
  mongoose: "MongoDB (Mongoose)",
  pg: "PostgreSQL",
  mysql2: "MySQL",
  redis: "Redis",
  ioredis: "Redis",
  "@planetscale/database": "PlanetScale",
  firebase: "Firebase",
};

const TESTING: Record<string, string> = {
  vitest: "Vitest",
  jest: "Jest",
  mocha: "Mocha",
  "@playwright/test": "Playwright",
  cypress: "Cypress",
  "@testing-library/react": "Testing Library",
};

const NOTABLE = [
  "next",
  "react",
  "typescript",
  "tailwindcss",
  "@supabase/supabase-js",
  "@prisma/client",
  "drizzle-orm",
  "stripe",
  "zod",
];

function detectPackageManager(root: string): string {
  if (existsSync(path.join(root, "bun.lock")) || existsSync(path.join(root, "bun.lockb"))) return "bun";
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(root, "package-lock.json"))) return "npm";
  return "unknown";
}

// Tier 1 — cheap, deterministic stack detection from package.json. No Claude.
export function detectStack(repo: Repo): TechStack {
  // monorepo-aware: merge deps from every package.json (not just the root).
  const pkgPaths = fg.sync("**/package.json", {
    cwd: repo.root,
    ignore: ["**/node_modules/**"],
    absolute: true,
  });
  let deps: Record<string, string> = {};
  for (const pp of pkgPaths) {
    try {
      const pkg = JSON.parse(readFileSync(pp, "utf8"));
      deps = { ...deps, ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    } catch {
      /* skip unparseable */
    }
  }

  const has = (k: string) => k in deps;
  const clean = (v: string) => (v ?? "").replace(/^[\^~]/, "");

  const hasTsconfig =
    fg.sync("**/tsconfig.json", { cwd: repo.root, ignore: ["**/node_modules/**"] }).length > 0;
  const language = has("typescript") || hasTsconfig ? "TypeScript" : "JavaScript";

  const frameworks = Object.keys(FRAMEWORKS).filter(has).map((k) => FRAMEWORKS[k]);
  const databases = Object.keys(DATABASES).filter(has).map((k) => DATABASES[k]);
  const testing = Object.keys(TESTING).filter(has).map((k) => TESTING[k]);
  const notable = NOTABLE.filter(has).map((k) => ({ name: k, version: clean(deps[k]) }));

  return {
    language,
    packageManager: detectPackageManager(repo.root),
    frameworks,
    databases,
    testing,
    notable,
  };
}

export function printStack(tech: TechStack): void {
  console.log("\n📦 Tech stack");
  console.log(`   Language : ${tech.language}`);
  console.log(`   Package  : ${tech.packageManager}`);
  console.log(`   Framework: ${tech.frameworks.join(", ") || "—"}`);
  console.log(`   Database : ${tech.databases.join(", ") || "—"}`);
  console.log(`   Testing  : ${tech.testing.join(", ") || "⚠️  none detected"}`);
  if (tech.notable.length) {
    console.log("   Versions :");
    for (const n of tech.notable) console.log(`     ${n.name}@${n.version}`);
  }
}
