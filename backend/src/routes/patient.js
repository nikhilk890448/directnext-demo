import { Router } from "express";
import { authClient } from "../authClient.js";
import { requirePatientAuth } from "../auth.js";
import { restGet, restInsert, restUpdate } from "../rest.js";
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
//
// Uses restUpdate/restInsert (raw PostgREST) rather than supabase.from() —
// this route sits behind requirePatientAuth, the same request context
// where the SDK's query builder was previously found to silently no-op
// (see auth.js). A write that "succeeds" with 0 rows affected and no
// thrown error is exactly how this bug hid — plain HTTP avoids it, and we
// now check the result explicitly instead of assuming success.
patientRouter.post("/fill-payment-choice", requirePatientAuth, async (req, res) => {
  const { method } = req.body || {};
  if (!["cash", "insurance"].includes(method)) return res.status(400).json({ ok: false, error: "invalid_method" });

  const { data: journeys } = await restGet(`journeys?patient_id=eq.${req.patient.id}&order=created_at.desc&limit=1&select=*`);
  const journey = Array.isArray(journeys) && journeys.length ? journeys[0] : null;
  if (!journey || journey.current_stage !== "pharmacy") {
    return res.status(409).json({ ok: false, error: "wrong_stage", message: "No active fill awaiting a payment choice." });
  }

  const update = { fill_payment_method: method, updated_at: new Date().toISOString() };
  if (method === "cash") update.pharmacy_status = "payment_pending";

  const upd = await restUpdate("journeys", `id=eq.${journey.id}`, update);
  if (upd.status >= 400 || !Array.isArray(upd.data) || upd.data.length === 0) {
    console.log("[fill-payment-choice] journeys update failed or affected 0 rows:", upd.status, upd.raw || upd.data);
    return res.status(500).json({ ok: false, error: "update_failed" });
  }

  await appendAudit({ journeyId: journey.id, actor: "patient", decision: `chose ${method} for this fill`, fieldsShared: "payment method only", consentBasis: "consent" });

  if (method === "cash") {
    const { data: quotes } = await restGet(`pricing_quotes?journey_id=eq.${journey.id}&order=created_at.desc&limit=1&select=*`);
    const q = Array.isArray(quotes) && quotes.length ? quotes[0] : null;
    const ins = await restInsert("payment_requests", { journey_id: journey.id, amount: q?.cash_price || 0, status: "pending" });
    if (ins.status >= 400) console.log("[fill-payment-choice] payment_requests insert failed:", ins.status, ins.raw || ins.data);
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

  const upd1 = await restUpdate("payment_requests", `id=eq.${pay.id}`, { status: "paid", paid_at: new Date().toISOString() });
  const upd2 = await restUpdate("journeys", `id=eq.${pay.journey_id}`, { pharmacy_status: "payment_received", updated_at: new Date().toISOString() });
  if (upd1.status >= 400 || upd2.status >= 400) {
    console.log("[pay] update failed:", upd1.status, upd2.status);
    return res.status(500).json({ ok: false, error: "update_failed" });
  }

  await appendAudit({ journeyId: pay.journey_id, actor: "patient", decision: "payment received (demo gateway — no real funds moved)", fieldsShared: "payment status only" });

  res.json({ ok: true });
});

// GET /api/patient/me/export — the patient's own complete journey record as
// one downloadable JSON document: their patient record, journey, every
// stage transition, every task, the full audit trail, prescription,
// pricing, and payment/PA request history. This is safe to build exactly
// because it's scoped to the authenticated patient's OWN data — the same
// boundary that already protects /me. It is deliberately NOT the same
// thing as a pharma-side "export any patient's journey" feature — that
// would need real authentication added to the dashboard first, since the
// dashboard is currently unauthenticated by design specifically because it
// never carries PHI. Exporting PHI through that same unauthenticated
// surface would undo that boundary, so that version isn't built here.
patientRouter.get("/me/export", requirePatientAuth, async (req, res) => {
  const patient = req.patient;

  const { data: journeys } = await restGet(`journeys?patient_id=eq.${patient.id}&order=created_at.desc&select=*`);
  const journeyIds = (journeys || []).map((j) => j.id);

  const fetchAllForJourneys = async (table, orderCol = "created_at") => {
    if (journeyIds.length === 0) return [];
    const inList = journeyIds.join(",");
    const { data } = await restGet(`${table}?journey_id=in.(${inList})&order=${orderCol}`);
    return Array.isArray(data) ? data : [];
  };

  const [events, stageHistory, tasks, audit, pricing, payments, pharmacyRequests, eligibilityRequests] = await Promise.all([
    fetchAllForJourneys("journey_events"),
    fetchAllForJourneys("stage_history", "entered_at"),
    fetchAllForJourneys("tasks"),
    fetchAllForJourneys("audit_log"),
    fetchAllForJourneys("pricing_quotes"),
    fetchAllForJourneys("payment_requests"),
    fetchAllForJourneys("pharmacy_requests"),
    fetchAllForJourneys("eligibility_requests"),
  ]);

  const exportPayload = {
    exportedAt: new Date().toISOString(),
    patient: {
      patientRef: patient.patient_ref, firstName: patient.first_name, lastName: patient.last_name,
      dob: patient.dob, email: patient.email, phone: patient.phone, address: patient.address,
      condition: patient.condition, narrative: patient.narrative, billingMethod: patient.billing_method,
      insurance: patient.insurance,
    },
    journeys, journeyEvents: events, stageHistory, tasks, auditTrail: audit,
    pricingQuotes: pricing, paymentRequests: payments, pharmacyRequests, eligibilityRequests,
  };

  res.setHeader("Content-Disposition", `attachment; filename="${patient.patient_ref}-journey-export.json"`);
  res.json(exportPayload);
});
