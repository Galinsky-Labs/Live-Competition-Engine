import Link from "next/link";
import { JsonForm } from "@/components/json-form";

export const dynamic = "force-dynamic";

export default function SignupPage() {
  return (
    <main className="shell narrow">
      <h1>Create an account</h1>
      <JsonForm
        action="/api/auth/signup"
        submitLabel="Create account"
        redirectTo="/dashboard"
        fields={[
          { name: "email", label: "Email", type: "email", required: true, autoComplete: "email" },
          { name: "password", label: "Password (12+ characters)", type: "password", required: true, autoComplete: "new-password" }
        ]}
      />
      <p>Already registered? <Link href="/login">Sign in</Link>.</p>
    </main>
  );
}
