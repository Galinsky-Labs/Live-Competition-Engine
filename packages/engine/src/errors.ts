/** Domain rule violation with an HTTP-friendly status and a stable code. */
export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) {
    super(message === code ? code : `${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what: string) => new DomainError(404, `${what}_not_found`);
export const conflict = (code: string) => new DomainError(409, code);
export const invalid = (code: string) => new DomainError(400, code);
export const forbidden = (code = "forbidden") => new DomainError(403, code);
