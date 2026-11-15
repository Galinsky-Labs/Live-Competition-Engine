import { describe, expect, it } from "vitest";
import { parseProviderEnv, ProviderNotConfiguredError, requireMux, requirePostmark, requireStripe } from "./providers";

describe("provider configuration", () => {
  it("boots without credentials and fails closed when a provider is required", () => {
    const env = parseProviderEnv({});
    expect(() => requireStripe(env)).toThrow(ProviderNotConfiguredError);
    expect(() => requireMux(env)).toThrow(ProviderNotConfiguredError);
    expect(() => requirePostmark(env)).toThrow(ProviderNotConfiguredError);
  });
  it("accepts well-formed credentials and rejects malformed ones", () => {
    expect(requireStripe(parseProviderEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })).secretKey).toBe("sk_test_x");
    expect(() => parseProviderEnv({ STRIPE_SECRET_KEY: "pk_live_x" })).toThrow();
  });
});
