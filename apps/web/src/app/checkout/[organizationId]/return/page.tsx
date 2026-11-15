import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * Landing page after hosted checkout. It deliberately shows no payment state:
 * the order only changes when the provider's signed webhook arrives, and this
 * page cannot authenticate the visitor. Clients poll the order API instead.
 */
export default async function CheckoutReturnPage({
  params,
  searchParams
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ reference?: string }>;
}) {
  const { organizationId } = await params;
  const { reference } = await searchParams;
  const safeReference = typeof reference === "string" && /^[0-9a-f-]{36}$/i.test(reference) ? reference : null;
  return (
    <main className="shell">
      <p className="eyebrow">Checkout</p>
      <h1>Thanks — we are confirming your payment</h1>
      <p className="lede" role="status">
        Your access is granted as soon as the payment provider confirms the charge. This usually
        takes a few seconds. You can safely close this page.
      </p>
      {safeReference ? (
        <p>
          Order reference: <code>{safeReference}</code>
        </p>
      ) : null}
      <p>
        <Link href={`/checkout/${encodeURIComponent(organizationId)}/cancelled`}>Problems with your payment?</Link>
      </p>
    </main>
  );
}
