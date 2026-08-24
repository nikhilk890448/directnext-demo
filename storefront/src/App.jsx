import React, { useState } from "react";
import { submitIntake } from "./api.js";

const CONDITIONS = [
  "Rheumatoid Arthritis", "Plaque Psoriasis", "Type 2 Diabetes",
  "Multiple Sclerosis", "Chronic Migraine", "Crohn's Disease", "Something else",
];

const STEPS = ["Welcome", "About you", "Insurance", "Consent", "Review"];

const EMPTY = {
  condition: "",
  firstName: "", lastName: "", dob: "", email: "", phone: "",
  addressLine: "", city: "", state: "", zip: "",
  hasInsurance: true, payer: "", memberId: "", groupNumber: "",
  consentCareCoordination: false,
};

export default function App() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function canAdvance() {
    if (step === 0) return !!form.condition;
    if (step === 1) return form.firstName && form.lastName && form.dob && form.email;
    if (step === 2) return !form.hasInsurance || (form.payer && form.memberId);
    if (step === 3) return form.consentCareCoordination;
    return true;
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        firstName: form.firstName, lastName: form.lastName, dob: form.dob,
        email: form.email, phone: form.phone,
        address: { line: form.addressLine, city: form.city, state: form.state, zip: form.zip },
        condition: form.condition,
        insurance: form.hasInsurance ? { payer: form.payer, member_id: form.memberId, group_number: form.groupNumber } : null,
        consentCareCoordination: form.consentCareCoordination,
      };
      const data = await submitIntake(payload);
      setResult(data);
    } catch (e) {
      setError(e.data?.missingFields ? `Missing: ${e.data.missingFields.join(", ")}` : "Something went wrong submitting your information. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) return <Confirmation result={result} name={form.firstName} />;

  return (
    <div className="wrap">
      <Style />
      <header className="hero">
        <div className="brandmark">DirectNEXT Care</div>
        <p className="herosub">One place to start your treatment — we'll handle your doctor, insurance, and pharmacy from here.</p>
      </header>

      <div className="card">
        <Progress step={step} />

        {step === 0 && <Welcome form={form} update={update} />}
        {step === 1 && <AboutYou form={form} update={update} />}
        {step === 2 && <Insurance form={form} update={update} />}
        {step === 3 && <Consent form={form} update={update} />}
        {step === 4 && <Review form={form} />}

        {error && <div className="errorbox">{error}</div>}

        <div className="navrow">
          {step > 0 && <button className="btn ghost" onClick={() => setStep((s) => s - 1)} disabled={submitting}>Back</button>}
          <div className="spacer" />
          {step < STEPS.length - 1 && (
            <button className="btn primary" disabled={!canAdvance()} onClick={() => setStep((s) => s + 1)}>Continue</button>
          )}
          {step === STEPS.length - 1 && (
            <button className="btn primary" disabled={submitting} onClick={handleSubmit}>
              {submitting ? "Submitting…" : "Submit my information"}
            </button>
          )}
        </div>
      </div>

      <p className="finePrint">Your information is used only to coordinate your care across your provider, insurer, and pharmacy. Demo environment — please don't enter real personal information.</p>
    </div>
  );
}

function Progress({ step }) {
  return (
    <div className="progress">
      {STEPS.map((s, i) => (
        <div key={s} className={"pstep" + (i <= step ? " done" : "")}>
          <span className="pdot" />
          <span className="plabel">{s}</span>
        </div>
      ))}
    </div>
  );
}

function Welcome({ form, update }) {
  return (
    <div className="step">
      <h2>Let's get you started</h2>
      <p className="stepdesc">This takes about 5 minutes. First, what are we treating today?</p>
      <div className="chipgrid">
        {CONDITIONS.map((c) => (
          <button key={c} className={"chip" + (form.condition === c ? " chipactive" : "")} onClick={() => update("condition", c)}>
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

function AboutYou({ form, update }) {
  return (
    <div className="step">
      <h2>A little about you</h2>
      <p className="stepdesc">So your care team knows who they're helping.</p>
      <div className="fieldgrid">
        <Field label="First name" value={form.firstName} onChange={(v) => update("firstName", v)} />
        <Field label="Last name" value={form.lastName} onChange={(v) => update("lastName", v)} />
        <Field label="Date of birth" type="date" value={form.dob} onChange={(v) => update("dob", v)} />
        <Field label="Email" type="email" value={form.email} onChange={(v) => update("email", v)} />
        <Field label="Phone (optional)" value={form.phone} onChange={(v) => update("phone", v)} />
      </div>
      <h3 className="subhead">Shipping address (optional for now)</h3>
      <div className="fieldgrid">
        <Field label="Street address" value={form.addressLine} onChange={(v) => update("addressLine", v)} wide />
        <Field label="City" value={form.city} onChange={(v) => update("city", v)} />
        <Field label="State" value={form.state} onChange={(v) => update("state", v)} />
        <Field label="ZIP" value={form.zip} onChange={(v) => update("zip", v)} />
      </div>
    </div>
  );
}

function Insurance({ form, update }) {
  return (
    <div className="step">
      <h2>Your insurance</h2>
      <p className="stepdesc">We'll check your benefits automatically — no phone calls needed.</p>
      <div className="togglerow">
        <button className={"toggle" + (form.hasInsurance ? " toggleactive" : "")} onClick={() => update("hasInsurance", true)}>I have insurance</button>
        <button className={"toggle" + (!form.hasInsurance ? " toggleactive" : "")} onClick={() => update("hasInsurance", false)}>I don't / not sure</button>
      </div>
      {form.hasInsurance && (
        <div className="fieldgrid mt">
          <Field label="Insurance company" value={form.payer} onChange={(v) => update("payer", v)} wide />
          <Field label="Member ID" value={form.memberId} onChange={(v) => update("memberId", v)} />
          <Field label="Group number (optional)" value={form.groupNumber} onChange={(v) => update("groupNumber", v)} />
        </div>
      )}
      {!form.hasInsurance && <p className="hint">No problem — we'll help you find cost-assistance options after you submit.</p>}
    </div>
  );
}

function Consent({ form, update }) {
  return (
    <div className="step">
      <h2>Before we continue</h2>
      <p className="stepdesc">Here's exactly what happens with your information.</p>
      <ul className="consentlist">
        <li>We'll share only what's needed with your doctor, insurer, and pharmacy to get your treatment moving.</li>
        <li>You can see the status of your journey at any time.</li>
        <li>You can withdraw this consent whenever you'd like — it won't affect any care already in progress.</li>
      </ul>
      <label className="consentcheck">
        <input type="checkbox" checked={form.consentCareCoordination} onChange={(e) => update("consentCareCoordination", e.target.checked)} />
        <span>I agree to let DirectNEXT Care coordinate my treatment across my care team.</span>
      </label>
    </div>
  );
}

function Review({ form }) {
  return (
    <div className="step">
      <h2>Review &amp; submit</h2>
      <div className="reviewgrid">
        <ReviewRow label="Condition" value={form.condition} />
        <ReviewRow label="Name" value={`${form.firstName} ${form.lastName}`} />
        <ReviewRow label="Date of birth" value={form.dob} />
        <ReviewRow label="Email" value={form.email} />
        <ReviewRow label="Insurance" value={form.hasInsurance ? `${form.payer} · ${form.memberId}` : "Not provided"} />
      </div>
    </div>
  );
}

function ReviewRow({ label, value }) {
  return (
    <div className="reviewrow">
      <span className="rlabel">{label}</span>
      <span className="rvalue">{value || "—"}</span>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", wide }) {
  return (
    <label className={"field" + (wide ? " wide" : "")}>
      <span>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Confirmation({ result, name }) {
  const stages = ["Intake received", "Safety check", "Insurance review", "Telehealth visit", "Pharmacy", "On its way", "Refills"];
  const activeIdx = result.stage === "insurance_pa" ? 2 : 0;
  return (
    <div className="wrap">
      <Style />
      <div className="card confirmcard">
        <div className="checkmark">✓</div>
        <h2>Thanks, {name || "there"} — you're all set</h2>
        <p className="stepdesc">Your reference number is <strong className="ref">{result.patientRef}</strong>. Save it — you'll use it to check your status.</p>
        <div className="timeline">
          {stages.map((s, i) => (
            <div key={s} className={"tnode" + (i <= activeIdx ? " tdone" : "")}>
              <span className="tdot" /> {s}
            </div>
          ))}
        </div>
        <p className="hint mt">We'll email you at every step. Most people hear back on insurance within a couple of days.</p>
      </div>
    </div>
  );
}

function Style() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Inter:wght@400;500;600&display=swap');
      :root{
        --ink:#0f2138; --sub:#5b7089; --line:#e4ebf3; --bg:#f6f9fc;
        --brand:#0b63f6; --brand-dark:#0847b8; --brand-tint:#eaf1ff;
        --mint:#12b886; --mint-tint:#e7f9f3;
        --fd:'Plus Jakarta Sans',sans-serif; --fb:'Inter',sans-serif;
      }
      *{box-sizing:border-box;}
      body{margin:0;}
      .wrap{min-height:100vh;background:var(--bg);font-family:var(--fb);color:var(--ink);padding:32px 16px 60px;display:flex;flex-direction:column;align-items:center;}
      .hero{max-width:560px;text-align:center;margin-bottom:22px;}
      .brandmark{font-family:var(--fd);font-weight:800;font-size:15px;color:var(--brand);letter-spacing:.02em;text-transform:uppercase;}
      .herosub{font-size:15px;color:var(--sub);margin-top:8px;line-height:1.5;}
      .card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:28px 30px;max-width:560px;width:100%;box-shadow:0 10px 40px rgba(15,33,56,.06);}
      .progress{display:flex;gap:6px;margin-bottom:24px;}
      .pstep{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;}
      .pdot{width:100%;height:4px;border-radius:4px;background:var(--line);display:block;}
      .pstep.done .pdot{background:var(--brand);}
      .plabel{font-size:9.5px;color:var(--sub);text-transform:uppercase;letter-spacing:.03em;display:none;}
      .step h2{font-family:var(--fd);font-size:21px;font-weight:700;margin:0 0 6px;}
      .stepdesc{font-size:13.5px;color:var(--sub);margin:0 0 18px;line-height:1.5;}
      .subhead{font-family:var(--fd);font-size:14px;margin:18px 0 10px;}
      .chipgrid{display:flex;flex-wrap:wrap;gap:8px;}
      .chip{background:var(--brand-tint);border:1.5px solid transparent;color:var(--brand-dark);padding:11px 16px;border-radius:12px;font-size:13.5px;font-weight:600;font-family:var(--fb);cursor:pointer;}
      .chip:hover{border-color:var(--brand);}
      .chipactive{background:var(--brand);color:#fff;}
      .fieldgrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
      .fieldgrid.mt{margin-top:16px;}
      @media(max-width:480px){.fieldgrid{grid-template-columns:1fr;}}
      .field{display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--sub);font-weight:600;}
      .field.wide{grid-column:1/-1;}
      .field input{border:1.5px solid var(--line);border-radius:10px;padding:11px 12px;font-size:14px;font-family:var(--fb);color:var(--ink);outline:none;}
      .field input:focus{border-color:var(--brand);}
      .togglerow{display:flex;gap:8px;}
      .toggle{flex:1;padding:13px;border-radius:12px;border:1.5px solid var(--line);background:#fff;font-size:13.5px;font-weight:600;color:var(--sub);cursor:pointer;}
      .toggleactive{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-tint);}
      .hint{font-size:12.5px;color:var(--sub);background:var(--bg);border-radius:10px;padding:10px 12px;margin-top:14px;}
      .consentlist{margin:0 0 18px;padding-left:18px;color:var(--sub);font-size:13px;line-height:1.7;}
      .consentcheck{display:flex;gap:10px;align-items:flex-start;background:var(--brand-tint);border-radius:12px;padding:14px;font-size:13px;color:var(--ink);cursor:pointer;}
      .consentcheck input{margin-top:2px;}
      .reviewgrid{display:flex;flex-direction:column;gap:2px;}
      .reviewrow{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line);font-size:13.5px;}
      .rlabel{color:var(--sub);}
      .rvalue{font-weight:600;}
      .errorbox{background:#fff1f0;color:#c0392b;border-radius:10px;padding:10px 12px;font-size:12.5px;margin-top:14px;}
      .navrow{display:flex;align-items:center;margin-top:24px;gap:10px;}
      .spacer{flex:1;}
      .btn{border-radius:12px;padding:12px 22px;font-size:14px;font-weight:700;font-family:var(--fb);cursor:pointer;border:none;}
      .btn.primary{background:var(--brand);color:#fff;}
      .btn.primary:disabled{background:#b9cdf4;cursor:not-allowed;}
      .btn.ghost{background:transparent;color:var(--sub);border:1.5px solid var(--line);}
      .finePrint{max-width:560px;text-align:center;font-size:11px;color:var(--sub);margin-top:18px;line-height:1.5;}
      .confirmcard{text-align:center;}
      .checkmark{width:52px;height:52px;border-radius:50%;background:var(--mint-tint);color:var(--mint);font-size:24px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;}
      .ref{color:var(--brand-dark);font-family:var(--fd);}
      .timeline{display:flex;flex-direction:column;gap:10px;text-align:left;margin-top:20px;}
      .tnode{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--sub);}
      .tdot{width:9px;height:9px;border-radius:50%;background:var(--line);}
      .tdone{color:var(--ink);font-weight:600;}
      .tdone .tdot{background:var(--mint);}
      .mt{margin-top:16px;}
    `}</style>
  );
}
