import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadProject } from "./project.js";
import type { Repo } from "./ingest.js";
import { detectStack } from "./tech-stack.js";
import { readChoices, type TargetScale } from "./intent.js";
import type { InfraPrescription } from "./backend/architect.js";

// DEVOPS SCAFFOLDER — Shepherd already KNOWS the infra (the scale architect
// prescribed it, the intake captured what you want, the probe found the missing
// security headers + rate limit). So it generates the actual DevOps deck: CI/CD,
// git hooks, containerization, a reverse proxy, Kubernetes, and observability —
// tailored to your stack, your selected infra, and your deploy target.
//
// RIGHT-SIZED to the declared scale (the tweet's lesson, applied to ops): a small
// app gets CI + Husky + a Dockerfile + Caddy; a ~1M app additionally gets k8s +
// Prometheus + Grafana. We don't dump a control plane on a weekend project.
//
// Maintainer model: this writes a work-order with REAL, ready-to-adapt config to
// `.shepherd/devops-order.md` — you (or your Claude Code session) drop the files in.

interface AppProfile {
  isNext: boolean;
  port: number;
  startCmd: string;
  buildOutput: string; // what to copy into the runtime image
  nodeImage: string;
}

function appProfile(repo: Repo): AppProfile {
  const tech = detectStack(repo);
  const isNext = tech.frameworks.includes("Next.js") || repo.hasNext;
  const project = loadProject(repo.root);
  const port = project.config.port ?? (isNext ? 3000 : 3000);
  return {
    isNext,
    port,
    startCmd: isNext ? "npm run start" : "node dist/index.js",
    buildOutput: isNext ? ".next, public, package.json" : "dist, package.json",
    nodeImage: "node:20-alpine",
  };
}

// Map known infra (from the user's selected components / prescriptions / stack) to
// docker-compose service blocks — only the ones actually in play.
function infraKeywords(repo: Repo, prescriptions: InfraPrescription[], selected: string[]): Set<string> {
  const hay = (
    prescriptions.map((p) => `${p.component} ${p.recommendation}`).join(" ") +
    " " +
    selected.join(" ") +
    " " +
    detectStack(repo).databases.join(" ")
  ).toLowerCase();
  const kw = new Set<string>();
  const add = (k: string, ...needles: string[]) => {
    if (needles.some((n) => hay.includes(n))) kw.add(k);
  };
  add("redis", "redis", "valkey", "cache", "bullmq", "ioredis");
  add("postgres", "postgres", "postgresql", "pg ", "supabase", "prisma");
  add("mysql", "mysql", "mariadb", "planetscale");
  add("mongo", "mongo");
  add("kafka", "kafka", "redpanda");
  add("rabbitmq", "rabbitmq", "amqp");
  add("meilisearch", "meilisearch");
  add("elasticsearch", "elasticsearch", "opensearch");
  return kw;
}

const COMPOSE_SERVICE: Record<string, string> = {
  redis: `  redis:\n    image: valkey/valkey:8-alpine   # Redis-compatible, BSD-licensed\n    ports: ["6379:6379"]\n    volumes: ["redis-data:/data"]`,
  postgres: `  postgres:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set in .env}\n    ports: ["5432:5432"]\n    volumes: ["pg-data:/var/lib/postgresql/data"]`,
  mysql: `  mysql:\n    image: mysql:8\n    environment:\n      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD:?set in .env}\n    ports: ["3306:3306"]\n    volumes: ["mysql-data:/var/lib/mysql"]`,
  mongo: `  mongo:\n    image: mongo:7\n    ports: ["27017:27017"]\n    volumes: ["mongo-data:/data/db"]`,
  kafka: `  redpanda:\n    image: redpandadata/redpanda:latest   # Kafka API, single binary\n    command: ["redpanda","start","--smp","1","--overprovisioned"]\n    ports: ["9092:9092"]`,
  rabbitmq: `  rabbitmq:\n    image: rabbitmq:3-management-alpine\n    ports: ["5672:5672","15672:15672"]`,
  meilisearch: `  meilisearch:\n    image: getmeili/meilisearch:latest\n    ports: ["7700:7700"]\n    volumes: ["meili-data:/meili_data"]`,
  elasticsearch: `  elasticsearch:\n    image: docker.elastic.co/elasticsearch/elasticsearch:8.13.0\n    environment: { discovery.type: single-node, xpack.security.enabled: "false" }\n    ports: ["9200:9200"]`,
};
const VOLUME_FOR: Record<string, string> = {
  redis: "redis-data",
  postgres: "pg-data",
  mysql: "mysql-data",
  mongo: "mongo-data",
  meilisearch: "meili-data",
};

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

