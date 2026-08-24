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
  if (!token) {
    console.log("[patient-auth] no token in Authorization header");
    return res.status(401).json({ ok: false, error: "missing_token" });
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    console.log("[patient-auth] getUser failed:", userErr?.message || "no user returned");
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
  console.log("[patient-auth] token resolved to auth user id:", userData.user.id, userData.user.email);

  const { data: patient, error: pErr } = await supabase
    .from("patients")
    .select("*")
    .eq("auth_user_id", userData.user.id)
    .maybeSingle();
  if (pErr) {
    console.log("[patient-auth] patients query error:", pErr.message);
    return res.status(401).json({ ok: false, error: "no_patient_for_account" });
  }
  if (!patient) {
    console.log("[patient-auth] no patient row matched auth_user_id:", userData.user.id);
    return res.status(401).json({ ok: false, error: "no_patient_for_account" });
  }

  req.patient = patient;
  next();
}
