import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { supabase } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ============================================================================
// This service stands in for a payer's real-time eligibility system — the
// counterpart to an X12 270/271 exchange, in a plain-JSON shape instead of
// literal EDI segments (the segment syntax adds nothing to the demo; the
// field requirements are the real part, and those are preserved exactly).
// It is reached by the main backend over a genuine HTTP call, not an
// in-process function — this process can be redeployed, scaled, or replaced
// with a real clearinghouse connection independently of the main backend.
// ============================================================================

const REQUIRED = [
  ["payerId", (p) => p.payerId],
  ["provider.npi", (p) => p.provider?.npi],
  ["subscriber.memberId", (p) => p.subscriber?.memberId],
  ["subscriber.lastName", (p) => p.subscriber?.lastName],
  ["subscriber.dob", (p) => p.subscriber?.dob],
  ["serviceTypeCode", (p) => p.serviceTypeCode],
];

function findMissing(payload) {
  return REQUIRED.filter(([, get]) => !get(payload)).map(([label]) => label);
}

function hashToUnit(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

const PLANS = ["Bronze Advantage", "Silver Select", "Gold Choice PPO", "Platinum Complete"];

function adjudicate(payload) {
  const seed = hashToUnit((payload.payerId || "") + (payload.subscriber?.memberId || "") + payload.requestId);
  if (seed < 0.15) return { outcome: "pending_review" };
  if (seed < 0.30) {
    return {
      outcome: "auto_denied",
      decision: { reason: seed < 0.22 ? "Prior authorization required and not on file" : "Therapy not covered under this plan tier" },
    };
  }
  return {
    outcome: "auto_approved",
    decision: {
      planName: PLANS[Math.floor(seed * PLANS.length)],
      copay: Math.round(10 + seed * 60),
      coinsurance: Math.round(seed * 20),
      deductibleRemaining: Math.round(seed * 2000),
      priorAuthRequired: false,
    },
  };
}

// POST /eligibility/inquiry — called by the main backend.
app.post("/eligibility/inquiry", async (req, res) => {
  const payload = req.body || {};
  const missing = findMissing(payload);

  if (missing.length > 0) {
    await supabase.from("eligibility_requests").insert({
      journey_id: payload.requestId, request: payload, missing_fields: missing, status: "needs_info",
    });
    return res.json({ status: "needs_info", missingFields: missing });
  }

  const { outcome, decision } = adjudicate(payload);
  const dbStatus = outcome; // "pending_review" | "auto_denied" | "auto_approved"

  await supabase.from("eligibility_requests").insert({
    journey_id: payload.requestId, request: payload, missing_fields: [], status: dbStatus, decision: decision || null,
  });

  res.json({ status: outcome, decision: decision || null });
});

// GET /api/requests — for the dashboard.
app.get("/api/requests", async (_req, res) => {
  const { data, error } = await supabase.from("eligibility_requests").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, requests: data });
});

// POST /api/requests/:id/decide — human reviewer acts on a pending_review request,
// then calls back to the main backend over real HTTP so the journey actually moves.
app.post("/api/requests/:id/decide", async (req, res) => {
  const { id } = req.params;
  const { decision: outcome, notes } = req.body || {}; // "approved" | "denied"

  const { data: row } = await supabase.from("eligibility_requests").select("*").eq("id", id).maybeSingle();
  if (!row) return res.status(404).json({ ok: false, error: "not found" });

  const decisionPayload = outcome === "approved"
    ? { planName: "Reviewed — Standard Plan", copay: 35, coinsurance: 10, deductibleRemaining: 400, priorAuthRequired: false }
    : { reason: notes || "Denied on manual review" };

  await supabase.from("eligibility_requests").update({
    status: outcome, decision: decisionPayload, reviewed_by: "demo-reviewer", updated_at: new Date().toISOString(),
  }).eq("id", id);

  try {
    await fetch(`${process.env.BACKEND_URL}/api/journeys/${row.journey_id}/eligibility-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Payer-Callback-Key": process.env.PAYER_CALLBACK_SECRET || "" },
      body: JSON.stringify({ status: outcome, decision: decisionPayload }),
    });
  } catch (e) {
    console.error("callback to backend failed:", e.message);
    return res.status(502).json({ ok: false, error: "decided locally but callback to backend failed", detail: e.message });
  }

  res.json({ ok: true });
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, "..", "public")));

const port = process.env.PORT || 8081;
app.listen(port, () => console.log(`Payer simulator listening on :${port}`));
