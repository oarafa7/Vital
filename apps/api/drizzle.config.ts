import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Only `public` is ours. Without this, drizzle-kit can decide it should
  // manage Supabase's `auth` schema — which `public.users.id` references —
  // and emit CREATE/DROP statements against gotrue's own tables.
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
});
