# Shepherd — GitHub App

The same engine, server-side. On every pull request it runs Shepherd's **deterministic** detectors (security, hygiene, provenance, right-size, IaC/DevOps, scale-T1 — no LLM, ~$0/PR) on the changed files and posts:

- a **Check Run** — *Shepherd — Go-Live Gate* — pass/fail, with inline annotations on the offending diff lines (make it a **required** check in branch protection to gate merges), and
- a single **summary comment** with the go-live verdict (updated each push).

The deep Claude review + scale/cost audit stay on the developer's own `npx shepherd` (their account). This is the free tier.

---

## What it does on a PR

1. `pull_request` (opened / synchronize / reopened) → an in-progress Check Run.
2. Lists the PR's changed files, shallow-clones the head commit.
3. Runs `scan(dir, { deep: false })` and scopes findings to the changed files.
4. Completes the Check (`success` / `failure`) with annotations + a `verdictMarkdown` summary, and upserts the PR comment.
5. Cleans up the clone. Errors never crash the webhook — they post a `neutral` check that retries next push.

## Run it

Three secrets from registering the App (below): `APP_ID`, `PRIVATE_KEY` (the PEM — `\n`-escaped is fine), `WEBHOOK_SECRET`. `PORT` defaults to 3000.

```bash
npm run build
APP_ID=... PRIVATE_KEY="$(cat key.pem)" WEBHOOK_SECRET=... npm run start:app
# or: docker build -f src/app/Dockerfile -t shepherd-app . && docker run -p 3000:3000 --env-file .env shepherd-app
```

`GET /healthz` → `shepherd app ok`. Webhooks: `POST /api/github/webhooks` (signature-verified).

## Register the App (one-time)

1. **Create the App** — GitHub → *Settings → Developer settings → GitHub Apps → New GitHub App* (or use [`app-manifest.yml`](./app-manifest.yml)). Set:
   - **Webhook URL:** `https://YOUR-DEPLOYMENT/api/github/webhooks`
   - **Webhook secret:** a random string → this is `WEBHOOK_SECRET`
   - **Permissions:** Checks **Read & write**, Pull requests **Read & write**, Contents **Read-only**
   - **Subscribe to events:** *Pull request*
2. **Note the App ID** (`APP_ID`) and **generate a private key** (downloads a `.pem` → `PRIVATE_KEY`).
3. **Deploy** the container anywhere with a public URL (Fly / Render / Railway / a VPS) with the three env vars set.
4. **Install** the App on your repos (*Install App* in the App settings).

## Local testing

Use [smee.io](https://smee.io) to forward webhooks to `localhost`:

```bash
npx smee-client --url https://smee.io/your-channel --target http://localhost:3000/api/github/webhooks
```

Set the App's Webhook URL to the smee channel, run `npm run app`, open a PR, and watch the Check appear. The App settings → *Advanced* → *Recent Deliveries* lets you **Redeliver** any event while iterating.

## Notes & limits

- **Deterministic only** server-side (zero LLM cost). A paid Claude-deep-review tier needs billing/quotas first.
- Triggers on **pull requests** only (push-to-main is a follow-on).
- It respects a repo's committed `.shepherd/triage.json` (suppressed findings stay suppressed).
- The install token is injected into the clone URL and never logged.
