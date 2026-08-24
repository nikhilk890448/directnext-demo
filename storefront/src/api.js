// Set this in Render → storefront static site → Environment → VITE_API_URL
// to your deployed backend's URL, e.g. https://directnext-backend.onrender.com
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

export async function submitIntake(payload) {
  const res = await fetch(`${API_URL}/api/intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || "submit_failed"), { data });
  return data;
}
