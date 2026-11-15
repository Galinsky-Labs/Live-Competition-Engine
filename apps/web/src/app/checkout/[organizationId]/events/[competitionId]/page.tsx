import { isUuid } from "@live-competition-engine/domain";
import { listTicketTypes, ticketTypeView } from "@live-competition-engine/db/ticketing";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const formatPrice = (minor: number, currency: string) => {
  if (minor === 0) return "Free";
  try {
    const format = new Intl.NumberFormat("en", { style: "currency", currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  } catch {
    return `${minor} ${currency} (minor units)`;
  }
};

/**
 * Public ticket listing for an event. Only families enabled for the event are
 * listed, so a disabled family shows no price at all. Purchases go through the
 * authenticated API (POST …/ticket-types/{ticketTypeId}/orders), which returns a
 * hosted-checkout redirect.
 */
export default async function EventTicketsPage({ params }: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await params;
  if (!isUuid(organizationId) || !isUuid(competitionId)) notFound();
  let types: ReturnType<typeof ticketTypeView>[] = [];
  try {
    types = (await listTicketTypes(organizationId, competitionId)).map(type => ticketTypeView(type));
  } catch {
    notFound();
  }
  return (
    <main className="shell">
      <p className="eyebrow">Event access</p>
      <h1>Tickets and passes</h1>
      {types.length === 0 ? (
        <p className="lede">This event does not sell access. Entry is open.</p>
      ) : (
        <table>
          <caption>Available ticket types</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Price</th>
              <th scope="col">Availability</th>
            </tr>
          </thead>
          <tbody>
            {types.map(type => (
              <tr key={type.id}>
                <th scope="row">{type.name}</th>
                <td>{type.kind === "ppv" ? "Pay-per-view stream" : "Entry ticket"}</td>
                <td>{formatPrice(type.priceMinor, type.currency)}</td>
                <td>
                  {!type.onSale ? "Not on sale" : type.remaining === null ? "Available" : type.remaining === 0 ? "Sold out" : `${type.remaining} left`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
