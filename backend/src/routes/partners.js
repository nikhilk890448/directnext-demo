import { Router } from "express";
import { supabase } from "../db.js";
import { appendAudit } from "../hash.js";
import { nextStage, dueAt } from "../workflow.js";
import { scopeFields } from "../contracts.js";
import { computePricing } from "../pricing.js";
import { runEligibilityCheck } from "../eligibility-check.js";

export const partnersRouter = Router();

function telehealthView(patient) {
  return scopeFields("telehealth", {
    patient_ref: patient.patient_ref,
    first_name: patient.first_name,
    last_name: patient.last_name,
    dob: patient.dob,
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
    prescription: journey.prescription || null,
    pharmacy_status: journey.pharmacy_status,
    fill_payment_method: journey.fill_payment_method,
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

// POST /api/partner/telehealth/queue/:id/complete — the clinician writes a
// structured, eRx-lite prescription (drug/sig/quantity — NCPDP SCRIPT
// NewRx-shaped, not just a free-text therapy name) plus the visit's
// clinical summary. This never goes straight to the pharmacy — it's
// written here, in our backend, and the pharmacy reads it back out through
// its own scoped endpoint below. No direct telehealth-to-pharmacy channel
// exists anywhere in this system.
partnersRouter.post("/telehealth/queue/:id/complete", async (req, res) => {
  const { id } = req.params;
  const {
    diagnosisCode, diagnosisLabel, medicalNecessity, clinicianName,
    drugName, ndc, strength, form, sig, quantity, daysSupply, refills,
  } = req.body || {};
  const { data: journey } = await supabase.from("journeys").select("*, patients(*)").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });
  if (journey.current_stage !== "telehealth") {
    return res.status(409).json({ ok: false, error: "wrong_stage", message: "This journey isn't at Telehealth." });
  }
  if (!drugName || !sig || !quantity || !medicalNecessity) {
    return res.status(400).json({ ok: false, error: "missing_fields", message: "Drug, SIG, quantity, and medical necessity are required to complete a visit." });
  }

  const patient = journey.patients;
  const now = await closeStage(id, journey, "telehealth");

  const clinicalSummary = {
    diagnosisCode: diagnosisCode || null,
    diagnosisLabel: diagnosisLabel || patient.condition,
    medicalNecessity,
    clinicianName: clinicianName || "Unspecified clinician",
    visitDate: now.toISOString().slice(0, 10),
  };
  const prescription = {
    drugName, ndc: ndc || null, strength: strength || null, form: form || null,
    sig, quantity: Number(quantity), daysSupply: daysSupply ? Number(daysSupply) : null,
    refills: refills ? Number(refills) : 0, dateWritten: now.toISOString().slice(0, 10),
  };

  const next = nextStage("telehealth"); // pharmacy
  await supabase.from("journeys").update({
    clinical_summary: clinicalSummary,
    prescription,
    current_stage: next.key,
    status: "in_progress",
    pharmacy_status: "prescription_received",
    fill_payment_method: null,
    stage_entered_at: now.toISOString(),
    sla_due_at: dueAt(now, next.slaHours),
    updated_at: now.toISOString(),
  }).eq("id", id);

  const pricing = computePricing(prescription);
  await supabase.from("pricing_quotes").insert({
    journey_id: id, cash_price: pricing.cashPrice, insurance_price_estimate: pricing.insurancePriceEstimate,
  });

  await supabase.from("journey_events").insert({ journey_id: id, event_type: "stage_advanced", payload: { to: "pharmacy" } });
  await appendAudit({ journeyId: id, actor: "clinician:telehealth", decision: "visit completed — prescription written, advanced to pharmacy", fieldsShared: "diagnosis + rationale (to payer only, never the pharma dashboard); prescription (to pharmacy only)" });

  res.json({ ok: true, stage: "pharmacy" });
});

// Pharmacy → telehealth info requests. The clinician who saw the patient
// responds here — never a direct pharmacy-to-clinician link.
partnersRouter.get("/telehealth/requests", async (_req, res) => {
  const { data, error } = await supabase
    .from("pharmacy_requests")
    .select("id, journey_id, request_type, message, created_at, journeys(patients(patient_ref))")
    .eq("status", "open")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  const requests = (data || []).map((r) => ({
    id: r.id, journeyId: r.journey_id, requestType: r.request_type, message: r.message,
    createdAt: r.created_at, patientRef: r.journeys?.patients?.patient_ref,
  }));
  res.json({ ok: true, requests });
});

partnersRouter.post("/telehealth/requests/:id/respond", async (req, res) => {
  const { id } = req.params;
  const { response } = req.body || {};
  if (!response) return res.status(400).json({ ok: false, error: "missing_response" });
  const { data: reqRow } = await supabase.from("pharmacy_requests").select("*").eq("id", id).maybeSingle();
  if (!reqRow) return res.status(404).json({ ok: false, error: "not found" });

  await supabase.from("pharmacy_requests").update({ status: "fulfilled", response, fulfilled_at: new Date().toISOString() }).eq("id", id);
  await appendAudit({ journeyId: reqRow.journey_id, actor: "clinician:telehealth", decision: `responded to pharmacy's ${reqRow.request_type} request`, fieldsShared: "response content shared with pharmacy only" });
  res.json({ ok: true });
});

// ============================================================================
// PHARMACY — the dispensing pharmacy's own console.
// ============================================================================

partnersRouter.get("/pharmacy/queue", async (_req, res) => {
  const { data, error } = await supabase
    .from("journeys")
    .select("id, stage_entered_at, sla_due_at, prescription, pharmacy_status, fill_payment_method, patients(*)")
    .eq("current_stage", "pharmacy");
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
  const { data: quote } = await supabase.from("pricing_quotes").select("*").eq("journey_id", req.params.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: requests } = await supabase.from("pharmacy_requests").select("*").eq("journey_id", req.params.id).order("created_at", { ascending: false });
  res.json({
    ok: true,
    journeyId: journey.id,
    patient: pharmacyView(journey.patients, journey),
    pricing: quote ? { cashPrice: quote.cash_price, insurancePriceEstimate: quote.insurance_price_estimate } : null,
    requests: requests || [],
  });
});

partnersRouter.post("/pharmacy/queue/:id/request-info", async (req, res) => {
  const { id } = req.params;
  const { requestType, message } = req.body || {};
  if (!requestType || !message) return res.status(400).json({ ok: false, error: "missing_fields" });
  await supabase.from("pharmacy_requests").insert({ journey_id: id, request_type: requestType, message, status: "open" });
  await appendAudit({ journeyId: id, actor: "partner:pharmacy", decision: `requested ${requestType} from telehealth`, fieldsShared: "request text only" });
  res.json({ ok: true });
});

partnersRouter.post("/pharmacy/queue/:id/initiate-pa", async (req, res) => {
  const { id } = req.params;
  const { data: journey } = await supabase.from("journeys").select("*, patients(*)").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });
  if (journey.fill_payment_method !== "insurance") {
    return res.status(409).json({ ok: false, error: "wrong_payment_method", message: "Patient hasn't chosen the insurance path for this fill." });
  }
  await supabase.from("journeys").update({ pharmacy_status: "insurance_pa_pending" }).eq("id", id);
  const result = await runEligibilityCheck({ journey, patient: journey.patients });
  res.json({ ok: true, pharmacyStatus: result.pharmacyStatus });
});

