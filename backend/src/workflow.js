// The declarative shape of the program — one array, everything else reads it.
//
// Order note: insurance_pa sits AFTER telehealth. A prior authorization
// review needs the clinician's diagnosis and medical necessity rationale —
// that only exists once the telehealth visit has happened. This is
// different from a bare eligibility/coverage check (which only needs
// demographic + policy matching and could run earlier); this program models
// the fuller prior-auth process, so it waits for the clinical note.
export const STAGES = [
  { key: "intake", label: "Intake & Consent", slaHours: 24, owner: "Patient Services" },
  { key: "safety_check", label: "Safety / Completeness Check", slaHours: 4, owner: "Governance" },
  { key: "telehealth", label: "Telehealth Visit", slaHours: 48, owner: "Independent Clinician" },
  { key: "insurance_pa", label: "Insurance Prior Authorization", slaHours: 72, owner: "Access & Benefits" },
  { key: "pharmacy", label: "Pharmacy Fulfillment", slaHours: 24, owner: "Fulfilment" },
  { key: "logistics", label: "Logistics / Delivery", slaHours: 48, owner: "Fulfilment" },
  { key: "refill", label: "Adherence & Refill", slaHours: 720, owner: "Care Team" },
];

export function stageIndex(key) {
  return STAGES.findIndex((s) => s.key === key);
}

/**
 * Next stage after `key`. Pass { skipInsurance: true } for patients who
 * chose to self-pay at intake — their journey never touches insurance_pa.
 */
export function nextStage(key, { skipInsurance = false } = {}) {
  let i = stageIndex(key);
  if (i === -1) return null;
  i++;
  while (i < STAGES.length) {
    if (skipInsurance && STAGES[i].key === "insurance_pa") { i++; continue; }
    return STAGES[i];
  }
  return null;
}

export function slaHoursFor(key) {
  return STAGES.find((s) => s.key === key)?.slaHours ?? 24;
}
export function dueAt(fromDate, hours) {
  return new Date(fromDate.getTime() + hours * 3600 * 1000).toISOString();
}
