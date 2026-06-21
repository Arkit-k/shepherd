#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { watch, existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { scan } from "./engine/run.js";
import { buildFixOrder, writeFixOrder } from "./engine/handoff.js";

// Shepherd as an MCP server — this is how Claude Code "wires in".
//
// Two ways it works:
//  • PULL — Claude Code calls `scan` / `fix_order`, gets a compact work-order,
//    and applies the fixes itself.
//  • PUSH (Channels, research preview) — Shepherd declares a channel capability
//    and watches `.shepherd/fix-order.md`. When any `npx shepherd` run writes a
//    new work-order, Shepherd PUSHES it into the running Claude Code session, so
//    it wakes up and applies the fixes with zero typing.
//
// Shepherd never edits code itself — it is the maintainer that hands off work.
const server = new McpServer(
  { name: "shepherd", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} }, // makes this a push channel
    },
    instructions:
      'Shepherd is a production-readiness maintainer. Work orders arrive as ' +
      '<channel source="shepherd" ...> messages pointing at .shepherd/fix-order.md. ' +
      "When one arrives, read that file and apply the listed fixes as minimal diffs, " +
      "then call the `scan` tool with only_blocking=true to verify the gates are closed.",
  },
);

server.tool(
  "scan",
  "Scan a repository for production-readiness issues — security (cost-bomb endpoints, exposed secrets, unauthed API routes, hardcoded localhost) and code quality / measurable SOLID smells (oversized files, overly long functions, god-classes). Returns structured findings. Workflow: run scan, fix every finding where gate=true, then run scan again to verify it's shipshape.",
  {
    path: z.string().default(".").describe("Path to the repo to scan (default: current directory)."),
    only_blocking: z
      .boolean()
      .default(false)
      .describe("Return only blocking (gate=true) findings — use when re-verifying after a fix to keep context minimal."),
  },
  async ({ path: p, only_blocking }) => {
    const { repo, findings } = await scan(p);
    const blocking = findings.filter((f) => f.disposition === "gate");
    const shown = only_blocking ? blocking : findings;

    const payload = {
      summary: {
        files_scanned: repo.files.length,
        total_findings: findings.length,
        blocking: blocking.length,
        shipshape: blocking.length === 0,
      },
      findings: shown.map((f) => ({
        id: f.id,
        severity: f.severity,
        gate: f.disposition === "gate",
        file: f.file,
        line: f.line,
        message: f.message,
      })),
    };

    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },
);

// The hand-off tool. Shepherd is the maintainer: it never edits code. This tool
// scans the repo and returns a precise fix WORK-ORDER (the prompt) for THIS
// Claude Code session to execute itself, then it should re-run `scan` to verify.
server.tool(
  "fix_order",
  "Get Shepherd's fix work-order for a repo: scans for blocking (gate) production-readiness issues and returns precise, file-by-file instructions for YOU (this Claude Code session) to apply. Shepherd does not edit code — it hands you the order. After applying, call `scan` with only_blocking=true to verify the gates are closed. Also writes the order to .shepherd/fix-order.md.",
  {
    path: z.string().default(".").describe("Path to the repo (default: current directory)."),
  },
  async ({ path: p }) => {
    const { repo, findings } = await scan(p);
    const gates = findings.filter((f) => f.disposition === "gate");
    if (gates.length === 0) {
      return { content: [{ type: "text", text: "✅ No blocking issues — nothing to fix." }] };
    }
    const ts = new Date().toISOString();
    const order = buildFixOrder(gates, ts);
    try {
      writeFixOrder(repo.root, order);
    } catch {
      /* still return the order even if the file write fails */
    }
    return { content: [{ type: "text", text: order }] };
  },
);

// ── Channels push: watch .shepherd/fix-order.md and push when it changes ──────
function startChannelWatch(): void {
  const projectDir = process.cwd();
  const shepherdDir = path.join(projectDir, ".shepherd");
  const orderPath = path.join(shepherdDir, "fix-order.md");
  let lastMtime = 0;
  const dbg = (m: string) => {
    if (process.env.SHEPHERD_DEBUG) console.error(`[shepherd-channel] ${m}`);
  };
  dbg(`watching ${orderPath}`);

  const push = () => {
    try {
      if (!existsSync(orderPath)) return dbg("push: no order file");
      const mtime = statSync(orderPath).mtimeMs;
      if (mtime === lastMtime) return dbg("push: unchanged mtime"); // dedupe repeated fs events
      lastMtime = mtime;
      dbg("push: sending channel notification");
      // fire-and-forget; if the session isn't listening it drops silently.
      void server.server.notification({
        method: "notifications/claude/channel",
        params: {
          content:
            "Shepherd produced a new fix work-order. Read `.shepherd/fix-order.md` and apply the " +
            "listed fixes as minimal diffs, then call the `scan` tool with only_blocking=true to verify.",
          meta: { source: "shepherd", order: ".shepherd/fix-order.md" },
        },
      });
    } catch {
      /* channels are best-effort / research preview */
    }
  };

  let timer: NodeJS.Timeout | null = null;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(push, 500);
  };

  const arm = () => {
    if (!existsSync(shepherdDir)) {
      dbg(".shepherd missing — retry in 5s");
      setTimeout(arm, 5000); // wait for the folder to appear, then watch
      return;
    }
    try {
      watch(shepherdDir, (_event, filename) => {
        dbg(`fs event: ${filename}`);
        if (filename === "fix-order.md") debounced();
      });
      dbg("armed watch on .shepherd");
      push(); // push once if an order already exists at startup
    } catch (e) {
      dbg(`watch failed: ${String(e)}`);
    }
  };
  arm();
}

const transport = new StdioServerTransport();
await server.connect(transport);
startChannelWatch();
