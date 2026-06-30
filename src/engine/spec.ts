import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadProject } from "./project.js";
import type { Repo } from "./ingest.js";
import { detectStack } from "./tech-stack.js";
import { classifyShape, type BackendShape } from "./backend/architecture.js";
import { classifyProduction, type InfraInventory } from "./backend/production.js";
import { analyzeStructure, type StructureStyle } from "./structure.js";
import { scaleArchitect, type InfraPrescription } from "./backend/architect.js";
import { claudeAvailable } from "./fixers/claude.js";
import { claudeAgentJsonArray } from "./claude-json.js";

// SPEC-FIRST mode — the inversion. Every other axis judges code AFTER it's written
// (diagnostic). This authors the architecture/design BLUEPRINT the user's Claude
// Code builds FROM (prescriptive). Shepherd is the architect that hands Claude the
// target pattern, the module boundaries, the design patterns to apply, the
// industry-standard principles as hard constraints, and the infra plan — so the
// code is built right the first time, then proven right by /certify.
//
// Maintainer model holds: Shepherd writes the spec; the user's session writes the
// code. Mostly DETERMINISTIC (the skeleton + principles stand without Claude); an
// optional web-grounded Claude pass authors the blueprint narrative for THIS app.

export interface SpecInputs {
  stack: string;
  shape: BackendShape;
  comms: string[];
  patterns: string[];
  infra: InfraInventory;
  structure: StructureStyle;
}

export interface BlueprintSection {
  title: string;
  body: string;
}

export interface ArchitectureSpec {
  inputs: SpecInputs;
  targetPattern: string;
  rationale: string;
  prescriptions: InfraPrescription[];
  blueprint: BlueprintSection[]; // optional Claude-authored narrative
  markdown: string;
}

// Recommend the TARGET architecture from what's detected. Forward-looking, and
// deliberately not over-prescriptive — evolve toward the right shape, don't
// rewrite for its own sake.
function recommendTarget(patterns: string[], shape: BackendShape): { targetPattern: string; rationale: string } {
  const has = (p: string) => patterns.some((x) => x.includes(p));
  if (has("hexagonal"))
    return {
      targetPattern: "Hexagonal (ports & adapters) — strengthen it",
      rationale:
        "You already lean hexagonal. Keep the domain core pure (no framework/IO imports), express every external dependency as a port, and keep adapters at the edge. This is the structure that survives a large team and a decade.",
    };
  if (has("CQRS"))
    return {
      targetPattern: "CQRS-lite over a clean domain core",
      rationale:
        "Keep commands and queries separated, but don't split the datastore until read/write load actually diverges. A clean domain core underneath keeps it from turning into accidental complexity.",
    };
  if (has("event-driven") || has("task-queue")) {
    const monolith = shape !== "microservices";
    return {
      targetPattern: monolith
        ? "Event-driven modular monolith (real broker + worker pool)"
        : "Event-driven microservices (real broker + per-service workers)",
      rationale:
        "You're already event-shaped. Make it real: a durable broker (not an in-process EventEmitter), a dedicated worker pool for async work, and idempotent handlers with retries + a dead-letter queue. " +
        (monolith
          ? "Stay a modular monolith until a module's load or team ownership truly demands extraction — premature microservices are the #1 self-inflicted scaling wound."
          : "Keep service boundaries aligned to bounded contexts, with typed contracts between them."),
    };
  }
  if (shape === "serverless")
    return {
      targetPattern: "Serverless with a clean domain core",
      rationale:
        "Keep functions thin — a function is a transport adapter, not the place business logic lives. Put the logic in a framework-free core the functions call, so it's testable and portable, and watch cold-start + per-invocation cost.",
    };
  return {
    targetPattern: "Modular monolith with a clean domain core (hexagonal-lite)",
    rationale:
      "Start as a modular monolith: feature modules with explicit boundaries, a framework-free domain core, IO pushed to the edges. It's the highest-leverage shape for a small team that wants the option to scale or split later without a rewrite.",
  };
}

