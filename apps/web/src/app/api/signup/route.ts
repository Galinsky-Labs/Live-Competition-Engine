import { authService, signupDeps } from "../../../lib/signup-services";
import { createSignupHandlers } from "./handler";

const handlers = createSignupHandlers(authService(), signupDeps);

export async function POST(request: Request) {
  return handlers.signup(request);
}
