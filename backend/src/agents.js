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

// Conditions where a prior-auth requirement is more likely — a coarse,
// declared heuristic (not a real payer-policy lookup), used only to set an
// early expectation carried forward to the insurance_pa stage.
const PA_LIKELY_CONDITIONS = ["Rheumatoid Arthritis", "Multiple Sclerosis", "Crohn's Disease"];

/**
 * A01 — Eligibility & Benefits, ORCH plane, fail-open. Runs FIRST, before
 * any patient/journey record is even created. This is the single gate for
 * everything about whether the submission is usable at all:
 *   1. Intake completeness — the required fields are present.
 *   2. Consent — care-coordination consent was captured. Required on both
 *      paths, but especially load-bearing on the insurance path, since it's
 *      what makes sharing with the payer for a coverage determination
 *      legitimate later at insurance_pa.
 *   3. If billing_method is "insurance": the insurance fields needed to
 *      even attempt a coverage check are present (payer_id, member_id).
 * A03, downstream, is purely the clinical/policy layer — it doesn't
 * re-check any of this.
 */
export function checkEligibility(patient) {
  const requiredFields = ["first_name", "last_name", "dob", "email", "condition"];
  const missingFields = requiredFields.filter((f) => !patient[f]);
  if (missingFields.length) {
    return { pass: false, reason: `Incomplete intake — missing: ${missingFields.join(", ")}`, missingFields, pathway: null, paRequired: null };
  }

  if (!patient.consent?.care_coordination) {
    return { pass: false, reason: "Care-coordination consent not captured", pathway: null, paRequired: null };
  }

  if (patient.billing_method !== "insurance") {
    return { pass: true, reason: null, pathway: "self-pay", paRequired: false };
  }

  const ins = patient.insurance;
  const required = ["payer_id", "member_id"];
  const missing = required.filter((f) => !ins?.[f]);
  if (!ins || missing.length) {
    return { pass: false, reason: `Opted into insurance billing but missing: ${missing.join(", ") || "insurance details"}`, pathway: "hold", paRequired: null };
  }
  return { pass: true, reason: null, pathway: "insured", paRequired: PA_LIKELY_CONDITIONS.includes(patient.condition) };
}

/**
 * A03 — Appropriateness Guardrail, GOV plane, fail-closed. Runs SECOND,
 * only once A01 has already cleared completeness, consent, and (if
 * applicable) insurance fields — none of that is re-checked here. This is
 * purely the clinical/policy layer: the NLP narrative check for drug
 * pre-selection and any contraindication-adjacent mention. It can only add
 * a hold or a flag on top of an already-clean intake; it never has
 * anything of its own to fail on besides what the NLP layer finds.
 */
export async function guardrailCheck(patient) {
  const nlp = await checkNarrativeGuardrail(patient);
  if (nlp.drugPreSelected) {
    return { pass: false, reason: "Narrative names a specific drug before the visit — policy requires the clinician to determine treatment", nlpProvenance: nlp };
  }
  return { pass: true, reason: null, advisoryFlag: nlp.contraindicationMention || null, nlpProvenance: nlp };
}

// Gemini model names get deprecated/rotated fairly often (this is a known,
// ongoing thing with the free tier). Try a short list in order and remember
// whichever one actually works for this process, instead of hardcoding one
// string that can 404 again next month.
const GEMINI_MODEL_CANDIDATES = ["gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-flash-latest"];
let workingGeminiModel = null;

async function callGeminiJSON(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const modelsToTry = workingGeminiModel ? [workingGeminiModel] : GEMINI_MODEL_CANDIDATES;

  for (const model of modelsToTry) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0 },
          }),
        }
      );
      if (res.status === 404) {
        console.log(`[a03-llm] model "${model}" not available (404), trying next candidate`);
        continue; // this model is retired/unavailable — try the next one
      }
      if (!res.ok) {
        console.log(`[a03-llm] Gemini call failed with model "${model}", status:`, res.status);
        return null; // a non-404 failure (rate limit, bad request, etc.) — don't keep guessing models
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return null;
      workingGeminiModel = model; // remember it worked, skip straight to it next time
      console.log(`[a03-llm] using model "${model}"`);
      return JSON.parse(text);
    } catch (e) {
      console.log(`[a03-llm] Gemini call errored with model "${model}":`, e.message);
      return null;
    }
  }
  console.log("[a03-llm] no candidate model worked — falling back to rules-only");
  return null;
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
  if (!narrative) return { drugPreSelected: false, contraindicationMention: null, ran: false, model: null, skippedReason: "no narrative provided" };

  const prompt = `You are a policy compliance checker for a patient intake narrative. You do NOT diagnose or judge clinical appropriateness — only detect two things.

Patient's own words: "${narrative.slice(0, 1000)}"

Return ONLY a JSON object with this exact shape:
{"drugPreSelected": boolean, "contraindicationMention": string or null}

drugPreSelected = true ONLY if the patient explicitly names a specific brand or drug they want prescribed (e.g. "I want Ozempic"). Mentioning a condition or symptom is NOT pre-selection.
contraindicationMention = a short (under 15 words) neutral description of anything mentioned that a clinician should know about (e.g. "mentions pregnancy", "mentions currently taking blood thinners"), or null if nothing notable.`;

  const result = await callGeminiJSON(prompt);
  if (!result || typeof result.drugPreSelected !== "boolean") {
    return { drugPreSelected: false, contraindicationMention: null, ran: false, model: null, skippedReason: "model unavailable or returned an unparseable response — fell back to rules-only" };
  }
  return { ...result, ran: true, model: workingGeminiModel, skippedReason: null };
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
  eligibility: checkEligibility,
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
