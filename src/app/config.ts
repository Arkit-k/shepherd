import { z } from "zod";

// Env config for the Shepherd GitHub App. The three GitHub secrets come from
// registering the App (App ID + a generated private key + the webhook secret you
// set). PRIVATE_KEY is a PEM; many hosts store it with literal "\n" — we unescape.

const Env = z.object({
  APP_ID: z.string().min(1),
  PRIVATE_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  PORT: z.string().optional(),
});

export interface AppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  port: number;
}

export function loadConfig(): AppConfig {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Shepherd App misconfigured — missing/invalid env: ${missing}. ` +
        `Set APP_ID, PRIVATE_KEY (PEM), and WEBHOOK_SECRET (see src/app/README.md).`,
    );
  }
  const e = parsed.data;
  const privateKey = e.PRIVATE_KEY.includes("\\n") ? e.PRIVATE_KEY.replace(/\\n/g, "\n") : e.PRIVATE_KEY;
  return { appId: e.APP_ID, privateKey, webhookSecret: e.WEBHOOK_SECRET, port: Number(e.PORT) || 3000 };
}
