import type { ReactNode } from "react";
import type { EventRecord } from "@live-competition-engine/db/events";

export interface SectionProps {
  org: { id: string; name: string; slug: string };
  event: EventRecord;
}
export type Section = (props: SectionProps) => Promise<ReactNode> | ReactNode;

/** Units register server-rendered sections for the public event page and the producer console. */
export const eventSections: { public: Section[]; manage: Section[] } = {
  public: [],
  manage: []
};
