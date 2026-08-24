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
export async function guardrailCheck(patient) {
  if (!patient.condition) return { pass: false, reason: "No condition on file" };
  if (!patient.consent?.care_coordination) return { pass: false, reason: "Care-coordination consent not captured" };
  if (patient.billing_method === "insurance") {
    const ins = patient.insurance;
    const required = ["payer_id", "member_id"];
    const missing = required.filter((f) => !ins?.[f]);
    if (!ins || missing.length) return { pass: false, reason: `Opted into insurance billing but missing: ${missing.join(", ") || "insurance details"}` };
  }

  // Rules pass. The NLP layer below can only tighten this result — it can
  // raise a hold or an advisory flag, never turn a rules failure into a
  // pass, and never blocks intake if it's unavailable (fails open to the
  // rules-only result above).
  const nlp = await checkNarrativeGuardrail(patient);
  if (nlp.drugPreSelected) {
    return { pass: false, reason: "Narrative names a specific drug before the visit — policy requires the clinician to determine treatment" };
  }
  return { pass: true, reason: null, advisoryFlag: nlp.contraindicationMention || null };
}

const GEMINI_MODEL = "gemini-2.5-flash";

async function callGeminiJSON(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      }
    );
    if (!res.ok) {
      console.log("[a03-llm] Gemini call failed, status:", res.status);
      return null;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    console.log("[a03-llm] Gemini call errored:", e.message);
    return null;
  }
}

/**
 * A03's NLP layer (advisory, on top of the rule floor above). Reads the
 * patient's own intake narrative for two things a structured-field rules
 * engine can't check: the patient explicitly naming a drug before the
 * visit (a policy violation — treatment choice belongs to the clinician),
 * and any contraindication-adjacent mention, surfaced as a flag for a
 * human to see, never used to block on its own. If Gemini isn't configured
 * or the call fails, this returns a neutral no-op result — guardrailCheck
 * then falls back to the rules-only outcome, exactly as if this layer
 * didn't run at all.
 */
async function checkNarrativeGuardrail(patient) {
  const narrative = (patient.narrative || "").trim();
  if (!narrative) return { drugPreSelected: false, contraindicationMention: null };

  const prompt = `You are a policy compliance checker for a patient intake narrative. You do NOT diagnose or judge clinical appropriateness — only detect two things.

Patient's own words: "${narrative.slice(0, 1000)}"

Return ONLY a JSON object with this exact shape:
{"drugPreSelected": boolean, "contraindicationMention": string or null}

drugPreSelected = true ONLY if the patient explicitly names a specific brand or drug they want prescribed (e.g. "I want Ozempic"). Mentioning a condition or symptom is NOT pre-selection.
contraindicationMention = a short (under 15 words) neutral description of anything mentioned that a clinician should know about (e.g. "mentions pregnancy", "mentions currently taking blood thinners"), or null if nothing notable.`;

  const result = await callGeminiJSON(prompt);
  if (!result || typeof result.drugPreSelected !== "boolean") {
    return { drugPreSelected: false, contraindicationMention: null };
  }
  return result;
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
  return { ok: true, result: await fn(input) };
}
