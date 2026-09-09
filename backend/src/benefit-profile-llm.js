// backend/src/benefit-profile-llm.js
//
// Calls Indegene's Cortex agent platform to turn a REDACTED Stedi
// eligibility response into a structured benefit profile + pathway.
//
// CONFIRMED (from the actual Cortex agent configuration):
//   - Input variable "insurance_profile" (type json) — this is where the
//     redacted Stedi data goes, as a native JSON value, not a string.
//   - Output variable "benefit_profile" — the agent's answer, expected to
//     contain the benefit details AND a "pathway" field nested inside it.
//
// STILL UNCONFIRMED (marked TODO below): the auth header format, and
// exactly where in the response body the "benefit_profile" output
// variable actually lands (trying the most likely shape first, with
// fallbacks, and logging the full raw response either way).
import { randomUUID } from "crypto";

const CORTEX_ENDPOINT = process.env.CORTEX_ENDPOINT || "https://cortex.indegene.ai/api/v1/agents/run";

export async function buildBenefitProfile(redactedStediResponse) {
  if (!process.env.CORTEX_API_KEY) {
    console.log("[cortex] CORTEX_API_KEY not set — skipping, caller falls back to the default pathway");
    return null;
  }
  if (!process.env.CORTEX_AGENT_ID) {
    console.log("[cortex] CORTEX_AGENT_ID not set — required to know which agent to run.");
    return null;
  }

  const requestBody = {
    agent_id: parseInt(process.env.CORTEX_AGENT_ID, 10),
    variables: {
      // CONFIRMED (from Cortex's own validation error): despite being a
      // "json"-typed variable in Cortex's UI, the API wants it as a JSON
      // STRING, not a native object — Cortex's own template engine parses
      // it internally. Sending the raw object caused: "Input
      // 'insurance_profile' has the wrong type: expected a string."
      insurance_profile: JSON.stringify(redactedStediResponse),
    },
    session_id: randomUUID(), // fresh per call — this isn't a multi-turn conversation
    scenario_id: null,
    version_no: null,
    // The actual data travels via `variables.insurance_profile` above —
    // this is just the instruction telling the agent what to do with it.
    message: "Using the provided insurance_profile, generate the benefit_profile output: a structured benefit summary (plan name, whether coverage is active, deductible, copay, coinsurance, whether prior authorization is likely) plus a pathway field set to either \"insured\" or \"hold\" (\"hold\" if coverage isn't active or the data is too incomplete to proceed confidently).",
    verbose: false,
  };

  try {
    const res = await fetch(CORTEX_ENDPOINT, {
      method: "POST",
      headers: {
        // TODO: still unconfirmed — Bearer-token is a guess.
        Authorization: `Bearer ${process.env.CORTEX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.log("[cortex] call failed, status:", res.status, errText.slice(0, 500));
      return null;
    }

    const data = await res.json();
    console.log("[cortex] raw response:", JSON.stringify(data, null, 2));

    // Look for the named output variable "benefit_profile" in the most
    // likely places first — mirroring the request's own "variables"
    // structure — then fall back to a few generic guesses. Whatever the
    // real shape turns out to be, the raw log above shows it exactly.
    const benefitProfile =
      data.variables?.benefit_profile ??
      data.output_variables?.benefit_profile ??
      data.outputs?.benefit_profile ??
      data.benefit_profile ??
      null;

    if (!benefitProfile) {
      console.log("[cortex] no benefit_profile found in the response — check the raw response above and update the extraction here");
      return null;
    }

    const parsed = typeof benefitProfile === "string" ? JSON.parse(benefitProfile) : benefitProfile;
    if (!parsed || !parsed.pathway) {
      console.log("[cortex] benefit_profile was found but had no pathway field:", JSON.stringify(parsed));
      return null;
    }
    return parsed;
  } catch (e) {
    console.log("[cortex] errored:", e.message);
    return null;
  }
}
