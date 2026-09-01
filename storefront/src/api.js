// Set this in Render → storefront static site → Environment → VITE_API_URL
// to your deployed backend's URL, e.g. https://directnext-backend.onrender.com
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

async function req(path, opts = {}) {
  // Merge headers instead of letting opts.headers replace the default
  // entirely — otherwise any call that adds an Authorization header (like
  // the ones below) silently loses Content-Type: application/json, and
  // Express never parses the body at all. That was the actual bug behind
  // "invalid_method": the body was never being read, not that a bad value
  // was sent.
  const { headers: extraHeaders, ...rest } = opts;
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
    ...rest,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || "request_failed"), { data });
  return data;
}

export const submitIntake = (payload) => req("/api/intake", { method: "POST", body: JSON.stringify(payload) });
export const login = (email, password) => req("/api/patient/login", { method: "POST", body: JSON.stringify({ email, password }) });
export const fetchMe = (token) => req("/api/patient/me", { headers: { Authorization: `Bearer ${token}` } });
export const choosePaymentMethod = (token, method) => req("/api/patient/fill-payment-choice", {
  method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ method }),
});
export const payNow = (token, paymentRequestId) => req("/api/patient/pay", {
  method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ paymentRequestId }),
});

// Triggers a real browser file download rather than returning JSON to the
// caller — this one bypasses req() since we want the raw response body as
// a downloadable file, not a parsed object to act on.
export async function downloadMyJourney(token) {
  const res = await fetch(`${API_URL}/api/patient/me/export`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("export_failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "my-journey-export.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
