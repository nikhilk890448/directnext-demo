// The declarative shape of the program — one array, everything else reads it.
//
// insurance_pa and logistics are no longer separate top-level stages. Both
// are now sub-statuses inside "pharmacy" (journeys.pharmacy_status):
// prescription_received → payment_pending/insurance_pa_pending →
// payment_received/insurance_approved → dispensed → in_transit → delivered.
// This matches how prior authorization and shipping actually happen in
// practice — pharmacy-initiated, not automatic upstream gates — and is
// what lets the pharmacy console own the whole fulfillment lifecycle.
export const STAGES = [
  { key: "intake", label: "Intake & Consent", slaHours: 24, owner: "Patient Services" },
  { key: "safety_check", label: "Safety / Completeness Check", slaHours: 4, owner: "Governance" },
  { key: "telehealth", label: "Telehealth Visit", slaHours: 48, owner: "Independent Clinician" },
  { key: "pharmacy", label: "Pharmacy Fulfillment", slaHours: 96, owner: "Fulfilment" },
  { key: "refill", label: "Adherence & Refill", slaHours: 720, owner: "Care Team" },
];

export function stageIndex(key) {
  return STAGES.findIndex((s) => s.key === key);
}

export function nextStage(key) {
  const i = stageIndex(key);
  if (i === -1 || i === STAGES.length - 1) return null;
  return STAGES[i + 1];
}

export function slaHoursFor(key) {
  return STAGES.find((s) => s.key === key)?.slaHours ?? 24;
}
export function dueAt(fromDate, hours) {
  return new Date(fromDate.getTime() + hours * 3600 * 1000).toISOString();
}
