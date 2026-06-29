import { askShepherd } from "./chat.js";
import { recordTest, type TestKind } from "./memory/tests-log.js";
import { writeTestOrder } from "./handoff.js";

// Test generation. Shepherd believes everything essential deserves a test, so
// when asked it DESIGNS the essential cases — inspecting the real code with its
// read tools — and writes a test work-order the user's Claude Code session
// applies (Shepherd designs; it doesn't write the files). Each designed test is
// also logged to .shepherd/test.md so the memory of what's been covered grows.

const KINDS: TestKind[] = ["unit", "integration", "contract", "load", "probe", "regression"];
function coerceKind(k?: string): TestKind {
  return (KINDS as string[]).includes(String(k)) ? (k as TestKind) : "unit";
}

interface DesignedTest {
  name?: string;
  kind?: string;
  target?: string;
  assert?: string;
}

export interface TestDesign {
  order: string;
  orderPath: string;
  tests: DesignedTest[];
  sessionId?: string;
}

function testPrompt(request: string): string {
  return [
    `The user asked: "${request}".`,
    `Design the ESSENTIAL test cases for this. FIRST use your read tools to inspect the`,
    `relevant code and the project's existing test setup (framework, conventions).`,
    `Cover the risks that matter: happy path, edge cases, failure modes, and — where`,
    `relevant — security/abuse (rate-limit / cost-bomb), contracts, and load.`,
    ``,
    `Produce a TEST WORK-ORDER in markdown the user's Claude Code session can apply to`,
    `CREATE the test files. For each test: the target test-file path to create, the`,
    `framework to use (match what the repo already uses), and the FULL, runnable test`,
    `code in a fenced block. Real tests, no placeholders.`,
    ``,
    `After the work-order, append EXACTLY ONE fenced json block listing what you designed:`,
    "```json",
    `[{"name":"...","kind":"unit|integration|contract|load|probe|regression","target":"path","assert":"one line: what it checks"}]`,
    "```",
  ].join("\n");
}

// Pull the trailing ```json [...] ``` block out of the reply: it's our structured
// log, separate from the human-facing work-order. Returns the order body (block
// removed) and the parsed list.
function splitJsonBlock(text: string): { body: string; tests: DesignedTest[] } {
  const re = /```json\s*([\s\S]*?)```/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return { body: text, tests: [] };
  let tests: DesignedTest[] = [];
  try {
    const parsed = JSON.parse(last[1]);
    if (Array.isArray(parsed)) tests = parsed;
  } catch {
    /* leave the block in the body if it won't parse */
    return { body: text, tests: [] };
  }
  const body = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
  return { body, tests };
}

export function designTests(
  root: string,
  request: string,
  opts: { preamble: string; sessionId?: string },
): TestDesign | null {
  const reply = askShepherd(testPrompt(request), { root, preamble: opts.preamble, sessionId: opts.sessionId });
  if (!reply) return null;

  const { body, tests } = splitJsonBlock(reply.text);
  const ts = new Date().toISOString();
  for (const t of tests) {
    recordTest(root, {
      kind: coerceKind(t.kind),
      target: t.target ?? "—",
      test: t.name ?? t.assert ?? "test",
      result: "designed",
      ts,
    });
  }
  const order = body || reply.text;
  const orderPath = writeTestOrder(root, order);
  return { order, orderPath, tests, sessionId: reply.sessionId };
}
