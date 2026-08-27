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

  // The independent telehealth network. Full clinical identity — a
  // clinician needs the patient's real name and DOB to conduct a valid
  // visit and write a valid prescription. What's still deliberately
  // excluded is insurance/payer information — that's the actual firewall:
  // a clinician's decision shouldn't correlate with what a payer might
  // reimburse, not that the clinician shouldn't know who the patient is.
  telehealth: ["patient_ref", "first_name", "last_name", "dob", "condition", "narrative", "preferred_contact"],

  // The dispensing pharmacy. Fulfillment fields only — the prescription
  // itself (drug/sig/quantity, not diagnosis), shipping address, and
  // payment-path status. No diagnosis, no narrative, no insurance member
  // detail beyond what's needed to route a PA request.
  // The dispensing pharmacy. Fulfillment fields plus real identity — a
  // pharmacy legally needs the patient's name (and DOB, for the standard
  // "two patient identifiers" dispensing safety check) to verify who
  // they're shipping/handing medication to. No diagnosis, no narrative, no
  // insurance member detail beyond what's needed to route a PA request.
  pharmacy: ["patient_ref", "first_name", "last_name", "dob", "shipping_address", "prescription", "pharmacy_status", "fill_payment_method"],
};

export function scopeFields(role, record) {
  const allow = FIELD_CONTRACTS[role];
  if (!allow) throw new Error(`No field contract defined for role "${role}"`);
  const out = {};
  for (const f of allow) if (f in record) out[f] = record[f];
  return out;
}