// The industry-standard coding principles, stated as HARD CONSTRAINTS Claude must
// follow while building. Deterministic — the moat doesn't need a model for these.
const PRINCIPLES: Array<{ id: string; rule: string }> = [
  { id: "separation", rule: "Separation of concerns: the transport layer (HTTP handlers / route files) stays thin — parse, validate, delegate. NO business logic in controllers or route handlers." },
  { id: "dependency-direction", rule: "Dependency inversion: the domain/core depends on nothing; infrastructure (DB, HTTP, queues) depends on the domain via interfaces (ports). Dependencies point inward, never the reverse." },
  { id: "validate-at-boundary", rule: "Validate at the boundary: every external input — HTTP body/query/params, queue messages, third-party responses — is parsed through a schema (zod or equivalent) BEFORE it reaches domain logic. Never trust the client." },
  { id: "typed-contracts", rule: "Typed contracts end-to-end: no `any` at boundaries; API/service contracts are typed (tRPC / OpenAPI-generated / shared types), so a contract change is a compile error, not a runtime surprise." },
  { id: "single-responsibility", rule: "Single Responsibility: a module/class/function does one thing. Keep functions short and cohesive; if you need 'and' to describe it, split it." },
  { id: "error-handling", rule: "Explicit error handling: typed/known errors at the domain edge, a single error-mapping layer at the transport edge. NEVER leak stack traces or internals to clients. Every network/IO call has a timeout." },
  { id: "idempotency", rule: "Idempotency + async: writes and side effects that can be retried are idempotent (keys/upserts). Slow or external work (email, payments, AI calls, image processing) goes to a queue/worker, NOT the request path." },
  { id: "statelessness", rule: "Statelessness: no module-level mutable state that breaks across instances. Sessions, rate-limit counters, and caches live in a shared store (Redis/Valkey), so the app scales horizontally." },
  { id: "config-secrets", rule: "Config & secrets: all config via environment, validated at boot; secrets never in code or the client bundle. Fail fast on missing required config." },
  { id: "observability", rule: "Observability from day one: structured logs with a request/correlation id, a health/readiness endpoint, and metrics on the hot paths. You can't operate what you can't see." },
  { id: "tests-first-class", rule: "Tests are a deliverable, not an afterthought: every use case has an integration test that exercises it through its real boundary. This is what Shepherd's /certify will run to prove the build." },
];

// Design-pattern guidance, scale-aware: what to reach for, what to avoid.
const PATTERN_GUIDANCE: Array<{ use: string }> = [
  { use: "**Dependency injection** (constructor injection) for stateful services — NOT Singletons. Singletons are global mutable state: untestable and broken across instances at scale. Reserve a single instance only for stateless shared resources (logger, DB pool)." },
  { use: "**Repository pattern** to isolate data access behind an interface, so the domain doesn't import the ORM and you can test it without a database." },
  { use: "**Strategy / Adapter** for every swappable external provider (payment, email, LLM, storage) — one interface, provider behind it. Makes them mockable and replaceable." },
  { use: "**Outbox / queue** for side effects — emit an event or enqueue a job; don't do the work inline in the request." },
  { use: "**Factory** ONLY for real families or non-trivial construction. If it's a single `new X()`, skip the factory (YAGNI). Avoid premature Builders and a Proxy in core logic." },
];

