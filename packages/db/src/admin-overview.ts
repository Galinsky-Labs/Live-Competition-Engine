/**
 * LC-43 pluggable overview sections for the tenant administration console.
 * Billing (commerce) is built elsewhere; until a provider is registered the
 * section reports "not_configured". Providers must filter by organizationId.
 */

export type SectionResult<T> = { status: "not_configured" } | { status: "ok"; data: T } | { status: "unavailable" };

export interface BillingSummary {
  plan: string | null;
  currency: string | null;
  outstandingMinor: number;
  lastInvoiceAt: string | null;
}

export interface BillingVisibilityProvider {
  summary(organizationId: string): Promise<BillingSummary>;
}

export interface ModerationOverviewCounts {
  reports: Record<"open" | "triaged" | "actioned" | "dismissed", number>;
  activeActions: number;
  openAppeals: number;
  activeLegalHolds: number;
}

export interface ModerationOverviewProvider {
  counts(organizationId: string): Promise<ModerationOverviewCounts>;
}

let billingProvider: BillingVisibilityProvider | null = null;
let moderationProvider: ModerationOverviewProvider | null = null;

export function registerBillingVisibilityProvider(provider: BillingVisibilityProvider | null): void {
  billingProvider = provider;
}

export function registerModerationOverviewProvider(provider: ModerationOverviewProvider | null): void {
  moderationProvider = provider;
}

async function section<T>(load: (() => Promise<T>) | null): Promise<SectionResult<T>> {
  if (!load) return { status: "not_configured" };
  try {
    return { status: "ok", data: await load() };
  } catch {
    // A failing optional section must not take down the console; it reports unavailable.
    return { status: "unavailable" };
  }
}

export async function billingSection(organizationId: string, provider = billingProvider): Promise<SectionResult<BillingSummary>> {
  return section(provider ? () => provider.summary(organizationId) : null);
}

export async function moderationSection(organizationId: string, provider = moderationProvider): Promise<SectionResult<ModerationOverviewCounts>> {
  return section(provider ? () => provider.counts(organizationId) : null);
}
