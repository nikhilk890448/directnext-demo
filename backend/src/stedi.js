// Real-time eligibility checks via Stedi's clearinghouse API. This answers
// "is this coverage actually active" — a genuinely different question from
// what A01 checked before (only whether the patient typed *something* into
// the insurance fields). It does NOT answer "is this specific therapy
// covered" — that's what prior authorization (pharmacy-initiated, see
// eligibility-check.js) is for; a 270/271 check can't determine that.
const STEDI_ENDPOINT = "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3";

export async function checkStediEligibility(patient) {
  const ins = patient.insurance;
  if (!ins?.payer_id || !ins?.member_id) return { ok: false, reason: "missing_fields" };

  const isSelf = (ins.relationship_to_subscriber || "self") === "self";
  const toStediDate = (d) => (d || "").replaceAll("-", ""); // YYYY-MM-DD -> YYYYMMDD

  const payload = {
    tradingPartnerServiceId: ins.payer_id,
    provider: { organizationName: "DirectNEXT Care Program", npi: "1999999984" },
    subscriber: isSelf
      ? { firstName: patient.first_name, lastName: patient.last_name, memberId: ins.member_id, dateOfBirth: toStediDate(patient.dob) }
      : { firstName: ins.subscriber_first_name, lastName: ins.subscriber_last_name, memberId: ins.member_id, dateOfBirth: toStediDate(ins.subscriber_dob) },
    encounter: { serviceTypeCodes: ["30"] }, // 30 = general health benefit plan coverage
  };
  if (!isSelf) {
    payload.dependents = [{ firstName: patient.first_name, lastName: patient.last_name, dateOfBirth: toStediDate(patient.dob) }];
  }

  console.log("[stedi] OUTGOING eligibility request:", JSON.stringify(payload, null, 2));

  let response, body;
  try {
    response = await fetch(STEDI_ENDPOINT, {
      method: "POST",
      // FIXED: Stedi requires the "Key " prefix — a bare API key fails auth.
      headers: { Authorization: `Key ${process.env.STEDI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    body = await response.json();
  } catch (e) {
    console.log("[stedi] request failed (network error):", e.message);
    return { ok: false, reason: "network_error" };
  }

  console.log("[stedi] INCOMING eligibility response:", JSON.stringify(body, null, 2));

  if (!response.ok || (body.errors && body.errors.length > 0)) {
    return { ok: false, reason: "stedi_error", raw: body };
  }

  const activeStatus = (body.planStatus || []).find((s) => s.statusCode === "1");
  return {
    ok: true,
    active: !!activeStatus,
    planDetails: activeStatus?.planDetails || null,
    checkId: body.id || null,
    searchId: body.eligibilitySearchId || null,
    raw: body,
  };
}

/**
 * Strips patient-identifying fields from a raw Stedi response before it's
 * handed to any LLM — keeps plan/benefit data (what's actually needed to
 * reason about coverage), drops subscriber/dependent name, DOB, and member
 * ID. Payer name/ID is kept (not patient PII).
 */
export function redactStediResponse(raw) {
  if (!raw) return null;
  const stripPerson = (p) => (p ? { relationship: p.relationship, gender: p.gender } : undefined);
  return {
    payer: raw.payer ? { name: raw.payer.name } : undefined,
    planInformation: raw.planInformation,
    planStatus: raw.planStatus,
    benefitsInformation: raw.benefitsInformation,
    subscriber: stripPerson(raw.subscriber),
    dependents: Array.isArray(raw.dependents) ? raw.dependents.map(stripPerson) : undefined,
    errors: raw.errors,
  };
}
