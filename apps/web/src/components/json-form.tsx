"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

export interface FieldSpec {
  name: string;
  label: string;
  type?: "text" | "email" | "password" | "number" | "datetime-local" | "textarea" | "select" | "checkbox" | "url";
  required?: boolean;
  autoComplete?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
}

export interface JsonFormProps {
  action: string;
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  fields: FieldSpec[];
  submitLabel: string;
  /** Static values merged into the body. */
  extra?: Record<string, unknown>;
  /** Where to go after success; `refresh` re-renders the current page. */
  redirectTo?: string | "refresh";
  /** Optional transform, e.g. to nest fields. */
  shape?: "flat" | "json-field";
  /** Nest number fields under this key (e.g. `scores`). */
  nest?: string;
  children?: ReactNode;
}

const messages: Record<string, string> = {
  invalid: "Email or password is incorrect.",
  throttled: "Too many attempts. Please wait 15 minutes and try again.",
  email_taken: "An account with that email already exists.",
  password_too_short: "Use a password of at least 12 characters.",
  email_invalid: "Enter a valid email address.",
  forbidden: "You do not have permission to do that.",
  missing: "Please sign in first."
};

export function JsonForm({ action, method = "POST", fields, submitLabel, extra, redirectTo = "refresh", nest, children }: JsonFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = { ...extra };
    for (const field of fields) {
      const raw = form.get(field.name);
      if (field.type === "checkbox") body[field.name] = raw === "on";
      else if (raw === null || raw === "") continue;
      else if (field.type === "number" && nest) body[nest] = { ...(body[nest] as Record<string, unknown> | undefined), [field.name]: Number(raw) };
      else if (field.type === "number") body[field.name] = Number(raw);
      else if (field.type === "datetime-local") body[field.name] = new Date(String(raw)).toISOString();
      else if (field.name.endsWith("Json")) {
        try {
          body[field.name.slice(0, -4)] = JSON.parse(String(raw));
        } catch {
          setBusy(false);
          setError(`${field.label} must be valid JSON.`);
          return;
        }
      } else body[field.name] = String(raw);
    }
    try {
      const response = await fetch(action, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin"
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(messages[payload.error ?? ""] ?? `Request failed (${payload.error ?? response.status}).`);
        return;
      }
      if (redirectTo === "refresh") {
        (event.target as HTMLFormElement).reset();
        router.refresh();
      } else router.push(redirectTo);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={onSubmit} noValidate={false}>
      {fields.map(field => (
        <label key={field.name} className={field.type === "checkbox" ? "check" : undefined}>
          <span>{field.label}</span>
          {field.type === "textarea" ? (
            <textarea name={field.name} required={field.required} defaultValue={field.defaultValue as string | undefined} rows={4} />
          ) : field.type === "select" ? (
            <select name={field.name} required={field.required} defaultValue={field.defaultValue as string | undefined}>
              {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ) : field.type === "checkbox" ? (
            <input type="checkbox" name={field.name} defaultChecked={Boolean(field.defaultValue)} />
          ) : (
            <input
              name={field.name}
              type={field.type ?? "text"}
              required={field.required}
              autoComplete={field.autoComplete}
              defaultValue={field.defaultValue as string | number | undefined}
              min={field.min}
              max={field.max}
              step={field.step}
            />
          )}
          {field.help ? <small>{field.help}</small> : null}
        </label>
      ))}
      {children}
      {error ? <p role="alert" className="error">{error}</p> : null}
      <button type="submit" disabled={busy}>{busy ? "Working…" : submitLabel}</button>
    </form>
  );
}

/** A single-click action button (e.g. publish, start timer). */
export function ActionButton({ action, method = "POST", body, label, confirm: confirmText }: { action: string; method?: "POST" | "DELETE" | "PUT" | "PATCH"; body?: Record<string, unknown>; label: string; confirm?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span className="action">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          if (confirmText && !window.confirm(confirmText)) return;
          setBusy(true);
          setError(null);
          const response = await fetch(action, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), credentials: "same-origin" });
          setBusy(false);
          if (!response.ok) {
            const payload = (await response.json().catch(() => ({}))) as { error?: string };
            setError(messages[payload.error ?? ""] ?? payload.error ?? String(response.status));
            return;
          }
          router.refresh();
        }}
      >
        {label}
      </button>
      {error ? <span role="alert" className="error"> {error}</span> : null}
    </span>
  );
}

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="link"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
