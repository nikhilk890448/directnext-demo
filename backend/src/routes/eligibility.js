import { Router } from "express";
import { supabase } from "../db.js";
import { appendAudit } from "../hash.js";

export const eligibilityRouter = Router();

// Called by the payer-simulator service — server to server, not a browser
// request, so it's guarded by a shared secret instead of CORS.
function checkSharedSecret(req, res, next) {
  const key = req.headers["x-payer-callback-key"];
  if (!process.env.PAYER_CALLBACK_SECRET || key !== process.env.PAYER_CALLBACK_SECRET) {
    return res.status(401).json({ ok: false, error: "bad_callback_key" });
  }
  next();
}

// POST /api/journeys/:id/eligibility-decision — updates pharmacy_status
// only. The journey's current_stage stays "pharmacy" throughout this
// whole sub-flow; PA approval/denial is a pharmacy-internal state change,
// not a stage transition.
eligibilityRouter.post("/:id/eligibility-decision", checkSharedSecret, async (req, res) => {
  const { id } = req.params;
  const { status, decision } = req.body || {}; // status: "approved" | "denied"

  const { data: journey } = await supabase.from("journeys").select("*").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });

  await appendAudit({
    journeyId: id,
    actor: "payer-simulator",
    decision: `prior authorization ${status}${decision?.planName ? ` — ${decision.planName}` : ""}`,
    fieldsShared: "coverage status, benefit tier only",
    consentBasis: "treatment",
  });

  if (status === "denied") {
    await supabase.from("journeys").update({ pharmacy_status: "insurance_pa_pending" }).eq("id", id);
    await supabase.from("tasks").insert({
      journey_id: id,
      type: "Prior authorization denied",
      reason: decision?.reason || "Payer denied coverage for this therapy",
      priority: "high",
      assigned_role: "Access & Benefits",
    });
    return res.json({ ok: true, held: true });
  }

  await supabase.from("journeys").update({ pharmacy_status: "insurance_approved", updated_at: new Date().toISOString() }).eq("id", id);
  res.json({ ok: true, held: false, pharmacyStatus: "insurance_approved" });
});