function buildMarkdown(
  inputs: SpecInputs,
  target: { targetPattern: string; rationale: string },
  prescriptions: InfraPrescription[],
  blueprint: BlueprintSection[],
  ts: string,
): string {
  const lines: string[] = [
    `# Shepherd — architecture & design spec`,
    ``,
    `_Generated ${ts}. The blueprint to build to. Shepherd authored this; your Claude Code session builds from it — then run \`/certify\` to prove the build matches._`,
    ``,
    `## What this is`,
    ``,
    `- **Stack:** ${inputs.stack}`,
    `- **Detected today:** ${inputs.shape} · pattern(s): ${inputs.patterns.join(", ")} · ${inputs.structure}-based structure${inputs.comms.length ? ` · comms: ${inputs.comms.join(", ")}` : ""}`,
    ``,
    `## 1. Target architecture`,
    ``,
    `**${target.targetPattern}**`,
    ``,
    target.rationale,
    ``,
    `## 2. Structure`,
    ``,
    inputs.structure === "layer" || inputs.structure === "mixed"
      ? `Today the code is organized by **layer** (\`models/\`, \`controllers/\`, \`services/\`). Reorganize by **feature / vertical slice**: one folder per feature owning its route, service, domain logic, and tests, over a shared framework-free \`core/\` (domain) and \`infrastructure/\` (adapters). A change then touches one folder, not five.`
      : `Keep the **feature / vertical-slice** structure: one folder per feature owning its full slice (route → service → domain → tests), over a shared framework-free \`core/\` domain and \`infrastructure/\` adapters. Don't drift back into layer-folders.`,
    ``,
    "```",
    "src/",
    "  core/                 # pure domain: entities, use-cases, ports (no framework imports)",
    "  features/",
    "    <feature>/          # route + handler + service + domain + tests, colocated",
    "  infrastructure/       # adapters: db, http clients, queue, cache (implement the ports)",
    "  shared/               # cross-cutting: config, logging, errors, types",
    "```",
    ``,
    `## 3. Design patterns to apply`,
    ``,
    ...PATTERN_GUIDANCE.map((g) => `- ${g.use}`),
    ``,
    `## 4. Build constraints (industry-standard principles — non-negotiable)`,
    ``,
    `Hold these as you write every module. Shepherd will check them on the way back in.`,
    ``,
    ...PRINCIPLES.map((p, i) => `${i + 1}. ${p.rule}`),
    ``,
  ];

  if (prescriptions.length) {
    lines.push(
      `## 5. Infrastructure plan (build it in from the start)`,
      ``,
      `The workload this app is heading toward needs the infrastructure below. Wire it as you build, not after it falls over. (Full detail + sources in \`.shepherd/scale-plan.md\`.)`,
      ``,
    );
    const order: Array<["now" | "soon" | "later", string]> = [
      ["now", "🔴 From the start"],
      ["soon", "🟡 As traffic ramps"],
      ["later", "🔵 Later headroom"],
    ];
    for (const [pri, heading] of order) {
      const group = prescriptions.filter((p) => p.priority === pri);
      if (!group.length) continue;
      lines.push(`### ${heading}`, ``);
      for (const p of group) {
        lines.push(`- **${p.recommendation}** — _${p.component}_: ${p.need}${p.where ? ` (plugs into \`${p.where}\`)` : ""}`);
      }
      lines.push(``);
    }
  }

  if (blueprint.length) {
    lines.push(`## ${prescriptions.length ? 6 : 5}. Blueprint for this app`, ``);
    for (const s of blueprint) {
      lines.push(`### ${s.title}`, ``, s.body, ``);
    }
  }

  lines.push(
    `---`,
    ``,
    `**Build from this in your Claude Code session**, e.g. _"scaffold the architecture in \`.shepherd/architecture-spec.md\`"_ or build one feature module at a time against it.`,
    `When a slice is built, run **\`/certify\`** — Shepherd re-scans and runs your tests to prove it matches the spec.`,
    ``,
  );
  return lines.join("\n");
}

// The Claude-authored blueprint narrative — forward-looking, web-grounded, concrete
// to THIS app. Optional: the deterministic spec above stands without it.
function authorBlueprint(repo: Repo, inputs: SpecInputs, target: string, opts: { web?: boolean; budgetUsd?: number }): BlueprintSection[] {
  if (!claudeAvailable()) return [];
  const prompt = [
    `You are a principal software architect writing the TARGET architecture blueprint a team will BUILD this app to.`,
    `This is forward-looking design guidance, not a review of existing code.`,
    ``,
    `App: ${inputs.stack}. Detected shape: ${inputs.shape}. Pattern(s): ${inputs.patterns.join(", ")}. Structure: ${inputs.structure}-based.`,
    `Recommended target: ${target}.`,
    `It must be correct, maintainable by a large team, and able to scale toward ~1,000,000 users.`,
    ``,
    `Read a few key files to ground yourself in what this app actually does, then author a CONCRETE blueprint.`,
    `Cover, specific to THIS app (name real modules/entities you see):`,
    `- the module/layer boundaries and what each owns`,
    `- where business logic lives and how data flows through a typical request`,
    `- the 3–5 most important design-pattern choices for this app at this scale (and what to avoid)`,
    `- the highest-risk thing to get right early`,
    `Reference current best practice where useful.`,
    ``,
    `Respond with ONLY a JSON array of {"title":string,"body":string} sections. 3–6 sections. Keep each body tight (a short paragraph or a few bullets in one string).`,
  ].join("\n");

  const raw = claudeAgentJsonArray<{ title?: string; body?: string }>(prompt, repo.root, {
    web: opts.web ?? true,
    budgetUsd: opts.budgetUsd ?? 0.6,
  });
  if (!raw) return [];
  return raw
    .filter((s) => s && s.title && s.body)
    .map((s) => ({ title: String(s.title), body: String(s.body) }));
}

export function architectureSpec(repo: Repo, opts: { web?: boolean; budgetUsd?: number } = {}): ArchitectureSpec {
  const tech = detectStack(repo);
  const stack = `${tech.language}, ${tech.frameworks.join(", ") || "—"}`;
  const { shape, comms } = classifyShape(repo);
  const { patterns, infra } = classifyProduction(repo);
  const structure = analyzeStructure(repo).style;
  const inputs: SpecInputs = { stack, shape, comms, patterns, infra, structure };

  const target = recommendTarget(patterns, shape);

  // The infra plan — reuse the web-grounded scale architect (skipped if no Claude).
  let prescriptions: InfraPrescription[] = [];
  if (claudeAvailable() && opts.web !== false) {
    try {
      prescriptions = scaleArchitect(repo, { web: opts.web ?? true }).prescriptions;
    } catch {
      /* infra plan is best-effort */
    }
  }

  const blueprint = authorBlueprint(repo, inputs, target.targetPattern, opts);
  const ts = new Date().toISOString();
  const markdown = buildMarkdown(inputs, target, prescriptions, blueprint, ts);

  return { inputs, targetPattern: target.targetPattern, rationale: target.rationale, prescriptions, blueprint, markdown };
}

export function writeArchitectureSpec(root: string, markdown: string): string {
  const project = loadProject(root);
  const abs = path.join(project.dir, "architecture-spec.md");
  writeFileSync(abs, markdown);
  return path.relative(root, abs);
}
