import express from "express";
import cors from "cors";
import { intakeRouter } from "./routes/intake.js";
import { journeysRouter } from "./routes/journeys.js";
import { agentsRouter } from "./routes/agents.js";
import { startSlaSweep } from "./sla-sweep.js";

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true, // "*" during local dev if unset
}));
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use("/api/intake", intakeRouter);
app.use("/api/journeys", journeysRouter);
app.use("/api/agents", agentsRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "internal_error" });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`DirectNEXT backend listening on :${port}`);
  startSlaSweep();
});
