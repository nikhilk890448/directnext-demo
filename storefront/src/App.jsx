import React, { useState, useEffect } from "react";
import { submitIntake, login, fetchMe, choosePaymentMethod, payNow } from "./api.js";

const CONDITIONS = [
  "Rheumatoid Arthritis", "Plaque Psoriasis", "Type 2 Diabetes",
  "Multiple Sclerosis", "Chronic Migraine", "Crohn's Disease", "Something else",
];

// Demo payer IDs — illustrative, not verified against any real payer directory.
// In production this would come from a maintained payer list (e.g. a
// clearinghouse's payer directory), not be hardcoded.
const PAYERS = [
  { name: "Aetna", id: "60054" },
  { name: "Cigna", id: "62308" },
  { name: "UnitedHealthcare", id: "87726" },
  { name: "Blue Cross Blue Shield", id: "BCBS001" },
  { name: "Humana", id: "61099" },
  { name: "Other / not listed", id: "OTHER" },
];
const RELATIONSHIPS = ["Self", "Spouse", "Child", "Other"];

// Matches backend/src/workflow.js STAGES order exactly — used to compute
// "how far along" a journey is without hardcoding stage-specific indices.
const STAGE_KEYS = ["intake", "telehealth", "pharmacy", "refill"];

const STEPS = ["Welcome", "About you", "Account", "Coverage", "Consent", "Review"];

const EMPTY = {
  condition: "",
  narrative: "",
  firstName: "", lastName: "", dob: "", email: "", phone: "",
  addressLine: "", city: "", state: "", zip: "",
  password: "", confirmPassword: "",
  billingMethod: "insurance", payer: "", memberId: "", groupNumber: "", relationship: "Self",
  subscriberFirstName: "", subscriberLastName: "", subscriberDob: "",
  showPharmacyBenefit: false, rxBin: "", rxPcn: "", rxGroup: "",
  consentCareCoordination: false,
};

export default function App() {
  const [screen, setScreen] = useState(() => (localStorage.getItem("dn_token") ? "portal" : "register"));
  return (
    <div className="shell">
      <Style />
      <TopNav screen={screen} setScreen={setScreen} />
      {screen === "register" && <RegisterFlow goLogin={() => setScreen("login")} />}
      {screen === "login" && <LoginView onSuccess={() => setScreen("portal")} />}
      {screen === "portal" && <PortalView onLogout={() => { localStorage.removeItem("dn_token"); setScreen("login"); }} />}
    </div>
  );
}

function TopNav({ screen, setScreen }) {
  if (screen === "portal") return null;
  return (
    <div className="topnav">
      <span className="brandmark">DirectNEXT Care</span>
      <button className="navlink" onClick={() => setScreen(screen === "login" ? "register" : "login")}>
        {screen === "login" ? "New here? Register" : "Already registered? Log in"}
      </button>
    </div>
  );
}

