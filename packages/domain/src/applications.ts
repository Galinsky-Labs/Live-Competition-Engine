import { DomainError, isBoundedText, isUuid } from "./index.ts";

/**
 * LC-17 application forms, answers and status machine. Pure: no I/O, the clock is
 * passed in. Every invalid input throws DomainError with a stable snake_case code.
 */

export const applicationStatuses = [
  "draft", "submitted", "under_review", "selected", "waitlisted", "declined", "withdrawn"
] as const;
export type ApplicationStatus = (typeof applicationStatuses)[number];
export type ApplicationActor = "applicant" | "producer" | "system";

export const MAX_FORM_FIELDS = 50;
export const MAX_TEXT_LENGTH = 5000;
export const MAX_CHOICE_OPTIONS = 50;
export const MAX_MEDIA_ITEMS = 5;

const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CONSENT_VERSION = /^[a-z0-9][a-z0-9._-]{0,39}$/;

interface FieldBase { key: string; label: string; required: boolean; }
export interface TextField extends FieldBase { type: "text"; maxLength: number; multiline: boolean; }
export interface ChoiceField extends FieldBase { type: "choice"; options: { value: string; label: string }[]; multiple: boolean; }
export interface MediaField extends FieldBase { type: "media"; maxItems: number; }
export interface ConsentField extends FieldBase { type: "consent"; consentVersion: string; }
export type FormField = TextField | ChoiceField | MediaField | ConsentField;

export interface ApplicationFormDefinition {
  opensAt: Date;
  closesAt: Date;
  /** Maximum number of selected applications; null = unbounded. */
  capacity: number | null;
  /** Consent field whose acceptance allows reviewers to see the applicant's contact email. */
  contactConsentKey: string | null;
  fields: FormField[];
}

const invalidForm = (): never => { throw new DomainError("invalid_application_form"); };

function parseDate(value: unknown): Date {
  if (typeof value !== "string" && !(value instanceof Date)) return invalidForm();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return invalidForm();
  return date;
}

function parseField(raw: unknown): FormField {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalidForm();
  const input = raw as Record<string, unknown>;
  if (typeof input.key !== "string" || !FIELD_KEY.test(input.key)) return invalidForm();
  if (!isBoundedText(input.label, 200, 1) || input.label.trim() === "") return invalidForm();
  if (input.required !== undefined && typeof input.required !== "boolean") return invalidForm();
  const base = { key: input.key, label: input.label as string, required: input.required === true };
  switch (input.type) {
    case "text": {
      const maxLength = input.maxLength ?? 500;
      if (!Number.isSafeInteger(maxLength) || (maxLength as number) < 1 || (maxLength as number) > MAX_TEXT_LENGTH) return invalidForm();
      if (input.multiline !== undefined && typeof input.multiline !== "boolean") return invalidForm();
      return { ...base, type: "text", maxLength: maxLength as number, multiline: input.multiline === true };
    }
    case "choice": {
      if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > MAX_CHOICE_OPTIONS) return invalidForm();
      const options = input.options.map(option => {
        const o = option as Record<string, unknown>;
        if (!o || typeof o !== "object" || !isBoundedText(o.value, 80, 1) || !isBoundedText(o.label, 200, 1)) return invalidForm();
        return { value: o.value as string, label: o.label as string };
      });
      if (new Set(options.map(o => o.value)).size !== options.length) return invalidForm();
      if (input.multiple !== undefined && typeof input.multiple !== "boolean") return invalidForm();
      return { ...base, type: "choice", options, multiple: input.multiple === true };
    }
    case "media": {
      const maxItems = input.maxItems ?? 1;
      if (!Number.isSafeInteger(maxItems) || (maxItems as number) < 1 || (maxItems as number) > MAX_MEDIA_ITEMS) return invalidForm();
      return { ...base, type: "media", maxItems: maxItems as number };
    }
    case "consent": {
      if (typeof input.consentVersion !== "string" || !CONSENT_VERSION.test(input.consentVersion)) return invalidForm();
      return { ...base, type: "consent", consentVersion: input.consentVersion };
    }
    default:
      return invalidForm();
  }
}

/** Validate a producer-supplied form definition. Bounded, closed set of field types. */
export function parseApplicationForm(raw: unknown): ApplicationFormDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalidForm();
  const input = raw as Record<string, unknown>;
  const opensAt = parseDate(input.opensAt);
  const closesAt = parseDate(input.closesAt);
  if (closesAt.getTime() <= opensAt.getTime()) return invalidForm();
  const capacity = input.capacity ?? null;
  if (capacity !== null && (!Number.isSafeInteger(capacity) || (capacity as number) < 1 || (capacity as number) > 100000)) return invalidForm();
  if (!Array.isArray(input.fields) || input.fields.length > MAX_FORM_FIELDS) return invalidForm();
  const fields = (input.fields as unknown[]).map(parseField);
  if (new Set(fields.map(f => f.key)).size !== fields.length) return invalidForm();
  const contactConsentKey = input.contactConsentKey ?? null;
  if (contactConsentKey !== null &&
      !fields.some(f => f.type === "consent" && f.key === contactConsentKey)) return invalidForm();
  return { opensAt, closesAt, capacity: capacity as number | null, contactConsentKey: contactConsentKey as string | null, fields };
}

export type AnswerValue = string | string[] | boolean;
export interface NormalizedAnswers {
  answers: Record<string, AnswerValue>;
  /** Accepted consents (key + version) present in the answers. */
  consents: { key: string; version: string }[];
  /** Media ids referenced by media fields, with the field they belong to. */
  media: { fieldKey: string; mediaId: string }[];
}