// ── CI/CD ────────────────────────────────────────────────────────────────────
function ciSection(app: AppProfile, deployTarget?: string): string {
  const deployStep = deployTargetStep(deployTarget);
  const yml = `name: CI
on:
  push: { branches: [main] }
  pull_request: {}
permissions: { contents: read }
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build --if-present
      - run: npm test
      - run: npx shepherd .          # the gate — fails the build if it isn't production-ready
${deployStep}`;
  return [
    `## 1. CI/CD — \`.github/workflows/ci.yml\``,
    ``,
    `Build → test → **Shepherd gate** → deploy. The deploy job \`needs:\` the gate, so an unproven build never ships.`,
    ``,
    fence("yaml", yml),
    ``,
    `> Pin actions to a commit SHA for supply-chain safety once you've settled the versions, and keep secrets in the repo's CI secret store.`,
    ``,
  ].join("\n");
}

function deployTargetStep(target?: string): string {
  const t = (target ?? "").toLowerCase();
  if (t.includes("vercel"))
    return `  deploy:\n    needs: ci\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npx vercel deploy --prod --token=\${{ secrets.VERCEL_TOKEN }}`;
  if (t.includes("fly"))
    return `  deploy:\n    needs: ci\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: superfly/flyctl-actions/setup-flyctl@master\n      - run: flyctl deploy --remote-only\n        env: { FLY_API_TOKEN: \${{ secrets.FLY_API_TOKEN }} }`;
  if (t.includes("render"))
    return `  deploy:\n    needs: ci\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    steps:\n      - run: curl -fsSL "\${{ secrets.RENDER_DEPLOY_HOOK }}"   # Render deploy hook`;
  if (t.includes("kube") || t.includes("k8s") || t.includes("docker"))
    return `  deploy:\n    needs: ci\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: docker build -t \$REGISTRY/app:\${{ github.sha }} .\n      - run: docker push \$REGISTRY/app:\${{ github.sha }}\n      - run: kubectl set image deployment/app app=\$REGISTRY/app:\${{ github.sha }}   # or argocd / helm upgrade`;
  return `  # deploy:\n  #   needs: ci    # add your platform's deploy step here; it must 'needs: ci' so it only runs when the gate passes`;
}

// ── Husky ────────────────────────────────────────────────────────────────────
function huskySection(): string {
  return [
    `## 2. Git hooks — Husky`,
    ``,
    `The whole team gets lint/format on commit and the gate before push (not just whoever set it up locally).`,
    ``,
    fence("bash", `npm i -D husky lint-staged\nnpx husky init`),
    ``,
    `\`.husky/pre-commit\`:`,
    fence("bash", `npx lint-staged`),
    `\`.husky/pre-push\`:`,
    fence("bash", `npm test && npx shepherd --git-check   # gate the push on the diff`),
    `\`package.json\`:`,
    fence("json", `"lint-staged": {\n  "*.{ts,tsx,js,jsx}": ["eslint --fix", "prettier --write"]\n}`),
    ``,
  ].join("\n");
}

// ── Docker ───────────────────────────────────────────────────────────────────
function dockerSection(app: AppProfile): string {
  const dockerfile = `# syntax=docker/dockerfile:1
FROM ${app.nodeImage} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ${app.nodeImage} AS run
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/${app.isNext ? ".next ./.next" : "dist ./dist"}
${app.isNext ? "COPY --from=build /app/public ./public" : ""}
USER node
EXPOSE ${app.port}
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:${app.port}/healthz || exit 1
CMD ["sh","-c","${app.startCmd}"]`;
  return [
    `## 3. Containerization — \`Dockerfile\` (multi-stage) + \`.dockerignore\``,
    ``,
    `Multi-stage keeps the runtime image small; non-root \`USER\`, a healthcheck, prod-only deps.`,
    ``,
    fence("dockerfile", dockerfile),
    ``,
    `\`.dockerignore\`:`,
    fence("", `node_modules\n.git\n.env*\n${app.isNext ? ".next/cache" : "dist"}\nnpm-debug.log\n.shepherd\nDockerfile\n.dockerignore`),
    ``,
  ].join("\n");
}

