import { defineConfig } from "drizzle-kit";
import { parseServerEnv } from "@live-competition-engine/config";

const env = parseServerEnv();

// Migrations prefer a direct (non-pooled) connection when one is provided;
// the runtime keeps using the pooled DATABASE_URL.
const migrationUrl = process.env.DATABASE_MIGRATION_URL?.trim() || env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: migrationUrl
  },
  strict: true,
  verbose: true
});
