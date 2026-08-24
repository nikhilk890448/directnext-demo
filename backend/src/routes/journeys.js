import { Router } from "express";
import { supabase } from "../db.js";
import { appendAudit } from "../hash.js";
import { STAGES, nextStage, dueAt } from "../workflow.js";
import { runAgent } from "../agents.js";
import { runEligibilityCheck, synthesizeClinicalSummary } from "../eligibility-check.js";

export const journeysRouter = Router();

// GET /api/journeys — PHI-free list for the pharma dashboard.
// Reads only journey_dashboard_view; the patients table is never touched here.
journeysRouter.get("/", async (_req, res) => {
  const { data, error } = await supabase.from("journey_dashboard_view").select("*").order("stage_entered_at", { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, journeys: data });
});

// GET /api/journeys/meta/stages — stage definitions + live median latency.
// NOTE: must be declared before "/:id" or Express will treat "meta" as an id.
journeysRouter.get("/meta/stages", async (_req, res) => {
  const { data: latency } = await supabase.from("stage_latency_view").select("*");
  res.json({ ok: true, stages: STAGES, latency });
});

// GET /api/journeys/:id — single journey detail, still PHI-free.
journeysRouter.get("/:id", async (req, res) => {
  const { id } = req.params;
  const { data: journey, error } = await supabase.from("journey_dashboard_view").select("*").eq("journey_id", id).maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });

  const { data: tasks } = await supabase.from("task_dashboard_view").select("*").eq("journey_id", id).order("created_at", { ascending: false });
  const { data: history } = await supabase.from("stage_history").select("stage, entered_at, exited_at, duration_hours").eq("journey_id", id).order("entered_at");

  res.json({ ok: true, journey, tasks, history });
});

// GET /api/journeys/:id/audit — hash chain for one journey (decision text is PHI-free by construction).
journeysRouter.get("/:id/audit", async (req, res) => {
  const { data, error } = await supabase.from("audit_log").select("actor, decision, fields_shared, consent_basis, hash, prev_hash, created_at").eq("journey_id", req.params.id).order("created_at");
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, audit: data });
});

// POST /api/journeys/:id/tasks/:taskId/resolve
journeysRouter.post("/:id/tasks/:taskId/resolve", async (req, res) => {
  const { id, taskId } = req.params;
  const { error } = await supabase.from("tasks").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", taskId);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await appendAudit({ journeyId: id, actor: "human:dashboard", decision: `task ${taskId} resolved`, fieldsShared: "—" });
  res.json({ ok: true });
});

// POST /api/journeys/:id/simulate-next — DEMO ONLY. Stands in for a real
// partner (telehealth / pharmacy / courier) responding, since none of those
// integrations exist yet. Advances the journey one stage.
journeysRouter.post("/:id/simulate-next", async (req, res) => {
  const { id } = req.params;
  const { data: journey } = await supabase.from("journeys").select("*, patients(*)").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });

  // insurance_pa only moves via the payer-simulator's own console
  // (pending_review → Approve/Deny → calls back to
  // /api/journeys/:id/eligibility-decision). The pharma dashboard shouldn't
  // be the place coverage decisions get made. Checked before touching
  // anything so a rejected request doesn't log a bogus stage-history entry.
  if (journey.current_stage === "insurance_pa") {
    return res.status(409).json({
      ok: false,
      error: "not_simulable_here",
      message: "This journey is waiting on the payer. Check the payer console to review or decide it — it doesn't advance from this dashboard.",
    });
  }

  const patient = journey.patients;
  const now = new Date();

  // Close out the current stage in history.
  const enteredAt = new Date(journey.stage_entered_at);
  await supabase.from("stage_history").insert({
    journey_id: id, stage: journey.current_stage, entered_at: journey.stage_entered_at,
    exited_at: now.toISOString(), duration_hours: +((now - enteredAt) / 3600000).toFixed(2),
  });

  // Leaving telehealth captures the clinical note that a real EHR/telehealth
  // platform would produce — this is what travels with the prior auth
  // request next, so it has to exist before insurance_pa can be reached.
  let clinicalSummary = journey.clinical_summary;
  if (journey.current_stage === "telehealth") {
    clinicalSummary = synthesizeClinicalSummary(patient);
    await supabase.from("journeys").update({ clinical_summary: clinicalSummary }).eq("id", id);
    await appendAudit({ journeyId: id, actor: "clinician:telehealth", decision: "visit completed — clinical summary recorded", fieldsShared: "diagnosis + rationale (to payer only)" });
  }

  if (journey.current_stage === "refill") {
    const adherence = await runAgent("adherence", patient);
    await appendAudit({ journeyId: id, actor: "agent:adherence", decision: `adherence score computed: ${adherence.result?.score ?? "n/a"}`, fieldsShared: "score only" });
  }

  const skipInsurance = patient.billing_method === "direct";
  const next = nextStage(journey.current_stage, { skipInsurance });

  if (next && next.key === "insurance_pa") {
    // Advance into insurance_pa, then immediately fire the prior-auth
    // request — same pattern as before, just triggered from this point in
    // the workflow instead of at intake.
    await supabase.from("journeys").update({
      current_stage: "insurance_pa", status: "in_progress",
      stage_entered_at: now.toISOString(), sla_due_at: dueAt(now, next.slaHours),
      updated_at: now.toISOString(),
    }).eq("id", id);
    await supabase.from("journey_events").insert({ journey_id: id, event_type: "stage_advanced", payload: { to: "insurance_pa" } });
    await appendAudit({ journeyId: id, actor: "dispatcher", decision: "advanced to insurance_pa", fieldsShared: "—" });

    const result = await runEligibilityCheck({ journey: { ...journey, id, clinical_summary: clinicalSummary }, patient });
    return res.json({ ok: true, held: result.held, stage: result.stage, status: "in_progress" });
  }

  const status = next ? "in_progress" : "completed";
  const stageKey = next ? next.key : journey.current_stage;
  const slaHours = next ? next.slaHours : 0;

  await supabase.from("journeys").update({
    current_stage: stageKey, status,
    stage_entered_at: now.toISOString(),
    sla_due_at: next ? dueAt(now, slaHours) : null,
    updated_at: now.toISOString(),
  }).eq("id", id);

  await supabase.from("journey_events").insert({ journey_id: id, event_type: "stage_advanced", payload: { to: stageKey } });
  await appendAudit({ journeyId: id, actor: "dispatcher", decision: `advanced to ${stageKey}`, fieldsShared: "—" });

  res.json({ ok: true, held: false, stage: stageKey, status });
});

