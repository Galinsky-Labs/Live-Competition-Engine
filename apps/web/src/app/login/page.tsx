import Link from "next/link";
import { JsonForm } from "@/components/json-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="shell narrow">
      <h1>Sign in</h1>
      <JsonForm
        action="/api/auth/login"
        submitLabel="Sign in"
        redirectTo="/dashboard"
        fields={[
          { name: "email", label: "Email", type: "email", required: true, autoComplete: "email" },
          { name: "password", label: "Password", type: "password", required: true, autoComplete: "current-password" }
        ]}
      />
      <p>No account? <Link href="/signup">Create one</Link>.</p>
    </main>
  );
}
