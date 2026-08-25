import { supabase } from "./db.js";
import { appendAudit } from "./hash.js";
import { STAGES, nextStage, dueAt } from "./workflow.js";

/**
 * Fires the prior-authorization request to the payer-simulator. Called the
 * moment a journey's stage becomes insurance_pa (from journeys.js, right
 * after the telehealth stage closes out and a clinical summary exists).
 *
 * Unlike a bare 270 eligibility check (coverage/demographic matching only),
 * a real prior authorization needs clinical justification — diagnosis and
 * medical necessity — which is why this only fires post-telehealth and why
 * the payload includes `clinical`. Sharing that with the payer for a
 * coverage determination is a treatment/payment purpose under HIPAA and
 * doesn't need special authorization beyond the standard consent already
 * captured at intake — it's a different boundary than the pharma-facing
 * dashboard, which stays PHI-free because the pharma company has no
 * equivalent need-to-know.
 */
export async function runEligibilityCheck({ journey, patient }) {
  if (!patient.insurance) {
    await supabase.from("tasks").insert({
      journey_id: journey.id, type: "No insurance on file", reason: "No insurance provided at intake — route to patient assistance program",
      priority: "high", assigned_role: "Access & Benefits",
    });
    await appendAudit({ journeyId: journey.id, actor: "rule:G4", decision: "insurance_pa held — no insurance on file", fieldsShared: "—" });
    return { stage: "insurance_pa", held: true };
  }

  const ins = patient.insurance;
  const isSelf = (ins.relationship_to_subscriber || "self") === "self";
  const clinical = journey.clinical_summary || {};
  const payload = {
    requestId: journey.id,
    payerId: ins.payer_id,
    payerName: ins.payer_name,
    provider: { npi: "1999999984", name: "DirectNEXT Care Program" },
    subscriber: {
      memberId: ins.member_id,
      lastName: isSelf ? patient.last_name : ins.subscriber_last_name,
      firstName: isSelf ? patient.first_name : ins.subscriber_first_name,
      dob: isSelf ? patient.dob : ins.subscriber_dob,
    },
    dependent: isSelf ? null : { relationship: ins.relationship_to_subscriber, firstName: patient.first_name, lastName: patient.last_name, dob: patient.dob },
    serviceTypeCode: "30",
    dateOfService: new Date().toISOString().slice(0, 10),
    clinical: {
      diagnosisCode: clinical.diagnosisCode || null,
      diagnosisLabel: clinical.diagnosisLabel || patient.condition,
      prescribedTherapy: clinical.prescribedTherapy || null,
      medicalNecessity: clinical.medicalNecessity || null,
      clinicianName: clinical.clinicianName || null,
      visitDate: clinical.visitDate || null,
    },
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
    await appendAudit({ journeyId: journey.id, actor: "gateway", decision: "payer-simulator unreachable — held for retry", fieldsShared: "—" });
    await supabase.from("tasks").insert({
      journey_id: journey.id, type: "Eligibility check failed", reason: "Could not reach the payer service — will need a retry",
      priority: "high", assigned_role: "Access & Benefits",
    });
    return { stage: "insurance_pa", held: true };
  }

  await appendAudit({ journeyId: journey.id, actor: "payer-simulator", decision: `prior auth request: ${elig.status}`, fieldsShared: "coverage status + clinical summary" });

  if (elig.status === "needs_info") {
    await supabase.from("tasks").insert({
      journey_id: journey.id, type: "Prior auth request incomplete",
      reason: `Payer could not process — missing: ${(elig.missingFields || []).join(", ")}`,
      priority: "high", assigned_role: "Access & Benefits",
    });
    return { stage: "insurance_pa", held: true };
  }
  if (elig.status === "auto_denied") {
    await supabase.from("tasks").insert({
      journey_id: journey.id, type: "Prior authorization denied", reason: elig.decision?.reason || "Payer denied coverage",
      priority: "high", assigned_role: "Access & Benefits",
    });
    return { stage: "insurance_pa", held: true };
  }
  if (elig.status === "pending_review") {
    await supabase.from("tasks").insert({
      journey_id: journey.id, type: "Awaiting payer review", reason: "Prior auth needs clinical review — a payer reviewer must decide",
      priority: "medium", assigned_role: "Access & Benefits",
    });
    return { stage: "insurance_pa", held: true, pendingExternalReview: true };
  }

  // auto_approved — advance to the next stage right away.
  const advanced = new Date();
  const next = nextStage("insurance_pa"); // always pharmacy from here, regardless of billing method
  await supabase.from("journeys").update({
    current_stage: next.key, status: "in_progress",
    stage_entered_at: advanced.toISOString(),
    sla_due_at: dueAt(advanced, next.slaHours),
    updated_at: advanced.toISOString(),
  }).eq("id", journey.id);
  await supabase.from("journey_events").insert({ journey_id: journey.id, event_type: "prior_auth_approved", payload: {} });
  await appendAudit({ journeyId: journey.id, actor: "payer-simulator", decision: `prior auth approved — advanced to ${next.key}`, fieldsShared: "—" });

  return { stage: next.key, held: false };
}
