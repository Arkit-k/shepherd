#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scan } from "./engine/run.js";
import { buildFixOrder, writeFixOrder } from "./engine/handoff.js";

// Shepherd as an MCP server — this is how Claude Code "wires in".
// Claude Code drives: it calls `scan`, gets a compact structured findings list
// (not pasted code), fixes the gating files with its own tools, then calls
// `scan` again to verify. Shepherd's job is just to be the checker.
const server = new McpServer({ name: "shepherd", version: "0.0.1" });

server.tool(
  "scan",
  "Scan a repository for production-readiness issues — security (cost-bomb endpoints, exposed secrets, unauthed API routes, hardcoded localhost) and code quality / measurable SOLID smells (oversized files, overly long functions, god-classes). Returns structured findings. Workflow: run scan, fix every finding where gate=true, then run scan again to verify it's shipshape.",
  {
    path: z
      .string()
      .default(".")
      .describe("Path to the repo to scan (default: current directory)."),
    only_blocking: z
      .boolean()
      .default(false)
      .describe("Return only blocking (gate=true) findings — use when re-verifying after a fix to keep context minimal."),
  },
  async ({ path, only_blocking }) => {
    const { repo, findings } = await scan(path);
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
  async ({ path }) => {
    const { repo, findings } = await scan(path);
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

const transport = new StdioServerTransport();
await server.connect(transport);
