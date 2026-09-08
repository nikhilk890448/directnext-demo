// Real-time eligibility checks via Stedi's clearinghouse API. This answers
// "is this coverage actually active, and does it cover this therapy line"
// — a genuinely different question from what A01 checked before (only
// whether the patient typed *something* into the insurance fields).
//
// This is distinct from eligibility-check.js, which is the PRIOR
// AUTHORIZATION step (pharmacy-initiated, after a clinician has already
// prescribed something). This module runs earlier, at intake, before any
// clinician is involved — a real X12 270/271 check, not a PA request.
const STEDI_ENDPOINT = "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3";

// Every request and response is logged in full — this is the visibility
// into outgoing/incoming JSON. Check your Render backend logs for lines
// starting with [stedi]. Stedi's own portal (portal.stedi.com) also shows
// every check with a proper inspector UI, linked by the "id" and
// "eligibilitySearchId" fields in the response below — that's usually the
// better place to actually read a payload, not just confirm it happened.
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
      headers: { Authorization: process.env.STEDI_API_KEY, "Content-Type": "application/json" },
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
