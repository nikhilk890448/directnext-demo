// Set this in Render → dashboard static site → Environment → VITE_API_URL
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

async function req(path, opts) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || "request_failed"), { data });
  return data;
}

export const api = {
  listJourneys: () => req("/api/journeys"),
  getJourney: (id) => req(`/api/journeys/${id}`),
  getAudit: (id) => req(`/api/journeys/${id}/audit`),
  simulateNext: (id) => req(`/api/journeys/${id}/simulate-next`, { method: "POST" }),
  remind: (id) => req(`/api/journeys/${id}/remind`, { method: "POST" }),
  resolveTask: (journeyId, taskId) => req(`/api/journeys/${journeyId}/tasks/${taskId}/resolve`, { method: "POST" }),
  listAgents: () => req("/api/agents"),
  toggleAgent: (id) => req(`/api/agents/${id}/toggle`, { method: "POST" }),
  stagesMeta: () => req("/api/journeys/meta/stages"),
};
