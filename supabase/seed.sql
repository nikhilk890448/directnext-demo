-- ============================================================================
-- Optional demo seed data. Run this in Supabase → SQL Editor AFTER schema.sql
-- has already been applied. Safe to run more than once — it just adds more
-- synthetic patients each time (patient_ref values will differ per run
-- unless you clear the tables first — see the bottom of this file).
-- ============================================================================
do $$
declare
  v_patient_id uuid;
  v_journey_id uuid;
  v_ref text;
  v_stage text;
  v_hash text;
  stages text[] := array['intake','safety_check','insurance_pa','telehealth','pharmacy','logistics','refill'];
  first_names text[] := array['Maria','Daniel','Elaine','Priya','Marcus','Sofia','Tobias','Amara','Kojo','Ines','Grace','Owen'];
  last_names text[] := array['Thompson','Mercer','Fox','Nathan','Webb','Reyes','Lindqvist','Chukwu','Asante','Torres','Whitfield','Baptiste'];
  conditions text[] := array['Rheumatoid Arthritis','Plaque Psoriasis','Type 2 Diabetes','Multiple Sclerosis','Chronic Migraine'];
  i int;
  seed_suffix text := (extract(epoch from now())::bigint % 100000)::text;
begin
  for i in 1..12 loop
    v_ref := 'P-' || seed_suffix || '-' || i;

    insert into patients (patient_ref, first_name, last_name, dob, email, condition, insurance, consent)
    values (
      v_ref,
      first_names[1 + (i % array_length(first_names,1))],
      last_names[1 + (i % array_length(last_names,1))],
      (date '1975-01-01' + (i * 400) * interval '1 day')::date,
      'demo.patient' || i || '@example.com',
      conditions[1 + (i % array_length(conditions,1))],
      jsonb_build_object('payer','Demo Health Plan','member_id','M' || (100000+i),'group_number','G100'),
      jsonb_build_object('care_coordination', true)
    ) returning id into v_patient_id;

    v_stage := stages[1 + (i % array_length(stages,1))];

    insert into journeys (patient_id, current_stage, status, stage_entered_at, sla_due_at)
    values (
      v_patient_id, v_stage, 'in_progress',
      now() - (i || ' hours')::interval,
      case when i % 5 = 0 then now() - interval '2 hours' else now() + interval '48 hours' end
    ) returning id into v_journey_id;

    insert into journey_events (journey_id, event_type, payload) values
      (v_journey_id, 'enrolled', jsonb_build_object('source','seed')),
      (v_journey_id, 'consented', '{}'::jsonb);

    v_hash := encode(digest('seed|' || v_ref, 'sha256'), 'hex');
    insert into audit_log (journey_id, actor, decision, fields_shared, consent_basis, input_hash, prev_hash, hash)
    values (v_journey_id, 'seed', 'journey opened — ' || v_ref, 'patient_ref, consent_scope', 'consent', left(v_hash,16), repeat('0',64), v_hash);

    if i % 4 = 0 then
      insert into tasks (journey_id, type, reason, priority, assigned_role)
      values (v_journey_id, 'SLA breach', 'No response at "' || v_stage || '" within the allotted SLA', 'high', 'Care coordination');
    end if;

    if i % 3 = 0 then
      insert into stage_history (journey_id, stage, entered_at, exited_at, duration_hours)
      values (v_journey_id, stages[1], now() - interval '3 days', now() - interval '2 days', 22.5);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- To wipe ALL data (seed + real submissions) and start clean, run this
-- instead (uncomment first). Careful — this deletes everything.
-- ----------------------------------------------------------------------------
-- truncate audit_log, tasks, stage_history, journey_events, journeys, patients cascade;
