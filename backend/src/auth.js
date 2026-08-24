import { supabase } from "./db.js";

/**
 * Verifies the Bearer token from a logged-in patient and attaches the
 * matching patient row (by auth_user_id) to req.patient. This is the only
 * place a request is allowed to read a patient's own full record — the
 * pharma dashboard routes never go through this middleware.
 */
export async function requirePatientAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "missing_token" });

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ ok: false, error: "invalid_token" });

  const { data: patient, error: pErr } = await supabase
    .from("patients")
    .select("*")
    .eq("auth_user_id", userData.user.id)
    .maybeSingle();
  if (pErr || !patient) return res.status(401).json({ ok: false, error: "no_patient_for_account" });

  req.patient = patient;
  next();
}
