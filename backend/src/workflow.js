// The declarative shape of the program — one array, everything else reads it.
//
// insurance_pa and logistics are no longer separate top-level stages. Both
// are now sub-statuses inside "pharmacy" (journeys.pharmacy_status):
// prescription_received → payment_pending/insurance_pa_pending →
// payment_received/insurance_approved → dispensed → in_transit → delivered.
// This matches how prior authorization and shipping actually happen in
// practice — pharmacy-initiated, not automatic upstream gates — and is
// what lets the pharmacy console own the whole fulfillment lifecycle.
//
// There is also no separate "safety_check" stage. A01 (eligibility gate)
// and A03 (guardrail) both run synchronously inside the single POST
// /api/intake request — there's no asynchronous waiting period between
// them for a journey to visibly sit at. A journey either holds at "intake"
// (A01 rejected before any record was created, or A03 held it after) or
// advances straight to "telehealth". An earlier version of this file had a
// "safety_check" stage that no code path ever actually assigned to a
// journey — a dead stage that just confused the dashboard's funnel view.
export const STAGES = [
  // 3 minutes — intake is synchronous (A01+A03 both evaluate within the
  // same request), so this SLA only matters for the rare case where a
  // journey is stuck holding on a task and nobody's looked at it yet.
  { key: "intake", label: "Intake & Consent", slaHours: 3 / 60, owner: "Patient Services" },
  // Upper bound of the stated 1–2 hour target — the SLA is the point a
  // wait becomes a breach, not the expected/typical time.
  { key: "telehealth", label: "Telehealth Visit", slaHours: 2, owner: "Independent Clinician" },
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
