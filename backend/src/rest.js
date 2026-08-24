// A thin wrapper around PostgREST's raw HTTP API, used as a proven-reliable
// fallback wherever the supabase-js .from() query builder was returning
// empty results for this project even with a valid service_role key. See
// the comment in auth.js for the full story. Use this for reads in any
// route that sits downstream of a patient-auth check; the rest of the app's
// existing supabase.from() calls (dashboard, intake, journeys) are left as
// they are since those are already confirmed working.
export async function restGet(path) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: null, raw: text };
  }
}
