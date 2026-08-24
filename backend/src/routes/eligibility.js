import { Router } from "express";
import { supabase } from "../db.js";
import { appendAudit } from "../hash.js";
import { STAGES, nextStage, dueAt } from "../workflow.js";

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

// POST /api/journeys/:id/eligibility-decision
eligibilityRouter.post("/:id/eligibility-decision", checkSharedSecret, async (req, res) => {
  const { id } = req.params;
  const { status, decision } = req.body || {}; // status: "approved" | "denied"

  const { data: journey } = await supabase.from("journeys").select("*").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });

  await appendAudit({
    journeyId: id,
    actor: "payer-simulator",
    decision: `eligibility ${status}${decision?.planName ? ` — ${decision.planName}` : ""}`,
    fieldsShared: "coverage status, benefit tier only",
    consentBasis: "treatment",
  });

  if (status === "denied") {
    await supabase.from("tasks").insert({
      journey_id: id,
      type: "Prior authorization denied",
      reason: decision?.reason || "Payer denied coverage for this therapy",
      priority: "high",
      assigned_role: "Access & Benefits",
    });
    return res.json({ ok: true, held: true });
  }

  // Approved — close out insurance_pa stage and advance, same shape as
  // the "simulate-next" flow uses elsewhere.
  const now = new Date();
  const enteredAt = new Date(journey.stage_entered_at);
  await supabase.from("stage_history").insert({
    journey_id: id, stage: journey.current_stage, entered_at: journey.stage_entered_at,
    exited_at: now.toISOString(), duration_hours: +((now - enteredAt) / 3600000).toFixed(2),
  });

  const next = nextStage(journey.current_stage) || STAGES[STAGES.length - 1];
  await supabase.from("journeys").update({
    current_stage: next.key, status: "in_progress",
    stage_entered_at: now.toISOString(),
    sla_due_at: dueAt(now, next.slaHours),
    updated_at: now.toISOString(),
  }).eq("id", id);

  await supabase.from("journey_events").insert({ journey_id: id, event_type: "eligibility_approved", payload: {} });

  res.json({ ok: true, held: false, stage: next.key });
});