const invalidAnswers = (): never => { throw new DomainError("invalid_application_answers"); };

/**
 * Validate answers against a form. Drafts may omit required fields; submission
 * (`complete: true`) requires every required field and every required consent.
 * Unknown keys are rejected so the stored document stays bounded by the form.
 */
export function validateAnswers(form: Pick<ApplicationFormDefinition, "fields">, raw: unknown, options: { complete: boolean }): NormalizedAnswers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalidAnswers();
  const input = raw as Record<string, unknown>;
  const byKey = new Map(form.fields.map(f => [f.key, f]));
  for (const key of Object.keys(input)) if (!byKey.has(key)) return invalidAnswers();
  const answers: Record<string, AnswerValue> = {};
  const consents: NormalizedAnswers["consents"] = [];
  const media: NormalizedAnswers["media"] = [];
  for (const field of form.fields) {
    const value = input[field.key];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0) ||
        (field.type === "consent" && value === false)) {
      if (options.complete && field.required) throw new DomainError("application_incomplete");
      continue;
    }
    switch (field.type) {
      case "text":
        if (!isBoundedText(value, field.maxLength, 1)) return invalidAnswers();
        if (!field.multiline && /[\n\t]/.test(value)) return invalidAnswers();
        answers[field.key] = value;
        break;
      case "choice": {
        const values = field.multiple ? value : [value];
        if (!Array.isArray(values) || values.length > field.options.length) return invalidAnswers();
        const allowed = new Set(field.options.map(o => o.value));
        if (!values.every(v => typeof v === "string" && allowed.has(v)) || new Set(values).size !== values.length) return invalidAnswers();
        answers[field.key] = field.multiple ? [...(values as string[])] : (values[0] as string);
        break;
      }
      case "media": {
        if (!Array.isArray(value) || value.length > field.maxItems || !value.every(isUuid)) return invalidAnswers();
        const ids = (value as string[]).map(v => v.toLowerCase());
        if (new Set(ids).size !== ids.length) return invalidAnswers();
        answers[field.key] = ids;
        for (const mediaId of ids) media.push({ fieldKey: field.key, mediaId });
        break;
      }
      case "consent":
        if (value !== true) return invalidAnswers();
        answers[field.key] = true;
        consents.push({ key: field.key, version: field.consentVersion });
        break;
    }
  }
  return { answers, consents, media };
}

export function validateDisplayName(value: unknown): string {
  if (!isBoundedText(value, 120, 1) || /[\n\t]/.test(value) || value.trim() === "") {
    throw new DomainError("invalid_display_name");
  }
  return value.trim();
}

/** Applicant writes (create, edit, submit) are allowed only inside [opensAt, closesAt). */
export function assertWindowOpen(form: Pick<ApplicationFormDefinition, "opensAt" | "closesAt">, now: Date): void {
  if (now.getTime() < form.opensAt.getTime()) throw new DomainError("application_window_not_open");
  if (now.getTime() >= form.closesAt.getTime()) throw new DomainError("application_deadline_passed");
}

const transitions: Readonly<Record<ApplicationStatus, Partial<Record<ApplicationStatus, readonly ApplicationActor[]>>>> = {
  draft: { submitted: ["applicant"], withdrawn: ["applicant"] },
  submitted: { under_review: ["producer"], selected: ["producer"], waitlisted: ["producer"], declined: ["producer"], withdrawn: ["applicant"] },
  under_review: { selected: ["producer"], waitlisted: ["producer"], declined: ["producer"], withdrawn: ["applicant"] },
  waitlisted: { selected: ["producer", "system"], declined: ["producer"], withdrawn: ["applicant"] },
  selected: { withdrawn: ["applicant"] },
  // A declined application can be reopened for review (a revised decision), with a reason.
  declined: { under_review: ["producer"] },
  withdrawn: {}
};

export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return typeof value === "string" && (applicationStatuses as readonly string[]).includes(value);
}

export function canTransition(from: ApplicationStatus, to: ApplicationStatus, actor: ApplicationActor): boolean {
  return transitions[from][to]?.includes(actor) ?? false;
}

/** Throws invalid_state_transition when the actor may not move the application. */
export function assertTransition(from: ApplicationStatus, to: ApplicationStatus, actor: ApplicationActor): void {
  if (!canTransition(from, to, actor)) throw new DomainError("invalid_state_transition");
}

/** Producer decisions that require a written reason (kept in the decision history). */
export function decisionRequiresReason(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return to === "declined" || (from === "declined" && to === "under_review");
}

export function validateReason(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new DomainError("decision_reason_required");
    return null;
  }
  if (!isBoundedText(value, 1000, 1)) throw new DomainError("invalid_decision_reason");
  return value;
}

/** Waitlist promotion order: lowest position first, then earliest waitlisting, then id. */
export function nextToPromote<T extends { id: string; waitlistPosition: number | null; waitlistedAt: Date | null }>(waitlisted: readonly T[]): T | null {
  const sorted = [...waitlisted].filter(w => w.waitlistPosition !== null).sort((a, b) =>
    (a.waitlistPosition! - b.waitlistPosition!) ||
    ((a.waitlistedAt?.getTime() ?? 0) - (b.waitlistedAt?.getTime() ?? 0)) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted[0] ?? null;
}

/** Selection is refused once the competition's capacity is reached. */
export function assertCapacity(capacity: number | null, selectedCount: number): void {
  if (capacity !== null && selectedCount >= capacity) throw new DomainError("selection_capacity_conflict");
}
