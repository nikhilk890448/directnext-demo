// The declarative shape of the program — one array, everything else reads it.
// Adding a real partner integration later means adding a stage here and an
// endpoint that calls POST /api/journeys/:id/advance; nothing else changes.
export const STAGES = [
  { key: "intake", label: "Intake & Consent", slaHours: 24, owner: "Patient Services" },
  { key: "safety_check", label: "Safety / Completeness Check", slaHours: 4, owner: "Governance" },
  { key: "insurance_pa", label: "Insurance Prior Authorization", slaHours: 72, owner: "Access & Benefits" },
  { key: "telehealth", label: "Telehealth Visit", slaHours: 48, owner: "Independent Clinician" },
  { key: "pharmacy", label: "Pharmacy Fulfillment", slaHours: 24, owner: "Fulfilment" },
  { key: "logistics", label: "Logistics / Delivery", slaHours: 48, owner: "Fulfilment" },
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
