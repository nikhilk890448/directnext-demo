// Same reasoning as backend/src/rest.js: the supabase-js query builder was
// unreliable for this project, while plain HTTP calls to PostgREST work
// every time. This service uses raw REST exclusively for that reason.
const BASE = () => `${process.env.SUPABASE_URL}/rest/v1`;
const HEADERS = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});

export async function restGet(path) {
  const res = await fetch(`${BASE()}/${path}`, { headers: HEADERS() });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: null, raw: text }; }
}

export async function restInsert(table, row) {
  const res = await fetch(`${BASE()}/${table}`, {
    method: "POST",
    headers: { ...HEADERS(), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: null, raw: text }; }
}

export async function restUpdate(table, filterQuery, patch) {
  const res = await fetch(`${BASE()}/${table}?${filterQuery}`, {
    method: "PATCH",
    headers: { ...HEADERS(), Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: null, raw: text }; }
}
