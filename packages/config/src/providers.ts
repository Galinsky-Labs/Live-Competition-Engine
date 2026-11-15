import { z } from "zod";

/**
 * Optional external-provider credentials. Every value is optional so the engine
 * boots without them; adapters must call the matching `require*` function and
 * fail closed (DomainError "provider_not_configured") when a value is missing.
 */
export const providerEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().startsWith("sk_").optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
  MUX_TOKEN_ID: z.string().min(1).optional(),
  MUX_TOKEN_SECRET: z.string().min(1).optional(),
  MUX_WEBHOOK_SECRET: z.string().min(1).optional(),
  POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
  EMAIL_FROM_DEFAULT: z.string().email().optional(),
  JOB_WORKER_SECRET: z.string().min(32).optional()
});

export type ProviderEnv = z.infer<typeof providerEnvSchema>;

export function parseProviderEnv(source: NodeJS.ProcessEnv = process.env): ProviderEnv {
  const picked = Object.fromEntries(
    Object.keys(providerEnvSchema.shape).map(key => [key, source[key] === "" ? undefined : source[key]])
  );
  return providerEnvSchema.parse(picked);
}

export class ProviderNotConfiguredError extends Error {
  readonly code = "provider_not_configured";
  constructor(readonly provider: string) {
    super(`${provider} is not configured`);
  }
}

export function requireStripe(env = parseProviderEnv()) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) throw new ProviderNotConfiguredError("stripe");
  return { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET };
}

export function requireMux(env = parseProviderEnv()) {
  if (!env.MUX_TOKEN_ID || !env.MUX_TOKEN_SECRET || !env.MUX_WEBHOOK_SECRET) throw new ProviderNotConfiguredError("mux");
  return { tokenId: env.MUX_TOKEN_ID, tokenSecret: env.MUX_TOKEN_SECRET, webhookSecret: env.MUX_WEBHOOK_SECRET };
}

export function requirePostmark(env = parseProviderEnv()) {
  if (!env.POSTMARK_SERVER_TOKEN || !env.EMAIL_FROM_DEFAULT) throw new ProviderNotConfiguredError("postmark");
  return { serverToken: env.POSTMARK_SERVER_TOKEN, defaultFrom: env.EMAIL_FROM_DEFAULT };
}
