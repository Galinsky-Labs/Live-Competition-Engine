import type { Metadata } from "next";
import { renderBroadcastPage, type BroadcastPageProps } from "../shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Scoreboard · Broadcast", robots: { index: false, follow: false } };

/** Public scoreboard page for browser sources. Append ?transparent=1 for a transparent background. */
export default function ScoreboardPage(props: BroadcastPageProps) {
  return renderBroadcastPage("scoreboard", props);
}