async function setPharmacyStatus(req, res, expectedCurrent, newStatus) {
  const { id } = req.params;
  const { data: journey } = await supabase.from("journeys").select("*").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });
  if (expectedCurrent && journey.pharmacy_status !== expectedCurrent) {
    return res.status(409).json({ ok: false, error: "wrong_status", message: `Expected status "${expectedCurrent}", journey is at "${journey.pharmacy_status}".` });
  }
  await supabase.from("journeys").update({ pharmacy_status: newStatus, updated_at: new Date().toISOString() }).eq("id", id);
  await appendAudit({ journeyId: id, actor: "partner:pharmacy", decision: `pharmacy status → ${newStatus}`, fieldsShared: "status only" });
  return { ok: true, journey };
}

partnersRouter.post("/pharmacy/queue/:id/dispense", async (req, res) => {
  const { data: journey } = await supabase.from("journeys").select("*").eq("id", req.params.id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });
  if (!["insurance_approved", "payment_received"].includes(journey.pharmacy_status)) {
    return res.status(409).json({ ok: false, error: "not_cleared", message: "Payment or insurance approval isn't confirmed yet." });
  }
  const result = await setPharmacyStatus(req, res, journey.pharmacy_status, "dispensed");
  if (result && !res.headersSent) res.json({ ok: true, pharmacyStatus: "dispensed" });
});

partnersRouter.post("/pharmacy/queue/:id/ship", async (req, res) => {
  const result = await setPharmacyStatus(req, res, "dispensed", "in_transit");
  if (result && !res.headersSent) res.json({ ok: true, pharmacyStatus: "in_transit" });
});

partnersRouter.post("/pharmacy/queue/:id/deliver", async (req, res) => {
  const { id } = req.params;
  const { data: journey } = await supabase.from("journeys").select("*").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });
  if (journey.pharmacy_status !== "in_transit") {
    return res.status(409).json({ ok: false, error: "wrong_status", message: "Not marked in transit yet." });
  }

  const now = await closeStage(id, journey, "pharmacy");
  const next = nextStage("pharmacy"); // refill
  await supabase.from("journeys").update({
    pharmacy_status: "delivered",
    current_stage: next ? next.key : journey.current_stage,
    status: next ? "in_progress" : "completed",
    stage_entered_at: now.toISOString(),
    sla_due_at: next ? dueAt(now, next.slaHours) : null,
    updated_at: now.toISOString(),
  }).eq("id", id);
  await supabase.from("journey_events").insert({ journey_id: id, event_type: "stage_advanced", payload: { to: next?.key || "completed" } });
  await appendAudit({ journeyId: id, actor: "partner:pharmacy", decision: "delivered — advanced to refill", fieldsShared: "—" });

  res.json({ ok: true, stage: next?.key || "completed" });
});
