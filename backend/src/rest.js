// A thin wrapper around PostgREST's raw HTTP API, used as a proven-reliable
// fallback wherever the supabase-js .from() query builder was returning
// empty results (or, per this bug, silently no-op-ing writes) for this
// project even with a valid service_role key. See the comment in auth.js
// for the full story. Use this for ANY database call in a route that sits
// downstream of requirePatientAuth — reads AND writes — since that's the
// specific request context where .from() has been shown unreliable. Routes
// outside that context (dashboard, intake, journeys, partners) are left on
// supabase.from() since those are confirmed working.
const HEADERS = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});
const BASE = () => `${process.env.SUPABASE_URL}/rest/v1`;

async function parseRes(res) {
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: null, raw: text }; }
}

export async function restGet(path) {
  const res = await fetch(`${BASE()}/${path}`, { headers: HEADERS() });
  return parseRes(res);
}

export async function restInsert(table, row) {
  const res = await fetch(`${BASE()}/${table}`, {
    method: "POST",
    headers: { ...HEADERS(), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  return parseRes(res);
}

export async function restUpdate(table, filterQuery, patch) {
  const res = await fetch(`${BASE()}/${table}?${filterQuery}`, {
    method: "PATCH",
    headers: { ...HEADERS(), Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  return parseRes(res);
}
