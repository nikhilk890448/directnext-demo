import React, { useState, useEffect, useCallback, useMemo } from "react";
import { api } from "./api.js";

const STAGE_LABELS = {
  intake: "Intake & Consent",
  safety_check: "Safety / Completeness",
  telehealth: "Telehealth Visit",
  pharmacy: "Pharmacy Fulfillment",
  refill: "Adherence & Refill",
};
const STAGE_ORDER = Object.keys(STAGE_LABELS);

// Pharmacy sub-status shown alongside the stage name, since PA/payment/
// dispense/ship all happen inside "pharmacy" now rather than as separate
// top-level stages.
const PHARMACY_STATUS_LABELS = {
  prescription_received: "prescription received",
  payment_pending: "awaiting payment",
  insurance_pa_pending: "PA pending",
  payment_received: "payment received",
  insurance_approved: "insurance approved",
  dispensed: "dispensed",
  in_transit: "in transit",
  delivered: "delivered",
};

// Stages that now belong to their own partner console — the pharma
// dashboard shows a status note instead of a "Simulate next" button.
const CONSOLE_OWNED_STAGES = { telehealth: "Awaiting telehealth", pharmacy: "In pharmacy fulfillment" };

export default function App() {
  const [journeys, setJourneys] = useState([]);
  const [agents, setAgents] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [filterStage, setFilterStage] = useState("all");
  const [tab, setTab] = useState("journeys");

  const refresh = useCallback(async () => {
    try {
      const [j, a] = await Promise.all([api.listJourneys(), api.listAgents()]);
      setJourneys(j.journeys || []);
      setAgents(a.agents || []);
      setErr(null);
    } catch (e) {
      setErr("Can't reach the backend. Check VITE_API_URL and that the backend service is running.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  const loadDetail = useCallback(async (id) => {
    setSelectedId(id);
    try {
      const [d, aud] = await Promise.all([api.getJourney(id), api.getAudit(id)]);
      setDetail({ ...d, audit: aud.audit });
    } catch (e) {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const id = setInterval(() => loadDetail(selectedId), 8000);
    return () => clearInterval(id);
  }, [selectedId, loadDetail]);

  const kpis = useMemo(() => {
    const active = journeys.filter((j) => j.status === "in_progress");
    const breached = active.filter((j) => j.is_breached);
    const completed = journeys.filter((j) => j.status === "completed");
    return {
      active: active.length,
      breached: breached.length,
      completionRate: journeys.length ? Math.round((completed.length / journeys.length) * 100) : 0,
    };
  }, [journeys]);

  const filtered = filterStage === "all" ? journeys : journeys.filter((j) => j.current_stage === filterStage);

  async function handleSimulate(id) {
    await api.simulateNext(id);
    await refresh();
    if (selectedId === id) await loadDetail(id);
  }
  async function handleResolve(journeyId, taskId) {
    await api.resolveTask(journeyId, taskId);
    if (selectedId === journeyId) await loadDetail(journeyId);
    await refresh();
  }
  async function handleToggleAgent(id) {
    await api.toggleAgent(id);
    const a = await api.listAgents();
    setAgents(a.agents || []);
  }

  return (
    <div className="app">
      <Style />
      <header className="topbar">
        <div className="brand"><span className="mark" /> <h1>DirectNEXT Workflow</h1></div>
        <nav className="tabs">
          <button className={tab === "journeys" ? "tab active" : "tab"} onClick={() => setTab("journeys")}>Journeys</button>
          <button className={tab === "agents" ? "tab active" : "tab"} onClick={() => setTab("agents")}>Agents</button>
        </nav>
      </header>

      <div className="privnote">
        This view shows stage, timing, and status only — never patient name, date of birth, address, or clinical detail. That data is not sent by the backend to this app.
      </div>

      {err && <div className="errbanner">{err}</div>}
      {loading && <div className="loading">Loading…</div>}

      {!loading && tab === "journeys" && (
        <>
          <div className="kpirow">
            <div className="kpi"><div className="kv">{kpis.active}</div><div className="kl">Active journeys</div></div>
            <div className="kpi warn"><div className="kv">{kpis.breached}</div><div className="kl">Past SLA</div></div>
            <div className="kpi"><div className="kv">{kpis.completionRate}%</div><div className="kl">Completion rate</div></div>
          </div>

          <div className="funnel">
            <button className={"funnelchip" + (filterStage === "all" ? " active" : "")} onClick={() => setFilterStage("all")}>All ({journeys.length})</button>
            {STAGE_ORDER.map((s) => {
              const count = journeys.filter((j) => j.current_stage === s).length;
              return (
                <button key={s} className={"funnelchip" + (filterStage === s ? " active" : "")} onClick={() => setFilterStage(s)}>
                  {STAGE_LABELS[s]} ({count})
                </button>
              );
            })}
          </div>

          <div className="mainsplit">
            <div className="listcol">
              <table className="jtable">
                <thead>
                  <tr><th>Patient ref</th><th>Stage</th><th>SLA</th><th></th></tr>
                </thead>
                <tbody>
                  {filtered.map((j) => (
                    <tr key={j.journey_id} className={selectedId === j.journey_id ? "selected" : ""} onClick={() => loadDetail(j.journey_id)}>
                      <td className="mono">{j.patient_ref}</td>
                      <td>{STAGE_LABELS[j.current_stage] || j.current_stage}{j.current_stage === "pharmacy" && j.pharmacy_status ? <span className="dim" style={{ fontSize: 10.5 }}><br />{PHARMACY_STATUS_LABELS[j.pharmacy_status] || j.pharmacy_status}</span> : null}</td>
                      <td>
                        <span className={"badge " + (j.is_breached ? "b-breach" : j.status === "completed" ? "b-done" : "b-ok")}>
                          {j.status === "completed" ? "Completed" : j.is_breached ? "Breached" : "On time"}
                        </span>
                      </td>
                      <td>
                        {j.status === "in_progress" && !CONSOLE_OWNED_STAGES[j.current_stage] && (
                          <button className="minibtn" onClick={(e) => { e.stopPropagation(); handleSimulate(j.journey_id); }}>
                            Simulate next ▸
                          </button>
                        )}
                        {j.status === "in_progress" && CONSOLE_OWNED_STAGES[j.current_stage] && (
                          <span className="dim" style={{ fontSize: 11 }}>{CONSOLE_OWNED_STAGES[j.current_stage]}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && <tr><td colSpan={4} className="empty">No journeys in this stage.</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="detailcol">
              {!detail && <div className="empty card">Select a journey to see where that patient is right now.</div>}
              {detail && (
                <JourneyDetail detail={detail} onResolve={handleResolve} onSimulate={handleSimulate} />
              )}
            </div>
          </div>
        </>
      )}

      {!loading && tab === "agents" && <AgentsPanel agents={agents} onToggle={handleToggleAgent} />}
    </div>
  );
}

function JourneyDetail({ detail, onResolve, onSimulate }) {
  const j = detail.journey;
  const openTasks = (detail.tasks || []).filter((t) => t.status === "open");
  return (
    <div className="card">
      <div className="spread">
        <h3 className="mono">{j.patient_ref}</h3>
        <span className={"badge " + (j.is_breached ? "b-breach" : "b-ok")}>{j.is_breached ? "Past SLA" : "On time"}</span>
      </div>
      <p className="small">Current stage: <strong>{STAGE_LABELS[j.current_stage] || j.current_stage}</strong>{j.current_stage === "pharmacy" && j.pharmacy_status ? ` — ${PHARMACY_STATUS_LABELS[j.pharmacy_status] || j.pharmacy_status}` : ""}</p>
      <p className="small">SLA due: <span className="mono">{j.sla_due_at ? new Date(j.sla_due_at).toLocaleString() : "—"}</span></p>

      {j.status === "in_progress" && !CONSOLE_OWNED_STAGES[j.current_stage] && (
        <button className="btn primary" onClick={() => onSimulate(j.journey_id)}>Simulate partner response ▸</button>
      )}
      {j.status === "in_progress" && CONSOLE_OWNED_STAGES[j.current_stage] && (
        <p className="small" style={{ color: "var(--cyan)" }}>Waiting on {j.current_stage === "telehealth" ? "the telehealth partner" : "the pharmacy"} — this stage is handled in that partner's own console, not here.</p>
      )}

      <h4 className="sectionhead">Stage history</h4>
      <ul className="timelinelist">
        {(detail.history || []).map((h, i) => (
          <li key={i}>
            <span className="mono">{STAGE_LABELS[h.stage] || h.stage}</span>
            <span className="dim"> — {h.duration_hours != null ? `${h.duration_hours}h` : "in progress"}</span>
          </li>
        ))}
      </ul>

      <h4 className="sectionhead">Open items — action required</h4>
      {openTasks.length === 0 && <p className="small dim">Nothing needs attention here.</p>}
      <ul className="tasklist">
        {openTasks.map((t) => (
          <li key={t.id} className={"taskrow p-" + t.priority}>
            <div>
              <div className="tasktext">{t.reason}</div>
              <div className="taskmeta">{t.assigned_role || "Unassigned"} · {t.priority}</div>
            </div>
            <button className="minibtn" onClick={() => onResolve(j.journey_id, t.id)}>Resolve</button>
          </li>
        ))}
      </ul>

      <h4 className="sectionhead">Audit trail</h4>
      <ul className="auditlist">
        {(detail.audit || []).slice(-6).map((a, i) => (
          <li key={i}><span className="mono dim">{a.actor}</span> — {a.decision}</li>
        ))}
      </ul>
    </div>
  );
}

function AgentsPanel({ agents, onToggle }) {
  return (
    <div className="card">
      <h3>Agent registry</h3>
      <p className="small dim">Deterministic stubs today, wired for real model calls later. GOV agents fail closed (they can hold a journey); ORCH agents fail open (they never block — a human just gets a task).</p>
      <table className="jtable">
        <thead><tr><th>Agent</th><th>Name</th><th>Plane</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.id}</td>
              <td>{a.name}</td>
              <td><span className={"badge " + (a.plane === "GOV" ? "b-gov" : "b-orch")}>{a.plane}</span></td>
              <td><span className={"badge " + (a.status === "up" ? "b-ok" : "b-breach")}>{a.status}</span></td>
              <td><button className="minibtn" onClick={() => onToggle(a.id)}>{a.status === "up" ? "Kill switch" : "Restore"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Style() {
  return (
    <style>{`
      :root{
        --bg:#0a0f1a; --panel:#111a2b; --panel2:#16223a; --border:#243250; --border-lit:#33456b;
        --text:#e7edf7; --dim:#8ea0c0; --faint:#516084;
        --cyan:#4fc3e0; --amber:#e8a33d; --green:#4ade80; --red:#f0576b;
        --fd:'Segoe UI',sans-serif; --fm:'Consolas',monospace;
      }
      *{box-sizing:border-box;}
      body{margin:0;}
      .app{min-height:100vh;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;padding:18px 22px 40px;}
      .mono{font-family:var(--fm);}
      .dim{color:var(--faint);}
      .small{font-size:12px;}
      button{cursor:pointer;font-family:inherit;}
      .topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}
      .brand{display:flex;align-items:center;gap:8px;}
      .brand .mark{width:9px;height:9px;border-radius:2px;background:var(--cyan);box-shadow:0 0 8px var(--cyan);}
      .brand h1{font-size:16px;margin:0;}
      .tabs{display:flex;gap:4px;}
      .tab{background:var(--panel2);border:1px solid var(--border);color:var(--dim);padding:7px 14px;border-radius:6px;font-size:12.5px;}
      .tab.active{color:var(--cyan);border-color:var(--cyan);}
      .privnote{font-size:11px;color:var(--faint);background:var(--panel2);border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin:10px 0 16px;}
      .errbanner{background:#4a2230;color:var(--red);border-radius:6px;padding:10px 12px;font-size:12.5px;margin-bottom:12px;}
      .loading{color:var(--faint);font-size:13px;padding:20px 0;}
      .kpirow{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px;}
      .kpi{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px;}
      .kpi.warn .kv{color:var(--red);}
      .kv{font-size:26px;font-weight:700;}
      .kl{font-size:10.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.05em;margin-top:2px;}
      .funnel{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;}
      .funnelchip{background:var(--panel2);border:1px solid var(--border);color:var(--dim);padding:6px 10px;border-radius:20px;font-size:11px;}
      .funnelchip.active{border-color:var(--cyan);color:var(--cyan);}
      .mainsplit{display:grid;grid-template-columns:1fr 360px;gap:14px;align-items:start;}
      @media(max-width:900px){.mainsplit{grid-template-columns:1fr;}}
      .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px;}
      .card h3{margin:0 0 6px;font-size:14px;}
      .spread{display:flex;justify-content:space-between;align-items:center;}
      table.jtable{width:100%;border-collapse:collapse;font-size:12.5px;}
      .jtable th{text-align:left;color:var(--faint);font-weight:500;font-size:10.5px;text-transform:uppercase;padding:8px;border-bottom:1px solid var(--border);}
      .jtable td{padding:9px 8px;border-bottom:1px solid var(--border);}
      .jtable tr{cursor:pointer;}
      .jtable tr.selected{background:var(--panel2);}
      .jtable tr:hover{background:var(--panel2);}
      .empty{color:var(--faint);font-size:12.5px;padding:16px;}
      .badge{font-size:10px;padding:2px 8px;border-radius:20px;font-family:var(--fm);}
      .b-ok{background:rgba(74,222,128,.15);color:var(--green);}
      .b-breach{background:rgba(240,87,107,.15);color:var(--red);}
      .b-done{background:rgba(79,195,224,.15);color:var(--cyan);}
      .b-gov{background:rgba(232,163,61,.15);color:var(--amber);}
      .b-orch{background:rgba(79,195,224,.15);color:var(--cyan);}
      .minibtn{background:var(--panel2);border:1px solid var(--border);color:var(--dim);border-radius:5px;padding:5px 9px;font-size:11px;}
      .minibtn:hover{border-color:var(--cyan);color:var(--text);}
      .btn{border-radius:6px;padding:9px 14px;font-size:12.5px;font-weight:600;border:1px solid var(--border);background:var(--panel2);color:var(--text);margin:10px 0;}
      .btn.primary{border-color:var(--cyan);color:var(--cyan);}
      .sectionhead{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);margin:16px 0 8px;}
      .timelinelist, .tasklist, .auditlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px;}
      .timelinelist li, .auditlist li{font-size:11.5px;color:var(--dim);}
      .taskrow{display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--panel2);border-radius:6px;padding:8px 10px;}
      .taskrow.p-high{border-left:3px solid var(--red);}
      .tasktext{font-size:12px;}
      .taskmeta{font-size:10px;color:var(--faint);margin-top:2px;}
    `}</style>
  );
}
