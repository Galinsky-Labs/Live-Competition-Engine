"use client";

import { useCallback } from "react";

export type ApiResult = { ok: boolean; status: number; body: Record<string, unknown> };

const errorText: Record<string, string> = {
  consent_required: "Please accept the audience terms first.",
  rate_limited: "You are going a little fast. Please wait a moment.",
  feature_disabled: "This feature is not available for this event.",
  account_muted: "You are temporarily muted.",
  message_blocked: "That message contains a blocked term.",
  vote_conflict: "You have already voted.",
  voter_not_eligible: "You are not eligible to vote in this window.",
  invalid_state_window_not_open: "Voting is not open right now.",
  ballot_voided: "Your ballot was excluded by the organizers.",
  missing: "An access token is required.",
  forbidden: "You do not have access to this event."
};

export function useApi(token: string) {
  return useCallback(async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> => {
    const response = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = await response.json() as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { ok: response.ok, status: response.status, body: parsed };
  }, [token]);
}

export function describeError(result: ApiResult): string {
  const code = typeof result.body.error === "string" ? result.body.error : `http_${result.status}`;
  return errorText[code] ?? `Request failed (${code}).`;
}

