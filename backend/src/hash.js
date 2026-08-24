import crypto from "crypto";
import { supabase } from "./db.js";

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

/**
 * Appends one record to the hash-chained audit trail and persists it.
 *
 * `decision` and `fieldsShared` must always be written PHI-free — they are
 * readable by the dashboard. Describe *what happened*, never the patient's
 * personal or clinical details ("payer response received" not "John's claim
 * for his RA diagnosis was approved").
 */
export async function appendAudit({ journeyId, actor, decision, fieldsShared, consentBasis }) {
  const { data: last } = await supabase
    .from("audit_log")
    .select("hash")
    .eq("journey_id", journeyId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const prevHash = last?.hash || "0".repeat(64);
  const t = new Date().toISOString();
  const inputHash = sha256(`${actor}|${decision}|${t}`).slice(0, 16);
  const hash = sha256(prevHash + inputHash + decision);

  const { error } = await supabase.from("audit_log").insert({
    journey_id: journeyId,
    actor,
    decision,
    fields_shared: fieldsShared || "—",
    consent_basis: consentBasis || "treatment",
    input_hash: inputHash,
    prev_hash: prevHash,
    hash,
  });
  if (error) console.error("audit write failed:", error.message);
  return { hash, prevHash };
}
