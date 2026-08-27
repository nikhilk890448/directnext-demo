import { Router } from "express";
import { supabase } from "../db.js";
import { appendAudit } from "../hash.js";
import { STAGES, nextStage, dueAt } from "../workflow.js";
import { runAgent } from "../agents.js";

export const journeysRouter = Router();

// GET /api/journeys — PHI-free list for the pharma dashboard.
// Reads only journey_dashboard_view; the patients table is never touched here.
journeysRouter.get("/", async (_req, res) => {
  const { data, error } = await supabase.from("journey_dashboard_view").select("*").order("stage_entered_at", { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, journeys: data });
});

// GET /api/journeys/meta/stages — stage definitions + live median latency.
// NOTE: must be declared before "/:id" or Express will treat "meta" as an id.
journeysRouter.get("/meta/stages", async (_req, res) => {
  const { data: latency } = await supabase.from("stage_latency_view").select("*");
  res.json({ ok: true, stages: STAGES, latency });
});

// GET /api/journeys/:id — single journey detail, still PHI-free.
journeysRouter.get("/:id", async (req, res) => {
  const { id } = req.params;
  const { data: journey, error } = await supabase.from("journey_dashboard_view").select("*").eq("journey_id", id).maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });

  const { data: tasks } = await supabase.from("task_dashboard_view").select("*").eq("journey_id", id).order("created_at", { ascending: false });
  const { data: history } = await supabase.from("stage_history").select("stage, entered_at, exited_at, duration_hours").eq("journey_id", id).order("entered_at");

  res.json({ ok: true, journey, tasks, history });
});

// GET /api/journeys/:id/audit — hash chain for one journey (decision text is PHI-free by construction).
journeysRouter.get("/:id/audit", async (req, res) => {
  const { data, error } = await supabase.from("audit_log").select("actor, decision, fields_shared, consent_basis, hash, prev_hash, created_at").eq("journey_id", req.params.id).order("created_at");
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, audit: data });
});

// POST /api/journeys/:id/tasks/:taskId/resolve
journeysRouter.post("/:id/tasks/:taskId/resolve", async (req, res) => {
  const { id, taskId } = req.params;
  const { error } = await supabase.from("tasks").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", taskId);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await appendAudit({ journeyId: id, actor: "human:dashboard", decision: `task ${taskId} resolved`, fieldsShared: "—" });
  res.json({ ok: true });
});

// POST /api/journeys/:id/remind — a non-destructive nudge, available for
// EVERY stage regardless of who owns it. Unlike simulate-next, this never
// changes any state — it only logs that a human asked for a status check/
// reminder. Safe to expose everywhere, including console-owned stages,
// since it can't be used to bypass a partner's actual decision.
journeysRouter.post("/:id/remind", async (req, res) => {
  const { id } = req.params;
  const { data: journey } = await supabase.from("journeys").select("current_stage, pharmacy_status").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });

  const label = journey.current_stage === "pharmacy" && journey.pharmacy_status
    ? `${journey.current_stage} (${journey.pharmacy_status})`
    : journey.current_stage;
  await appendAudit({ journeyId: id, actor: "human:dashboard", decision: `manual reminder sent to partner for ${label}`, fieldsShared: "—" });
  res.json({ ok: true });
});

// POST /api/journeys/:id/simulate-next — DEMO ONLY, and now only for
// stages without their own partner console (currently just refill/
// adherence). telehealth and pharmacy both moved to their own dedicated
// consoles — the pharma dashboard shouldn't be the place any partner's
// decision or work actually happens.
journeysRouter.post("/:id/simulate-next", async (req, res) => {
  const { id } = req.params;
  const { data: journey } = await supabase.from("journeys").select("*, patients(*)").eq("id", id).maybeSingle();
  if (!journey) return res.status(404).json({ ok: false, error: "not found" });

  // Never let this bypass an open hold — e.g. a journey sitting at
  // "intake" because A03 flagged it. Simulate-next used to have no such
  // guard and could silently advance a held journey around its own gate.
  const { data: openTasks } = await supabase.from("tasks").select("id").eq("journey_id", id).eq("status", "open").limit(1);
  if (openTasks && openTasks.length > 0) {
    return res.status(409).json({ ok: false, error: "blocked_by_open_task", message: "This journey has an open task holding it — resolve it in Exceptions before advancing." });
  }

  const CONSOLE_OWNED = {
    telehealth: "This journey is waiting on the telehealth partner. Check the telehealth console to complete the visit — it doesn't advance from this dashboard.",
    pharmacy: "This journey is waiting on the pharmacy. Check the pharmacy console — prior auth, payment, dispensing, and shipping all happen there now, not from this dashboard.",
  };
  if (CONSOLE_OWNED[journey.current_stage]) {
    return res.status(409).json({ ok: false, error: "not_simulable_here", message: CONSOLE_OWNED[journey.current_stage] });
  }

  const patient = journey.patients;
  const now = new Date();

  // Close out the current stage in history.
  const enteredAt = new Date(journey.stage_entered_at);
  await supabase.from("stage_history").insert({
    journey_id: id, stage: journey.current_stage, entered_at: journey.stage_entered_at,
    exited_at: now.toISOString(), duration_hours: +((now - enteredAt) / 3600000).toFixed(2),
  });

  if (journey.current_stage === "refill") {
    const adherence = await runAgent("adherence", patient);
    await appendAudit({ journeyId: id, actor: "agent:adherence", decision: `adherence score computed: ${adherence.result?.score ?? "n/a"}`, fieldsShared: "score only" });
  }

  const next = nextStage(journey.current_stage);

  const status = next ? "in_progress" : "completed";
  const stageKey = next ? next.key : journey.current_stage;
  const slaHours = next ? next.slaHours : 0;

  await supabase.from("journeys").update({
    current_stage: stageKey, status,
    stage_entered_at: now.toISOString(),
    sla_due_at: next ? dueAt(now, slaHours) : null,
    updated_at: now.toISOString(),
  }).eq("id", id);

  await supabase.from("journey_events").insert({ journey_id: id, event_type: "stage_advanced", payload: { to: stageKey } });
  await appendAudit({ journeyId: id, actor: "dispatcher", decision: `advanced to ${stageKey}`, fieldsShared: "—" });

  res.json({ ok: true, held: false, stage: stageKey, status });
});

