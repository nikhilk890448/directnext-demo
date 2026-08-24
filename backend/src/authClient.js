import { createClient } from "@supabase/supabase-js";

// A dedicated client used ONLY for patient-facing auth calls (sign-in, token
// verification) — never for reading/writing tables. The main `supabase`
// client in db.js is a shared singleton used everywhere else for service-role
// data access; calling auth.signInWithPassword() or auth.getUser() on THAT
// client would overwrite its internal session with whichever patient just
// authenticated, silently downgrading every other query in the app from
// service_role to that patient's own low-privileged session until the
// process restarts. Keeping auth calls on this separate instance prevents
// that entirely.
export const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
