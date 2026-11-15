/** Format an instant in the event's own IANA time zone, with the zone name shown. */
export function formatInZone(date: Date | null, timeZone: string): string | null {
  if (!date) return null;
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "full", timeStyle: "short", timeZone, timeZoneName: "short" }).format(date);
  } catch {
    return date.toISOString();
  }
}

export const STATUS_LABEL: Record<string, string> = {
  published: "Upcoming",
  live: "Live now",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  draft: "Draft"
};
