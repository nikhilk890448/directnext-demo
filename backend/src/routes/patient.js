import { Router } from "express";
import { supabase } from "../db.js";
import { requirePatientAuth } from "../auth.js";
import { STAGES } from "../workflow.js";

export const patientRouter = Router();

patientRouter.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: "missing_credentials" });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ ok: false, error: "invalid_credentials" });

  res.json({ ok: true, accessToken: data.session.access_token });
});

// GET /api/patient/me — this is the ONE place the full, real patient record
// (their own name, stage, tasks) is returned. It only works with a valid
// token belonging to that exact patient, verified in requirePatientAuth.
patientRouter.get("/me", requirePatientAuth, async (req, res) => {
  const patient = req.patient;

  const { data: journey } = await supabase
    .from("journeys")
    .select("*")
    .eq("patient_id", patient.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let tasks = [];
  if (journey) {
    const { data } = await supabase
      .from("tasks")
      .select("*")
      .eq("journey_id", journey.id)
      .eq("status", "open")
      .order("created_at", { ascending: false });
    tasks = data || [];
  }

  res.json({
    ok: true,
    patient: { firstName: patient.first_name, patientRef: patient.patient_ref, condition: patient.condition },
    journey: journey
      ? {
          currentStage: journey.current_stage,
          stageLabel: STAGES.find((s) => s.key === journey.current_stage)?.label || journey.current_stage,
          status: journey.status,
          slaDueAt: journey.sla_due_at,
        }
      : null,
    tasksNeedingYou: tasks.map((t) => ({ reason: t.reason, priority: t.priority, createdAt: t.created_at })),
    stages: STAGES.map((s) => s.key),
  });
});
