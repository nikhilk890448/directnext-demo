import { Router } from "express";
import { supabase } from "../db.js";
import { appendAudit } from "../hash.js";
import { STAGES, dueAt } from "../workflow.js";
import { checkIntakeCompleteness, guardrailCheck, runAgent } from "../agents.js";

export const intakeRouter = Router();

function genPatientRef() {
  return "P-" + Math.floor(10000 + Math.random() * 89999);
}

intakeRouter.post("/", async (req, res) => {
  const body = req.body || {};
  const patientDraft = {
    first_name: body.firstName,
    last_name: body.lastName,
    dob: body.dob || null,
    email: body.email,
    phone: body.phone || null,
    address: body.address || null,
    condition: body.condition,
    insurance: body.insurance || null,
    consent: { care_coordination: !!body.consentCareCoordination },
    patient_ref: genPatientRef(),
  };

  // Agent 1: intake completeness (ORCH, fail-open) — runs against the raw
  // draft before anything is persisted, so an incomplete submission never
  // silently becomes a stuck journey.
  const completeness = checkIntakeCompleteness(patientDraft);
  if (!completeness.pass) {
    return res.status(400).json({ ok: false, error: "incomplete_intake", missingFields: completeness.missingFields });
  }

  const { data: patient, error: pErr } = await supabase.from("patients").insert(patientDraft).select().single();
  if (pErr) return res.status(500).json({ ok: false, error: pErr.message });

  const now = new Date();
  const { data: journey, error: jErr } = await supabase
    .from("journeys")
    .insert({
      patient_id: patient.id,
      current_stage: "intake",
      status: "in_progress",
      stage_entered_at: now.toISOString(),
      sla_due_at: dueAt(now, STAGES[0].slaHours),
    })
    .select()
    .single();
  if (jErr) return res.status(500).json({ ok: false, error: jErr.message });

  await supabase.from("journey_events").insert([
    { journey_id: journey.id, event_type: "enrolled", payload: { source: "storefront" } },
    { journey_id: journey.id, event_type: "consented", payload: { care_coordination: patientDraft.consent.care_coordination } },
    { journey_id: journey.id, event_type: "intake_submitted", payload: {} },
  ]);

  await appendAudit({
    journeyId: journey.id,
    actor: "rule:intake",
    decision: `journey opened — ${patient.patient_ref}`,
    fieldsShared: "patient_ref, consent_scope",
    consentBasis: "consent",
  });

  // Agent 2: appropriateness guardrail (GOV, fail-closed). If it can't clear,
  // the journey holds right here and a PHI-free task explains why.
  const guardrail = await runAgent("guardrail", patientDraft);
  const guardrailPass = guardrail.failClosed ? false : guardrail.result?.pass;

  if (!guardrailPass) {
    await supabase.from("tasks").insert({
      journey_id: journey.id,
      type: "Guardrail hold",
      reason: guardrail.failClosed ? "Guardrail agent unavailable — held pending review" : "Guardrail check did not clear at intake",
      priority: "high",
      assigned_role: "Governance",
    });
    await appendAudit({
      journeyId: journey.id,
      actor: "agent:guardrail",
      decision: "guardrail hold created at intake",
      fieldsShared: "—",
    });
    return res.status(201).json({ ok: true, patientRef: patient.patient_ref, journeyId: journey.id, stage: "intake", held: true });
  }

  // Guardrail cleared — advance straight to the safety/completeness stage,
  // then on into insurance PA, so the demo shows real movement immediately.
  const nextEntered = new Date();
  await supabase.from("journeys").update({
    current_stage: "insurance_pa",
    status: "in_progress",
    stage_entered_at: nextEntered.toISOString(),
    sla_due_at: dueAt(nextEntered, STAGES[2].slaHours),
    updated_at: nextEntered.toISOString(),
  }).eq("id", journey.id);

  await supabase.from("journey_events").insert({ journey_id: journey.id, event_type: "gate_pass", payload: { gate: "safety_check" } });
  await appendAudit({ journeyId: journey.id, actor: "agent:guardrail", decision: "guardrail cleared — advanced to insurance_pa", fieldsShared: "—" });

  res.status(201).json({ ok: true, patientRef: patient.patient_ref, journeyId: journey.id, stage: "insurance_pa", held: false });
});
