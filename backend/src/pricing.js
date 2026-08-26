// Deterministic synthetic pricing — NOT real drug pricing, no external
// pricing API involved. Given a structured prescription (drug + quantity),
// computes a cash price and an estimated insurance copay. This is the
// "check what drug is prescribed and quantity, then price it" step —
// same "deterministic stub behind a fixed contract" pattern as every other
// agent in this build; swap the body for a real pricing feed later without
// touching any caller.
function hashToUnit(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

export function computePricing(prescription) {
  const drug = (prescription?.drugName || "unknown").toLowerCase();
  const qty = Number(prescription?.quantity) || 1;
  const seed = hashToUnit(drug + qty);
  const basePricePerUnit = 40 + Math.round(seed * 460); // $40–$500/unit, synthetic
  const cashPrice = Math.round(basePricePerUnit * qty);
  const insurancePriceEstimate = Math.round(15 + seed * 65); // typical copay range, synthetic
  return { cashPrice, insurancePriceEstimate };
}
