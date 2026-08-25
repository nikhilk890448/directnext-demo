const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

let queue = [];
let selectedId = null;

async function refresh() {
  try {
    const res = await fetch(`${API_URL}/api/partner/telehealth/queue`);
    const data = await res.json();
    queue = data.queue || [];
    renderTable();
  } catch (e) { /* backend unreachable — leave table as-is */ }
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
    tr.innerHTML = `<td class="mono">${q.patient_ref}</td><td>${q.condition || "—"}</td><td class="mono">${new Date(q.stageEnteredAt).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  }
}

async function loadDetail(id) {
  const res = await fetch(`${API_URL}/api/partner/telehealth/queue/${id}`);
  const data = await res.json();
  const p = data.patient;
  const flags = data.advisoryFlags || [];
  const el = document.getElementById("detail");
  el.innerHTML = `
    <h3>${p.patient_ref}</h3>
    <p style="font-size:12.5px;color:var(--dim);margin-bottom:6px"><strong>Condition:</strong> ${p.condition || "—"}</p>
    <p style="font-size:12.5px;color:var(--dim);margin-bottom:14px"><strong>In their words:</strong> ${p.narrative || "(nothing provided)"}</p>
    ${flags.map(f => `<div class="flag">⚑ ${f.reason}</div>`).join("")}
    <div class="field"><span>Diagnosis code (ICD-10)</span><input id="dxCode" placeholder="e.g. M06.9"></div>
    <div class="field"><span>Diagnosis label</span><input id="dxLabel" value="${p.condition || ""}"></div>
    <div class="field"><span>Prescribed therapy</span><input id="rx" placeholder="What you're prescribing"></div>
    <div class="field"><span>Medical necessity rationale</span><textarea id="necessity" placeholder="Why this treatment is appropriate for this patient"></textarea></div>
    <div class="field"><span>Clinician name</span><input id="clinician" placeholder="Dr. ..."></div>
    <button class="btn" id="completeBtn">Complete visit</button>
    <div id="err"></div>
  `;
  document.getElementById("completeBtn").onclick = () => completeVisit(id);
}

async function completeVisit(id) {
  const body = {
    diagnosisCode: document.getElementById("dxCode").value,
    diagnosisLabel: document.getElementById("dxLabel").value,
    prescribedTherapy: document.getElementById("rx").value,
    medicalNecessity: document.getElementById("necessity").value,
    clinicianName: document.getElementById("clinician").value,
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
