const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

let queue = [];
let selectedId = null;

async function refresh() {
  try {
    const res = await fetch(`${API_URL}/api/partner/pharmacy/queue`);
    const data = await res.json();
    queue = data.queue || [];
    renderTable();
  } catch (e) { /* backend unreachable */ }
}

function renderTable() {
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";
  if (queue.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">Nothing to fill right now.</td></tr>';
    return;
  }
  for (const q of queue) {
    const tr = document.createElement("tr");
    if (q.journeyId === selectedId) tr.className = "selected";
    tr.onclick = () => { selectedId = q.journeyId; renderTable(); loadDetail(q.journeyId); };
    tr.innerHTML = `<td class="mono">${q.patient_ref}</td><td>${q.prescription || "—"}</td><td class="mono">${new Date(q.stageEnteredAt).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  }
}

async function loadDetail(id) {
  const res = await fetch(`${API_URL}/api/partner/pharmacy/queue/${id}`);
  const data = await res.json();
  const p = data.patient;
  const el = document.getElementById("detail");
  el.innerHTML = `
    <h3>${p.patient_ref}</h3>
    <div class="kv"><span>Prescription</span><span>${p.prescription || "—"}</span></div>
    <div class="kv"><span>Ship to</span><span>${p.shipping_address || "—"}</span></div>
    <button class="btn" id="dispenseBtn">Dispense &amp; ship</button>
  `;
  document.getElementById("dispenseBtn").onclick = () => dispense(id);
}

async function dispense(id) {
  const res = await fetch(`${API_URL}/api/partner/pharmacy/queue/${id}/complete`, { method: "POST" });
  if (!res.ok) return;
  selectedId = null;
  document.getElementById("detail").innerHTML = '<p class="empty">Select a patient to see fulfillment details.</p>';
  refresh();
}

refresh();
setInterval(refresh, 8000);
