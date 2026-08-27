const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

let queue = [];
let selectedId = null;

const STATUS_LABELS = {
  prescription_received: "Prescription received",
  payment_pending: "Awaiting patient payment",
  insurance_pa_pending: "PA pending with payer",
  payment_received: "Payment received",
  insurance_approved: "Insurance approved",
  dispensed: "Dispensed",
  in_transit: "In transit",
  delivered: "Delivered",
};

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
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Nothing in the queue right now.</td></tr>';
    return;
  }
  for (const q of queue) {
    const tr = document.createElement("tr");
    if (q.journeyId === selectedId) tr.className = "selected";
    tr.onclick = () => { selectedId = q.journeyId; renderTable(); loadDetail(q.journeyId); };
    const drug = q.prescription?.drugName || "—";
    tr.innerHTML = `
      <td>${[q.first_name, q.last_name].filter(Boolean).join(" ") || q.patient_ref}</td>
      <td>${drug}</td>
      <td><span class="badge">${STATUS_LABELS[q.pharmacy_status] || q.pharmacy_status || "—"}</span></td>
      <td>${q.fill_payment_method || "—"}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadDetail(id) {
  const res = await fetch(`${API_URL}/api/partner/pharmacy/queue/${id}`);
  const data = await res.json();
  const p = data.patient;
  const rx = p.prescription || {};
  const status = p.pharmacy_status;
  const el = document.getElementById("detail");

  let actionHtml = "";
  if (!p.fill_payment_method) {
    actionHtml = `<p class="hint">Awaiting the patient's payment choice on their own dashboard.</p>`;
  } else if (p.fill_payment_method === "insurance" && status === "prescription_received") {
    actionHtml = `<button class="btn" id="paBtn">Initiate prior authorization</button>`;
  } else if (status === "insurance_pa_pending") {
    actionHtml = `<p class="hint">Submitted to the payer — check back, or see the payer console.</p>`;
  } else if (status === "payment_pending") {
    actionHtml = `<p class="hint">Awaiting patient payment.</p>`;
  } else if (["insurance_approved", "payment_received"].includes(status)) {
    actionHtml = `<button class="btn" id="dispenseBtn">Mark dispensed</button>`;
  } else if (status === "dispensed") {
    actionHtml = `<button class="btn" id="shipBtn">Mark in transit</button>`;
  } else if (status === "in_transit") {
    actionHtml = `<button class="btn" id="deliverBtn">Mark delivered</button>`;
  } else if (status === "delivered") {
    actionHtml = `<p class="hint">Delivered — journey moved on to refill/adherence.</p>`;
  }

  const pricingHtml = data.pricing
    ? `<div class="kv"><span>Cash price</span><span>$${data.pricing.cashPrice}</span></div><div class="kv"><span>Insurance est.</span><span>$${data.pricing.insurancePriceEstimate}</span></div>`
    : "";

  const requestsHtml = (data.requests || []).map((r) => `
    <div class="reqcard">
      <div class="reqhead"><span class="pill">${r.request_type.replace("_", " ")}</span><span class="pill ${r.status === "open" ? "pill-open" : "pill-done"}">${r.status}</span></div>
      <p class="reqmsg"><strong>Asked:</strong> ${r.message}</p>
      ${r.response ? `<p class="reqmsg"><strong>Answer:</strong> ${r.response}</p>` : ""}
    </div>
  `).join("");

  el.innerHTML = `
    <h3>${[p.first_name, p.last_name].filter(Boolean).join(" ") || p.patient_ref}</h3>
    <div class="kv"><span>Reference / DOB</span><span>${p.patient_ref} · ${p.dob || "—"}</span></div>
    <div class="kv"><span>Drug</span><span>${rx.drugName || "—"}</span></div>
    <div class="kv"><span>Strength / form</span><span>${[rx.strength, rx.form].filter(Boolean).join(" · ") || "—"}</span></div>
    <div class="kv"><span>SIG</span><span>${rx.sig || "—"}</span></div>
    <div class="kv"><span>Quantity</span><span>${rx.quantity || "—"}</span></div>
    <div class="kv"><span>Days supply / refills</span><span>${rx.daysSupply || "—"} / ${rx.refills ?? "—"}</span></div>
    ${pricingHtml}
    <div class="kv"><span>Ship to</span><span>${p.shipping_address || "—"}</span></div>
    <div class="kv"><span>Status</span><span>${STATUS_LABELS[status] || status || "—"}</span></div>

    <div class="actionbox">${actionHtml}</div>

    <h4 class="rxhead">Request info from telehealth</h4>
    <p style="font-size:11px;color:var(--faint);margin-bottom:8px">For specialty-drug PA support — clinical notes, lab results, etc. Goes to the clinician who saw this patient, through the backend, never directly.</p>
    <select id="reqType">
      <option value="clinical_notes">Clinical notes</option>
      <option value="lab_results">Lab investigation reports</option>
      <option value="other">Other</option>
    </select>
    <textarea id="reqMsg" placeholder="What do you need?"></textarea>
    <button class="btn small" id="sendReqBtn">Send request</button>

    ${requestsHtml ? `<h4 class="rxhead">Request history</h4>${requestsHtml}` : ""}
  `;

  document.getElementById("paBtn")?.addEventListener("click", () => act(id, "initiate-pa"));
  document.getElementById("dispenseBtn")?.addEventListener("click", () => act(id, "dispense"));
  document.getElementById("shipBtn")?.addEventListener("click", () => act(id, "ship"));
  document.getElementById("deliverBtn")?.addEventListener("click", () => act(id, "deliver"));
  document.getElementById("sendReqBtn")?.addEventListener("click", () => sendRequest(id));
}

async function act(id, action) {
  await fetch(`${API_URL}/api/partner/pharmacy/queue/${id}/${action}`, { method: "POST" });
  loadDetail(id);
  refresh();
}

async function sendRequest(id) {
  const requestType = document.getElementById("reqType").value;
  const message = document.getElementById("reqMsg").value;
  if (!message.trim()) return;
  await fetch(`${API_URL}/api/partner/pharmacy/queue/${id}/request-info`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestType, message }),
  });
  loadDetail(id);
}

refresh();
setInterval(refresh, 8000);
