import { authClient } from "./authClient.js";

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

  const { data: userData, error: userErr } = await authClient.auth.getUser(token);
  if (userErr || !userData?.user) {
    console.log("[patient-auth] getUser failed:", userErr?.message || "no user returned");
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
  console.log("[patient-auth] token resolved to auth user id:", userData.user.id, userData.user.email);

  // Bypassing the supabase-js query builder here and hitting PostgREST
  // directly with fetch(). The .from() builder was reliably returning zero
  // rows for this project/key combination even on a dedicated client that
  // never touches auth state — while the identical request over plain HTTP
  // (proven via curl during debugging) works every time. This sidesteps
  // whatever that SDK-level issue is rather than continuing to chase it.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const restUrl = `${process.env.SUPABASE_URL}/rest/v1/patients?auth_user_id=eq.${encodeURIComponent(userData.user.id)}&select=*`;
  let rows;
  
  try {
    const restRes = await fetch(restUrl, {
      method: "GET",
      headers: { 
        // Identifies the routing gateway context
        "apikey": serviceKey, 
        // Bypasses Row-Level Security (RLS) policies completely
        "Authorization": `Bearer ${serviceKey}`, 
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
    });

    // Read as text first to log potential error messages or empty strings
    const rawText = await restRes.text();
    console.log("[patient-auth] direct REST lookup status:", restRes.status, "raw payload:", rawText);
    
    rows = JSON.parse(rawText);
  } catch (e) {
    console.log("[patient-auth] direct REST lookup threw:", e.message);
    return res.status(401).json({ ok: false, error: "no_patient_for_account" });
  }

  // Handle case where PostgREST returns a single error object instead of an array
  const patient = Array.isArray(rows) ? rows[0] : null;
  if (!patient) {
    console.log("[patient-auth] no patient row matched auth_user_id:", userData.user.id, "raw response:", JSON.stringify(rows));
    return res.status(401).json({ ok: false, error: "no_patient_for_account" });
  }

  req.patient = patient;
  next();
}
