const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

let queue = [];
let selectedId = null;
let requests = [];

async function refresh() {
  try {
    const [qRes, rRes] = await Promise.all([
      fetch(`${API_URL}/api/partner/telehealth/queue`),
      fetch(`${API_URL}/api/partner/telehealth/requests`),
    ]);
    const qData = await qRes.json();
    const rData = await rRes.json();
    queue = qData.queue || [];
    requests = rData.requests || [];
    renderTable();
    renderRequests();
  } catch (e) { /* backend unreachable — leave UI as-is */ }
}

function renderTable() {
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";
  if (queue.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">Nobody waiting right now.</td></tr>';
    return;
  }
  for (const q of queue) {
    const tr = document.createElement("tr");
    if (q.journeyId === selectedId) tr.className = "selected";
    tr.onclick = () => { selectedId = q.journeyId; renderTable(); loadDetail(q.journeyId); };
    const name = [q.first_name, q.last_name].filter(Boolean).join(" ") || q.patient_ref;
    tr.innerHTML = `<td>${name}</td><td>${q.condition || "—"}</td><td class="mono">${new Date(q.stageEnteredAt).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  }
}

function renderRequests() {
  const el = document.getElementById("requests");
  if (requests.length === 0) {
    el.innerHTML = '<p class="empty">No open requests from pharmacy.</p>';
    return;
  }
  el.innerHTML = requests.map((r) => `
    <div class="reqcard">
      <div class="reqhead"><span class="mono">${r.patientRef}</span><span class="pill">${r.requestType.replace("_", " ")}</span></div>
      <p class="reqmsg">${r.message}</p>
      <textarea id="resp-${r.id}" placeholder="Your response..."></textarea>
      <button class="btn small" data-id="${r.id}">Send response</button>
    </div>
  `).join("");
  el.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.onclick = () => respondToRequest(btn.dataset.id);
  });
}

async function respondToRequest(id) {
  const response = document.getElementById(`resp-${id}`).value;
  if (!response.trim()) return;
  await fetch(`${API_URL}/api/partner/telehealth/requests/${id}/respond`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response }),
  });
  refresh();
}

async function loadDetail(id) {
  const res = await fetch(`${API_URL}/api/partner/telehealth/queue/${id}`);
  const data = await res.json();
  const p = data.patient;
  const flags = data.advisoryFlags || [];
  const el = document.getElementById("detail");
  const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || p.patient_ref;
  el.innerHTML = `
    <h3>${name}</h3>
    <p style="font-size:11px;color:var(--faint);margin-bottom:6px">${p.patient_ref} · DOB ${p.dob || "—"}</p>
    <p style="font-size:12.5px;color:var(--dim);margin-bottom:6px"><strong>Condition:</strong> ${p.condition || "—"}</p>
    <p style="font-size:12.5px;color:var(--dim);margin-bottom:14px"><strong>In their words:</strong> ${p.narrative || "(nothing provided)"}</p>
    ${flags.map(f => `<div class="flag">⚑ ${f.reason}</div>`).join("")}

    <div class="field"><span>Diagnosis code (ICD-10)</span><input id="dxCode" placeholder="e.g. M06.9"></div>
    <div class="field"><span>Diagnosis label</span><input id="dxLabel" value="${p.condition || ""}"></div>
    <div class="field"><span>Medical necessity rationale</span><textarea id="necessity" placeholder="Why this treatment is appropriate for this patient"></textarea></div>
    <div class="field"><span>Clinician name</span><input id="clinician" placeholder="Dr. ..."></div>

    <h4 class="rxhead">Prescription (eRx)</h4>
    <div class="field"><span>Drug name</span><input id="drugName" placeholder="e.g. Adalimumab"></div>
    <div class="fieldrow">
      <div class="field"><span>Strength</span><input id="strength" placeholder="e.g. 40mg/0.8mL"></div>
      <div class="field"><span>Form</span><input id="form" placeholder="e.g. prefilled syringe"></div>
    </div>
    <div class="field"><span>NDC (optional)</span><input id="ndc" placeholder="e.g. 0074-XXXX-XX"></div>
    <div class="field"><span>SIG (directions)</span><input id="sig" placeholder="e.g. Inject 40mg subcutaneously every other week"></div>
    <div class="fieldrow">
      <div class="field"><span>Quantity</span><input id="quantity" type="number" placeholder="e.g. 2"></div>
      <div class="field"><span>Days supply</span><input id="daysSupply" type="number" placeholder="e.g. 28"></div>
      <div class="field"><span>Refills</span><input id="refills" type="number" placeholder="e.g. 3"></div>
    </div>

    <button class="btn" id="completeBtn">Complete visit &amp; send prescription</button>
    <div id="err"></div>
  `;
  document.getElementById("completeBtn").onclick = () => completeVisit(id);
}

async function completeVisit(id) {
  const val = (id) => document.getElementById(id).value;
  const body = {
    diagnosisCode: val("dxCode"), diagnosisLabel: val("dxLabel"),
    medicalNecessity: val("necessity"), clinicianName: val("clinician"),
    drugName: val("drugName"), strength: val("strength"), form: val("form"), ndc: val("ndc"),
    sig: val("sig"), quantity: val("quantity"), daysSupply: val("daysSupply"), refills: val("refills"),
  };
  const res = await fetch(`${API_URL}/api/partner/telehealth/queue/${id}/complete`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    document.getElementById("err").innerHTML = `<div class="err">${data.message || "Something went wrong."}</div>`;
    return;
  }
  selectedId = null;
  document.getElementById("detail").innerHTML = '<p class="empty">Select a patient to begin the visit.</p>';
  refresh();
}

refresh();
setInterval(refresh, 8000);
