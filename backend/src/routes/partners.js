import { Router } from "express";
import { supabase } from "../db.js";
import { appendAudit } from "../hash.js";
import { nextStage, dueAt } from "../workflow.js";
import { scopeFields } from "../contracts.js";
import { runEligibilityCheck } from "../eligibility-check.js";

export const partnersRouter = Router();

function telehealthView(patient) {
  return scopeFields("telehealth", {
    patient_ref: patient.patient_ref,
    condition: patient.condition,
    narrative: patient.narrative,
    preferred_contact: patient.phone || patient.email,
  });
}
function pharmacyView(patient, journey) {
  const a = patient.address || {};
  const shipping = [a.line, a.city, a.state, a.zip].filter(Boolean).join(", ");
  return scopeFields("pharmacy", {
    patient_ref: patient.patient_ref,
    shipping_address: shipping || null,
    prescription: journey.clinical_summary?.prescribedTherapy || null,
  });
}
async function closeStage(id, journey, stageName) {
  const now = new Date();
  const enteredAt = new Date(journey.stage_entered_at);
  await supabase.from("stage_history").insert({
    journey_id: id, stage: stageName, entered_at: journey.stage_entered_at,
    exited_at: now.toISOString(), duration_hours: +((now - enteredAt) / 3600000).toFixed(2),
  });
  return now;
}
async function plainAdvance(id, current, opts) {
  const now = new Date();
  const next = nextStage(current, opts);
  const status = next ? "in_progress" : "completed";
  const stageKey = next ? next.key : current;
  await supabase.from("journeys").update({
    current_stage: stageKey, status,
    stage_entered_at: now.toISOString(),
    sla_due_at: next ? dueAt(now, next.slaHours) : null,
    updated_at: now.toISOString(),
  }).eq("id", id);
  await supabase.from("journey_events").insert({ journey_id: id, event_type: "stage_advanced", payload: { to: stageKey } });
  await appendAudit({ journeyId: id, actor: "dispatcher", decision: `advanced to ${stageKey}`, fieldsShared: "—" });
  return { stage: stageKey, status };
}

// ============================================================================
// TELEHEALTH — the independent clinician network's own console.
// ============================================================================

partnersRouter.get("/telehealth/queue", async (_req, res) => {
  const { data, error } = await supabase
    .from("journeys")
    .select("id, stage_entered_at, sla_due_at, patients(*)")
    .eq("current_stage", "telehealth")
    .eq("status", "in_progress");
  if (error) return res.status(500).json({ ok: false, error: error.message });
  const queue = (data || []).map((j) => ({
    journeyId: j.id, stageEnteredAt: j.stage_entered_at, slaDueAt: j.sla_due_at,
    ...telehealthView(j.patients),
  }));
  res.json({ ok: true, queue });
});

partnersRouter.get("/telehealth/queue/:id", async (req, res) => {
  const { data: journey } = await supabase.from("journeys").select("*, patients(*)").eq("id", req.params.id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });
  const { data: tasks } = await supabase.from("tasks").select("type, reason, priority").eq("journey_id", req.params.id).eq("status", "open");
  res.json({
    ok: true,
    journeyId: journey.id,
    patient: telehealthView(journey.patients),
    advisoryFlags: (tasks || []).filter((t) => t.type === "Guardrail advisory"),
  });
});

// POST /api/partner/telehealth/queue/:id/complete — the clinician documents
// the visit themselves (diagnosis, prescribed therapy, medical necessity),
// instead of the platform synthesizing it. This is what feeds the prior
// auth request at insurance_pa next.
partnersRouter.post("/telehealth/queue/:id/complete", async (req, res) => {
  const { id } = req.params;
  const { diagnosisCode, diagnosisLabel, prescribedTherapy, medicalNecessity, clinicianName } = req.body || {};
  const { data: journey } = await supabase.from("journeys").select("*, patients(*)").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });
  if (journey.current_stage !== "telehealth") {
    return res.status(409).json({ ok: false, error: "wrong_stage", message: "This journey isn't at Telehealth." });
  }
  if (!prescribedTherapy || !medicalNecessity) {
    return res.status(400).json({ ok: false, error: "missing_fields", message: "Prescribed therapy and medical necessity are required to complete a visit." });
  }

  const patient = journey.patients;
  const now = await closeStage(id, journey, "telehealth");

  const clinicalSummary = {
    diagnosisCode: diagnosisCode || null,
    diagnosisLabel: diagnosisLabel || patient.condition,
    prescribedTherapy, medicalNecessity,
    clinicianName: clinicianName || "Unspecified clinician",
    visitDate: now.toISOString().slice(0, 10),
  };
  await supabase.from("journeys").update({ clinical_summary: clinicalSummary }).eq("id", id);
  await appendAudit({ journeyId: id, actor: "clinician:telehealth", decision: "visit completed — clinical summary recorded", fieldsShared: "diagnosis + rationale (to payer only, never the pharma dashboard)" });

  const skipInsurance = patient.billing_method === "direct";
  const next = nextStage("telehealth", { skipInsurance });

  if (next && next.key === "insurance_pa") {
    await supabase.from("journeys").update({
      current_stage: "insurance_pa", status: "in_progress",
      stage_entered_at: now.toISOString(), sla_due_at: dueAt(now, next.slaHours),
      updated_at: now.toISOString(),
    }).eq("id", id);
    await supabase.from("journey_events").insert({ journey_id: id, event_type: "stage_advanced", payload: { to: "insurance_pa" } });
    await appendAudit({ journeyId: id, actor: "dispatcher", decision: "advanced to insurance_pa", fieldsShared: "—" });
    const result = await runEligibilityCheck({ journey: { ...journey, id, clinical_summary: clinicalSummary }, patient });
    return res.json({ ok: true, stage: result.stage, held: result.held });
  }

  const result = await plainAdvance(id, "telehealth", { skipInsurance });
  res.json({ ok: true, stage: result.stage, held: false });
});

// ============================================================================
// PHARMACY — the dispensing pharmacy's own console.
// ============================================================================

partnersRouter.get("/pharmacy/queue", async (_req, res) => {
  const { data, error } = await supabase
    .from("journeys")
    .select("id, stage_entered_at, sla_due_at, clinical_summary, patients(*)")
    .eq("current_stage", "pharmacy")
    .eq("status", "in_progress");
  if (error) return res.status(500).json({ ok: false, error: error.message });
  const queue = (data || []).map((j) => ({
    journeyId: j.id, stageEnteredAt: j.stage_entered_at, slaDueAt: j.sla_due_at,
    ...pharmacyView(j.patients, j),
  }));
  res.json({ ok: true, queue });
});

partnersRouter.get("/pharmacy/queue/:id", async (req, res) => {
  const { data: journey } = await supabase.from("journeys").select("*, patients(*)").eq("id", req.params.id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });
  res.json({ ok: true, journeyId: journey.id, patient: pharmacyView(journey.patients, journey) });
});

partnersRouter.post("/pharmacy/queue/:id/complete", async (req, res) => {
  const { id } = req.params;
  const { data: journey } = await supabase.from("journeys").select("*").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });
  if (journey.current_stage !== "pharmacy") {
    return res.status(409).json({ ok: false, error: "wrong_stage", message: "This journey isn't at Pharmacy." });
  }

  await closeStage(id, journey, "pharmacy");
  await appendAudit({ journeyId: id, actor: "partner:pharmacy", decision: "dispensed and shipped", fieldsShared: "fulfillment status only" });

  const result = await plainAdvance(id, "pharmacy", {});
  res.json({ ok: true, stage: result.stage });
});
