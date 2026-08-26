import { Router } from "express";
import { authClient } from "../authClient.js";
import { requirePatientAuth } from "../auth.js";
import { restGet } from "../rest.js";
import { supabase } from "../db.js";
import { appendAudit } from "../hash.js";
import { STAGES } from "../workflow.js";

export const patientRouter = Router();

patientRouter.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: "missing_credentials" });

  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ ok: false, error: "invalid_credentials" });

  res.json({ ok: true, accessToken: data.session.access_token });
});

// GET /api/patient/me — this is the ONE place the full, real patient record
// (their own name, stage, tasks) is returned. It only works with a valid
// token belonging to that exact patient, verified in requirePatientAuth.
// Uses restGet (raw PostgREST calls) rather than supabase.from() — see the
// comment in auth.js for why: the SDK query builder was unreliable for
// this project, plain HTTP calls to the same endpoint work every time.
patientRouter.get("/me", requirePatientAuth, async (req, res) => {
  const patient = req.patient;

  const journeyPath = `journeys?patient_id=eq.${patient.id}&order=created_at.desc&limit=1&select=*`;
  const { data: journeys } = await restGet(journeyPath);
  const journey = Array.isArray(journeys) && journeys.length ? journeys[0] : null;

  let tasks = [];
  let pricing = null;
  let paymentRequest = null;
  if (journey) {
    const tasksPath = `tasks?journey_id=eq.${journey.id}&status=eq.open&order=created_at.desc&select=*`;
    const { data } = await restGet(tasksPath);
    tasks = Array.isArray(data) ? data : [];

    if (journey.current_stage === "pharmacy") {
      const { data: quotes } = await restGet(`pricing_quotes?journey_id=eq.${journey.id}&order=created_at.desc&limit=1&select=*`);
      const q = Array.isArray(quotes) && quotes.length ? quotes[0] : null;
      if (q) pricing = { cashPrice: q.cash_price, insurancePriceEstimate: q.insurance_price_estimate };

      const { data: pays } = await restGet(`payment_requests?journey_id=eq.${journey.id}&status=eq.pending&order=created_at.desc&limit=1&select=*`);
      const p = Array.isArray(pays) && pays.length ? pays[0] : null;
      if (p) paymentRequest = { id: p.id, amount: p.amount };
    }
  }

  res.json({
    ok: true,
    patient: { firstName: patient.first_name, patientRef: patient.patient_ref, condition: patient.condition },
    journey: journey
      ? {
          currentStage: journey.current_stage,
          stageLabel: STAGES.find((s) => s.key === journey.current_stage)?.label || journey.current_stage,
          status: journey.status,
          slaDueAt: journey.sla_due_at,
          pharmacyStatus: journey.pharmacy_status,
          fillPaymentMethod: journey.fill_payment_method,
          prescription: journey.prescription
            ? { drugName: journey.prescription.drugName, sig: journey.prescription.sig, quantity: journey.prescription.quantity }
            : null,
        }
      : null,
    pricing,
    paymentRequest,
    tasksNeedingYou: tasks.map((t) => ({ reason: t.reason, priority: t.priority, createdAt: t.created_at })),
    stages: STAGES.map((s) => s.key),
  });
});

// POST /api/patient/fill-payment-choice — the patient picks cash or
// insurance for THIS specific fill, once real pricing exists (never at
// intake, before a drug was even chosen). Choosing cash immediately opens
// a payment request; choosing insurance just records the choice — the
// pharmacy is the one that actually submits the PA (see partners.js).
patientRouter.post("/fill-payment-choice", requirePatientAuth, async (req, res) => {
  const { method } = req.body || {};
  if (!["cash", "insurance"].includes(method)) return res.status(400).json({ ok: false, error: "invalid_method" });

  const { data: journeys } = await restGet(`journeys?patient_id=eq.${req.patient.id}&order=created_at.desc&limit=1&select=*`);
  const journey = Array.isArray(journeys) && journeys.length ? journeys[0] : null;
  if (!journey || journey.current_stage !== "pharmacy") {
    return res.status(409).json({ ok: false, error: "wrong_stage", message: "No active fill awaiting a payment choice." });
  }

  const update = { fill_payment_method: method, updated_at: new Date().toISOString() };
  if (method === "cash") {
    update.pharmacy_status = "payment_pending";
  }
  await supabase.from("journeys").update(update).eq("id", journey.id);
  await appendAudit({ journeyId: journey.id, actor: "patient", decision: `chose ${method} for this fill`, fieldsShared: "payment method only", consentBasis: "consent" });

  if (method === "cash") {
    const { data: quotes } = await restGet(`pricing_quotes?journey_id=eq.${journey.id}&order=created_at.desc&limit=1&select=*`);
    const q = Array.isArray(quotes) && quotes.length ? quotes[0] : null;
    await supabase.from("payment_requests").insert({ journey_id: journey.id, amount: q?.cash_price || 0, status: "pending" });
  }

  res.json({ ok: true });
});

// POST /api/patient/pay — demo-only "pay now" button. No real payment
// gateway is integrated here; this models the routing (a payment request
// reaching the patient dashboard through our own channel), not real money
// movement.
patientRouter.post("/pay", requirePatientAuth, async (req, res) => {
  const { paymentRequestId } = req.body || {};
  const { data: payRows } = await restGet(`payment_requests?id=eq.${paymentRequestId}&select=*`);
  const pay = Array.isArray(payRows) && payRows.length ? payRows[0] : null;
  if (!pay) return res.status(404).json({ ok: false, error: "not found" });

  await supabase.from("payment_requests").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", pay.id);
  await supabase.from("journeys").update({ pharmacy_status: "payment_received", updated_at: new Date().toISOString() }).eq("id", pay.journey_id);
  await appendAudit({ journeyId: pay.journey_id, actor: "patient", decision: "payment received (demo gateway — no real funds moved)", fieldsShared: "payment status only" });

  res.json({ ok: true });
});
