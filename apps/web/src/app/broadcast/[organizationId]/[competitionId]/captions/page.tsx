import type { Metadata } from "next";
import { renderBroadcastPage, type BroadcastPageProps } from "../shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Captions · Broadcast", robots: { index: false, follow: false } };

/** Public captions page for browser sources. Append ?transparent=1 for a transparent background. */
export default function CaptionsPage(props: BroadcastPageProps) {
  return renderBroadcastPage("captions", props);
}
