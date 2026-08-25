// ============================================================================
// "Only the information a stage needs should be relayed to that stage."
// This file is where that rule actually lives in code: an allow-list per
// downstream role, and a function that redacts everything else. Every new
// partner endpoint (payer, telehealth, pharmacy, courier) should build its
// response through scopeFields() instead of returning the patient row raw.
// ============================================================================
export const FIELD_CONTRACTS = {
  // The pharma workflow dashboard: stage/timing/status only, never PHI.
  dashboard: ["patient_ref", "current_stage", "status", "stage_entered_at", "sla_due_at", "is_breached"],

  // The independent telehealth network. Clinical fields only — explicitly
  // NO insurance/payer information. This is the routing/prescribing
  // firewall: a clinician deciding treatment must not see which payer is
  // involved or what it might reimburse, to keep the visit's outcome
  // uncorrelated with coverage economics.
  telehealth: ["patient_ref", "condition", "narrative", "preferred_contact"],

  // The dispensing pharmacy. Fulfillment fields only — no diagnosis, no
  // narrative, no insurance detail. Just what's needed to ship the
  // prescribed therapy to the right place.
  pharmacy: ["patient_ref", "shipping_address", "prescription"],

  logistics: ["patient_ref", "shipping_address"],
};

export function scopeFields(role, record) {
  const allow = FIELD_CONTRACTS[role];
  if (!allow) throw new Error(`No field contract defined for role "${role}"`);
  const out = {};
  for (const f of allow) if (f in record) out[f] = record[f];
  return out;
}