// ── docker-compose ───────────────────────────────────────────────────────────
function composeSection(app: AppProfile, kw: Set<string>): string {
  const services = [...kw].map((k) => COMPOSE_SERVICE[k]).filter(Boolean);
  const volumes = [...kw].map((k) => VOLUME_FOR[k]).filter(Boolean);
  const depends = [...kw].filter((k) => COMPOSE_SERVICE[k]);
  const compose = `services:
  app:
    build: .
    ports: ["${app.port}:${app.port}"]
    env_file: [.env]
${depends.length ? `    depends_on: [${depends.map((d) => (d === "kafka" ? "redpanda" : d)).join(", ")}]` : ""}
${services.join("\n")}
${volumes.length ? `volumes:\n${volumes.map((v) => `  ${v}:`).join("\n")}` : ""}`;
  return [
    `## 4. Local stack — \`docker-compose.yml\``,
    ``,
    kw.size
      ? `Stands up the app with the infrastructure you selected (${[...kw].join(", ")}), so dev == prod-shaped.`
      : `The app container; add your datastores here as you adopt them.`,
    ``,
    fence("yaml", compose),
    ``,
  ].join("\n");
}

// ── reverse proxy ────────────────────────────────────────────────────────────
function proxySection(app: AppProfile, preferNginx: boolean): string {
  const caddy = `yourdomain.com {
\tencode zstd gzip
\theader {
\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains; preload"
\t\tX-Content-Type-Options "nosniff"
\t\tX-Frame-Options "DENY"
\t\tContent-Security-Policy "default-src 'self'"
\t\t-Server
\t}
\treverse_proxy localhost:${app.port}
}`;
  const nginx = `# /etc/nginx/conf.d/app.conf
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
server {
  listen 443 ssl http2;
  server_name yourdomain.com;
  ssl_protocols TLSv1.2 TLSv1.3;
  server_tokens off;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options DENY always;
  add_header Content-Security-Policy "default-src 'self'" always;
  location / {
    limit_req zone=api burst=20 nodelay;
    proxy_pass http://localhost:${app.port};
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}`;
  return [
    `## 5. Reverse proxy${preferNginx ? " — nginx" : " — Caddy (recommended)"}`,
    ``,
    preferNginx
      ? `nginx with TLS, the security headers the live probe checks for, and a rate limit in front of your API (the cost-bomb defense at the edge).`
      : `**Caddy** — automatic HTTPS, one file. It sets the security headers the live probe flags as missing. (Rate limiting needs the \`caddy-ratelimit\` plugin or do it in-app.)`,
    ``,
    preferNginx ? fence("nginx", nginx) : fence("", caddy),
    ``,
    preferNginx
      ? ``
      : `Prefer nginx (or you're on k8s)? Use an ingress-nginx with the same headers + \`limit_req\`.`,
    ``,
  ].join("\n");
}

// ── kubernetes ───────────────────────────────────────────────────────────────
function k8sSection(app: AppProfile): string {
  const manifest = `apiVersion: apps/v1
kind: Deployment
metadata: { name: app }
spec:
  replicas: 3
  selector: { matchLabels: { app: app } }
  template:
    metadata: { labels: { app: app } }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 1000 }
      containers:
        - name: app
          image: REGISTRY/app:TAG
          ports: [{ containerPort: ${app.port} }]
          resources:
            requests: { cpu: "100m", memory: "128Mi" }
            limits:   { cpu: "500m", memory: "512Mi" }
          readinessProbe: { httpGet: { path: /readyz, port: ${app.port} }, initialDelaySeconds: 5 }
          livenessProbe:  { httpGet: { path: /healthz, port: ${app.port} }, initialDelaySeconds: 15 }
          envFrom: [{ secretRef: { name: app-secrets } }]
---
apiVersion: v1
kind: Service
metadata: { name: app }
spec: { selector: { app: app }, ports: [{ port: 80, targetPort: ${app.port} }] }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: app }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: app }
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }`;
  return [
    `## 6. Kubernetes — \`k8s/app.yaml\``,
    ``,
    `Deployment + Service + HPA, with **readiness/liveness probes** (zero-downtime deploys), **resource requests/limits** (no noisy-neighbour), non-root, and secrets via \`secretRef\`. Add an Ingress (ingress-nginx) with the headers from §5.`,
    ``,
    fence("yaml", manifest),
    ``,
    `> Requires \`/healthz\` and \`/readyz\` endpoints in the app — Shepherd's operations check flags these if missing.`,
    ``,
  ].join("\n");
}

