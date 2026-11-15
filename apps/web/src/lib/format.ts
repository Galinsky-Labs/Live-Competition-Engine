export function formatInZone(date: Date | string | null | undefined, timeZone: string): string {
  if (!date) return "To be announced";
  const value = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long", timeZone }).format(value);
}
