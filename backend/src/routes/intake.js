import { Router } from "express";
import { supabase } from "../db.js";
import { appendAudit } from "../hash.js";
import { STAGES, dueAt } from "../workflow.js";
import { checkIntakeCompleteness, runAgent } from "../agents.js";

export const intakeRouter = Router();

function genPatientRef() {
  return "P-" + Math.floor(10000 + Math.random() * 89999);
}

intakeRouter.post("/", async (req, res) => {
  const body = req.body || {};

  if (!body.password || body.password.length < 8) {
    return res.status(400).json({ ok: false, error: "weak_password", message: "Password must be at least 8 characters." });
  }

  const insurance = body.hasInsurance
    ? {
        payer_id: body.insurance?.payerId || null,
        payer_name: body.insurance?.payer || null,
        member_id: body.insurance?.memberId || null,
        group_number: body.insurance?.groupNumber || null,
        relationship_to_subscriber: body.insurance?.relationship || "self",
        subscriber_first_name: body.insurance?.subscriberFirstName || null,
        subscriber_last_name: body.insurance?.subscriberLastName || null,
        subscriber_dob: body.insurance?.subscriberDob || null,
        rx_bin: body.insurance?.rxBin || null,
        rx_pcn: body.insurance?.rxPcn || null,
        rx_group: body.insurance?.rxGroup || null,
      }
    : null;

  const patientDraft = {
    first_name: body.firstName,
    last_name: body.lastName,
    dob: body.dob || null,
    email: body.email,
    phone: body.phone || null,
    address: body.address || null,
    condition: body.condition,
    insurance,
    consent: { care_coordination: !!body.consentCareCoordination },
    patient_ref: genPatientRef(),
  };

  const completeness = checkIntakeCompleteness(patientDraft);
  if (!completeness.pass) {
    return res.status(400).json({ ok: false, error: "incomplete_intake", missingFields: completeness.missingFields });
  }

  // Create the login account first — if this fails (e.g. email already
  // registered), we haven't written any patient/journey rows yet.
  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: { patient_ref: patientDraft.patient_ref },
  });
  if (authErr) {
    const msg = /already/i.test(authErr.message) ? "An account with this email already exists." : authErr.message;
    return res.status(400).json({ ok: false, error: "account_creation_failed", message: msg });
  }
  patientDraft.auth_user_id = authUser.user.id;

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
    await appendAudit({ journeyId: journey.id, actor: "agent:guardrail", decision: "guardrail hold created at intake", fieldsShared: "—" });
    return res.status(201).json({ ok: true, patientRef: patient.patient_ref, journeyId: journey.id, stage: "intake", held: true });
  }

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
