// backend/src/benefit-profile-llm.js
//
// Calls Indegene's Cortex agent platform to turn a REDACTED Stedi
// eligibility response into a structured benefit profile + pathway.
//
// CONFIRMED: this points at a real endpoint (cortex.indegene.ai).
// NOT CONFIRMED: the exact request/response JSON shape below — there's no
// public API reference for this internal platform, so the two spots
// marked TODO are a best guess at common "agent run" conventions
// (Bearer auth, {input: "..."} body). Check Indegene's internal Cortex
// API docs and adjust those two spots if the real contract differs —
// everything else (the redaction, the prompt content, how the result
// gets used) stays correct regardless.

const CORTEX_ENDPOINT = process.env.CORTEX_ENDPOINT || "https://cortex.indegene.ai/api/v1/agents/run";

export async function buildBenefitProfile(redactedStediResponse) {
  if (!process.env.CORTEX_API_KEY) {
    return null; // not configured — caller falls back to the existing heuristic
  }

  const prompt = `You are reviewing a patient's insurance benefit data (already stripped of any name, date of birth, or member ID) to produce a structured benefit profile and a pathway recommendation.

Benefit data:
${JSON.stringify(redactedStediResponse, null, 2)}

Return ONLY a JSON object with this exact shape:
{
  "benefitProfile": {
    "planName": string or null,
    "coverageActive": boolean,
    "deductible": string or null,
    "copay": string or null,
    "coinsurance": string or null,
    "priorAuthLikely": boolean,
    "notes": string
  },
  "pathway": "insured" | "hold"
}

pathway = "hold" if coverage is not active or the benefit data is too incomplete to proceed confidently. Otherwise "insured".`;

  try {
    const res = await fetch(CORTEX_ENDPOINT, {
      method: "POST",
      headers: {
        // TODO: confirm this is really Bearer-token auth for Cortex —
        // some internal platforms use a custom header (e.g. "x-api-key")
        // instead. Check your Cortex API docs.
        Authorization: `Bearer ${process.env.CORTEX_API_KEY}`,
        "Content-Type": "application/json",
      },
      // TODO: confirm the actual request body shape Cortex's agents/run
      // endpoint expects — this guesses a plain {input: "..."} body,
      // which is one common convention but not confirmed for Cortex
      // specifically. It may instead want something like
      // {agentId: "...", messages: [{role: "user", content: prompt}]}.
      body: JSON.stringify({ input: prompt }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.log("[cortex] call failed, status:", res.status, errText.slice(0, 300));
      return null;
    }

    const data = await res.json();
    console.log("[cortex] raw response:", JSON.stringify(data, null, 2));

    // TODO: confirm where Cortex actually puts the agent's text output —
    // this tries a few common shapes (output, result, response, text) but
    // the real field name needs verifying against your Cortex docs.
    const text = data.output || data.result || data.response || data.text;
    if (!text) {
      console.log("[cortex] response had no recognizable output field — check the raw response above and update the extraction in benefit-profile-llm.js");
      return null;
    }

    const parsed = typeof text === "string" ? JSON.parse(text) : text;
    if (!parsed.pathway || !parsed.benefitProfile) return null;
    return parsed;
  } catch (e) {
    console.log("[cortex] errored:", e.message);
    return null;
  }
}
