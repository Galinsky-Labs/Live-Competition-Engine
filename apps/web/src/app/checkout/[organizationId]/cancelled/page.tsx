export const dynamic = "force-dynamic";

/** Landing page when the buyer leaves hosted checkout without paying. */
export default async function CheckoutCancelledPage({ searchParams }: { searchParams: Promise<{ reference?: string }> }) {
  const { reference } = await searchParams;
  const safeReference = typeof reference === "string" && /^[0-9a-f-]{36}$/i.test(reference) ? reference : null;
  return (
    <main className="shell">
      <p className="eyebrow">Checkout</p>
      <h1>Payment not completed</h1>
      <p className="lede">
        No charge was made. Any seat held for you is released automatically when the checkout
        session expires. You can start a new purchase at any time.
      </p>
      {safeReference ? (
        <p>
          Order reference: <code>{safeReference}</code>
        </p>
      ) : null}
    </main>
  );
}
