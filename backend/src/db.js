import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  // Fail loudly at boot rather than silently returning empty data later.
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars. " +
    "Set them in Render → your service → Environment before the app can talk to the database."
  );
}

// IMPORTANT: this is the service_role key. It bypasses Row Level Security and
// can read PHI. It must only ever live here, on the backend, as a server
// environment variable — never in the storefront or dashboard frontend code,
// and never committed to git.
export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});
