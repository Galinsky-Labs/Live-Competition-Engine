import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { isUuid } from "@live-competition-engine/domain";
import styles from "./console.module.css";

const sections = [
  ["selection", "Selection"],
  ["judges", "Judges"],
  ["judging", "Judging"],
  ["moderation", "Scores and critiques"]
] as const;

/**
 * Server-rendered shell shared by the producer/judge consoles. It renders no event data:
 * all data is loaded by the client component through the authenticated APIs.
 */
export function ConsoleShell({ organizationId, competitionId, current, title, intro, children }: {
  organizationId: string; competitionId: string; current: (typeof sections)[number][0]; title: string; intro: string; children: ReactNode;
}) {
  if (!isUuid(organizationId) || !isUuid(competitionId)) notFound();
  const base = `/console/${organizationId}/competitions/${competitionId}`;
  return (
    <main className={styles.console}>
      <nav aria-label="Event console">
        <ul>
          {sections.map(([slug, label]) => (
            <li key={slug}>
              <a href={`${base}/${slug}`} aria-current={slug === current ? "page" : undefined}>{label}</a>
            </li>
          ))}
        </ul>
      </nav>
      <h1>{title}</h1>
      <p className={styles.muted}>{intro}</p>
      {children}
    </main>
  );
}
