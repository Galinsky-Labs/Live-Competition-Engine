import type { ReactNode } from "react";
import styles from "./admin.module.css";

const sections = [
  ["", "Overview"],
  ["members", "Members"],
  ["venues", "Venues"],
  ["features", "Features"]
] as const;

export function AdminShell({ organizationId, title, children }: { organizationId: string; title: string; children: ReactNode }) {
  return (
    <main className={styles.console}>
      <p className="eyebrow">Tenant administration</p>
      <nav className={styles.nav} aria-label="Administration sections">
        <ul>
          {sections.map(([path, label]) => (
            <li key={path}>
              <a href={`/admin/${organizationId}${path ? `/${path}` : ""}`}>{label}</a>
            </li>
          ))}
        </ul>
      </nav>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

export function AccessDenied({ reason }: { reason: "unauthenticated" | "forbidden" | "not_found" }) {
  const message = reason === "unauthenticated"
    ? "Sign in with an account that administers this tenant."
    : reason === "forbidden" ? "Your account cannot administer this tenant." : "This tenant was not found.";
  return (
    <main className={styles.console}>
      <h1>Access denied</h1>
      <p role="alert">{message}</p>
    </main>
  );
}

export function tableClass() {
  return styles.table;
}

export function countsClass() {
  return styles.counts;
}

export function noticeClass() {
  return styles.notice;
}

export function formatDate(value: Date | string | null): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
