import { supabase } from "./db.js";
import { appendAudit } from "./hash.js";

/**
 * Fires a prior-authorization request to the payer-simulator. Now called
 * from the PHARMACY console ("Initiate PA"), once the patient has chosen
 * the insurance path for a specific fill — not automatically after
 * telehealth. This matches how PA actually works: the pharmacy submits
 * the claim/PA at the point of dispensing, using the clinical
 * justification the clinician already documented at the visit.
 *
 * Unlike a bare 270 eligibility check (coverage/demographic matching
 * only), this includes `clinical` — diagnosis and medical necessity — the
 * same "share with the payer for a coverage determination is a
 * treatment/payment purpose under HIPAA" reasoning as before. Updates
 * journeys.pharmacy_status directly; never touches current_stage, since
 * the journey stays at "pharmacy" throughout this whole sub-flow.
 */
export async function runEligibilityCheck({ journey, patient }) {
  const ins = patient.insurance;
  if (!ins) {
    await supabase.from("tasks").insert({
      journey_id: journey.id, type: "No insurance on file", reason: "Insurance path chosen but no insurance on file — route to cash-pay instead",
      priority: "high", assigned_role: "Access & Benefits",
    });
    await appendAudit({ journeyId: journey.id, actor: "rule:pharmacy-pa", decision: "PA not submitted — no insurance on file", fieldsShared: "—" });
    return { pharmacyStatus: "insurance_pa_pending", held: true };
  }

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
      prescribedTherapy: journey.prescription?.drugName || null,
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
    await appendAudit({ journeyId: journey.id, actor: "gateway", decision: "payer-simulator unreachable — PA held for retry", fieldsShared: "—" });
    await supabase.from("tasks").insert({
      journey_id: journey.id, type: "PA submission failed", reason: "Could not reach the payer service — will need a retry",
      priority: "high", assigned_role: "Access & Benefits",
    });
    return { pharmacyStatus: "insurance_pa_pending", held: true };
  }

  await appendAudit({ journeyId: journey.id, actor: "payer-simulator", decision: `prior auth request: ${elig.status}`, fieldsShared: "coverage status + clinical summary" });

  if (elig.status === "needs_info") {
    await supabase.from("tasks").insert({
      journey_id: journey.id, type: "PA submission incomplete",
      reason: `Payer could not process — missing: ${(elig.missingFields || []).join(", ")}`,
      priority: "high", assigned_role: "Access & Benefits",
    });
    return { pharmacyStatus: "insurance_pa_pending", held: true };
  }
  if (elig.status === "auto_denied") {
    await supabase.from("tasks").insert({
      journey_id: journey.id, type: "Prior authorization denied", reason: elig.decision?.reason || "Payer denied coverage",
      priority: "high", assigned_role: "Access & Benefits",
    });
    return { pharmacyStatus: "insurance_pa_pending", held: true };
  }
  if (elig.status === "pending_review") {
    // The normal case now — every complete PA request goes to manual
    // review in the payer console (see payer-simulator/src/index.js).
    return { pharmacyStatus: "insurance_pa_pending", held: true, pendingExternalReview: true };
  }

  // auto_approved (rare — payer-simulator no longer auto-adjudicates, kept
  // for robustness in case that changes) — mark approved directly.
  await appendAudit({ journeyId: journey.id, actor: "payer-simulator", decision: "prior auth approved", fieldsShared: "—" });
  return { pharmacyStatus: "insurance_approved", held: false };
}