/* ============================= REGISTRATION ============================= */
function RegisterFlow({ goLogin }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  function update(field, value) { setForm((f) => ({ ...f, [field]: value })); }

  function canAdvance() {
    if (step === 0) return !!form.condition;
    if (step === 1) return form.firstName && form.lastName && form.dob && form.email;
    if (step === 2) return form.password.length >= 8 && form.password === form.confirmPassword;
    if (step === 3) {
      if (form.billingMethod === "direct") return true;
      const base = form.payer && form.memberId;
      if (form.relationship === "Self") return base;
      return base && form.subscriberFirstName && form.subscriberLastName && form.subscriberDob;
    }
    if (step === 4) return form.consentCareCoordination;
    return true;
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const payerObj = PAYERS.find((p) => p.name === form.payer);
      const payload = {
        firstName: form.firstName, lastName: form.lastName, dob: form.dob,
        email: form.email, phone: form.phone, password: form.password,
        address: { line: form.addressLine, city: form.city, state: form.state, zip: form.zip },
        condition: form.condition,
        narrative: form.narrative || null,
        billingMethod: form.billingMethod,
        insurance: form.billingMethod === "insurance" ? {
          payer: form.payer, payerId: payerObj?.id || "OTHER",
          memberId: form.memberId, groupNumber: form.groupNumber,
          relationship: form.relationship.toLowerCase(),
          subscriberFirstName: form.relationship === "Self" ? form.firstName : form.subscriberFirstName,
          subscriberLastName: form.relationship === "Self" ? form.lastName : form.subscriberLastName,
          subscriberDob: form.relationship === "Self" ? form.dob : form.subscriberDob,
          rxBin: form.showPharmacyBenefit ? form.rxBin : null,
          rxPcn: form.showPharmacyBenefit ? form.rxPcn : null,
          rxGroup: form.showPharmacyBenefit ? form.rxGroup : null,
        } : null,
        consentCareCoordination: form.consentCareCoordination,
      };
      const data = await submitIntake(payload);
      setResult(data);
    } catch (e) {
      setError(e.data?.message || (e.data?.missingFields ? `Missing: ${e.data.missingFields.join(", ")}` : "Something went wrong submitting your information. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  if (result) return <Confirmation result={result} name={form.firstName} goLogin={goLogin} />;

  return (
    <div className="wrap">
      <header className="hero">
        <p className="herosub">One place to start your treatment — we'll handle your doctor, insurance, and pharmacy from here.</p>
      </header>
      <div className="card">
        <Progress step={step} />
        {step === 0 && <Welcome form={form} update={update} />}
        {step === 1 && <AboutYou form={form} update={update} />}
        {step === 2 && <Account form={form} update={update} />}
        {step === 3 && <Insurance form={form} update={update} />}
        {step === 4 && <Consent form={form} update={update} />}
        {step === 5 && <Review form={form} />}
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
      {STEPS.map((s, i) => <div key={s} className={"pdot" + (i <= step ? " done" : "")} />)}
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
          <button key={c} className={"chip" + (form.condition === c ? " chipactive" : "")} onClick={() => update("condition", c)}>{c}</button>
        ))}
      </div>
      <h3 className="subhead">In your own words (optional)</h3>
      <textarea
        className="narrativebox"
        placeholder="Tell us a bit about what's going on — this helps your care team, and there's no wrong way to say it."
        value={form.narrative}
        onChange={(e) => update("narrative", e.target.value)}
        maxLength={1000}
      />
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

function Account({ form, update }) {
  const mismatch = form.confirmPassword && form.password !== form.confirmPassword;
  return (
    <div className="step">
      <h2>Create your account</h2>
      <p className="stepdesc">So you can log back in anytime to see where things stand — no need to call anyone.</p>
      <div className="fieldgrid">
        <Field label="Password (min. 8 characters)" type="password" value={form.password} onChange={(v) => update("password", v)} wide />
        <Field label="Confirm password" type="password" value={form.confirmPassword} onChange={(v) => update("confirmPassword", v)} wide />
      </div>
      {mismatch && <p className="hint" style={{ color: "#c0392b", background: "#fff1f0" }}>Passwords don't match yet.</p>}
    </div>
  );
}

function Insurance({ form, update }) {
  return (
    <div className="step">
      <h2>Coverage</h2>
      <p className="stepdesc">How would you like to pay for this? Your clinician will decide on the actual treatment at your visit — cost details come after that, once we know what's being prescribed.</p>

      <div className="togglerow">
        <button className={"toggle" + (form.billingMethod === "insurance" ? " toggleactive" : "")} onClick={() => update("billingMethod", "insurance")}>Use my insurance</button>
        <button className={"toggle" + (form.billingMethod === "direct" ? " toggleactive" : "")} onClick={() => update("billingMethod", "direct")}>Pay directly</button>
      </div>

      {form.billingMethod === "insurance" && (
        <>
          <div className="fieldgrid mt">
            <SelectField label="Insurance company" value={form.payer} onChange={(v) => update("payer", v)} options={PAYERS.map((p) => p.name)} wide />
            <Field label="Member ID" value={form.memberId} onChange={(v) => update("memberId", v)} />
            <Field label="Group number (optional)" value={form.groupNumber} onChange={(v) => update("groupNumber", v)} />
            <SelectField label="Whose plan is this?" value={form.relationship} onChange={(v) => update("relationship", v)} options={RELATIONSHIPS} />
          </div>
          {form.relationship !== "Self" && (
            <>
              <h3 className="subhead">Subscriber (policy holder) details</h3>
              <div className="fieldgrid">
                <Field label="Subscriber first name" value={form.subscriberFirstName} onChange={(v) => update("subscriberFirstName", v)} />
                <Field label="Subscriber last name" value={form.subscriberLastName} onChange={(v) => update("subscriberLastName", v)} />
                <Field label="Subscriber date of birth" type="date" value={form.subscriberDob} onChange={(v) => update("subscriberDob", v)} />
              </div>
            </>
          )}
          <button className="linkbtn mt" onClick={() => update("showPharmacyBenefit", !form.showPharmacyBenefit)}>
            {form.showPharmacyBenefit ? "− Hide pharmacy benefit details" : "+ My pharmacy benefit is different from my medical plan"}
          </button>
          {form.showPharmacyBenefit && (
            <div className="fieldgrid mt">
              <Field label="RxBIN" value={form.rxBin} onChange={(v) => update("rxBin", v)} />
              <Field label="RxPCN" value={form.rxPcn} onChange={(v) => update("rxPcn", v)} />
              <Field label="RxGroup" value={form.rxGroup} onChange={(v) => update("rxGroup", v)} />
            </div>
          )}
        </>
      )}
      {form.billingMethod === "direct" && <p className="hint">Got it — we'll skip the insurance review and route you straight to the pharmacy after your visit.</p>}
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
        <li>You can see the status of your journey at any time by logging in.</li>
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
        <ReviewRow label="Payment method" value={form.billingMethod === "insurance" ? "Through insurance" : "Paying direct"} />
        <ReviewRow label="Insurance" value={form.billingMethod === "insurance" ? `${form.payer} · ${form.memberId}` : "Not applicable"} />
        {form.billingMethod === "insurance" && form.relationship !== "Self" && <ReviewRow label="Relationship" value={form.relationship} />}
      </div>
    </div>
  );
}

function ReviewRow({ label, value }) {
  return <div className="reviewrow"><span className="rlabel">{label}</span><span className="rvalue">{value || "—"}</span></div>;
}

function Field({ label, value, onChange, type = "text", wide }) {
  return (
    <label className={"field" + (wide ? " wide" : "")}>
      <span>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
function SelectField({ label, value, onChange, options, wide }) {
  return (
    <label className={"field" + (wide ? " wide" : "")}>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function Confirmation({ result, name, goLogin }) {
  const stages = ["Intake received", "Telehealth visit", "Pharmacy & delivery", "Refills"];
  const activeIdx = Math.max(0, STAGE_KEYS.indexOf(result.stage));
  return (
    <div className="wrap">
      <div className="card confirmcard">
        <div className="checkmark">✓</div>
        <h2>Thanks, {name || "there"} — you're all set</h2>
        <p className="stepdesc">Your reference number is <strong className="ref">{result.patientRef}</strong>. Your account is ready — log in anytime to check your status.</p>
        <div className="timeline">
          {stages.map((s, i) => (
            <div key={s} className={"tnode" + (i <= activeIdx ? " tdone" : "")}><span className="tdot" /> {s}</div>
          ))}
        </div>
        <button className="btn primary mt" onClick={goLogin}>Log in to my account</button>
      </div>
    </div>
  );
}

/* ============================= LOGIN + PORTAL ============================= */
function LoginView({ onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleLogin() {
    setBusy(true); setError(null);
    try {
      const data = await login(email, password);
      localStorage.setItem("dn_token", data.accessToken);
      onSuccess();
    } catch (e) {
      setError("Email or password didn't match. Please try again.");
    } finally { setBusy(false); }
  }

  return (
    <div className="wrap">
      <div className="card" style={{ maxWidth: 420 }}>
        <h2>Log in</h2>
        <p className="stepdesc">Check your journey status anytime.</p>
        <div className="fieldgrid">
          <Field label="Email" type="email" value={email} onChange={setEmail} wide />
          <Field label="Password" type="password" value={password} onChange={setPassword} wide />
        </div>
        {error && <div className="errorbox">{error}</div>}
        <button className="btn primary mt" disabled={busy || !email || !password} onClick={handleLogin}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </div>
    </div>
  );
}

function PortalView({ onLogout }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const token = localStorage.getItem("dn_token");
    if (!token) { onLogout(); return; }
    try { setData(await fetchMe(token)); }
    catch (e) { setError("Session expired — please log in again."); localStorage.removeItem("dn_token"); }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleChoose(method) {
    setBusy(true);
    const token = localStorage.getItem("dn_token");
    try { await choosePaymentMethod(token, method); await load(); }
    finally { setBusy(false); }
  }
  async function handlePay() {
    setBusy(true);
    const token = localStorage.getItem("dn_token");
    try { await payNow(token, data.paymentRequest.id); await load(); }
    finally { setBusy(false); }
  }

  if (error) return <div className="wrap"><div className="card"><p>{error}</p><button className="btn primary" onClick={onLogout}>Back to login</button></div></div>;
  if (!data) return <div className="wrap"><p className="stepdesc">Loading…</p></div>;

  const stages = ["Intake & Consent", "Telehealth Visit", "Pharmacy Fulfillment", "Adherence & Refill"];
  const currentIdx = data.stages.indexOf(data.journey?.currentStage);
  const j = data.journey;
  const PHARMACY_STATUS_LABELS = {
    prescription_received: "Prescription received — choose how to pay below",
    payment_pending: "Awaiting your payment",
    insurance_pa_pending: "Your pharmacy has submitted this to your insurer for approval",
    payment_received: "Payment received — preparing your order",
    insurance_approved: "Insurance approved — preparing your order",
    dispensed: "Dispensed",
    in_transit: "On its way to you",
    delivered: "Delivered",
  };

  return (
    <div className="wrap">
      <div className="portaltop">
        <span className="brandmark">DirectNEXT Care</span>
        <button className="navlink" onClick={onLogout}>Log out</button>
      </div>
      <div className="card">
        <h2>Hi, {data.patient.firstName}</h2>
        <p className="stepdesc">Reference: <strong className="ref">{data.patient.patientRef}</strong></p>
        {j ? (
          <>
            <div className="rail">
              {stages.map((s, i) => (
                <div key={s} className={"railstep" + (i < currentIdx ? " done" : i === currentIdx ? " current" : "")}>{s}</div>
              ))}
            </div>

            {j.currentStage === "pharmacy" && j.prescription && (
              <div className="card" style={{ marginTop: 16 }}>
                <h3 className="subhead" style={{ marginTop: 0 }}>Your prescription</h3>
                <p className="stepdesc">{j.prescription.drugName} — {j.prescription.sig} (qty {j.prescription.quantity})</p>
                <p className="stepdesc" style={{ fontWeight: 600 }}>{PHARMACY_STATUS_LABELS[j.pharmacyStatus] || j.pharmacyStatus}</p>

                {j.pharmacyStatus === "prescription_received" && !j.fillPaymentMethod && data.pricing && (
                  <>
                    <div className="costcompare2">
                      <button className="costopt" disabled={busy} onClick={() => handleChoose("insurance")}>
                        <div className="costlabel">Use my insurance</div>
                        <div className="costvalue">~${data.pricing.insurancePriceEstimate}</div>
                      </button>
                      <button className="costopt" disabled={busy} onClick={() => handleChoose("cash")}>
                        <div className="costlabel">Pay directly</div>
                        <div className="costvalue">${data.pricing.cashPrice}</div>
                      </button>
                    </div>
                  </>
                )}

                {j.pharmacyStatus === "payment_pending" && data.paymentRequest && (
                  <button className="btn primary mt" disabled={busy} onClick={handlePay}>
                    Pay ${data.paymentRequest.amount} now
                  </button>
                )}
              </div>
            )}

            {data.tasksNeedingYou.length > 0 && (
              <div className="card" style={{ marginTop: 16, background: "#fff8ec" }}>
                <h3 className="subhead" style={{ marginTop: 0 }}>Needs your attention</h3>
                {data.tasksNeedingYou.map((t, i) => <p key={i} className="stepdesc">{t.reason}</p>)}
              </div>
            )}
          </>
        ) : <p className="stepdesc">No active journey found.</p>}
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
      *{box-sizing:border-box;} body{margin:0;}
      .shell{min-height:100vh;background:var(--bg);font-family:var(--fb);color:var(--ink);}
      .topnav,.portaltop{display:flex;justify-content:space-between;align-items:center;max-width:560px;margin:0 auto;padding:20px 16px 0;}
      .brandmark{font-family:var(--fd);font-weight:800;font-size:14px;color:var(--brand);letter-spacing:.02em;text-transform:uppercase;}
      .navlink{background:none;border:none;color:var(--brand);font-size:12.5px;font-weight:600;cursor:pointer;}
      .wrap{padding:20px 16px 60px;display:flex;flex-direction:column;align-items:center;}
      .hero{max-width:560px;text-align:center;margin-bottom:22px;}
      .herosub{font-size:15px;color:var(--sub);margin-top:8px;line-height:1.5;}
      .card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:28px 30px;max-width:560px;width:100%;box-shadow:0 10px 40px rgba(15,33,56,.06);}
      .progress{display:flex;gap:6px;margin-bottom:24px;}
      .pdot{flex:1;height:4px;border-radius:4px;background:var(--line);}
      .pdot.done{background:var(--brand);}
      .step h2{font-family:var(--fd);font-size:21px;font-weight:700;margin:0 0 6px;}
      .stepdesc{font-size:13.5px;color:var(--sub);margin:0 0 14px;line-height:1.5;}
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
      .field input, .field select{border:1.5px solid var(--line);border-radius:10px;padding:11px 12px;font-size:14px;font-family:var(--fb);color:var(--ink);outline:none;background:#fff;}
      .narrativebox{width:100%;min-height:90px;border:1.5px solid var(--line);border-radius:12px;padding:12px 14px;font-size:14px;font-family:var(--fb);color:var(--ink);outline:none;resize:vertical;}
      .narrativebox:focus{border-color:var(--brand);}
      .field input:focus, .field select:focus{border-color:var(--brand);}
      .togglerow{display:flex;gap:8px;}
      .toggle{flex:1;padding:13px;border-radius:12px;border:1.5px solid var(--line);background:#fff;font-size:13.5px;font-weight:600;color:var(--sub);cursor:pointer;}
      .toggleactive{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-tint);}
      .hint{font-size:12.5px;color:var(--sub);background:var(--bg);border-radius:10px;padding:10px 12px;margin-top:14px;}
      .linkbtn{background:none;border:none;color:var(--brand);font-size:12.5px;font-weight:600;cursor:pointer;padding:0;}
      .consentlist{margin:0 0 18px;padding-left:18px;color:var(--sub);font-size:13px;line-height:1.7;}
      .consentcheck{display:flex;gap:10px;align-items:flex-start;background:var(--brand-tint);border-radius:12px;padding:14px;font-size:13px;color:var(--ink);cursor:pointer;}
      .consentcheck input{margin-top:2px;}
      .reviewgrid{display:flex;flex-direction:column;gap:2px;}
      .reviewrow{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line);font-size:13.5px;}
      .rlabel{color:var(--sub);} .rvalue{font-weight:600;}
      .errorbox{background:#fff1f0;color:#c0392b;border-radius:10px;padding:10px 12px;font-size:12.5px;margin-top:14px;}
      .navrow{display:flex;align-items:center;margin-top:24px;gap:10px;}
      .spacer{flex:1;}
      .btn{border-radius:12px;padding:12px 22px;font-size:14px;font-weight:700;font-family:var(--fb);cursor:pointer;border:none;}
      .btn.primary{background:var(--brand);color:#fff;}
      .btn.primary:disabled{background:#b9cdf4;cursor:not-allowed;}
      .btn.ghost{background:transparent;color:var(--sub);border:1.5px solid var(--line);}
      .btn.mt{margin-top:16px;}
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
      .rail{display:flex;flex-direction:column;gap:8px;margin-top:16px;}
      .costcompare2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;}
      .costopt{border:1.5px solid var(--line);border-radius:12px;padding:14px;text-align:center;background:#fff;cursor:pointer;}
      .costopt:hover{border-color:var(--brand);}
      .costopt .costlabel{font-size:11.5px;color:var(--sub);font-weight:600;text-transform:uppercase;letter-spacing:.03em;}
      .costopt .costvalue{font-family:var(--fd);font-size:20px;font-weight:700;color:var(--ink);margin-top:4px;}
      .railstep{padding:10px 14px;border-radius:10px;background:var(--bg);font-size:13px;color:var(--sub);}
      .railstep.current{background:var(--brand-tint);color:var(--brand-dark);font-weight:700;}
      .railstep.done{color:var(--mint);}
    `}</style>
  );
}
