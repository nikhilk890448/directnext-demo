import { supabase } from "./db.js";

// ============================================================================
// Every function below is a deterministic, rule-based stand-in. Each has a
// fixed input/output shape on purpose: swap the body for a real model or
// external AI call later and nothing that calls runAgent() has to change.
// ============================================================================

function hashToUnit(str) {
  // Deterministic pseudo-randomness from a string, so demo runs are stable.
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

/** Governance — ORCH plane. Checks the intake payload for missing required fields. */
export function checkIntakeCompleteness(patient) {
  const required = ["first_name", "last_name", "dob", "email", "condition"];
  const missing = required.filter((f) => !patient[f]);
  return { pass: missing.length === 0, missingFields: missing };
}

/** Governance — GOV plane, fail-closed. Basic policy hard-stops before any clinician handoff. */
export function guardrailCheck(patient) {
  if (!patient.condition) return { pass: false, reason: "No condition on file" };
  if (!patient.consent?.care_coordination) return { pass: false, reason: "Care-coordination consent not captured" };
  if (patient.billing_method === "insurance") {
    const ins = patient.insurance;
    const required = ["payer_id", "member_id"];
    const missing = required.filter((f) => !ins?.[f]);
    if (!ins || missing.length) return { pass: false, reason: `Opted into insurance billing but missing: ${missing.join(", ") || "insurance details"}` };
  }
  return { pass: true, reason: null };
}

/** ORCH. Predicts likelihood the payer denies prior authorization. */
export function predictDenialRisk(patient) {
  const seed = hashToUnit((patient.insurance?.payer || "unknown") + patient.patient_ref);
  const risk = seed < 0.15 ? "high" : seed < 0.45 ? "medium" : "low";
  return { risk, reason: `heuristic score on payer + program mix (${(seed * 100).toFixed(0)})` };
}

/** ORCH. Suggests the lowest-cost fulfillment/assistance pathway. */
export function calculateCheapestOption(patient) {
  const options = ["Manufacturer copay card", "Bridge program", "Standard benefit", "Foundation assistance"];
  const seed = hashToUnit(patient.patient_ref + "cost");
  const option = options[Math.floor(seed * options.length)];
  const estCost = Math.round(20 + seed * 180);
  return { option, estMonthlyCost: estCost };
}

/** ORCH. Predicts a 0–100 adherence likelihood score for the refill stage. */
export function predictAdherence(patient) {
  const seed = hashToUnit(patient.patient_ref + "adherence");
  return { score: Math.round(40 + seed * 60) };
}

const AGENT_FNS = {
  "intake-completeness": checkIntakeCompleteness,
  guardrail: guardrailCheck,
  "denial-risk": predictDenialRisk,
  "cost-optimizer": calculateCheapestOption,
  adherence: predictAdherence,
};

/**
 * Runs an agent by id, respecting its kill-switch status in agent_registry.
 * GOV-plane agents fail closed (caller should hold the journey if down);
 * ORCH-plane agents fail open (return a neutral fallback, never block).
 */
export async function runAgent(agentId, input) {
  const { data: agent } = await supabase.from("agent_registry").select("*").eq("id", agentId).maybeSingle();
  if (!agent) return { ok: false, error: "unknown agent" };

  if (agent.status === "down") {
    if (agent.plane === "GOV") {
      return { ok: false, failClosed: true, reason: `${agent.name} is unavailable` };
    }
    return { ok: true, failOpen: true, result: null, reason: `${agent.name} unavailable — rules baseline used` };
  }

  const fn = AGENT_FNS[agentId];
  if (!fn) return { ok: false, error: "no implementation" };
  return { ok: true, result: fn(input) };
}
