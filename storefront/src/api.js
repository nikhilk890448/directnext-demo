// Set this in Render → storefront static site → Environment → VITE_API_URL
// to your deployed backend's URL, e.g. https://directnext-backend.onrender.com
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

export const submitIntake = (payload) => req("/api/intake", { method: "POST", body: JSON.stringify(payload) });
export const login = (email, password) => req("/api/patient/login", { method: "POST", body: JSON.stringify({ email, password }) });
export const fetchMe = (token) => req("/api/patient/me", { headers: { Authorization: `Bearer ${token}` } });
