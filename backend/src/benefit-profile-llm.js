// backend/src/benefit-profile-llm.js
//
// Calls Indegene's Cortex agent (DNX-A01) to turn a REDACTED Stedi
// eligibility response into a structured benefit profile + pathway.
//
// CONFIRMED response envelope (from Cortex's own API docs):
//   { final_content: "...", grounded_state, run_id, verification_complete, ... }
// final_content is where the agent's actual answer lives — its shape
// "matches the declared output type," which per DNX-A01's own system
// prompt is the benefit_profile JSON schema below. It's emitted as text
// ("Emit only well-formed JSON... do not output conversational prose or
// code fences"), so it needs JSON.parse().
//
// CONFIRMED benefit_profile schema (from DNX-A01's own system prompt):
//   patient_ref, pathway ("self-pay" | "standard_copay" | "direct_dispense" | "hold"),
//   pathway_conf (0.0–1.0; agent itself is instructed to force "hold"
//   below 0.90 — we double-check this too, see agents.js),
//   coverage: { status, plan_type }, pa_required (boolean),
//   fields: [{ name, value, source_span, conf, judge }], routing: { to }
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
      // Cortex wants this as a JSON STRING even though the variable's
      // declared type is "json" — confirmed from an earlier validation error.
      insurance_profile: JSON.stringify(redactedStediResponse),
    },
    session_id: randomUUID(),
    scenario_id: null,
    version_no: null,
    // DNX-A01's own system prompt already fully defines the task (it
    // references {insurance_profile} and {benefit_profile} as its own
    // template variables) — this just needs to trigger the run, not repeat
    // instructions the agent's own configuration already has.
    message: "Generate the benefit_profile for the provided insurance_profile.",
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
    console.log("[cortex] grounded_state:", data.grounded_state, "· run_id:", data.run_id);

    if (!data.final_content) {
      console.log("[cortex] no final_content in response:", JSON.stringify(data, null, 2));
      return null;
    }

    let parsed;
    try {
      parsed = typeof data.final_content === "string" ? JSON.parse(data.final_content) : data.final_content;
    } catch (e) {
      console.log("[cortex] final_content wasn't valid JSON:", data.final_content);
      return null;
    }

    if (!parsed.pathway) {
      console.log("[cortex] parsed benefit_profile had no pathway field:", JSON.stringify(parsed));
      return null;
    }
    return parsed;
  } catch (e) {
    console.log("[cortex] errored:", e.message);
    return null;
  }
}
