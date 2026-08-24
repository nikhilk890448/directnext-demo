import { Router } from "express";
import { supabase } from "../db.js";
import { appendAudit } from "../hash.js";

export const agentsRouter = Router();

agentsRouter.get("/", async (_req, res) => {
  const { data, error } = await supabase.from("agent_registry").select("*").order("id");
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, agents: data });
});

agentsRouter.post("/:id/toggle", async (req, res) => {
  const { id } = req.params;
  const { data: agent } = await supabase.from("agent_registry").select("*").eq("id", id).maybeSingle();
  if (!agent) return res.status(404).json({ ok: false, error: "not found" });

  const newStatus = agent.status === "up" ? "down" : "up";
  await supabase.from("agent_registry").update({ status: newStatus }).eq("id", id);
  await appendAudit({
    journeyId: null,
    actor: "human:dashboard",
    decision: `${id} set to ${newStatus} (${agent.plane} plane)`,
    fieldsShared: "—",
  });
  res.json({ ok: true, id, status: newStatus });
});
