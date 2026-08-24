import { Router } from "express";
import { supabase } from "../db.js";
import { appendAudit } from "../hash.js";
import { STAGES, nextStage, dueAt } from "../workflow.js";
import { runAgent } from "../agents.js";

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
// partner (payer / telehealth / pharmacy / courier) responding, since none
// of those integrations exist yet. Advances the journey one stage and runs
// the relevant agent stub along the way.
journeysRouter.post("/:id/simulate-next", async (req, res) => {
  const { id } = req.params;
  const { data: journey } = await supabase.from("journeys").select("*, patients(*)").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });

  const patient = journey.patients;
  const now = new Date();

  // Close out the current stage in history.
  const enteredAt = new Date(journey.stage_entered_at);
  await supabase.from("stage_history").insert({
    journey_id: id, stage: journey.current_stage, entered_at: journey.stage_entered_at,
    exited_at: now.toISOString(), duration_hours: +((now - enteredAt) / 3600000).toFixed(2),
  });

  // Stage-specific integration. insurance_pa now makes a REAL HTTP call to
  // the standalone payer-simulator service — a genuine network hop to a
  // separately deployed app, not an in-process function.
  if (journey.current_stage === "insurance_pa") {
    if (!patient.insurance) {
      await supabase.from("tasks").insert({
        journey_id: id, type: "No insurance on file", reason: "No insurance provided at intake — route to patient assistance program",
        priority: "high", assigned_role: "Access & Benefits",
      });
      await appendAudit({ journeyId: id, actor: "rule:G4", decision: "insurance_pa held — no insurance on file", fieldsShared: "—" });
      return res.json({ ok: true, held: true, stage: "insurance_pa" });
    }

    const ins = patient.insurance;
    const isSelf = (ins.relationship_to_subscriber || "self") === "self";
    const payload = {
      requestId: id,
      payerId: ins.payer_id,
      payerName: ins.payer_name,
      // No prescriber is on file yet (that happens at the telehealth stage
      // in this program), so the requesting entity is the program itself.
      provider: { npi: "1999999984", name: "DirectNEXT Care Program" },
      subscriber: {
        memberId: ins.member_id,
        lastName: isSelf ? patient.last_name : ins.subscriber_last_name,
        firstName: isSelf ? patient.first_name : ins.subscriber_first_name,
        dob: isSelf ? patient.dob : ins.subscriber_dob,
      },
      dependent: isSelf ? null : { relationship: ins.relationship_to_subscriber, firstName: patient.first_name, lastName: patient.last_name, dob: patient.dob },
      serviceTypeCode: "30",
      dateOfService: now.toISOString().slice(0, 10),
    };

    let elig;
    try {
      const resp = await fetch(`${process.env.PAYER_SIMULATOR_URL}/eligibility/inquiry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      elig = await resp.json();
    } catch (e) {
      await appendAudit({ journeyId: id, actor: "gateway", decision: "payer-simulator unreachable — held for retry", fieldsShared: "—" });
      await supabase.from("tasks").insert({
        journey_id: id, type: "Eligibility check failed", reason: "Could not reach the payer service — will need a retry",
        priority: "high", assigned_role: "Access & Benefits",
      });
      return res.json({ ok: true, held: true, stage: "insurance_pa" });
    }

    await appendAudit({ journeyId: id, actor: "payer-simulator", decision: `eligibility inquiry: ${elig.status}`, fieldsShared: "coverage status only" });

    if (elig.status === "needs_info") {
      await supabase.from("tasks").insert({
        journey_id: id, type: "Eligibility inquiry incomplete",
        reason: `Payer could not process — missing: ${(elig.missingFields || []).join(", ")}`,
        priority: "high", assigned_role: "Access & Benefits",
      });
      return res.json({ ok: true, held: true, stage: "insurance_pa" });
    }
    if (elig.status === "auto_denied") {
      await supabase.from("tasks").insert({
        journey_id: id, type: "Prior authorization denied", reason: elig.decision?.reason || "Payer denied coverage",
        priority: "high", assigned_role: "Access & Benefits",
      });
      return res.json({ ok: true, held: true, stage: "insurance_pa" });
    }
    if (elig.status === "pending_review") {
      await supabase.from("tasks").insert({
        journey_id: id, type: "Awaiting payer review", reason: "Eligibility is ambiguous — a payer reviewer needs to decide",
        priority: "medium", assigned_role: "Access & Benefits",
      });
      // This journey will advance later via /api/journeys/:id/eligibility-decision,
      // called by the payer-simulator's dashboard once a human decides.
      return res.json({ ok: true, held: true, stage: "insurance_pa", pendingExternalReview: true });
    }
    // status === "auto_approved" — fall through to the normal advance below.
  }
  if (journey.current_stage === "refill") {
    const adherence = await runAgent("adherence", patient);
    await appendAudit({ journeyId: id, actor: "agent:adherence", decision: `adherence score computed: ${adherence.result?.score ?? "n/a"}`, fieldsShared: "score only" });
  }

  const next = nextStage(journey.current_stage);
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

