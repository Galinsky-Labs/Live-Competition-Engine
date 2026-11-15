import type { Metadata } from "next";
import { renderBroadcastPage, type BroadcastPageProps } from "../shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Overlay · Broadcast", robots: { index: false, follow: false } };

/** Public overlay page for browser sources. Append ?transparent=1 for a transparent background. */
export default function OverlayPage(props: BroadcastPageProps) {
  return renderBroadcastPage("overlay", props);
}
