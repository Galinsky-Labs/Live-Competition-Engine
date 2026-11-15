/** Browser-tab storage for the bearer session issued at signup (sessionStorage, cleared with the tab). */
export const SESSION_KEY = "lce.signup.session";

export interface StoredSession {
  token: string;
  organizationId: string;
  accountId: string;
}

export function readStoredSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredSession>;
    return typeof value.token === "string" && typeof value.organizationId === "string" && typeof value.accountId === "string"
      ? (value as StoredSession)
      : null;
  } catch {
    return null;
  }
}
