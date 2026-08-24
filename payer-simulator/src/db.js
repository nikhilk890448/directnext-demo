import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — set them in this service's environment.");
}

// This service shares the same Supabase project as the main backend, but
// only ever touches the eligibility_requests table and reads the minimal
// journey_id it needs — it never touches patients directly. A production
// version of this would live behind the payer's own systems entirely.
export const supabase = createClient(url, key, { auth: { persistSession: false } });
