import { AuthenticationService } from "@live-competition-engine/auth";
import { createPostgresAuthStore } from "@live-competition-engine/db/auth-store";

let service: AuthenticationService | undefined;

/** Lazily constructed process-wide authentication service backed by PostgreSQL. */
export function authService(): AuthenticationService {
  service ??= new AuthenticationService(createPostgresAuthStore());
  return service;
}
