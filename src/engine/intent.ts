import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadProject } from "./project.js";

// THE USER'S INTENT — captured once, reused everywhere. The autopilot loop is
// consultative: before it designs/right-sizes/certifies/ships, Shepherd asks the
// user what they actually want (the scale they're building for, the architecture,
// which infrastructure, where it deploys). Those choices drive every downstream
// judgment — most importantly, the DECLARED SCALE decides whether prescribing
// Redis/Kafka is "needed" or "over-engineering". Persisted so we ask once, not
// every run, and so the non-interactive CI run can honor the same decisions.

export type TargetScale = "small" | "growing" | "large";

export interface LoopChoices {
  scale: TargetScale; // what the user is building for — calibrates right-size vs infra
  architecture?: string; // chosen target pattern; undefined = accept Shepherd's recommendation
  infraAll: boolean; // keep every prescribed infra component
  infra: string[]; // when not infraAll, the component names the user chose to keep
  deployTarget?: string; // Vercel / Fly / Render / Docker+k8s / …
  note?: string; // free-text "anything else I should know"
  ts?: string;
}

const FILE = "intent.json";

function intentPath(root: string): string {
  return path.join(loadProject(root).dir, FILE);
}

export function readChoices(root: string): LoopChoices | null {
  const p = intentPath(root);
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, "utf8")) as LoopChoices;
    if (!c || typeof c.scale !== "string") return null;
    return c;
  } catch {
    return null;
  }
}

export function writeChoices(root: string, choices: LoopChoices): void {
  try {
    writeFileSync(intentPath(root), JSON.stringify(choices, null, 2) + "\n");
  } catch {
    /* intent is best-effort — never break the loop over it */
  }
}

export const SCALE_LABEL: Record<TargetScale, string> = {
  small: "small / just getting started",
  growing: "growing (thousands of users)",
  large: "~1M+ users / high traffic",
};

// A one-line summary for the "use saved choices?" prompt.
export function summarizeChoices(c: LoopChoices): string {
  const infra = c.infraAll ? "all prescribed infra" : c.infra.length ? c.infra.join(", ") : "no extra infra";
  return [
    `scale = ${SCALE_LABEL[c.scale]}`,
    `architecture = ${c.architecture ?? "Shepherd's recommendation"}`,
    `infra = ${infra}`,
    ...(c.deployTarget ? [`deploy = ${c.deployTarget}`] : []),
    ...(c.note ? [`note = "${c.note}"`] : []),
  ].join(" · ");
}
