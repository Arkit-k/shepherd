import { createServer } from "node:http";
import { App } from "octokit";
import { createNodeMiddleware } from "@octokit/webhooks";
import { loadConfig } from "./config.js";
import { handlePullRequest, type PRContext } from "./review.js";

// The Shepherd GitHub App — the same engine, server-side, gating every PR. It runs
// the DETERMINISTIC detectors only (zero LLM cost — the free tier); the deep Claude
// review stays on the user's own CLI/account. On a pull_request it posts a Check Run
// (with inline annotations) + a single summary comment with the go-live verdict.
//
// No web framework: Node's built-in http server hosts Octokit's webhook middleware
// (which verifies the signature) at /api/github/webhooks, plus a /healthz probe.

const cfg = loadConfig();

const app = new App({
  appId: cfg.appId,
  privateKey: cfg.privateKey,
  webhooks: { secret: cfg.webhookSecret },
});

app.webhooks.on(["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"], (ctx) =>
  handlePullRequest(ctx as unknown as PRContext),
);
app.webhooks.onError((err) => console.error("[shepherd] webhook error:", err.message));

// webhooks-only middleware (not the App-level one, which also mounts OAuth routes).
const middleware = createNodeMiddleware(app.webhooks, { path: "/api/github/webhooks" });

const server = createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("shepherd app ok");
    return;
  }
  if (await middleware(req, res)) return; // webhook handled
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(cfg.port, () => {
  console.log(`🐑 Shepherd App listening on :${cfg.port} — webhooks at /api/github/webhooks`);
});