// ── observability ────────────────────────────────────────────────────────────
function observabilitySection(): string {
  const prom = `# prometheus.yml
global: { scrape_interval: 15s }
scrape_configs:
  - job_name: app
    metrics_path: /metrics
    static_configs: [{ targets: ["app:${"${PORT:-3000}"}"] }]`;
  const compose = `  prometheus:
    image: prom/prometheus:latest
    volumes: ["./prometheus.yml:/etc/prometheus/prometheus.yml:ro"]
    ports: ["9090:9090"]
  grafana:
    image: grafana/grafana:latest
    environment: { GF_AUTH_ANONYMOUS_ENABLED: "true" }
    ports: ["3001:3000"]
    depends_on: [prometheus]`;
  return [
    `## 7. Observability — Prometheus + Grafana`,
    ``,
    `Expose \`/metrics\` from the app (\`prom-client\` for Node), scrape with Prometheus, dashboard in Grafana.`,
    ``,
    `Instrument the app:`,
    fence("bash", `npm i prom-client`),
    fence("ts", `import client from "prom-client";\nclient.collectDefaultMetrics();\n// app.get("/metrics", async (_req, res) => res.type(client.register.contentType).send(await client.register.metrics()));`),
    ``,
    `\`prometheus.yml\`:`,
    fence("yaml", prom),
    ``,
    `Add to \`docker-compose.yml\` (or use the \`kube-prometheus-stack\` Helm chart on k8s):`,
    fence("yaml", compose),
    ``,
  ].join("\n");
}

export interface DevopsBlueprint {
  scale: TargetScale;
  included: string[];
  markdown: string;
}

export function devopsBlueprint(
  repo: Repo,
  opts: { prescriptions?: InfraPrescription[] } = {},
): DevopsBlueprint {
  const choices = readChoices(repo.root);
  const scale: TargetScale = choices?.scale ?? "growing";
  const deployTarget = choices?.deployTarget;
  const app = appProfile(repo);
  const prescriptions = opts.prescriptions ?? [];
  const selectedInfra = choices?.infraAll ? prescriptions.map((p) => p.component) : choices?.infra ?? [];
  const kw = infraKeywords(repo, prescriptions, selectedInfra);
  // k8s/large lean toward nginx-ingress; otherwise Caddy.
  const preferNginx = scale === "large" || (deployTarget ?? "").toLowerCase().includes("kube");

  const sections: string[] = [ciSection(app, deployTarget), huskySection(), dockerSection(app)];
  const included = ["CI/CD (GitHub Actions)", "Husky git hooks", "Docker (multi-stage)"];

  // compose: when there's infra to stand up, or beyond the smallest scale.
  if (kw.size > 0 || scale !== "small") {
    sections.push(composeSection(app, kw));
    included.push("docker-compose");
  }
  sections.push(proxySection(app, preferNginx));
  included.push(preferNginx ? "nginx reverse proxy" : "Caddy reverse proxy");

  // k8s + full observability only when the declared scale earns the operational cost.
  if (scale === "large") {
    sections.push(k8sSection(app), observabilitySection());
    included.push("Kubernetes (Deployment/Service/HPA)", "Prometheus + Grafana");
  }

  const scaleLine =
    scale === "small"
      ? `Right-sized for a **small / early** project: CI, hooks, a container, and a reverse proxy. No Kubernetes or a metrics stack yet — that's operational weight you don't need at this scale (add it when traffic justifies it).`
      : scale === "growing"
        ? `Right-sized for a **growing** project: the above plus a local stack with your infra. Kubernetes + Prometheus/Grafana are held back until you're closer to high traffic.`
        : `Sized for **~1M / high traffic**: the full deck including Kubernetes (autoscaling, probes, limits) and a Prometheus + Grafana observability stack.`;

  const markdown = [
    `# Shepherd — DevOps & infrastructure work-order`,
    ``,
    `_Generated for a ${detectStack(repo).language} / ${app.isNext ? "Next.js" : "Node"} app on port ${app.port}. Shepherd describes it; you (or your Claude Code session) drop the files in._`,
    ``,
    scaleLine,
    ``,
    `**Included:** ${included.join(" · ")}.`,
    selectedInfra.length ? `**Your infra:** ${selectedInfra.join(", ")}.` : ``,
    `These configs set the security headers and rate limit the live probe checks for, and the CI/k8s gates wire to \`/healthz\`,\`/readyz\` — so they close real findings, not just boilerplate.`,
    ``,
    `---`,
    ``,
    ...sections,
    `---`,
    ``,
    `Copy each into your repo (or ask your Claude Code session: _"create the files in \`.shepherd/devops-order.md\`"_). Re-run \`npx shepherd\` after to confirm the security/ops findings clear.`,
    ``,
  ].join("\n");

  return { scale, included, markdown };
}

export function writeDevopsOrder(root: string, markdown: string): string {
  const project = loadProject(root);
  const abs = path.join(project.dir, "devops-order.md");
  writeFileSync(abs, markdown);
  return path.relative(root, abs);
}
