import { supabase } from "./db.js";
import { appendAudit } from "./hash.js";

// Runs on an interval inside the Node process (fine for a demo on Render's
// free tier). For real scale, move this to a Render Cron Job hitting a
// dedicated /api/internal/sla-sweep endpoint instead of an in-process timer.
export async function slaSweep() {
  const nowIso = new Date().toISOString();
  const { data: overdue, error } = await supabase
    .from("journeys")
    .select("id, current_stage")
    .eq("status", "in_progress")
    .lt("sla_due_at", nowIso);

  if (error) { console.error("sla sweep failed:", error.message); return; }
  if (!overdue?.length) return;

  for (const j of overdue) {
    const { data: existing } = await supabase
      .from("tasks")
      .select("id")
      .eq("journey_id", j.id)
      .eq("type", "SLA breach")
      .eq("status", "open")
      .maybeSingle();
    if (existing) continue; // already flagged, don't duplicate

    await supabase.from("tasks").insert({
      journey_id: j.id,
      type: "SLA breach",
      reason: `No response at "${j.current_stage}" within the allotted SLA`,
      priority: "high",
      assigned_role: "Care coordination",
    });
    await appendAudit({ journeyId: j.id, actor: "sla-timer", decision: `SLA breached at ${j.current_stage}`, fieldsShared: "—" });
  }
}

export function startSlaSweep(intervalMs = 5 * 60 * 1000) {
  slaSweep();
  return setInterval(slaSweep, intervalMs);
}
