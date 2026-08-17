import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Migrations are generated from the schema and applied by src/db/migrate.ts,
  // which works against both PGlite (dev/test) and real Postgres.
  strict: true,
  verbose: true,
} satisfies Config;
