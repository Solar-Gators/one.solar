-- =============================================================================
-- 036: Solar Evals — eval types, set up on the page (Solar Evals → Setup)
-- =============================================================================
-- Run once, after 035: Supabase → SQL Editor → New query → paste → Run.
--
--   Until now Solar Evals had one way of working (the member eval): the member
--   answers their CE's questions, the CE writes the eval with the lead's input,
--   they meet, and the CE shares it. This makes all of that a setting, so new
--   kinds of evals (e.g. the President evaluating the CEs with their leads'
--   feedback) can be set up without touching the database:
--
--   * Eval types (eval_types). Each one says, as data:
--       who can be evaluated, who evaluates, who gives input (and how many,
--       picked by whom, and whether they can leave notes for the evaluator);
--       which form is used (and whether it has variants, e.g. per division);
--       whether there's a self-eval questionnaire, and whose questions;
--       whether there's a meeting; whether the person can comment;
--       who can read the answers and the eval, and from which point on;
--       which emails go out.
--     "Who" is: anyone, people whose role has a permission, a OneSolar role,
--     an eval group (below), or one specific person, so nobody needs a new
--     OneSolar position just for evals.
--   * Each eval keeps a copy of its type's settings from when it started
--     (evals.type_settings); the rules below read that copy. Changing a type
--     changes new evals; "Apply to evals in progress" updates the open ones.
--   * Eval groups (eval_groups): named lists of people, e.g. "Subsystem leads".
--   * Shared questionnaires (eval_questionnaires), as well as each CE's own.
--   * Input notes (eval_input_notes): a lead's notes for the evaluator, which
--     the person evaluated never sees.
--   * Forms (eval_tracks) can be top-level forms with variants, not only the
--     master template and CE divisions; forms can be removed when unused.
--     The Leadership eval form comes with a variant for each E-board / CE / PM /
--     lead position (from Solar_Evals_All_Leadership_Positions.pdf).
--   * Rating scales can have 2 to 10 levels, with or without N/O.
--
--   The "Member eval" type below reproduces exactly how evals worked before.
--   New permission "Set up Solar Evals" (Admin and E-board by default).
-- =============================================================================

insert into public.permissions (key, label, description, sort) values
  ('evals.types', 'Set up Solar Evals', 'Create eval types: who evaluates whom, the steps, who sees what and when, and eval groups.', 15)
on conflict (key) do nothing;
insert into public.role_permissions (role, permission) values ('admin', 'evals.types'), ('eboard', 'evals.types')
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- Forms: top-level forms and their variants
-- ---------------------------------------------------------------------------
alter table public.eval_tracks
  add column parent_id  text references public.eval_tracks(id) on delete restrict,
  add column removed_at timestamptz;
update public.eval_tracks set parent_id = 'master' where kind = 'ce' and parent_id is null;
alter table public.eval_tracks add constraint eval_tracks_parent_check
  check ((kind = 'master') = (parent_id is null));

drop policy if exists "signed-in read" on public.eval_tracks;
create policy "signed-in read" on public.eval_tracks for select to authenticated using (removed_at is null);

-- The leadership evals (from Solar_Evals_All_Leadership_Positions.pdf): a form with a variant per position.
insert into public.eval_tracks (id, name, kind, parent_id, color, sort) values
  ('leadership', 'Leadership eval', 'master', null, '#13315c', 10),
  ('lead-president', 'President', 'ce', 'leadership', '#0b2545', 11),
  ('lead-vp', 'Vice President', 'ce', 'leadership', '#1d4ed8', 12),
  ('lead-treasurer', 'Treasurer', 'ce', 'leadership', '#17803d', 13),
  ('lead-secretary', 'Secretary', 'ce', 'leadership', '#7c3aed', 14),
  ('lead-business', 'Business Coordinator', 'ce', 'leadership', '#be185d', 15),
  ('lead-mech-ce', 'Mechanical Chief Engineer', 'ce', 'leadership', '#C2622A', 16),
  ('lead-elec-ce', 'Electrical Chief Engineer', 'ce', 'leadership', '#2F5FA8', 17),
  ('lead-mech-pm', 'Mechanical Integration Project Manager', 'ce', 'leadership', '#8A3F7A', 18),
  ('lead-elec-pm', 'Electrical Integration Project Manager', 'ce', 'leadership', '#1F7A6B', 19),
  ('lead-subsystem-lead', 'Subsystem Lead', 'ce', 'leadership', '#a15c07', 20)
on conflict (id) do nothing;
insert into public.eval_templates (id, track_id, label, note, based_on, rubric, author_name, created_at) values
  ('00000000-0000-4000-8000-000000000100', 'leadership', 'v1.0', 'The leadership master: the universal page and a role page to fill in per position.', null, $rubric${"title": "Solar Evals", "catHead": "Category", "catSub": "Behavioral expectations", "scale": ["Unsatisfactory", "Below expectations", "Meets expectations", "Exceeds expectations", "Exceptional"], "noOption": true, "pages": [{"id": "universal", "name": "Universal Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Semester", "bind": "semester"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Rate performance against agreed role expectations; 3 = fully meets expectations.", "legend": "N/O = Not observed / not applicable", "capsNames": true, "criteria": [{"id": "communication", "tag": "", "name": "Communication", "sub": "Updates, coordination, feedback", "writeIn": false, "levels": ["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]}, {"id": "reliability-accountability", "tag": "", "name": "Reliability & Accountability", "sub": "Commitments and follow-through", "writeIn": false, "levels": ["Repeatedly leaves agreed responsibilities unfinished or unaddressed.", "Misses commitments and requires frequent reminders or escalation.", "Follows through or flags risks and renegotiates deadlines early.", "Delivers dependably and takes action before issues become delays.", "Builds lasting reliability in critical work beyond individual tasks."]}, {"id": "attendance-participation", "tag": "", "name": "Attendance & Participation", "sub": "Agreed sessions and engagement", "writeIn": false, "levels": ["Often misses agreed meetings or work without timely notice.", "Attendance or meaningful participation is inconsistent.", "Meets agreed participation expectations or communicates conflicts.", "Contributes consistently and makes shared work sessions productive.", "Creates conditions that help others participate effectively."]}, {"id": "role-competence-work-quality", "tag": "", "name": "Role Competence & Work Quality", "sub": "Judgment, execution, checking", "writeIn": false, "levels": ["Output often misses basic requirements or needs major correction.", "Applies role skills unevenly; frequent guidance or rework needed.", "Performs assigned work to standard and checks key requirements.", "Handles complex responsibilities independently with strong quality.", "Elevates standards or methods across the team through excellent work."]}, {"id": "initiative-ownership", "tag": "", "name": "Initiative & Ownership", "sub": "Self-direction and problem solving", "writeIn": false, "levels": ["Rarely advances responsibilities without repeated direction.", "Waits for prompting on routine decisions, next steps, or blockers.", "Advances owned work independently and escalates issues when needed.", "Identifies problems early and drives solutions beyond assigned tasks.", "Follows through on high-impact improvements with lasting results."]}, {"id": "learning-development", "tag": "", "name": "Learning & Development", "sub": "Feedback, curiosity, growth", "writeIn": false, "levels": ["Makes little effort to address known gaps or act on feedback.", "Improvement is inconsistent; similar issues persist after feedback.", "Accepts feedback and improves skills needed for the position.", "Actively builds new skills and applies lessons to current work.", "Demonstrates exceptional growth and shares useful lessons widely."]}], "boxes": [], "notesTitle": "Scoring principles", "notes": ["3 meets expectations. Justify 1/2/4/5 with examples. Score agreed work, not raw hours. Handle safety issues separately."], "footer": "Solar Gators"}, {"id": "role", "name": "Role-specific Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Review Date", "bind": "review_date"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Specific expectations are based on position duties in the constitution; agree on goals at semester start.", "legend": "", "capsNames": false, "criteria": [{"id": "duty-1", "tag": "Role-specific", "name": "Position duty 1", "sub": "", "writeIn": true, "levels": ["Does not meet the agreed expectations for this duty.", "Partially meets them; needs repeated follow-up.", "Meets the agreed expectations for this duty.", "Exceeds them through strong, independent work.", "Exceptional; leaves lasting improvements for the team."]}, {"id": "duty-2", "tag": "Role-specific", "name": "Position duty 2", "sub": "", "writeIn": true, "levels": ["Does not meet the agreed expectations for this duty.", "Partially meets them; needs repeated follow-up.", "Meets the agreed expectations for this duty.", "Exceeds them through strong, independent work.", "Exceptional; leaves lasting improvements for the team."]}, {"id": "duty-3", "tag": "Role-specific", "name": "Position duty 3", "sub": "", "writeIn": true, "levels": ["Does not meet the agreed expectations for this duty.", "Partially meets them; needs repeated follow-up.", "Meets the agreed expectations for this duty.", "Exceeds them through strong, independent work.", "Exceptional; leaves lasting improvements for the team."]}, {"id": "duty-4", "tag": "Role-specific", "name": "Position duty 4", "sub": "", "writeIn": true, "levels": ["Does not meet the agreed expectations for this duty.", "Partially meets them; needs repeated follow-up.", "Meets the agreed expectations for this duty.", "Exceeds them through strong, independent work.", "Exceptional; leaves lasting improvements for the team."]}], "boxes": [{"id": "evidence", "title": "Notable contributions / evidence", "lines": 4, "role": "evidence"}, {"id": "goals", "title": "Next-semester goals", "lines": 4, "role": ""}, {"id": "improvement", "title": "Areas for improvement", "lines": 2, "role": ""}, {"id": "comments", "title": "Member comments / context", "lines": 2, "role": "comments"}], "notesTitle": "", "notes": ["N/O: insufficient evidence or not assigned. Do not average ratings into a single score."], "footer": "Solar Gators"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-10T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000101', 'lead-president', 'v1.0', 'From the leadership positions PDF (President).', '00000000-0000-4000-8000-000000000100', $rubric${"title": "Solar Evals", "catHead": "Category", "catSub": "Behavioral expectations", "scale": ["Unsatisfactory", "Below expectations", "Meets expectations", "Exceeds expectations", "Exceptional"], "noOption": true, "pages": [{"id": "universal", "name": "Universal Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Semester", "bind": "semester"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Rate performance against agreed role expectations; 3 = fully meets expectations.", "legend": "N/O = Not observed / not applicable", "capsNames": true, "criteria": [{"id": "communication", "tag": "", "name": "Communication", "sub": "Updates, coordination, feedback", "writeIn": false, "levels": ["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]}, {"id": "reliability-accountability", "tag": "", "name": "Reliability & Accountability", "sub": "Commitments and follow-through", "writeIn": false, "levels": ["Repeatedly leaves agreed responsibilities unfinished or unaddressed.", "Misses commitments and requires frequent reminders or escalation.", "Follows through or flags risks and renegotiates deadlines early.", "Delivers dependably and takes action before issues become delays.", "Builds lasting reliability in critical work beyond individual tasks."]}, {"id": "attendance-participation", "tag": "", "name": "Attendance & Participation", "sub": "Agreed sessions and engagement", "writeIn": false, "levels": ["Often misses agreed meetings or work without timely notice.", "Attendance or meaningful participation is inconsistent.", "Meets agreed participation expectations or communicates conflicts.", "Contributes consistently and makes shared work sessions productive.", "Creates conditions that help others participate effectively."]}, {"id": "role-competence-work-quality", "tag": "", "name": "Role Competence & Work Quality", "sub": "Judgment, execution, checking", "writeIn": false, "levels": ["Output often misses basic requirements or needs major correction.", "Applies role skills unevenly; frequent guidance or rework needed.", "Performs assigned work to standard and checks key requirements.", "Handles complex responsibilities independently with strong quality.", "Elevates standards or methods across the team through excellent work."]}, {"id": "initiative-ownership", "tag": "", "name": "Initiative & Ownership", "sub": "Self-direction and problem solving", "writeIn": false, "levels": ["Rarely advances responsibilities without repeated direction.", "Waits for prompting on routine decisions, next steps, or blockers.", "Advances owned work independently and escalates issues when needed.", "Identifies problems early and drives solutions beyond assigned tasks.", "Follows through on high-impact improvements with lasting results."]}, {"id": "learning-development", "tag": "", "name": "Learning & Development", "sub": "Feedback, curiosity, growth", "writeIn": false, "levels": ["Makes little effort to address known gaps or act on feedback.", "Improvement is inconsistent; similar issues persist after feedback.", "Accepts feedback and improves skills needed for the position.", "Actively builds new skills and applies lessons to current work.", "Demonstrates exceptional growth and shares useful lessons widely."]}], "boxes": [], "notesTitle": "Scoring principles", "notes": ["3 meets expectations. Justify 1/2/4/5 with examples. Score agreed work, not raw hours. Handle safety issues separately.", "CONSTITUTION: Article VIII, Section A(A); collective E-Board duties"], "footer": "Solar Gators  •  President"}, {"id": "role", "name": "Role-specific Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Review Date", "bind": "review_date"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Specific expectations are based on position duties in the constitution; agree on goals at semester start.", "legend": "", "capsNames": false, "criteria": [{"id": "team-stewardship", "tag": "", "name": "Team Stewardship", "sub": "Culture, shared E-Board duties", "writeIn": false, "levels": ["Neglects shared board duties or contributes to an unwelcoming climate.", "Participates unevenly in team culture and shared board obligations.", "Supports a welcoming culture and fulfills delegated board duties.", "Proactively improves team support, coordination, or shared operations.", "Establishes lasting improvements in team culture and board effectiveness."]}, {"id": "team-timeline-goals", "tag": "", "name": "Team Timeline & Goals", "sub": "Milestones and system timelines", "writeIn": false, "levels": ["Does not maintain an overall plan or react to missed milestones.", "Tracks milestones sporadically; major slips surface late.", "Maintains overall timeline, reviews system plans, and follows up.", "Anticipates dependencies and aligns teams to recover schedule risks.", "Creates an exceptionally effective planning system that sustains delivery."]}, {"id": "meeting-facilitation", "tag": "", "name": "Meeting Facilitation", "sub": "Town halls, work, CE/E-Board meetings", "writeIn": false, "levels": ["Regularly fails to convene or effectively run needed meetings.", "Meetings often lack direction, decisions, or follow-up.", "Conducts required meetings with clear decisions and action owners.", "Keeps meetings efficient and resolves cross-team issues quickly.", "Establishes decision-making habits that greatly improve execution."]}, {"id": "elections-governance", "tag": "", "name": "Elections & Governance", "sub": "Fair procedures and continuity", "writeIn": false, "levels": ["Neglects required election procedures or basic governance duties.", "Requires repeated correction to election planning or procedures.", "Mediates elections and handles governance requirements properly.", "Anticipates procedural issues and prepares a smooth transition.", "Sets a high standard for fair, reliable governance and continuity."]}, {"id": "team-structure-accountability", "tag": "", "name": "Team Structure & Accountability", "sub": "Subsystems, leads, approvals", "writeIn": false, "levels": ["Fails to address serious structural or leadership issues.", "Delays needed decisions or leaves ownership unclear.", "Approves needed structure changes and addresses accountability issues.", "Proactively aligns leads and system ownership to team needs.", "Makes difficult organizational changes that yield lasting improvements."]}], "boxes": [{"id": "evidence", "title": "Notable contributions / evidence", "lines": 4, "role": "evidence"}, {"id": "goals", "title": "Next-semester goals", "lines": 4, "role": ""}, {"id": "improvement", "title": "Areas for improvement", "lines": 2, "role": ""}, {"id": "comments", "title": "Member comments / context", "lines": 2, "role": "comments"}], "notesTitle": "", "notes": ["N/O: insufficient evidence or not assigned. Do not average ratings into a single score.", "CONSTITUTION: Article VIII, Section A(A); collective E-Board duties"], "footer": "Solar Gators  •  President"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-10T00:00:01Z'),
  ('00000000-0000-4000-8000-000000000102', 'lead-vp', 'v1.0', 'From the leadership positions PDF (Vice President).', '00000000-0000-4000-8000-000000000100', $rubric${"title": "Solar Evals", "catHead": "Category", "catSub": "Behavioral expectations", "scale": ["Unsatisfactory", "Below expectations", "Meets expectations", "Exceeds expectations", "Exceptional"], "noOption": true, "pages": [{"id": "universal", "name": "Universal Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Semester", "bind": "semester"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Rate performance against agreed role expectations; 3 = fully meets expectations.", "legend": "N/O = Not observed / not applicable", "capsNames": true, "criteria": [{"id": "communication", "tag": "", "name": "Communication", "sub": "Updates, coordination, feedback", "writeIn": false, "levels": ["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]}, {"id": "reliability-accountability", "tag": "", "name": "Reliability & Accountability", "sub": "Commitments and follow-through", "writeIn": false, "levels": ["Repeatedly leaves agreed responsibilities unfinished or unaddressed.", "Misses commitments and requires frequent reminders or escalation.", "Follows through or flags risks and renegotiates deadlines early.", "Delivers dependably and takes action before issues become delays.", "Builds lasting reliability in critical work beyond individual tasks."]}, {"id": "attendance-participation", "tag": "", "name": "Attendance & Participation", "sub": "Agreed sessions and engagement", "writeIn": false, "levels": ["Often misses agreed meetings or work without timely notice.", "Attendance or meaningful participation is inconsistent.", "Meets agreed participation expectations or communicates conflicts.", "Contributes consistently and makes shared work sessions productive.", "Creates conditions that help others participate effectively."]}, {"id": "role-competence-work-quality", "tag": "", "name": "Role Competence & Work Quality", "sub": "Judgment, execution, checking", "writeIn": false, "levels": ["Output often misses basic requirements or needs major correction.", "Applies role skills unevenly; frequent guidance or rework needed.", "Performs assigned work to standard and checks key requirements.", "Handles complex responsibilities independently with strong quality.", "Elevates standards or methods across the team through excellent work."]}, {"id": "initiative-ownership", "tag": "", "name": "Initiative & Ownership", "sub": "Self-direction and problem solving", "writeIn": false, "levels": ["Rarely advances responsibilities without repeated direction.", "Waits for prompting on routine decisions, next steps, or blockers.", "Advances owned work independently and escalates issues when needed.", "Identifies problems early and drives solutions beyond assigned tasks.", "Follows through on high-impact improvements with lasting results."]}, {"id": "learning-development", "tag": "", "name": "Learning & Development", "sub": "Feedback, curiosity, growth", "writeIn": false, "levels": ["Makes little effort to address known gaps or act on feedback.", "Improvement is inconsistent; similar issues persist after feedback.", "Accepts feedback and improves skills needed for the position.", "Actively builds new skills and applies lessons to current work.", "Demonstrates exceptional growth and shares useful lessons widely."]}], "boxes": [], "notesTitle": "Scoring principles", "notes": ["3 meets expectations. Justify 1/2/4/5 with examples. Score agreed work, not raw hours. Handle safety issues separately.", "CONSTITUTION: Article VIII, Section A(B); collective E-Board duties"], "footer": "Solar Gators  •  Vice President"}, {"id": "role", "name": "Role-specific Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Review Date", "bind": "review_date"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Specific expectations are based on position duties in the constitution; agree on goals at semester start.", "legend": "", "capsNames": false, "criteria": [{"id": "team-stewardship", "tag": "", "name": "Team Stewardship", "sub": "Culture, shared E-Board duties", "writeIn": false, "levels": ["Neglects shared board duties or contributes to an unwelcoming climate.", "Participates unevenly in team culture and shared board obligations.", "Supports a welcoming culture and fulfills delegated board duties.", "Proactively improves team support, coordination, or shared operations.", "Establishes lasting improvements in team culture and board effectiveness."]}, {"id": "university-relations", "tag": "", "name": "University Relations", "sub": "Department and university coordination", "writeIn": false, "levels": ["Misses important university contacts or commitments.", "Engages university contacts inconsistently or late.", "Coordinates university meetings and serves as a reliable liaison.", "Anticipates university needs and improves working relationships.", "Builds enduring university partnerships that benefit the team."]}, {"id": "competition-documentation", "tag": "", "name": "Competition Documentation", "sub": "ASC/FSGP communications and due dates", "writeIn": false, "levels": ["Misses critical submissions or fails to coordinate requirements.", "Submissions need repeated reminders or significant correction.", "Coordinates officials and ensures required documents are submitted.", "Tracks requirements early and prevents avoidable submission risks.", "Creates a robust process with exceptional compliance and continuity."]}, {"id": "shop-organization-safety", "tag": "", "name": "Shop Organization & Safety", "sub": "SDC coordination, inventory, cleanliness", "writeIn": false, "levels": ["Neglects major shop organization or safety coordination issues.", "Shop upkeep and SDC communication require repeated intervention.", "Coordinates shop cleanliness, inventory, safety, and SDC contact.", "Anticipates shop needs and resolves issues before work is affected.", "Implements lasting shop-management improvements adopted by the team."]}, {"id": "external-communication", "tag": "", "name": "External Communication", "sub": "Representation and follow-through", "writeIn": false, "levels": ["Fails to relay important external decisions or follow up.", "External contacts receive inconsistent or unclear communication.", "Represents the team professionally and follows through on requests.", "Builds effective relationships and keeps stakeholders well informed.", "Strengthens external trust through an outstanding coordination system."]}], "boxes": [{"id": "evidence", "title": "Notable contributions / evidence", "lines": 4, "role": "evidence"}, {"id": "goals", "title": "Next-semester goals", "lines": 4, "role": ""}, {"id": "improvement", "title": "Areas for improvement", "lines": 2, "role": ""}, {"id": "comments", "title": "Member comments / context", "lines": 2, "role": "comments"}], "notesTitle": "", "notes": ["N/O: insufficient evidence or not assigned. Do not average ratings into a single score.", "CONSTITUTION: Article VIII, Section A(B); collective E-Board duties"], "footer": "Solar Gators  •  Vice President"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-10T00:00:02Z'),
  ('00000000-0000-4000-8000-000000000103', 'lead-treasurer', 'v1.0', 'From the leadership positions PDF (Treasurer).', '00000000-0000-4000-8000-000000000100', $rubric${"title": "Solar Evals", "catHead": "Category", "catSub": "Behavioral expectations", "scale": ["Unsatisfactory", "Below expectations", "Meets expectations", "Exceeds expectations", "Exceptional"], "noOption": true, "pages": [{"id": "universal", "name": "Universal Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Semester", "bind": "semester"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Rate performance against agreed role expectations; 3 = fully meets expectations.", "legend": "N/O = Not observed / not applicable", "capsNames": true, "criteria": [{"id": "communication", "tag": "", "name": "Communication", "sub": "Updates, coordination, feedback", "writeIn": false, "levels": ["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]}, {"id": "reliability-accountability", "tag": "", "name": "Reliability & Accountability", "sub": "Commitments and follow-through", "writeIn": false, "levels": ["Repeatedly leaves agreed responsibilities unfinished or unaddressed.", "Misses commitments and requires frequent reminders or escalation.", "Follows through or flags risks and renegotiates deadlines early.", "Delivers dependably and takes action before issues become delays.", "Builds lasting reliability in critical work beyond individual tasks."]}, {"id": "attendance-participation", "tag": "", "name": "Attendance & Participation", "sub": "Agreed sessions and engagement", "writeIn": false, "levels": ["Often misses agreed meetings or work without timely notice.", "Attendance or meaningful participation is inconsistent.", "Meets agreed participation expectations or communicates conflicts.", "Contributes consistently and makes shared work sessions productive.", "Creates conditions that help others participate effectively."]}, {"id": "role-competence-work-quality", "tag": "", "name": "Role Competence & Work Quality", "sub": "Judgment, execution, checking", "writeIn": false, "levels": ["Output often misses basic requirements or needs major correction.", "Applies role skills unevenly; frequent guidance or rework needed.", "Performs assigned work to standard and checks key requirements.", "Handles complex responsibilities independently with strong quality.", "Elevates standards or methods across the team through excellent work."]}, {"id": "initiative-ownership", "tag": "", "name": "Initiative & Ownership", "sub": "Self-direction and problem solving", "writeIn": false, "levels": ["Rarely advances responsibilities without repeated direction.", "Waits for prompting on routine decisions, next steps, or blockers.", "Advances owned work independently and escalates issues when needed.", "Identifies problems early and drives solutions beyond assigned tasks.", "Follows through on high-impact improvements with lasting results."]}, {"id": "learning-development", "tag": "", "name": "Learning & Development", "sub": "Feedback, curiosity, growth", "writeIn": false, "levels": ["Makes little effort to address known gaps or act on feedback.", "Improvement is inconsistent; similar issues persist after feedback.", "Accepts feedback and improves skills needed for the position.", "Actively builds new skills and applies lessons to current work.", "Demonstrates exceptional growth and shares useful lessons widely."]}], "boxes": [], "notesTitle": "Scoring principles", "notes": ["3 meets expectations. Justify 1/2/4/5 with examples. Score agreed work, not raw hours. Handle safety issues separately.", "CONSTITUTION: Article VIII, Section A(C); collective E-Board duties"], "footer": "Solar Gators  •  Treasurer"}, {"id": "role", "name": "Role-specific Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Review Date", "bind": "review_date"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Specific expectations are based on position duties in the constitution; agree on goals at semester start.", "legend": "", "capsNames": false, "criteria": [{"id": "team-stewardship", "tag": "", "name": "Team Stewardship", "sub": "Culture, shared E-Board duties", "writeIn": false, "levels": ["Neglects shared board duties or contributes to an unwelcoming climate.", "Participates unevenly in team culture and shared board obligations.", "Supports a welcoming culture and fulfills delegated board duties.", "Proactively improves team support, coordination, or shared operations.", "Establishes lasting improvements in team culture and board effectiveness."]}, {"id": "purchasing-forms", "tag": "", "name": "Purchasing & Forms", "sub": "Orders, approvals, tax documentation", "writeIn": false, "levels": ["Repeatedly fails to process authorized purchases or required forms.", "Orders are often delayed by errors or missing follow-up.", "Processes authorized purchases accurately using required forms.", "Anticipates lead times and resolves purchasing blockers early.", "Creates an exceptionally reliable, transparent procurement process."]}, {"id": "financial-records", "tag": "", "name": "Financial Records", "sub": "Receipts, expenses, donations", "writeIn": false, "levels": ["Records are materially incomplete or cannot be reconciled.", "Records contain recurring gaps or require extensive corrections.", "Keeps accurate, current records of income, spending, and donations.", "Proactively reconciles records and makes financial status easy to use.", "Establishes durable, auditable records with outstanding continuity."]}, {"id": "funds-budget-stewardship", "tag": "", "name": "Funds & Budget Stewardship", "sub": "Approved expenditures and funds", "writeIn": false, "levels": ["Makes or permits expenditures outside required authorizations.", "Tracks available funds inconsistently; needs frequent correction.", "Handles funds and expenditures in line with approved budgets.", "Flags funding constraints early and helps prioritize purchases.", "Creates exceptional financial controls and useful spending visibility."]}, {"id": "university-liaison-reporting", "tag": "", "name": "University Liaison & Reporting", "sub": "University processes and statements", "writeIn": false, "levels": ["Fails to coordinate required university financial actions.", "Financial statements or liaison responses are late or inaccurate.", "Coordinates university financial matters and reports when requested.", "Anticipates reporting needs and resolves administrative issues early.", "Builds a highly dependable finance workflow valued by stakeholders."]}], "boxes": [{"id": "evidence", "title": "Notable contributions / evidence", "lines": 4, "role": "evidence"}, {"id": "goals", "title": "Next-semester goals", "lines": 4, "role": ""}, {"id": "improvement", "title": "Areas for improvement", "lines": 2, "role": ""}, {"id": "comments", "title": "Member comments / context", "lines": 2, "role": "comments"}], "notesTitle": "", "notes": ["N/O: insufficient evidence or not assigned. Do not average ratings into a single score.", "CONSTITUTION: Article VIII, Section A(C); collective E-Board duties"], "footer": "Solar Gators  •  Treasurer"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-10T00:00:03Z'),
  ('00000000-0000-4000-8000-000000000104', 'lead-secretary', 'v1.0', 'From the leadership positions PDF (Secretary).', '00000000-0000-4000-8000-000000000100', $rubric${"title": "Solar Evals", "catHead": "Category", "catSub": "Behavioral expectations", "scale": ["Unsatisfactory", "Below expectations", "Meets expectations", "Exceeds expectations", "Exceptional"], "noOption": true, "pages": [{"id": "universal", "name": "Universal Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Semester", "bind": "semester"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Rate performance against agreed role expectations; 3 = fully meets expectations.", "legend": "N/O = Not observed / not applicable", "capsNames": true, "criteria": [{"id": "communication", "tag": "", "name": "Communication", "sub": "Updates, coordination, feedback", "writeIn": false, "levels": ["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]}, {"id": "reliability-accountability", "tag": "", "name": "Reliability & Accountability", "sub": "Commitments and follow-through", "writeIn": false, "levels": ["Repeatedly leaves agreed responsibilities unfinished or unaddressed.", "Misses commitments and requires frequent reminders or escalation.", "Follows through or flags risks and renegotiates deadlines early.", "Delivers dependably and takes action before issues become delays.", "Builds lasting reliability in critical work beyond individual tasks."]}, {"id": "attendance-participation", "tag": "", "name": "Attendance & Participation", "sub": "Agreed sessions and engagement", "writeIn": false, "levels": ["Often misses agreed meetings or work without timely notice.", "Attendance or meaningful participation is inconsistent.", "Meets agreed participation expectations or communicates conflicts.", "Contributes consistently and makes shared work sessions productive.", "Creates conditions that help others participate effectively."]}, {"id": "role-competence-work-quality", "tag": "", "name": "Role Competence & Work Quality", "sub": "Judgment, execution, checking", "writeIn": false, "levels": ["Output often misses basic requirements or needs major correction.", "Applies role skills unevenly; frequent guidance or rework needed.", "Performs assigned work to standard and checks key requirements.", "Handles complex responsibilities independently with strong quality.", "Elevates standards or methods across the team through excellent work."]}, {"id": "initiative-ownership", "tag": "", "name": "Initiative & Ownership", "sub": "Self-direction and problem solving", "writeIn": false, "levels": ["Rarely advances responsibilities without repeated direction.", "Waits for prompting on routine decisions, next steps, or blockers.", "Advances owned work independently and escalates issues when needed.", "Identifies problems early and drives solutions beyond assigned tasks.", "Follows through on high-impact improvements with lasting results."]}, {"id": "learning-development", "tag": "", "name": "Learning & Development", "sub": "Feedback, curiosity, growth", "writeIn": false, "levels": ["Makes little effort to address known gaps or act on feedback.", "Improvement is inconsistent; similar issues persist after feedback.", "Accepts feedback and improves skills needed for the position.", "Actively builds new skills and applies lessons to current work.", "Demonstrates exceptional growth and shares useful lessons widely."]}], "boxes": [], "notesTitle": "Scoring principles", "notes": ["3 meets expectations. Justify 1/2/4/5 with examples. Score agreed work, not raw hours. Handle safety issues separately.", "CONSTITUTION: Article VIII, Section A(D); collective E-Board duties"], "footer": "Solar Gators  •  Secretary"}, {"id": "role", "name": "Role-specific Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Review Date", "bind": "review_date"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Specific expectations are based on position duties in the constitution; agree on goals at semester start.", "legend": "", "capsNames": false, "criteria": [{"id": "team-stewardship", "tag": "", "name": "Team Stewardship", "sub": "Culture, shared E-Board duties", "writeIn": false, "levels": ["Neglects shared board duties or contributes to an unwelcoming climate.", "Participates unevenly in team culture and shared board obligations.", "Supports a welcoming culture and fulfills delegated board duties.", "Proactively improves team support, coordination, or shared operations.", "Establishes lasting improvements in team culture and board effectiveness."]}, {"id": "meeting-records", "tag": "", "name": "Meeting Records", "sub": "Minutes and decisions", "writeIn": false, "levels": ["Does not record important meetings or decisions.", "Minutes omit decisions or are often unavailable when needed.", "Records relevant meetings and makes usable notes available.", "Captures clear actions and maintains organized, searchable records.", "Builds a lasting meeting-record system that improves continuity."]}, {"id": "room-scheduling", "tag": "", "name": "Room Scheduling", "sub": "Semester work rooms and special rooms", "writeIn": false, "levels": ["Fails to arrange required rooms, disrupting team activities.", "Bookings are often late, incomplete, or poorly coordinated.", "Reserves appropriate rooms in time for planned activities.", "Anticipates space needs and handles changes with minimal disruption.", "Creates a dependable scheduling process for multiple team needs."]}, {"id": "meeting-announcements", "tag": "", "name": "Meeting Announcements", "sub": "Time, place, and changes", "writeIn": false, "levels": ["Frequently omits or misstates critical meeting details.", "Announcements are inconsistent or require repeated correction.", "Communicates meeting times, places, and changes promptly.", "Anticipates confusion and keeps calendar information consistent.", "Makes team scheduling exceptionally clear and easy to follow."]}, {"id": "stem-outreach-opportunities", "tag": "", "name": "Stem Outreach Opportunities", "sub": "Finding events and opportunities", "writeIn": false, "levels": ["Does not seek or communicate relevant outreach opportunities.", "Occasionally finds events but rarely follows up.", "Identifies suitable STEM outreach opportunities for the team.", "Proactively develops a useful pipeline of outreach possibilities.", "Establishes strong recurring outreach opportunities for future teams."]}], "boxes": [{"id": "evidence", "title": "Notable contributions / evidence", "lines": 4, "role": "evidence"}, {"id": "goals", "title": "Next-semester goals", "lines": 4, "role": ""}, {"id": "improvement", "title": "Areas for improvement", "lines": 2, "role": ""}, {"id": "comments", "title": "Member comments / context", "lines": 2, "role": "comments"}], "notesTitle": "", "notes": ["N/O: insufficient evidence or not assigned. Do not average ratings into a single score.", "CONSTITUTION: Article VIII, Section A(D); collective E-Board duties"], "footer": "Solar Gators  •  Secretary"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-10T00:00:04Z'),
  ('00000000-0000-4000-8000-000000000105', 'lead-business', 'v1.0', 'From the leadership positions PDF (Business Coordinator).', '00000000-0000-4000-8000-000000000100', $rubric${"title": "Solar Evals", "catHead": "Category", "catSub": "Behavioral expectations", "scale": ["Unsatisfactory", "Below expectations", "Meets expectations", "Exceeds expectations", "Exceptional"], "noOption": true, "pages": [{"id": "universal", "name": "Universal Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Semester", "bind": "semester"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Rate performance against agreed role expectations; 3 = fully meets expectations.", "legend": "N/O = Not observed / not applicable", "capsNames": true, "criteria": [{"id": "communication", "tag": "", "name": "Communication", "sub": "Updates, coordination, feedback", "writeIn": false, "levels": ["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]}, {"id": "reliability-accountability", "tag": "", "name": "Reliability & Accountability", "sub": "Commitments and follow-through", "writeIn": false, "levels": ["Repeatedly leaves agreed responsibilities unfinished or unaddressed.", "Misses commitments and requires frequent reminders or escalation.", "Follows through or flags risks and renegotiates deadlines early.", "Delivers dependably and takes action before issues become delays.", "Builds lasting reliability in critical work beyond individual tasks."]}, {"id": "attendance-participation", "tag": "", "name": "Attendance & Participation", "sub": "Agreed sessions and engagement", "writeIn": false, "levels": ["Often misses agreed meetings or work without timely notice.", "Attendance or meaningful participation is inconsistent.", "Meets agreed participation expectations or communicates conflicts.", "Contributes consistently and makes shared work sessions productive.", "Creates conditions that help others participate effectively."]}, {"id": "role-competence-work-quality", "tag": "", "name": "Role Competence & Work Quality", "sub": "Judgment, execution, checking", "writeIn": false, "levels": ["Output often misses basic requirements or needs major correction.", "Applies role skills unevenly; frequent guidance or rework needed.", "Performs assigned work to standard and checks key requirements.", "Handles complex responsibilities independently with strong quality.", "Elevates standards or methods across the team through excellent work."]}, {"id": "initiative-ownership", "tag": "", "name": "Initiative & Ownership", "sub": "Self-direction and problem solving", "writeIn": false, "levels": ["Rarely advances responsibilities without repeated direction.", "Waits for prompting on routine decisions, next steps, or blockers.", "Advances owned work independently and escalates issues when needed.", "Identifies problems early and drives solutions beyond assigned tasks.", "Follows through on high-impact improvements with lasting results."]}, {"id": "learning-development", "tag": "", "name": "Learning & Development", "sub": "Feedback, curiosity, growth", "writeIn": false, "levels": ["Makes little effort to address known gaps or act on feedback.", "Improvement is inconsistent; similar issues persist after feedback.", "Accepts feedback and improves skills needed for the position.", "Actively builds new skills and applies lessons to current work.", "Demonstrates exceptional growth and shares useful lessons widely."]}], "boxes": [], "notesTitle": "Scoring principles", "notes": ["3 meets expectations. Justify 1/2/4/5 with examples. Score agreed work, not raw hours. Handle safety issues separately.", "CONSTITUTION: Article VIII, Section A(E); collective E-Board duties"], "footer": "Solar Gators  •  Business Coordinator"}, {"id": "role", "name": "Role-specific Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Review Date", "bind": "review_date"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Specific expectations are based on position duties in the constitution; agree on goals at semester start.", "legend": "", "capsNames": false, "criteria": [{"id": "team-stewardship", "tag": "", "name": "Team Stewardship", "sub": "Culture, shared E-Board duties", "writeIn": false, "levels": ["Neglects shared board duties or contributes to an unwelcoming climate.", "Participates unevenly in team culture and shared board obligations.", "Supports a welcoming culture and fulfills delegated board duties.", "Proactively improves team support, coordination, or shared operations.", "Establishes lasting improvements in team culture and board effectiveness."]}, {"id": "sponsorship-grants", "tag": "", "name": "Sponsorship & Grants", "sub": "Sponsor outreach and grant applications", "writeIn": false, "levels": ["Neglects agreed sponsor contacts and funding applications.", "Outreach is sporadic or follow-up is often missed.", "Coordinates sponsor outreach and applicable grant submissions.", "Maintains an active pipeline and follows up on promising contacts.", "Builds a repeatable sponsor/grant process with strong lasting results."]}, {"id": "fundraising-alumni", "tag": "", "name": "Fundraising & Alumni", "sub": "Donations, alumni, team events", "writeIn": false, "levels": ["Fails to organize assigned fundraising or alumni efforts.", "Fundraising activities lack follow-through or coordination.", "Coordinates alumni donation outreach and fundraising events.", "Anticipates event needs and improves donor engagement.", "Builds enduring alumni/fundraising programs with exceptional impact."]}, {"id": "marketing-branding", "tag": "", "name": "Marketing & Branding", "sub": "Social media, website, newsletter", "writeIn": false, "levels": ["Key communications are neglected or misleading.", "Content is inconsistent or repeatedly needs correction.", "Oversees accurate social media, website, and sponsor updates.", "Maintains a cohesive brand and a reliable content schedule.", "Establishes high-quality, sustainable team communications."]}, {"id": "business-team-management", "tag": "", "name": "Business Team Management", "sub": "Marketing and finance coordination", "writeIn": false, "levels": ["Leaves team members without direction or follow-up.", "Assignments and priorities are often unclear or missed.", "Coordinates marketing and finance work with clear responsibilities.", "Develops contributors and prevents handoff or ownership gaps.", "Builds a strong, self-sustaining business team and processes."]}], "boxes": [{"id": "evidence", "title": "Notable contributions / evidence", "lines": 4, "role": "evidence"}, {"id": "goals", "title": "Next-semester goals", "lines": 4, "role": ""}, {"id": "improvement", "title": "Areas for improvement", "lines": 2, "role": ""}, {"id": "comments", "title": "Member comments / context", "lines": 2, "role": "comments"}], "notesTitle": "", "notes": ["N/O: insufficient evidence or not assigned. Do not average ratings into a single score.", "CONSTITUTION: Article VIII, Section A(E); collective E-Board duties"], "footer": "Solar Gators  •  Business Coordinator"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-10T00:00:05Z'),
  ('00000000-0000-4000-8000-000000000106', 'lead-mech-ce', 'v1.0', 'From the leadership positions PDF (Mechanical Chief Engineer).', '00000000-0000-4000-8000-000000000100', $rubric${"title": "Solar Evals", "catHead": "Category", "catSub": "Behavioral expectations", "scale": ["Unsatisfactory", "Below expectations", "Meets expectations", "Exceeds expectations", "Exceptional"], "noOption": true, "pages": [{"id": "universal", "name": "Universal Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Semester", "bind": "semester"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Rate performance against agreed role expectations; 3 = fully meets expectations.", "legend": "N/O = Not observed / not applicable", "capsNames": true, "criteria": [{"id": "communication", "tag": "", "name": "Communication", "sub": "Updates, coordination, feedback", "writeIn": false, "levels": ["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]}, {"id": "reliability-accountability", "tag": "", "name": "Reliability & Accountability", "sub": "Commitments and follow-through", "writeIn": false, "levels": ["Repeatedly leaves agreed responsibilities unfinished or unaddressed.", "Misses commitments and requires frequent reminders or escalation.", "Follows through or flags risks and renegotiates deadlines early.", "Delivers dependably and takes action before issues become delays.", "Builds lasting reliability in critical work beyond individual tasks."]}, {"id": "attendance-participation", "tag": "", "name": "Attendance & Participation", "sub": "Agreed sessions and engagement", "writeIn": false, "levels": ["Often misses agreed meetings or work without timely notice.", "Attendance or meaningful participation is inconsistent.", "Meets agreed participation expectations or communicates conflicts.", "Contributes consistently and makes shared work sessions productive.", "Creates conditions that help others participate effectively."]}, {"id": "technical-ability-work-quality", "tag": "", "name": "Technical Ability & Work Quality", "sub": "Engineering judgment, verification", "writeIn": false, "levels": ["Technical work often misses basic requirements or needs major rework.", "Uses engineering fundamentals unevenly; needs frequent correction.", "Applies role-appropriate skills and checks work against requirements.", "Solves challenging problems independently with consistently strong work.", "Applies exceptional judgment and raises team-wide technical quality."]}, {"id": "initiative-ownership", "tag": "", "name": "Initiative & Ownership", "sub": "Self-direction and problem solving", "writeIn": false, "levels": ["Rarely advances responsibilities without repeated direction.", "Waits for prompting on routine decisions, next steps, or blockers.", "Advances owned work independently and escalates issues when needed.", "Identifies problems early and drives solutions beyond assigned tasks.", "Follows through on high-impact improvements with lasting results."]}, {"id": "learning-development", "tag": "", "name": "Learning & Development", "sub": "Feedback, curiosity, growth", "writeIn": false, "levels": ["Makes little effort to address known gaps or act on feedback.", "Improvement is inconsistent; similar issues persist after feedback.", "Accepts feedback and improves skills needed for the position.", "Actively builds new skills and applies lessons to current work.", "Demonstrates exceptional growth and shares useful lessons widely."]}], "boxes": [], "notesTitle": "Scoring principles", "notes": ["3 meets expectations. Justify 1/2/4/5 with examples. Score agreed work, not raw hours. Handle safety issues separately.", "CONSTITUTION: Article VIII, Section A(F)(a); shared CE duties"], "footer": "Solar Gators  •  Mechanical Chief Engineer"}, {"id": "role", "name": "Role-specific Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Review Date", "bind": "review_date"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Specific expectations are based on position duties in the constitution; agree on goals at semester start.", "legend": "", "capsNames": false, "criteria": [{"id": "team-stewardship", "tag": "", "name": "Team Stewardship", "sub": "Culture, shared E-Board duties", "writeIn": false, "levels": ["Neglects shared board duties or contributes to an unwelcoming climate.", "Participates unevenly in team culture and shared board obligations.", "Supports a welcoming culture and fulfills delegated board duties.", "Proactively improves team support, coordination, or shared operations.", "Establishes lasting improvements in team culture and board effectiveness."]}, {"id": "mechanical-technical-oversight", "tag": "", "name": "Mechanical Technical Oversight", "sub": "Safety, design requirements, technical decisions", "writeIn": false, "levels": ["Major mechanical requirements or design risks go unaddressed.", "Technical oversight is reactive and issues require outside rescue.", "Reviews assigned mechanical systems against design requirements.", "Identifies high-risk interfaces and leads timely technical decisions.", "Establishes exceptional technical rigor across assigned systems."]}, {"id": "schedules-vehicle-integration", "tag": "", "name": "Schedules & Vehicle Integration", "sub": "Subsystem milestones and dependencies", "writeIn": false, "levels": ["Does not coordinate system plans or integration dependencies.", "Tracks timelines unevenly; cross-system conflicts emerge late.", "Maintains approved plans and coordinates system integration.", "Anticipates clashes between mechanical systems and recovers risks.", "Builds an integration process that substantially improves delivery."]}, {"id": "lead-management", "tag": "", "name": "Lead Management", "sub": "Subsystem leads, work, resources", "writeIn": false, "levels": ["Leaves major lead or subsystem performance problems unaddressed.", "Provides inconsistent direction or delayed support to leads.", "Sets expectations, monitors leads, and manages subsystem needs.", "Coaches leads and resolves resourcing or execution issues early.", "Develops highly capable leads and lasting operating practices."]}, {"id": "verification-design-reports", "tag": "", "name": "Verification & Design Reports", "sub": "Evidence, reviews, ASC documentation", "writeIn": false, "levels": ["Fails to ensure critical checks or design reports are completed.", "Review is late or misses recurring technical/documentation gaps.", "Reviews subsystem VDRs and ensures appropriate verification.", "Improves review quality and identifies missing evidence early.", "Establishes exceptional validation and documentation discipline."]}], "boxes": [{"id": "evidence", "title": "Notable contributions / evidence", "lines": 4, "role": "evidence"}, {"id": "goals", "title": "Next-semester goals", "lines": 4, "role": ""}, {"id": "improvement", "title": "Areas for improvement", "lines": 2, "role": ""}, {"id": "comments", "title": "Member comments / context", "lines": 2, "role": "comments"}], "notesTitle": "", "notes": ["N/O: insufficient evidence or not assigned. Do not average ratings into a single score.", "CONSTITUTION: Article VIII, Section A(F)(a); shared CE duties"], "footer": "Solar Gators  •  Mechanical Chief Engineer"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-10T00:00:06Z'),
  ('00000000-0000-4000-8000-000000000107', 'lead-elec-ce', 'v1.0', 'From the leadership positions PDF (Electrical Chief Engineer).', '00000000-0000-4000-8000-000000000100', $rubric${"title": "Solar Evals", "catHead": "Category", "catSub": "Behavioral expectations", "scale": ["Unsatisfactory", "Below expectations", "Meets expectations", "Exceeds expectations", "Exceptional"], "noOption": true, "pages": [{"id": "universal", "name": "Universal Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Semester", "bind": "semester"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Rate performance against agreed role expectations; 3 = fully meets expectations.", "legend": "N/O = Not observed / not applicable", "capsNames": true, "criteria": [{"id": "communication", "tag": "", "name": "Communication", "sub": "Updates, coordination, feedback", "writeIn": false, "levels": ["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]}, {"id": "reliability-accountability", "tag": "", "name": "Reliability & Accountability", "sub": "Commitments and follow-through", "writeIn": false, "levels": ["Repeatedly leaves agreed responsibilities unfinished or unaddressed.", "Misses commitments and requires frequent reminders or escalation.", "Follows through or flags risks and renegotiates deadlines early.", "Delivers dependably and takes action before issues become delays.", "Builds lasting reliability in critical work beyond individual tasks."]}, {"id": "attendance-participation", "tag": "", "name": "Attendance & Participation", "sub": "Agreed sessions and engagement", "writeIn": false, "levels": ["Often misses agreed meetings or work without timely notice.", "Attendance or meaningful participation is inconsistent.", "Meets agreed participation expectations or communicates conflicts.", "Contributes consistently and makes shared work sessions productive.", "Creates conditions that help others participate effectively."]}, {"id": "technical-ability-work-quality", "tag": "", "name": "Technical Ability & Work Quality", "sub": "Engineering judgment, verification", "writeIn": false, "levels": ["Technical work often misses basic requirements or needs major rework.", "Uses engineering fundamentals unevenly; needs frequent correction.", "Applies role-appropriate skills and checks work against requirements.", "Solves challenging problems independently with consistently strong work.", "Applies exceptional judgment and raises team-wide technical quality."]}, {"id": "initiative-ownership", "tag": "", "name": "Initiative & Ownership", "sub": "Self-direction and problem solving", "writeIn": false, "levels": ["Rarely advances responsibilities without repeated direction.", "Waits for prompting on routine decisions, next steps, or blockers.", "Advances owned work independently and escalates issues when needed.", "Identifies problems early and drives solutions beyond assigned tasks.", "Follows through on high-impact improvements with lasting results."]}, {"id": "learning-development", "tag": "", "name": "Learning & Development", "sub": "Feedback, curiosity, growth", "writeIn": false, "levels": ["Makes little effort to address known gaps or act on feedback.", "Improvement is inconsistent; similar issues persist after feedback.", "Accepts feedback and improves skills needed for the position.", "Actively builds new skills and applies lessons to current work.", "Demonstrates exceptional growth and shares useful lessons widely."]}], "boxes": [], "notesTitle": "Scoring principles", "notes": ["3 meets expectations. Justify 1/2/4/5 with examples. Score agreed work, not raw hours. Handle safety issues separately.", "CONSTITUTION: Article VIII, Section A(F)(b); shared CE duties"], "footer": "Solar Gators  •  Electrical Chief Engineer"}, {"id": "role", "name": "Role-specific Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Review Date", "bind": "review_date"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Specific expectations are based on position duties in the constitution; agree on goals at semester start.", "legend": "", "capsNames": false, "criteria": [{"id": "team-stewardship", "tag": "", "name": "Team Stewardship", "sub": "Culture, shared E-Board duties", "writeIn": false, "levels": ["Neglects shared board duties or contributes to an unwelcoming climate.", "Participates unevenly in team culture and shared board obligations.", "Supports a welcoming culture and fulfills delegated board duties.", "Proactively improves team support, coordination, or shared operations.", "Establishes lasting improvements in team culture and board effectiveness."]}, {"id": "electrical-technical-oversight", "tag": "", "name": "Electrical Technical Oversight", "sub": "Design, interfaces, electrical safety", "writeIn": false, "levels": ["Major electrical requirements or safety risks go unaddressed.", "Design oversight is uneven; critical issues are found late.", "Reviews assigned electrical systems against design requirements.", "Anticipates interface, protection, and verification risks early.", "Raises electrical design and validation standards across systems."]}, {"id": "schedules-vehicle-integration", "tag": "", "name": "Schedules & Vehicle Integration", "sub": "Electrical milestones and interfaces", "writeIn": false, "levels": ["Does not coordinate subsystem plans or vehicle interfaces.", "Tracks timelines unevenly; integration issues emerge too late.", "Maintains approved plans and coordinates electrical integration.", "Anticipates hardware/software dependencies and reduces delays.", "Establishes exceptional integration planning across the division."]}, {"id": "lead-management", "tag": "", "name": "Lead Management", "sub": "Subsystem leads, work, resources", "writeIn": false, "levels": ["Leaves major lead or subsystem performance problems unaddressed.", "Provides inconsistent direction or delayed support to leads.", "Sets expectations, monitors leads, and manages subsystem needs.", "Coaches leads and resolves resourcing or execution issues early.", "Develops highly capable leads and lasting operating practices."]}, {"id": "verification-design-reports", "tag": "", "name": "Verification & Design Reports", "sub": "Testing, evidence, ASC documentation", "writeIn": false, "levels": ["Fails to ensure required electrical checks or VDRs are completed.", "Reviews are late or overlook critical testing/documentation gaps.", "Reviews subsystem VDRs and ensures appropriate verification.", "Improves test evidence and catches issues before integration.", "Establishes exceptional electrical testing and review practices."]}], "boxes": [{"id": "evidence", "title": "Notable contributions / evidence", "lines": 4, "role": "evidence"}, {"id": "goals", "title": "Next-semester goals", "lines": 4, "role": ""}, {"id": "improvement", "title": "Areas for improvement", "lines": 2, "role": ""}, {"id": "comments", "title": "Member comments / context", "lines": 2, "role": "comments"}], "notesTitle": "", "notes": ["N/O: insufficient evidence or not assigned. Do not average ratings into a single score.", "CONSTITUTION: Article VIII, Section A(F)(b); shared CE duties"], "footer": "Solar Gators  •  Electrical Chief Engineer"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-10T00:00:07Z'),
  ('00000000-0000-4000-8000-000000000108', 'lead-mech-pm', 'v1.0', 'From the leadership positions PDF (Mechanical Integration Project Manager).', '00000000-0000-4000-8000-000000000100', $rubric${"title": "Solar Evals", "catHead": "Category", "catSub": "Behavioral expectations", "scale": ["Unsatisfactory", "Below expectations", "Meets expectations", "Exceeds expectations", "Exceptional"], "noOption": true, "pages": [{"id": "universal", "name": "Universal Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Semester", "bind": "semester"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Rate performance against agreed role expectations; 3 = fully meets expectations.", "legend": "N/O = Not observed / not applicable", "capsNames": true, "criteria": [{"id": "communication", "tag": "", "name": "Communication", "sub": "Updates, coordination, feedback", "writeIn": false, "levels": ["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]}, {"id": "reliability-accountability", "tag": "", "name": "Reliability & Accountability", "sub": "Commitments and follow-through", "writeIn": false, "levels": ["Repeatedly leaves agreed responsibilities unfinished or unaddressed.", "Misses commitments and requires frequent reminders or escalation.", "Follows through or flags risks and renegotiates deadlines early.", "Delivers dependably and takes action before issues become delays.", "Builds lasting reliability in critical work beyond individual tasks."]}, {"id": "attendance-participation", "tag": "", "name": "Attendance & Participation", "sub": "Agreed sessions and engagement", "writeIn": false, "levels": ["Often misses agreed meetings or work without timely notice.", "Attendance or meaningful participation is inconsistent.", "Meets agreed participation expectations or communicates conflicts.", "Contributes consistently and makes shared work sessions productive.", "Creates conditions that help others participate effectively."]}, {"id": "role-competence-work-quality", "tag": "", "name": "Role Competence & Work Quality", "sub": "Judgment, execution, checking", "writeIn": false, "levels": ["Output often misses basic requirements or needs major correction.", "Applies role skills unevenly; frequent guidance or rework needed.", "Performs assigned work to standard and checks key requirements.", "Handles complex responsibilities independently with strong quality.", "Elevates standards or methods across the team through excellent work."]}, {"id": "initiative-ownership", "tag": "", "name": "Initiative & Ownership", "sub": "Self-direction and problem solving", "writeIn": false, "levels": ["Rarely advances responsibilities without repeated direction.", "Waits for prompting on routine decisions, next steps, or blockers.", "Advances owned work independently and escalates issues when needed.", "Identifies problems early and drives solutions beyond assigned tasks.", "Follows through on high-impact improvements with lasting results."]}, {"id": "learning-development", "tag": "", "name": "Learning & Development", "sub": "Feedback, curiosity, growth", "writeIn": false, "levels": ["Makes little effort to address known gaps or act on feedback.", "Improvement is inconsistent; similar issues persist after feedback.", "Accepts feedback and improves skills needed for the position.", "Actively builds new skills and applies lessons to current work.", "Demonstrates exceptional growth and shares useful lessons widely."]}], "boxes": [], "notesTitle": "Scoring principles", "notes": ["3 meets expectations. Justify 1/2/4/5 with examples. Score agreed work, not raw hours. Handle safety issues separately.", "CONSTITUTION: Article VIII, Section A(F)(c); collective E-Board duties"], "footer": "Solar Gators  •  Mechanical Integration Project Manager"}, {"id": "role", "name": "Role-specific Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Review Date", "bind": "review_date"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Specific expectations are based on position duties in the constitution; agree on goals at semester start.", "legend": "", "capsNames": false, "criteria": [{"id": "team-stewardship", "tag": "", "name": "Team Stewardship", "sub": "Culture, shared E-Board duties", "writeIn": false, "levels": ["Neglects shared board duties or contributes to an unwelcoming climate.", "Participates unevenly in team culture and shared board obligations.", "Supports a welcoming culture and fulfills delegated board duties.", "Proactively improves team support, coordination, or shared operations.", "Establishes lasting improvements in team culture and board effectiveness."]}, {"id": "mechanical-recruitment", "tag": "", "name": "Mechanical Recruitment", "sub": "Reaching prospective mechanical members", "writeIn": false, "levels": ["Does not carry out agreed recruitment activities.", "Outreach is inconsistent or leaves prospective members uninformed.", "Coordinates recruitment for the mechanical team.", "Proactively reaches appropriate students and improves follow-up.", "Builds a reliable recruitment process with lasting participation."]}, {"id": "technical-onboarding", "tag": "", "name": "Technical Onboarding", "sub": "Introductory mechanical training", "writeIn": false, "levels": ["New members receive no workable introduction or training.", "Training is ad hoc; major skill or safety gaps persist.", "Coordinates basic training suitable for new mechanical members.", "Improves training materials and checks new-member readiness.", "Establishes a sustainable, highly effective training pipeline."]}, {"id": "subsystem-placement", "tag": "", "name": "Subsystem Placement", "sub": "Transition into mechanical subteams", "writeIn": false, "levels": ["Recruits remain unassigned without meaningful work.", "Placement and introductions require repeated reminders.", "Connects new members with leads and relevant subsystem work.", "Checks early engagement and fixes stalled placements promptly.", "Establishes a lasting placement process that retains contributors."]}, {"id": "pipeline-coordination", "tag": "", "name": "Pipeline Coordination", "sub": "Lead communication and progress tracking", "writeIn": false, "levels": ["Does not communicate recruitment or onboarding status to leads.", "Handoffs and progress information are often incomplete.", "Coordinates with mechanical leads and tracks onboarding progress.", "Anticipates training capacity and placement bottlenecks.", "Creates clear cross-subsystem handoffs with exceptional continuity."]}], "boxes": [{"id": "evidence", "title": "Notable contributions / evidence", "lines": 4, "role": "evidence"}, {"id": "goals", "title": "Next-semester goals", "lines": 4, "role": ""}, {"id": "improvement", "title": "Areas for improvement", "lines": 2, "role": ""}, {"id": "comments", "title": "Member comments / context", "lines": 2, "role": "comments"}], "notesTitle": "", "notes": ["N/O: insufficient evidence or not assigned. Do not average ratings into a single score.", "CONSTITUTION: Article VIII, Section A(F)(c); collective E-Board duties"], "footer": "Solar Gators  •  Mechanical Integration Project Manager"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-10T00:00:08Z'),
  ('00000000-0000-4000-8000-000000000109', 'lead-elec-pm', 'v1.0', 'From the leadership positions PDF (Electrical Integration Project Manager).', '00000000-0000-4000-8000-000000000100', $rubric${"title": "Solar Evals", "catHead": "Category", "catSub": "Behavioral expectations", "scale": ["Unsatisfactory", "Below expectations", "Meets expectations", "Exceeds expectations", "Exceptional"], "noOption": true, "pages": [{"id": "universal", "name": "Universal Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Semester", "bind": "semester"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Rate performance against agreed role expectations; 3 = fully meets expectations.", "legend": "N/O = Not observed / not applicable", "capsNames": true, "criteria": [{"id": "communication", "tag": "", "name": "Communication", "sub": "Updates, coordination, feedback", "writeIn": false, "levels": ["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]}, {"id": "reliability-accountability", "tag": "", "name": "Reliability & Accountability", "sub": "Commitments and follow-through", "writeIn": false, "levels": ["Repeatedly leaves agreed responsibilities unfinished or unaddressed.", "Misses commitments and requires frequent reminders or escalation.", "Follows through or flags risks and renegotiates deadlines early.", "Delivers dependably and takes action before issues become delays.", "Builds lasting reliability in critical work beyond individual tasks."]}, {"id": "attendance-participation", "tag": "", "name": "Attendance & Participation", "sub": "Agreed sessions and engagement", "writeIn": false, "levels": ["Often misses agreed meetings or work without timely notice.", "Attendance or meaningful participation is inconsistent.", "Meets agreed participation expectations or communicates conflicts.", "Contributes consistently and makes shared work sessions productive.", "Creates conditions that help others participate effectively."]}, {"id": "role-competence-work-quality", "tag": "", "name": "Role Competence & Work Quality", "sub": "Judgment, execution, checking", "writeIn": false, "levels": ["Output often misses basic requirements or needs major correction.", "Applies role skills unevenly; frequent guidance or rework needed.", "Performs assigned work to standard and checks key requirements.", "Handles complex responsibilities independently with strong quality.", "Elevates standards or methods across the team through excellent work."]}, {"id": "initiative-ownership", "tag": "", "name": "Initiative & Ownership", "sub": "Self-direction and problem solving", "writeIn": false, "levels": ["Rarely advances responsibilities without repeated direction.", "Waits for prompting on routine decisions, next steps, or blockers.", "Advances owned work independently and escalates issues when needed.", "Identifies problems early and drives solutions beyond assigned tasks.", "Follows through on high-impact improvements with lasting results."]}, {"id": "learning-development", "tag": "", "name": "Learning & Development", "sub": "Feedback, curiosity, growth", "writeIn": false, "levels": ["Makes little effort to address known gaps or act on feedback.", "Improvement is inconsistent; similar issues persist after feedback.", "Accepts feedback and improves skills needed for the position.", "Actively builds new skills and applies lessons to current work.", "Demonstrates exceptional growth and shares useful lessons widely."]}], "boxes": [], "notesTitle": "Scoring principles", "notes": ["3 meets expectations. Justify 1/2/4/5 with examples. Score agreed work, not raw hours. Handle safety issues separately.", "CONSTITUTION: Article VIII, Section A(F)(d); collective E-Board duties"], "footer": "Solar Gators  •  Electrical Integration Project Manager"}, {"id": "role", "name": "Role-specific Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Review Date", "bind": "review_date"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Specific expectations are based on position duties in the constitution; agree on goals at semester start.", "legend": "", "capsNames": false, "criteria": [{"id": "team-stewardship", "tag": "", "name": "Team Stewardship", "sub": "Culture, shared E-Board duties", "writeIn": false, "levels": ["Neglects shared board duties or contributes to an unwelcoming climate.", "Participates unevenly in team culture and shared board obligations.", "Supports a welcoming culture and fulfills delegated board duties.", "Proactively improves team support, coordination, or shared operations.", "Establishes lasting improvements in team culture and board effectiveness."]}, {"id": "electrical-recruitment", "tag": "", "name": "Electrical Recruitment", "sub": "Reaching prospective electrical members", "writeIn": false, "levels": ["Does not carry out agreed recruitment activities.", "Outreach is inconsistent or leaves prospective members uninformed.", "Coordinates recruitment for the electrical team.", "Proactively reaches appropriate students and improves follow-up.", "Builds a reliable recruitment process with lasting participation."]}, {"id": "technical-onboarding", "tag": "", "name": "Technical Onboarding", "sub": "Introductory electrical training", "writeIn": false, "levels": ["New members receive no workable introduction or training.", "Training is ad hoc; major skills or safe-work gaps persist.", "Coordinates basic training suitable for new electrical members.", "Improves training materials and checks new-member readiness.", "Establishes a sustainable, highly effective training pipeline."]}, {"id": "subsystem-placement", "tag": "", "name": "Subsystem Placement", "sub": "Transition into electrical subteams", "writeIn": false, "levels": ["Recruits remain unassigned without meaningful work.", "Placement and introductions require repeated reminders.", "Connects new members with leads and relevant subsystem work.", "Checks early engagement and fixes stalled placements promptly.", "Establishes a lasting placement process that retains contributors."]}, {"id": "pipeline-coordination", "tag": "", "name": "Pipeline Coordination", "sub": "Lead communication and progress tracking", "writeIn": false, "levels": ["Does not communicate recruitment or onboarding status to leads.", "Handoffs and progress information are often incomplete.", "Coordinates with electrical leads and tracks onboarding progress.", "Anticipates training capacity and placement bottlenecks.", "Creates clear cross-subsystem handoffs with exceptional continuity."]}], "boxes": [{"id": "evidence", "title": "Notable contributions / evidence", "lines": 4, "role": "evidence"}, {"id": "goals", "title": "Next-semester goals", "lines": 4, "role": ""}, {"id": "improvement", "title": "Areas for improvement", "lines": 2, "role": ""}, {"id": "comments", "title": "Member comments / context", "lines": 2, "role": "comments"}], "notesTitle": "", "notes": ["N/O: insufficient evidence or not assigned. Do not average ratings into a single score.", "CONSTITUTION: Article VIII, Section A(F)(d); collective E-Board duties"], "footer": "Solar Gators  •  Electrical Integration Project Manager"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-10T00:00:09Z'),
  ('00000000-0000-4000-8000-000000000110', 'lead-subsystem-lead', 'v1.0', 'From the leadership positions PDF (Subsystem Lead).', '00000000-0000-4000-8000-000000000100', $rubric${"title": "Solar Evals", "catHead": "Category", "catSub": "Behavioral expectations", "scale": ["Unsatisfactory", "Below expectations", "Meets expectations", "Exceeds expectations", "Exceptional"], "noOption": true, "pages": [{"id": "universal", "name": "Universal Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Semester", "bind": "semester"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Rate performance against agreed role expectations; 3 = fully meets expectations.", "legend": "N/O = Not observed / not applicable", "capsNames": true, "criteria": [{"id": "communication", "tag": "", "name": "Communication", "sub": "Updates, coordination, feedback", "writeIn": false, "levels": ["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]}, {"id": "reliability-accountability", "tag": "", "name": "Reliability & Accountability", "sub": "Commitments and follow-through", "writeIn": false, "levels": ["Repeatedly leaves agreed responsibilities unfinished or unaddressed.", "Misses commitments and requires frequent reminders or escalation.", "Follows through or flags risks and renegotiates deadlines early.", "Delivers dependably and takes action before issues become delays.", "Builds lasting reliability in critical work beyond individual tasks."]}, {"id": "attendance-participation", "tag": "", "name": "Attendance & Participation", "sub": "Agreed sessions and engagement", "writeIn": false, "levels": ["Often misses agreed meetings or work without timely notice.", "Attendance or meaningful participation is inconsistent.", "Meets agreed participation expectations or communicates conflicts.", "Contributes consistently and makes shared work sessions productive.", "Creates conditions that help others participate effectively."]}, {"id": "technical-ability-work-quality", "tag": "", "name": "Technical Ability & Work Quality", "sub": "Engineering judgment, verification", "writeIn": false, "levels": ["Technical work often misses basic requirements or needs major rework.", "Uses engineering fundamentals unevenly; needs frequent correction.", "Applies role-appropriate skills and checks work against requirements.", "Solves challenging problems independently with consistently strong work.", "Applies exceptional judgment and raises team-wide technical quality."]}, {"id": "initiative-ownership", "tag": "", "name": "Initiative & Ownership", "sub": "Self-direction and problem solving", "writeIn": false, "levels": ["Rarely advances responsibilities without repeated direction.", "Waits for prompting on routine decisions, next steps, or blockers.", "Advances owned work independently and escalates issues when needed.", "Identifies problems early and drives solutions beyond assigned tasks.", "Follows through on high-impact improvements with lasting results."]}, {"id": "learning-development", "tag": "", "name": "Learning & Development", "sub": "Feedback, curiosity, growth", "writeIn": false, "levels": ["Makes little effort to address known gaps or act on feedback.", "Improvement is inconsistent; similar issues persist after feedback.", "Accepts feedback and improves skills needed for the position.", "Actively builds new skills and applies lessons to current work.", "Demonstrates exceptional growth and shares useful lessons widely."]}], "boxes": [], "notesTitle": "Scoring principles", "notes": ["3 meets expectations. Justify 1/2/4/5 with examples. Score agreed work, not raw hours. Handle safety issues separately.", "CONSTITUTION: Article VIII, Section C (appointed officers)"], "footer": "Solar Gators  •  Subsystem Lead"}, {"id": "role", "name": "Role-specific Rubric", "subtitle": "Solar Gators  /  Semester leadership review", "fields": [{"label": "Position", "bind": "division"}, {"label": "Member", "bind": "member_name"}, {"label": "Review Date", "bind": "review_date"}, {"label": "Evaluator(s)", "bind": "evaluator"}], "instruction": "Specific expectations are based on position duties in the constitution; agree on goals at semester start.", "legend": "", "capsNames": false, "criteria": [{"id": "technical-leadership-safety", "tag": "", "name": "Technical Leadership & Safety", "sub": "Design, quality, compliance", "writeIn": false, "levels": ["Leaves major design, reliability, or compliance issues unresolved.", "Technical decisions need repeated intervention or correction.", "Directs subsystem work to meet design and safety requirements.", "Anticipates technical risks and improves designs before integration.", "Establishes outstanding engineering quality and risk management."]}, {"id": "planning-weekly-execution", "tag": "", "name": "Planning & Weekly Execution", "sub": "Timeline, agendas, milestones", "writeIn": false, "levels": ["Does not establish usable plans or weekly assignments.", "Plans slip frequently without timely communication or recovery.", "Maintains a CE-aligned timeline and organizes weekly work.", "Anticipates blockers and reallocates work to protect milestones.", "Creates an exceptionally effective system for subsystem execution."]}, {"id": "member-management", "tag": "", "name": "Member Management", "sub": "Tasks, onboarding, development", "writeIn": false, "levels": ["Leaves members without useful work, direction, or basic support.", "Assignments are unclear or follow-up and onboarding are sporadic.", "Gives members meaningful weekly work and integrates newcomers.", "Develops members and matches assignments to growth and priorities.", "Builds a capable, self-directed group with strong knowledge sharing."]}, {"id": "integration-documentation", "tag": "", "name": "Integration & Documentation", "sub": "Car integration, VDR, knowledge transfer", "writeIn": false, "levels": ["Neglects major interfaces, VDR, or knowledge transfer duties.", "Integration coordination and records are repeatedly incomplete.", "Integrates subsystem, drafts VDR, and maintains knowledge records.", "Anticipates interfaces and produces strong, transferable documentation.", "Creates excellent integration and handoff practices for future teams."]}, {"id": "semester-priority-optional", "tag": "", "name": "Semester Priority (optional)", "sub": "Agreed subsystem milestone or deliverable", "writeIn": false, "levels": ["Makes no usable progress on an agreed priority.", "Makes partial progress; core outcome remains incomplete.", "Meets the agreed milestone or deliverable to required standard.", "Exceeds the target or materially accelerates subsystem progress.", "Delivers exceptional results with substantial lasting value."]}], "boxes": [{"id": "evidence", "title": "Notable contributions / evidence", "lines": 4, "role": "evidence"}, {"id": "goals", "title": "Next-semester goals", "lines": 4, "role": ""}, {"id": "improvement", "title": "Areas for improvement", "lines": 2, "role": ""}, {"id": "comments", "title": "Member comments / context", "lines": 2, "role": "comments"}], "notesTitle": "", "notes": ["N/O: insufficient evidence or not assigned. Do not average ratings into a single score.", "CONSTITUTION: Article VIII, Section C (appointed officers)"], "footer": "Solar Gators  •  Subsystem Lead"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-10T00:00:10Z')
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- Groups, types, shared questionnaires, input notes
-- ---------------------------------------------------------------------------
create table public.eval_groups (
  id              text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name            text not null check (length(trim(name)) between 1 and 60),
  members         uuid[] not null default '{}',
  updated_at      timestamptz not null default now(),
  updated_by_name text not null default ''
);

create table public.eval_types (
  id              text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name            text not null check (length(trim(name)) between 1 and 60),
  description     text not null default '' check (length(description) <= 600),
  active          boolean not null default true,
  sort            int not null default 100,
  settings        jsonb not null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.profiles(id) on delete set null,
  updated_by_name text not null default ''
);

create table public.eval_type_history (
  id            bigserial primary key,
  type_id       text not null references public.eval_types(id) on delete cascade,
  name          text not null,
  description   text not null default '',
  active        boolean not null,
  settings      jsonb not null,
  note          text not null default '' check (length(note) <= 600),
  saved_at      timestamptz not null default now(),
  saved_by_name text not null default ''
);
create index eval_type_history_type_idx on public.eval_type_history (type_id, saved_at desc);

create table public.eval_questionnaires (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) between 1 and 60),
  questions       jsonb not null,
  updated_at      timestamptz not null default now(),
  updated_by_name text not null default '',
  removed_at      timestamptz
);

alter table public.evals
  add column type_id       text references public.eval_types(id) on delete restrict,
  add column type_settings jsonb,
  add column subject_id    uuid references public.profiles(id) on delete set null,   -- the account of the person evaluated, when known
  add column input_ids     uuid[] not null default '{}';                             -- who gives input (was: one subsystem lead)
create index evals_type_idx on public.evals (type_id);
create index evals_subject_idx on public.evals (subject_id);

create table public.eval_input_notes (
  eval_id     uuid not null references public.evals(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  author_name text not null default '',
  body        text not null check (length(body) between 1 and 4000),
  updated_at  timestamptz not null default now(),
  primary key (eval_id, author_id)
);


-- ---------------------------------------------------------------------------
-- The settings of an eval type
-- ---------------------------------------------------------------------------
/** How evals worked before 036: the "Member eval" type. */
create or replace function public.eval_default_settings()
returns jsonb
language sql immutable set search_path = public, pg_temp
as $$
  select '{
    "labels":        {"subject": "Member", "evaluator": "CE", "input": "Subsystem lead", "variant": "Division"},
    "subjects":      {"rule": "anyone"},
    "evaluators":    {"rule": "permission", "value": "evals.write"},
    "input":         {"on": true, "rule": "anyone", "max": 1, "pickedBy": "either", "notes": false},
    "form":          {"track": "master", "variants": true},
    "questionnaire": {"on": true, "source": "evaluator", "id": null},
    "meeting":       true,
    "comments":      true,
    "visibility": {
      "answers":  {"evaluator": "final", "input": "final", "viewers": "final", "extra": "never"},
      "eval":     {"subject": "shared", "input": "final", "viewers": "final", "extra": "never"},
      "extraWho": {"rule": "none"}
    },
    "notify": {"submitted": true, "finished": false, "meeting": true, "shared": true, "input": false}
  }'::jsonb;
$$;

/** A label from the settings ("CE", "Member", …). */
create or replace function public.eval_lbl(s jsonb, k text)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(nullif(trim(s -> 'labels' ->> k), ''), eval_default_settings() -> 'labels' ->> k);
$$;

/** Does this person fit a "who" rule? {rule: anyone | permission | role | group | person | none, value} */
create or replace function public.eval_rule_match(p_rule jsonb, p_user uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_user is not null and exists (select 1 from profiles where id = p_user) and
    case coalesce(p_rule ->> 'rule', 'none')
      when 'anyone'     then true
      when 'permission' then user_has_permission(p_user, p_rule ->> 'value')
      when 'role'       then exists (select 1 from profile_roles where user_id = p_user and role = p_rule ->> 'value')
      when 'group'      then exists (select 1 from eval_groups where id = p_rule ->> 'value' and p_user = any(members))
      when 'person'     then p_user::text = p_rule ->> 'value'
      else false
    end;
$$;

/** Has an eval reached this point? need: never | draft (always) | final (finished or shared) | shared. */
create or replace function public.eval_stage_ok(p_status text, p_need text)
returns boolean
language sql immutable set search_path = public, pg_temp
as $$
  select case p_need
    when 'draft'  then true
    when 'final'  then p_status in ('final', 'shared')
    when 'shared' then p_status = 'shared'
    else false
  end;
$$;

create or replace function public.eval_check_rule(r jsonb, what text, allowed text[])
returns void
language plpgsql stable set search_path = public, pg_temp
as $$
declare v_rule text := r ->> 'rule'; v text := r ->> 'value';
begin
  if jsonb_typeof(r) is distinct from 'object' or not (coalesce(v_rule, '') = any(allowed)) then
    raise exception '"%": choose who that is.', what;
  end if;
  if v_rule = 'permission' and not exists (select 1 from permissions where key = v) then
    raise exception '"%": that permission doesn''t exist.', what;
  elsif v_rule = 'role' and not exists (select 1 from roles where key = v) then
    raise exception '"%": that position doesn''t exist any more.', what;
  elsif v_rule = 'group' and not exists (select 1 from eval_groups where id = v) then
    raise exception '"%": that eval group doesn''t exist any more.', what;
  elsif v_rule = 'person' and not exists (select 1 from profiles where id::text = v) then
    raise exception '"%": pick the person.', what;
  end if;
end;
$$;

/** Refuses settings that are incomplete or don't make sense; the page always sends a full set. */
create or replace function public.eval_check_settings(s jsonb)
returns void
language plpgsql stable set search_path = public, pg_temp
as $$
declare
  k text;
  v_bool text[] := array['true', 'false'];
  v_any text[] := array['anyone', 'permission', 'role', 'group', 'person'];
begin
  if jsonb_typeof(s) is distinct from 'object' then raise exception 'Those settings are incomplete.'; end if;
  foreach k in array array['subject', 'evaluator', 'input', 'variant'] loop
    if length(trim(coalesce(s -> 'labels' ->> k, ''))) not between 1 and 40 then
      raise exception 'Every name in "What to call people" needs 1 to 40 characters.';
    end if;
  end loop;
  perform eval_check_rule(s -> 'subjects', 'Who is evaluated', v_any);
  perform eval_check_rule(s -> 'evaluators', 'Who evaluates', v_any);
  if not (coalesce(s -> 'input' ->> 'on', '') = any(v_bool)) or not (coalesce(s -> 'input' ->> 'notes', '') = any(v_bool))
     or not (coalesce(s -> 'input' ->> 'pickedBy', '') = any(array['subject', 'evaluator', 'either']))
     or coalesce(s -> 'input' ->> 'max', '') !~ '^([1-9]|10)$' then
    raise exception '"Input from": those choices are incomplete.';
  end if;
  if (s -> 'input' ->> 'on')::boolean then perform eval_check_rule(s -> 'input', 'Input from', v_any); end if;
  if not exists (select 1 from eval_tracks where id = s -> 'form' ->> 'track' and removed_at is null) then
    raise exception 'Pick the form this eval uses.';
  end if;
  if not (coalesce(s -> 'form' ->> 'variants', '') = any(v_bool)) then raise exception 'Choose whether the form has variants.'; end if;
  -- One variant (e.g. just the Treasurer's form) can be used on its own; picking among variants needs the main form.
  if (s -> 'form' ->> 'variants')::boolean and exists (select 1 from eval_tracks where id = s -> 'form' ->> 'track' and parent_id is not null) then
    raise exception 'To let people pick a variant, choose the main form, not one of its variants.';
  end if;
  if not (coalesce(s -> 'questionnaire' ->> 'on', '') = any(v_bool))
     or not (coalesce(s -> 'questionnaire' ->> 'source', '') = any(array['evaluator', 'questionnaire'])) then
    raise exception '"Self-eval questionnaire": those choices are incomplete.';
  end if;
  if (s -> 'questionnaire' ->> 'on')::boolean and s -> 'questionnaire' ->> 'source' = 'questionnaire'
     and not exists (select 1 from eval_questionnaires where id::text = s -> 'questionnaire' ->> 'id' and removed_at is null) then
    raise exception 'Pick which questionnaire people answer.';
  end if;
  if not (coalesce(s ->> 'meeting', '') = any(v_bool)) or not (coalesce(s ->> 'comments', '') = any(v_bool)) then
    raise exception 'Choose whether there''s a meeting and whether comments are allowed.';
  end if;
  foreach k in array array['evaluator', 'input', 'viewers', 'extra'] loop
    if not (coalesce(s -> 'visibility' -> 'answers' ->> k, '') = any(array['never', 'submitted', 'final', 'shared'])) then
      raise exception '"Who sees what": choose when each person sees the self-eval answers.';
    end if;
  end loop;
  if not (coalesce(s -> 'visibility' -> 'eval' ->> 'subject', '') = any(array['never', 'final', 'shared']))
     or not (coalesce(s -> 'visibility' -> 'eval' ->> 'input', '') = any(array['never', 'draft', 'final', 'shared']))
     or not (coalesce(s -> 'visibility' -> 'eval' ->> 'viewers', '') = any(array['never', 'final', 'shared']))
     or not (coalesce(s -> 'visibility' -> 'eval' ->> 'extra', '') = any(array['never', 'draft', 'final', 'shared'])) then
    raise exception '"Who sees what": choose when each person sees the eval.';
  end if;
  if (s -> 'visibility' -> 'eval' ->> 'extra' <> 'never' or s -> 'visibility' -> 'answers' ->> 'extra' <> 'never') then
    perform eval_check_rule(s -> 'visibility' -> 'extraWho', 'Also readable by', v_any);
  elsif not (coalesce(s -> 'visibility' -> 'extraWho' ->> 'rule', '') = any(v_any || 'none'::text)) then
    raise exception '"Also readable by": choose who that is, or nobody.';
  end if;
  foreach k in array array['submitted', 'finished', 'meeting', 'shared', 'input'] loop
    if not (coalesce(s -> 'notify' ->> k, '') = any(v_bool)) then raise exception '"Emails": those choices are incomplete.'; end if;
  end loop;
  if (s -> 'input' ->> 'notes')::boolean and not (s -> 'input' ->> 'on')::boolean then
    raise exception 'Notes from "%" need input to be turned on.', s -> 'labels' ->> 'input';
  end if;
  if s -> 'visibility' -> 'eval' ->> 'subject' = 'never' and (s ->> 'comments')::boolean then
    raise exception 'The % can only comment on an eval they can read.', lower(s -> 'labels' ->> 'subject');
  end if;
  if octet_length(s::text) > 20000 then raise exception 'Those settings are too large.'; end if;
end;
$$;

insert into public.eval_types (id, name, description, sort, settings) values
  ('member', 'Member eval', 'Semester review of team members: the member answers their CE''s questions, the CE writes the eval with the subsystem lead''s input, they meet, then the CE shares it.', 0, public.eval_default_settings())
on conflict (id) do nothing;
insert into public.eval_type_history (type_id, name, description, active, settings, note, saved_by_name)
select id, name, description, active, settings, 'How Solar Evals worked before eval types.', 'Solar Gators' from public.eval_types where id = 'member';

-- Every eval so far is a member eval.
update public.evals e set
  type_id       = 'member',
  type_settings = public.eval_default_settings(),
  input_ids     = case when e.lead_id is null then '{}' else array[e.lead_id] end,
  subject_id    = case when e.kind = 'self' then e.evaluator_id
                       when e.self_eval_id is not null then (select s.evaluator_id from public.evals s where s.id = e.self_eval_id)
                       else coalesce(e.member_id, (select p.id from public.profiles p where lower(p.email) = e.member_email and e.member_email <> '' limit 1)) end;


-- ---------------------------------------------------------------------------
-- Who can read what: the eval's copy of its type's settings decides
-- ---------------------------------------------------------------------------
/** An evaluation (not a self-eval), for someone who didn't write it. */
create or replace function public.eval_visible_to_me(s jsonb, p_status text, p_subject uuid, p_member uuid, p_inputs uuid[])
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v jsonb := coalesce(s, eval_default_settings()) -> 'visibility';
begin
  if auth.uid() is null then return false; end if;
  return (p_status = 'shared' and p_member = auth.uid())
      or (p_subject = auth.uid() and eval_stage_ok(p_status, v -> 'eval' ->> 'subject'))
      or (auth.uid() = any(p_inputs) and eval_stage_ok(p_status, v -> 'eval' ->> 'input'))
      or (eval_stage_ok(p_status, v -> 'eval' ->> 'viewers') and has_permission('evals.view'))
      or (eval_stage_ok(p_status, v -> 'eval' ->> 'extra') and eval_rule_match(v -> 'extraWho', auth.uid()));
end;
$$;

/**
 * A self-eval's answers, for someone other than the person who wrote them.
 * Levels: submitted (once it's sent), final (once the evaluation made from it is finished), shared, never.
 */
create or replace function public.eval_answers_visible(p_self uuid)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare s evals; c evals; v jsonb;
begin
  if auth.uid() is null then return false; end if;
  select * into s from evals where id = p_self and kind = 'self';
  if s.id is null or s.status = 'draft' then return false; end if;
  select * into c from evals where self_eval_id = p_self and kind = 'ce';
  v := coalesce(s.type_settings, eval_default_settings()) -> 'visibility' -> 'answers';
  return exists (
    select 1 from (values
        ((coalesce(c.evaluator_id, s.ce_id) = auth.uid()), v ->> 'evaluator'),
        ((auth.uid() = any(s.input_ids || coalesce(c.input_ids, '{}'))), v ->> 'input'),
        (has_permission('evals.view'), v ->> 'viewers'),
        (eval_rule_match(coalesce(s.type_settings, eval_default_settings()) -> 'visibility' -> 'extraWho', auth.uid()), v ->> 'extra')
      ) as a(who, lvl)
    where a.who and case a.lvl
      when 'submitted' then true
      when 'final'     then c.status in ('final', 'shared')
      when 'shared'    then c.status = 'shared'
      else false end);
end;
$$;

drop policy if exists "eval readers" on public.evals;
create policy "eval readers" on public.evals for select to authenticated using (
  case when kind = 'self' then
    evaluator_id = auth.uid() or (status <> 'draft' and eval_answers_visible(id))
  else
    evaluator_id = auth.uid() or eval_visible_to_me(type_settings, status, subject_id, member_id, input_ids)
  end
);

alter table public.eval_groups         enable row level security;
alter table public.eval_types          enable row level security;
alter table public.eval_type_history   enable row level security;
alter table public.eval_questionnaires enable row level security;
alter table public.eval_input_notes    enable row level security;
create policy "signed-in read" on public.eval_groups         for select to authenticated using (true);
create policy "signed-in read" on public.eval_types          for select to authenticated using (true);
create policy "setup read"     on public.eval_type_history   for select to authenticated using (has_permission('evals.types'));
create policy "signed-in read" on public.eval_questionnaires for select to authenticated using (removed_at is null);
-- A note is for the evaluator: its author and the evaluator read it, never the person evaluated.
create policy "author or evaluator" on public.eval_input_notes for select to authenticated using (
  author_id = auth.uid() or exists (select 1 from evals e where e.id = eval_id and e.evaluator_id = auth.uid())
);
revoke all on public.eval_groups, public.eval_types, public.eval_type_history, public.eval_questionnaires, public.eval_input_notes from anon, authenticated;
grant select on public.eval_groups, public.eval_types, public.eval_type_history, public.eval_questionnaires, public.eval_input_notes to authenticated;
grant usage on sequence public.eval_type_history_id_seq to authenticated;


-- ---------------------------------------------------------------------------
-- Forms: rating scales of 2 to 10 levels, with or without N/O
-- ---------------------------------------------------------------------------
create or replace function public.check_rubric(p jsonb)
returns void
language plpgsql immutable set search_path = public, pg_temp
as $$
declare n int;
begin
  if jsonb_typeof(p) <> 'object'
     or coalesce(jsonb_typeof(p -> 'pages'), '') <> 'array' or jsonb_array_length(p -> 'pages') = 0
     or coalesce(jsonb_typeof(p -> 'scale'), '') <> 'array' or jsonb_array_length(p -> 'scale') not between 2 and 10 then
    raise exception 'That rubric is missing its pages or its rating labels (2 to 10).';
  end if;
  n := jsonb_array_length(p -> 'scale');
  if exists (select 1 from jsonb_array_elements(p -> 'pages') pg
             where coalesce(jsonb_typeof(pg -> 'criteria'), '') <> 'array') then
    raise exception 'Every rubric page needs a list of criteria.';
  end if;
  if exists (select 1 from jsonb_array_elements(p -> 'pages') pg, jsonb_array_elements(pg -> 'criteria') c
             where coalesce(jsonb_typeof(c -> 'levels'), '') <> 'array' or jsonb_array_length(c -> 'levels') <> n) then
    raise exception 'Every rating row needs a description for each of the % levels.', n;
  end if;
  if octet_length(p::text) > 200000 then
    raise exception 'That rubric is too large.';
  end if;
end;
$$;

/** Ratings must fit the eval's own scale. */
create or replace function public.eval_check_ratings(p_rubric jsonb, p_ratings jsonb)
returns void
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  n int := coalesce(jsonb_array_length(case when jsonb_typeof(p_rubric -> 'scale') = 'array' then p_rubric -> 'scale' end), 5);
  v_no boolean := coalesce((p_rubric ->> 'noOption')::boolean, true);
  v_msg text;
begin
  if p_ratings is null or p_ratings = 'null'::jsonb then return; end if;
  if jsonb_typeof(p_ratings) <> 'object' or exists (
       select 1 from jsonb_each(p_ratings) r
       where not ((jsonb_typeof(r.value) = 'number' and r.value::text ~ '^[0-9]+$' and (r.value::text)::int between 1 and n)
                  or (v_no and r.value = '"NO"'::jsonb))) then
    v_msg := format('A rating must be 1 to %s%s.', n, case when v_no then ' or N/O' else '' end);
    raise exception '%', v_msg;
  end if;
end;
$$;

/** Does this form (or variant) belong to the eval type? */
create or replace function public.eval_template_fits(p_track text, s jsonb)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_track = s -> 'form' ->> 'track'
      or ((s -> 'form' ->> 'variants')::boolean
          and exists (select 1 from eval_tracks where id = p_track and parent_id = s -> 'form' ->> 'track'));
$$;

/** The newest version of a form, for evals that don't pick a variant. */
create or replace function public.eval_latest_template(p_track text)
returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select id from eval_templates where track_id = p_track and removed_at is null order by created_at desc limit 1;
$$;


-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------
/**
 * p_kind: self_submitted (to the evaluator), input (to new input-givers), finished, meeting, shared (to the person).
 * Each eval type turns these on or off; Admin → Notifications and each person's choices still apply.
 */
create or replace function public.notify_eval(p_eval uuid, p_kind text, p_recipients uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := (select value from app_settings where key = 'notifications');
  v_ev       jsonb := v_settings -> 'events' -> 'eval_update';
  e          evals;
  s          jsonb;
  v_type     text;
  v_sem      text;
  v_actor    text := coalesce(my_display_name(), 'Someone');
  v_when     text;
  v_what     text;
  v_details  text;
  v_path     text;
  v_payload  jsonb;
  v_person   profiles;
  v_seen     text;
begin
  if v_settings is null or (v_settings -> 'enabled') is distinct from 'true'::jsonb or v_ev is null then return; end if;
  select * into e from evals where id = p_eval;
  if e.id is null then return; end if;
  s := coalesce(e.type_settings, eval_default_settings());
  if (s -> 'notify' ->> case p_kind when 'self_submitted' then 'submitted' else p_kind end) is distinct from 'true' then return; end if;
  v_type := coalesce((select name from eval_types where id = e.type_id), 'Solar Evals');
  v_sem := coalesce(nullif(e.semester, ''), 'this semester');
  v_seen := s -> 'visibility' -> 'eval' ->> 'subject';
  v_when := to_char(e.meeting_at at time zone 'America/New_York', 'FMDay, FMMonth FMDD "at" FMHH12:MI AM');
  v_path := 'evals/#/evals/' || e.id;

  if p_kind = 'self_submitted' then
    v_what := e.member_name || '''s self-eval is in';
    v_details := e.member_name || ' submitted their self-evaluation for ' || v_sem || '. Fill out your eval for them'
      || case s -> 'visibility' -> 'answers' ->> 'evaluator'
           when 'submitted' then '; their answers are on it.'
           when 'final' then '; you''ll see their answers once yours is finished.'
           else '.' end;
    v_path := 'evals/#/evals';
  elsif p_kind = 'input' then
    v_what := 'Your input on ' || e.member_name || '''s eval';
    v_details := v_actor || ' is writing ' || e.member_name || '''s ' || v_type || ' for ' || v_sem || ' and would like your input as '
      || lower(eval_lbl(s, 'input')) || '.'
      || case when s -> 'visibility' -> 'eval' ->> 'input' = 'draft'
              then ' You can read it in Solar Evals as they write it' || case when (s -> 'input' ->> 'notes')::boolean then ', and leave them notes' else '' end || '.'
              else ' Talk to them before they finish it.' end;
  elsif p_kind = 'finished' then
    v_what := case when v_seen = 'final' then 'Your evaluation is ready' else 'Your evaluation is complete' end;
    v_details := v_actor || ' finished your ' || v_type || ' for ' || v_sem || '.'
      || case when v_seen = 'final' then ' You can read it now' || case when (s ->> 'comments')::boolean then ', and add your own comments' else '' end || '.'
              when (s ->> 'meeting')::boolean then ' You''ll have a meeting to go over it; you''ll get the time and place.'
              else '' end;
    if v_seen <> 'final' then v_path := 'evals/#/evals'; end if;
  elsif p_kind = 'meeting' then
    v_what := 'Eval meeting: ' || v_when;
    v_details := v_actor || ' scheduled your eval meeting for ' || v_when
      || case when e.meeting_place <> '' then ' (' || e.meeting_place || ')' else '' end || '.';
    if e.kind <> 'self' and v_seen <> 'final' then v_path := 'evals/#/evals'; end if;
  elsif p_kind = 'shared' then
    v_what := 'Your evaluation is ready';
    v_details := v_actor || ' shared your ' || coalesce(nullif(e.semester, ''), '') || ' evaluation. You can read it'
      || case when e.self_eval_id is not null then ' next to your self-evaluation' else '' end
      || case when (s ->> 'comments')::boolean then ', and add your own comments' else '' end || '.';
  else
    return;
  end if;

  v_payload := jsonb_build_object(
    'what', v_what, 'details', regexp_replace(v_details, '\s+', ' ', 'g'), 'actor', v_actor,
    'member', e.member_name, 'semester', e.semester, 'app_path', v_path);

  for v_person in
    select * from profiles where id = any(p_recipients) and id is distinct from auth.uid()
  loop
    if (v_ev -> 'email') = 'true'::jsonb and v_person.notify_email
       and (v_person.notify_events -> 'eval_update' -> 'email') is distinct from 'false'::jsonb then
      insert into notification_outbox (event, recipient_id, email, channel, payload)
      values ('eval_update', v_person.id, v_person.email, 'email', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
    if (v_ev -> 'teams') = 'true'::jsonb and v_person.notify_teams
       and (v_person.notify_events -> 'eval_update' -> 'teams') is distinct from 'false'::jsonb then
      insert into notification_outbox (event, recipient_id, email, channel, payload)
      values ('eval_update', v_person.id, v_person.email, 'teams', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- Shared checks
-- ---------------------------------------------------------------------------
/** The type to start a new eval with: must exist and be turned on. */
create or replace function public.eval_type_for_new(p_type text)
returns eval_types
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare t eval_types;
begin
  select * into t from eval_types where id = coalesce(nullif(p_type, ''), 'member');
  if t.id is null or not t.active then raise exception 'That kind of eval isn''t available any more. Pick another one.'; end if;
  return t;
end;
$$;

/** Raise unless the signed-in person may write this type of eval. */
create or replace function public.eval_require_evaluator(s jsonb, p_type_name text)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if s -> 'evaluators' ->> 'rule' = 'permission' then
    perform require_permission(s -> 'evaluators' ->> 'value');
  elsif not eval_rule_match(s -> 'evaluators', auth.uid()) then
    raise exception 'You don''t write % evals. Ask whoever runs Solar Evals if that''s wrong.', p_type_name;
  end if;
end;
$$;

/** The input-givers someone picked: allowed by the type, within the limit, real accounts. */
create or replace function public.eval_check_inputs(s jsonb, p_new uuid[], p_old uuid[], p_by text, p_writer uuid)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v uuid; v_by text := s -> 'input' ->> 'pickedBy';
begin
  -- The same people in any order is no change.
  if coalesce((select array_agg(x order by x) from unnest(p_new) x), '{}') = coalesce((select array_agg(x order by x) from unnest(p_old) x), '{}') then
    return;
  end if;
  if not (s -> 'input' ->> 'on')::boolean then
    if cardinality(p_new) > 0 then raise exception 'This kind of eval doesn''t ask anyone for input.'; end if;
    return;
  end if;
  if v_by <> 'either' and v_by <> p_by then
    raise exception 'The % picks the %.', lower(eval_lbl(s, case v_by when 'subject' then 'subject' else 'evaluator' end)), lower(eval_lbl(s, 'input'));
  end if;
  if cardinality(p_new) > (s -> 'input' ->> 'max')::int then
    raise exception 'Pick up to % (%).', s -> 'input' ->> 'max', lower(eval_lbl(s, 'input'));
  end if;
  foreach v in array p_new loop
    if not exists (select 1 from profiles where id = v) then
      raise exception 'That %''s account no longer exists.', lower(eval_lbl(s, 'input'));
    end if;
    if v = p_writer then raise exception 'You can''t give input on your own eval.'; end if;
    if not (v = any(p_old)) and not eval_rule_match(s -> 'input', v) then
      raise exception '% can''t be picked as %.', coalesce((select nullif(full_name, '') from profiles where id = v), 'That person'), lower(eval_lbl(s, 'input'));
    end if;
  end loop;
end;
$$;

/** Input-givers from p: input_ids (a list) or, from older pages, lead_id. */
create or replace function public.eval_inputs_from(p jsonb)
returns uuid[]
language sql immutable set search_path = public, pg_temp
as $$
  select case
    when jsonb_typeof(p -> 'input_ids') = 'array' then
      coalesce((select array_agg(distinct x::uuid) from jsonb_array_elements_text(p -> 'input_ids') x where x <> ''), '{}')
    else array_remove(array[nullif(p ->> 'lead_id', '')::uuid], null) end;
$$;

/** Tell people newly asked for input. */
create or replace function public.eval_notify_inputs(p_eval uuid, p_old uuid[], p_new uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v uuid[] := array(select unnest(p_new) except select unnest(p_old));
begin
  if cardinality(v) > 0 then perform notify_eval(p_eval, 'input', v); end if;
end;
$$;

/** The questions for a self-eval: the evaluator's own (or the defaults), or the type's questionnaire. */
create or replace function public.eval_type_questions(s jsonb, p_ce uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when s -> 'questionnaire' ->> 'source' = 'questionnaire'
    then coalesce((select questions from eval_questionnaires where id::text = s -> 'questionnaire' ->> 'id'), eval_default_questions())
    else eval_questions_for(p_ce) end;
$$;

/** The account of the person evaluated, if there is one. */
create or replace function public.eval_subject_account(e evals)
returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(e.subject_id,
    (select s.evaluator_id from evals s where s.id = e.self_eval_id),
    (select id from profiles where lower(email) = e.member_email and e.member_email <> '' limit 1));
$$;


-- ---------------------------------------------------------------------------
-- Writing an evaluation
-- ---------------------------------------------------------------------------
/**
 * Start (p_id null) or update an eval you're writing.
 *   p: { type_id (new only, default "member"), template_id (new only), subject_id, member_name, member_email,
 *        semester, division, subsystem, input_ids (or lead_id), review_date, fields, ratings, answers }
 */
create or replace function public.eval_save(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id      uuid := p_id;
  e         evals;
  t         eval_templates;
  ty        eval_types;
  s         jsonb;
  v_old     uuid[] := '{}';
  v_inputs  uuid[];
  v_subject uuid;
  v_name    text;
  v_email   text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if v_id is null then
    ty := eval_type_for_new(p ->> 'type_id');
    s := ty.settings;
    perform eval_require_evaluator(s, ty.name);
    select * into t from eval_templates where id = nullif(p ->> 'template_id', '')::uuid and removed_at is null;
    if t.id is null then raise exception 'Pick a rubric to start from.'; end if;
    if not eval_template_fits(t.track_id, s) then raise exception 'That form isn''t one % evals use.', ty.name; end if;
    perform eval_check_ratings(t.rubric, p -> 'ratings');
    insert into evals (template_id, template_label, rubric, evaluator_id, type_id, type_settings)
    values (t.id, (select name from eval_tracks where id = t.track_id) || ' · ' || t.label, t.rubric, auth.uid(), ty.id, s)
    returning * into e;
    v_id := e.id;
  else
    select * into e from evals where id = v_id;
    s := coalesce(e.type_settings, eval_default_settings());
    if e.id is null or e.evaluator_id is distinct from auth.uid() or e.kind <> 'ce' then
      raise exception 'Only the % who wrote this eval can change it.', eval_lbl(s, 'evaluator');
    end if;
    if e.status = 'shared' then
      raise exception 'This eval is shared with the %. Stop sharing it to make changes.', lower(eval_lbl(s, 'subject'));
    end if;
    perform eval_check_ratings(e.rubric, p -> 'ratings');
    v_old := e.input_ids;
  end if;

  -- Who it's for.
  v_name := coalesce(trim(p ->> 'member_name'), e.member_name);
  v_email := lower(coalesce(trim(p ->> 'member_email'), e.member_email));
  v_subject := e.subject_id;
  if e.self_eval_id is null then
    if p ? 'subject_id' then
      v_subject := nullif(p ->> 'subject_id', '')::uuid;
      if v_subject is not null then
        if not eval_rule_match(s -> 'subjects', v_subject) then
          raise exception '% isn''t someone who gets this kind of eval.', coalesce((select nullif(full_name, '') from profiles where id = v_subject), 'That person');
        end if;
        select coalesce(nullif(trim(full_name), ''), email), lower(email) into v_name, v_email from profiles where id = v_subject;
      end if;
    elsif p ? 'member_email' and s -> 'subjects' ->> 'rule' = 'anyone' then
      v_subject := (select id from profiles where lower(email) = v_email and v_email <> '' limit 1);
    end if;
  end if;
  if v_subject = auth.uid() then raise exception 'You can''t write your own eval.'; end if;

  -- Who gives input.
  if p ? 'input_ids' or p ? 'lead_id' then
    v_inputs := eval_inputs_from(p);
    perform eval_check_inputs(s, v_inputs, v_old, 'evaluator', auth.uid());
  else
    v_inputs := e.input_ids;
  end if;
  if v_subject = any(v_inputs) then raise exception 'The person being evaluated can''t also give input.'; end if;

  update evals set
    member_name  = left(v_name, 120),
    member_email = left(v_email, 200),
    subject_id   = v_subject,
    semester     = left(coalesce(trim(p ->> 'semester'), semester), 40),
    division     = left(coalesce(trim(p ->> 'division'), division), 80),
    subsystem    = left(coalesce(trim(p ->> 'subsystem'), subsystem), 80),
    input_ids    = v_inputs,
    lead_id      = v_inputs[1],
    review_date  = case when p ? 'review_date' then nullif(p ->> 'review_date', '')::date else review_date end,
    fields       = coalesce(p -> 'fields', fields),
    ratings      = coalesce(p -> 'ratings', ratings),
    answers      = coalesce(p -> 'answers', answers),
    updated_at   = now()
  where id = v_id;
  perform eval_notify_inputs(v_id, v_old, v_inputs);
  return v_id;
end;
$$;

/** Draft ⇄ Finished ⇄ Shared, as the eval's type allows. */
create or replace function public.eval_set_status(p_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals; s jsonb; v_member uuid; v_seen text; v_type text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  select * into e from evals where id = p_id;
  if e.id is null then raise exception 'That eval no longer exists.'; end if;
  s := coalesce(e.type_settings, eval_default_settings());
  v_seen := s -> 'visibility' -> 'eval' ->> 'subject';
  v_type := coalesce((select name from eval_types where id = e.type_id), 'These');
  if e.kind <> 'ce' then raise exception 'A self-eval is submitted by its %.', lower(eval_lbl(s, 'subject')); end if;
  if e.evaluator_id is distinct from auth.uid() then raise exception 'Only the % who wrote this eval can do that.', eval_lbl(s, 'evaluator'); end if;
  if p_status not in ('draft', 'final', 'shared') then raise exception 'Unknown status "%".', p_status; end if;

  if p_status = 'final' then
    if trim(e.member_name) = '' then raise exception 'Add the %''s name first.', lower(eval_lbl(s, 'subject')); end if;
    if s -> 'subjects' ->> 'rule' <> 'anyone' and e.subject_id is null then
      raise exception 'Pick the % this eval is for first.', lower(eval_lbl(s, 'subject'));
    end if;
  end if;
  if p_status = 'shared' then
    if v_seen = 'never' then raise exception '% evals aren''t shared with the %.', v_type, lower(eval_lbl(s, 'subject')); end if;
    if v_seen = 'final' then raise exception 'The % can already read it once it''s finished.', lower(eval_lbl(s, 'subject')); end if;
    if e.status = 'draft' then raise exception 'Mark the eval finished before sharing it.'; end if;
    v_member := eval_subject_account(e);
    if v_member is null then
      raise exception 'Nobody has a OneSolar account with the email "%" yet. Ask them to create one, then share again.', e.member_email;
    end if;
  end if;

  update evals set
    status       = p_status,
    finalized_at = case when p_status = 'draft' then null when e.finalized_at is null then now() else e.finalized_at end,
    shared_at    = case when p_status = 'shared' then now() else null end,
    member_id    = case when p_status = 'shared' then v_member else null end,
    updated_at   = now()
  where id = p_id;

  if p_status = 'final' and e.status = 'draft' then
    v_member := eval_subject_account(e);
    if v_member is not null then perform notify_eval(p_id, 'finished', array[v_member]); end if;
  end if;
  if p_status = 'shared' and e.status <> 'shared' then
    perform notify_eval(p_id, 'shared', array[v_member]);
  end if;
end;
$$;

/** Only drafts can be deleted, by whoever is writing them. */
create or replace function public.eval_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals; s jsonb;
begin
  select * into e from evals where id = p_id;
  if e.id is null then return; end if;
  s := coalesce(e.type_settings, eval_default_settings());
  if e.evaluator_id is distinct from auth.uid() then
    raise exception 'Only the % who wrote this eval can delete it.', case when e.kind = 'self' then lower(eval_lbl(s, 'subject')) else eval_lbl(s, 'evaluator') end;
  end if;
  if e.status <> 'draft' then
    raise exception 'Only drafts can be deleted. Move it back to draft first.';
  end if;
  delete from evals where id = p_id;
end;
$$;

/** The person's own comments on their eval, once they can read it (if the type allows comments). */
create or replace function public.eval_member_comment(p_id uuid, p_text text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals; s jsonb;
begin
  select * into e from evals where id = p_id and kind = 'ce';
  s := coalesce(e.type_settings, eval_default_settings());
  if e.id is null or not coalesce((s ->> 'comments')::boolean, true)
     or not ((e.status = 'shared' and e.member_id = auth.uid())
             or (e.subject_id = auth.uid() and eval_stage_ok(e.status, s -> 'visibility' -> 'eval' ->> 'subject'))) then
    raise exception 'You can only comment on an eval that has been shared with you.';
  end if;
  update evals set member_comments = left(coalesce(p_text, ''), 4000), member_commented_at = now() where id = p_id;
end;
$$;

/** A note for the evaluator from someone giving input, while the eval is a draft. Empty text removes it. */
create or replace function public.eval_input_note_save(p_eval uuid, p_body text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals; s jsonb;
begin
  select * into e from evals where id = p_eval and kind = 'ce';
  s := coalesce(e.type_settings, eval_default_settings());
  if e.id is null or not (auth.uid() = any(e.input_ids)) or not coalesce((s -> 'input' ->> 'notes')::boolean, false) then
    raise exception 'Only someone asked for input can leave notes on this eval.';
  end if;
  if e.status <> 'draft' then raise exception 'It''s finished, so notes can''t be changed any more.'; end if;
  if coalesce(trim(p_body), '') = '' then
    delete from eval_input_notes where eval_id = p_eval and author_id = auth.uid();
  else
    insert into eval_input_notes (eval_id, author_id, author_name, body) values (p_eval, auth.uid(), coalesce(my_name(), ''), left(trim(p_body), 4000))
    on conflict (eval_id, author_id) do update set body = excluded.body, author_name = excluded.author_name, updated_at = now();
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- Self-evals (questionnaires)
-- ---------------------------------------------------------------------------
/**
 * Start (p_id null) or update your own self-eval.
 *   p: { type_id (new only), template_id (new only, when the form has variants), member_name, semester,
 *        division, subsystem, ce_id (the evaluator), input_ids (or lead_id), answers }
 */
create or replace function public.eval_self_save(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id     uuid := p_id;
  e        evals;
  t        eval_templates;
  ty       eval_types;
  s        jsonb;
  v_ce     uuid := nullif(p ->> 'ce_id', '')::uuid;
  v_old    uuid[] := '{}';
  v_inputs uuid[];
  v_tid    uuid;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if p ? 'answers' and (jsonb_typeof(p -> 'answers') <> 'object'
     or exists (select 1 from jsonb_each(p -> 'answers') a where jsonb_typeof(a.value) <> 'string' or length(a.value #>> '{}') > 4000)) then
    raise exception 'Each answer can be up to 4000 characters.';
  end if;

  if v_id is null then
    ty := eval_type_for_new(p ->> 'type_id');
    s := ty.settings;
    if not (s -> 'questionnaire' ->> 'on')::boolean then raise exception '% evals don''t have a self-eval.', ty.name; end if;
    if not eval_rule_match(s -> 'subjects', auth.uid()) then
      raise exception 'You aren''t someone who gets % evals. Ask whoever runs Solar Evals if that''s wrong.', ty.name;
    end if;
    v_tid := case when (s -> 'form' ->> 'variants')::boolean then nullif(p ->> 'template_id', '')::uuid
                  else eval_latest_template(s -> 'form' ->> 'track') end;
    select * into t from eval_templates where id = v_tid and removed_at is null;
    if t.id is null or not eval_template_fits(t.track_id, s) then raise exception 'Pick your %.', lower(eval_lbl(s, 'variant')); end if;
    insert into evals (kind, template_id, template_label, rubric, evaluator_id, member_id, subject_id, member_name, member_email, type_id, type_settings, ce_id)
    values ('self', t.id, (select name from eval_tracks where id = t.track_id) || ' · ' || t.label,
            jsonb_build_object('questions', eval_default_questions()), auth.uid(), auth.uid(), auth.uid(),
            coalesce(my_name(), ''), coalesce((select lower(email) from profiles where id = auth.uid()), ''), ty.id, s,
            case when s -> 'evaluators' ->> 'rule' = 'person' then (s -> 'evaluators' ->> 'value')::uuid end)
    returning * into e;
    v_id := e.id;
  else
    select * into e from evals where id = v_id;
    s := coalesce(e.type_settings, eval_default_settings());
    if e.id is null or e.kind <> 'self' or e.evaluator_id is distinct from auth.uid() then
      raise exception 'Only the % who wrote this self-eval can change it.', lower(eval_lbl(s, 'subject'));
    end if;
    if e.status <> 'draft' then raise exception 'You''ve submitted this self-eval. Take it back to change it.'; end if;
    v_old := e.input_ids;
  end if;

  if p ? 'ce_id' and v_ce is not null then
    if v_ce = auth.uid() then raise exception 'Pick your %, not yourself.', eval_lbl(s, 'evaluator'); end if;
    if not eval_rule_match(s -> 'evaluators', v_ce) then
      raise exception 'That person doesn''t fill out evals. Pick your %.', eval_lbl(s, 'evaluator');
    end if;
  end if;
  if p ? 'input_ids' or p ? 'lead_id' then
    v_inputs := eval_inputs_from(p);
    perform eval_check_inputs(s, v_inputs, v_old, 'subject', auth.uid());
  else
    v_inputs := e.input_ids;
  end if;

  update evals set
    member_name = left(coalesce(nullif(trim(p ->> 'member_name'), ''), member_name), 120),
    semester    = left(coalesce(trim(p ->> 'semester'), semester), 40),
    division    = left(coalesce(trim(p ->> 'division'), division), 80),
    subsystem   = left(coalesce(trim(p ->> 'subsystem'), subsystem), 80),
    ce_id       = case when p ? 'ce_id' then v_ce else ce_id end,
    input_ids   = v_inputs,
    lead_id     = v_inputs[1],
    answers     = coalesce(p -> 'answers', answers),
    updated_at  = now()
  where id = v_id;
  update evals set rubric = jsonb_build_object('questions', eval_type_questions(type_settings, ce_id)) where id = v_id;
  return v_id;
end;
$$;

/** Submit your self-eval (p_submit true), or take it back (false) until the evaluator starts theirs. */
create or replace function public.eval_self_submit(p_id uuid, p_submit boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals; s jsonb;
begin
  select * into e from evals where id = p_id;
  s := coalesce(e.type_settings, eval_default_settings());
  if e.id is null or e.kind <> 'self' or e.evaluator_id is distinct from auth.uid() then
    raise exception 'Only the % who wrote this self-eval can do that.', lower(eval_lbl(s, 'subject'));
  end if;
  if p_submit then
    if e.status <> 'draft' then return; end if;
    if e.ce_id is null then raise exception 'Pick your % first.', eval_lbl(s, 'evaluator'); end if;
    if not eval_rule_match(s -> 'evaluators', e.ce_id) then
      raise exception 'The % you picked no longer fills out evals. Pick again.', eval_lbl(s, 'evaluator');
    end if;
    if trim(e.member_name) = '' then raise exception 'Add your name first.'; end if;
    if not exists (select 1 from jsonb_each_text(e.answers) a where trim(a.value) <> '') then
      raise exception 'Answer at least one question first.';
    end if;
    update evals set status = 'final', finalized_at = now(), updated_at = now(),
                     rubric = jsonb_build_object('questions', eval_type_questions(s, e.ce_id))   -- the questions as they were answered
    where id = p_id;
    perform notify_eval(p_id, 'self_submitted', array[e.ce_id]);
  else
    if e.status = 'draft' then return; end if;
    if exists (select 1 from evals where self_eval_id = p_id) then
      raise exception 'Your % has already started their eval, so it can''t be taken back. Ask them if something needs to change.', eval_lbl(s, 'evaluator');
    end if;
    update evals set status = 'draft', finalized_at = null, updated_at = now() where id = p_id;
  end if;
end;
$$;

/** Submitted self-evals waiting for the signed-in person: who and when, not the answers. */
drop function if exists public.eval_inbox();
create function public.eval_inbox()
returns table (self_id uuid, member_id uuid, member_name text, semester text, division text, subsystem text,
               lead_id uuid, template_label text, submitted_at timestamptz, ce_eval_id uuid, ce_status text, meeting_at timestamptz,
               type_id text, type_name text, input_ids uuid[])
language sql stable security definer set search_path = public, pg_temp
as $$
  select s.id, s.evaluator_id, s.member_name, s.semester, s.division, s.subsystem,
         s.lead_id, s.template_label, s.finalized_at, c.id, c.status, s.meeting_at,
         s.type_id, coalesce(t.name, 'Member eval'), s.input_ids
  from evals s
  left join evals c on c.self_eval_id = s.id
  left join eval_types t on t.id = s.type_id
  where s.kind = 'self' and s.status <> 'draft' and s.ce_id = auth.uid()
  order by s.finalized_at desc;
$$;

/** The evaluator starts their eval from a self-eval sent to them. Returns the existing one if already started. */
create or replace function public.eval_start_review(p_self uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare s evals; v_id uuid; v_rubric jsonb; st jsonb;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  select * into s from evals where id = p_self;
  if s.id is null or s.kind <> 'self' or s.status = 'draft' or s.ce_id is distinct from auth.uid() then
    raise exception 'That self-eval isn''t waiting for you.';
  end if;
  select id into v_id from evals where self_eval_id = p_self;
  if v_id is not null then return v_id; end if;
  st := coalesce(s.type_settings, eval_default_settings());
  -- 031 self-evals carried the rubric itself; later ones carry questions, so take the form's rubric.
  v_rubric := case when s.rubric ? 'pages' then s.rubric
                   else coalesce((select rubric from eval_templates where id = s.template_id),
                                 (select rubric from eval_templates where id = eval_latest_template(st -> 'form' ->> 'track')),
                                 (select rubric from eval_templates where id = '00000000-0000-4000-8000-0000000000a1')) end;
  insert into evals (kind, template_id, template_label, rubric, evaluator_id, self_eval_id, subject_id,
                     member_name, member_email, semester, division, subsystem, lead_id, input_ids, type_id, type_settings)
  values ('ce', s.template_id, s.template_label, v_rubric, auth.uid(), s.id, s.evaluator_id,
          s.member_name, s.member_email, s.semester, s.division, s.subsystem, s.lead_id, s.input_ids, s.type_id, st)
  returning id into v_id;
  perform eval_notify_inputs(v_id, '{}', s.input_ids);
  return v_id;
end;
$$;

/** The evaluator schedules (or clears, p_at null) the eval meeting once their eval is finished. Tells the person. */
create or replace function public.eval_schedule_meeting(p_id uuid, p_at timestamptz, p_place text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals; s jsonb; v_member uuid;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  select * into e from evals where id = p_id;
  if e.id is null or e.kind <> 'ce' then raise exception 'That eval no longer exists.'; end if;
  s := coalesce(e.type_settings, eval_default_settings());
  if e.evaluator_id is distinct from auth.uid() then raise exception 'Only the % who wrote this eval can do that.', eval_lbl(s, 'evaluator'); end if;
  if not coalesce((s ->> 'meeting')::boolean, true) then
    raise exception 'This kind of eval doesn''t have a meeting.';
  end if;
  if e.status = 'draft' then raise exception 'Mark your eval finished first.'; end if;
  v_member := eval_subject_account(e);
  if p_at is not null and v_member is null then
    raise exception 'Nobody has a OneSolar account for % yet, so they can''t be told. Add their email first.', coalesce(nullif(e.member_name, ''), 'them');
  end if;
  update evals set meeting_at = p_at, meeting_place = left(trim(coalesce(p_place, '')), 200), updated_at = now()
  where id = p_id or id = e.self_eval_id;
  if p_at is not null then
    perform notify_eval(coalesce(e.self_eval_id, p_id), 'meeting', array[v_member]);
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- Setup (Set up Solar Evals): eval types and groups
-- ---------------------------------------------------------------------------
create or replace function public.eval_slug(p_name text)
returns text
language sql volatile set search_path = public, pg_temp
as $$
  select coalesce(nullif(left(trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g')), 30), ''), 'item')
         || '-' || substr(md5(random()::text), 1, 4);
$$;

/** Create (p_id null) or change an eval type. Every save is kept in its history. */
create or replace function public.eval_type_save(p_id text, p_name text, p_description text, p_active boolean, p_settings jsonb, p_note text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id text := p_id;
begin
  perform require_permission('evals.types');
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the eval type a name.'; end if;
  if exists (select 1 from eval_types where lower(name) = lower(trim(p_name)) and id is distinct from p_id) then
    raise exception 'There''s already an eval type called "%".', trim(p_name);
  end if;
  perform eval_check_settings(p_settings);
  if v_id is null then
    v_id := eval_slug(p_name);
    insert into eval_types (id, name, description, active, sort, settings, updated_by, updated_by_name)
    values (v_id, trim(p_name), left(coalesce(trim(p_description), ''), 600), coalesce(p_active, true),
            coalesce((select max(sort) + 1 from eval_types), 0), p_settings, auth.uid(), coalesce(my_name(), ''));
  else
    if not exists (select 1 from eval_types where id = v_id) then raise exception 'That eval type no longer exists.'; end if;
    if not coalesce(p_active, true) and not exists (select 1 from eval_types where active and id <> v_id) then
      raise exception 'Keep at least one eval type turned on.';
    end if;
    update eval_types set name = trim(p_name), description = left(coalesce(trim(p_description), ''), 600), active = coalesce(p_active, true),
      settings = p_settings, updated_at = now(), updated_by = auth.uid(), updated_by_name = coalesce(my_name(), '')
    where id = v_id;
  end if;
  insert into eval_type_history (type_id, name, description, active, settings, note, saved_by_name)
  select id, name, description, active, settings, left(coalesce(trim(p_note), ''), 600), updated_by_name from eval_types where id = v_id;
  return v_id;
end;
$$;

/** Delete an eval type nobody has used yet. Used ones are turned off instead, so their evals keep working. */
create or replace function public.eval_type_delete(p_id text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('evals.types');
  if exists (select 1 from evals where type_id = p_id) then
    raise exception 'Evals have already been written with this type. Turn it off instead, so they keep working.';
  end if;
  if not exists (select 1 from eval_types where active and id <> p_id) then
    raise exception 'Keep at least one eval type turned on.';
  end if;
  delete from eval_types where id = p_id;
end;
$$;

/** Give the evals of this type that aren't done yet the type's current settings. Returns how many changed. */
create or replace function public.eval_type_apply(p_id text)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_settings jsonb; n int;
begin
  perform require_permission('evals.types');
  select settings into v_settings from eval_types where id = p_id;
  if v_settings is null then raise exception 'That eval type no longer exists.'; end if;
  update evals e set type_settings = v_settings
  where e.type_id = p_id and e.type_settings is distinct from v_settings
    and e.status <> 'shared'
    and not (e.kind = 'self' and exists (select 1 from evals c where c.self_eval_id = e.id and c.status = 'shared'));
  get diagnostics n = row_count;
  return n;
end;
$$;

/** Create (p_id null) or change an eval group: a named list of people, e.g. "Subsystem leads". */
create or replace function public.eval_group_save(p_id text, p_name text, p_members uuid[])
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id text := p_id;
begin
  perform require_permission('evals.types');
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the group a name.'; end if;
  if exists (select 1 from eval_groups where lower(name) = lower(trim(p_name)) and id is distinct from p_id) then
    raise exception 'There''s already a group called "%".', trim(p_name);
  end if;
  if exists (select 1 from unnest(coalesce(p_members, '{}')) m where not exists (select 1 from profiles where id = m)) then
    raise exception 'Someone in that group no longer has an account.';
  end if;
  if v_id is null then
    v_id := eval_slug(p_name);
    insert into eval_groups (id, name, members, updated_by_name)
    values (v_id, trim(p_name), array(select distinct unnest(coalesce(p_members, '{}'))), coalesce(my_name(), ''));
  else
    update eval_groups set name = trim(p_name), members = array(select distinct unnest(coalesce(p_members, '{}'))),
      updated_at = now(), updated_by_name = coalesce(my_name(), '')
    where id = v_id;
    if not found then raise exception 'That group no longer exists.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.eval_group_delete(p_id text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_used text;
begin
  perform require_permission('evals.types');
  select string_agg(name, ', ') into v_used from eval_types where settings::text like '%"value": "' || p_id || '"%';
  if v_used is not null then raise exception 'That group is used by %. Change those first.', v_used; end if;
  delete from eval_groups where id = p_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- Shared questionnaires (Edit eval rubrics)
-- ---------------------------------------------------------------------------
/** 1 to 20 questions [{id, text, hint}], tidied. */
create or replace function public.eval_clean_questions(p jsonb)
returns jsonb
language plpgsql immutable set search_path = public, pg_temp
as $$
declare v jsonb;
begin
  if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p) not between 1 and 20 then
    raise exception 'Keep between 1 and 20 questions.';
  end if;
  if exists (select 1 from jsonb_array_elements(p) q
             where jsonb_typeof(q) <> 'object'
                or coalesce(q ->> 'id', '') !~ '^[a-z0-9][a-z0-9-]{0,39}$'
                or length(trim(coalesce(q ->> 'text', ''))) not between 1 and 500
                or length(coalesce(q ->> 'hint', '')) > 200) then
    raise exception 'Every question needs some text (up to 500 characters).';
  end if;
  if (select count(distinct q ->> 'id') from jsonb_array_elements(p) q) <> jsonb_array_length(p) then
    raise exception 'Two questions have the same id.';
  end if;
  select jsonb_agg(jsonb_build_object('id', q ->> 'id', 'text', trim(q ->> 'text'), 'hint', trim(coalesce(q ->> 'hint', ''))) order by n)
    into v from jsonb_array_elements(p) with ordinality as t(q, n);
  return v;
end;
$$;

create or replace function public.eval_questionnaire_save(p_id uuid, p_name text, p_questions jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid := p_id; v jsonb;
begin
  perform require_permission('evals.templates');
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the questionnaire a name.'; end if;
  if exists (select 1 from eval_questionnaires where lower(name) = lower(trim(p_name)) and removed_at is null and id is distinct from p_id) then
    raise exception 'There''s already a questionnaire called "%".', trim(p_name);
  end if;
  v := eval_clean_questions(p_questions);
  if v_id is null then
    insert into eval_questionnaires (name, questions, updated_by_name) values (trim(p_name), v, coalesce(my_name(), '')) returning id into v_id;
  else
    update eval_questionnaires set name = trim(p_name), questions = v, updated_at = now(), updated_by_name = coalesce(my_name(), '')
    where id = v_id and removed_at is null;
    if not found then raise exception 'That questionnaire no longer exists.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.eval_questionnaire_remove(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_used text;
begin
  perform require_permission('evals.templates');
  select string_agg(name, ', ') into v_used from eval_types where settings -> 'questionnaire' ->> 'id' = p_id::text;
  if v_used is not null then raise exception 'That questionnaire is used by %. Change those first.', v_used; end if;
  update eval_questionnaires set removed_at = now() where id = p_id;
end;
$$;

-- A CE's own questions use the same checks.
create or replace function public.eval_questions_save(p jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v jsonb;
begin
  perform require_permission('evals.write');
  v := eval_clean_questions(p);
  insert into eval_questions (owner_id, questions, updated_at) values (auth.uid(), v, now())
  on conflict (owner_id) do update set questions = excluded.questions, updated_at = now();
end;
$$;


-- ---------------------------------------------------------------------------
-- Forms (Edit eval rubrics)
-- ---------------------------------------------------------------------------
/** Add a form (p_parent null) or a variant of one (e.g. a division), or rename / recolour one. */
create or replace function public.eval_form_save(p_id text, p_name text, p_color text, p_parent text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id text;
begin
  perform require_permission('evals.templates');
  if coalesce(trim(p_name), '') = '' then raise exception 'Give it a name.'; end if;
  if p_id is null then
    if p_parent is not null and not exists (select 1 from eval_tracks where id = p_parent and parent_id is null and removed_at is null) then
      raise exception 'That form no longer exists.';
    end if;
    v_id := eval_slug(p_name);
    insert into eval_tracks (id, name, kind, parent_id, color, created_by, sort)
    values (v_id, trim(p_name), case when p_parent is null then 'master' else 'ce' end, p_parent, coalesce(p_color, '#5d6d7e'), auth.uid(),
            coalesce((select max(sort) + 1 from eval_tracks), 0));
    return v_id;
  end if;
  update eval_tracks set name = trim(p_name), color = coalesce(p_color, color), updated_at = now() where id = p_id and removed_at is null;
  if not found then raise exception 'That form no longer exists.'; end if;
  return p_id;
end;
$$;

/** Older pages: add a division (a variant of the master template), or rename / recolour one. */
create or replace function public.eval_track_save(p_id text, p_name text, p_color text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return eval_form_save(p_id, p_name, p_color, case when p_id is null then 'master' end);
end;
$$;

/** Take away a form (and its variants) nobody's eval type uses. Evals written on it keep their own copy. */
create or replace function public.eval_form_remove(p_id text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_used text; v_top text;
begin
  perform require_permission('evals.templates');
  select coalesce(parent_id, id) into v_top from eval_tracks where id = p_id and removed_at is null;
  if v_top is null then return; end if;
  select string_agg(name, ', ') into v_used from eval_types
  where settings -> 'form' ->> 'track' in (select id from eval_tracks where id = p_id or parent_id = p_id);
  if v_used is not null then raise exception 'That form is used by %. Pick another form there first.', v_used; end if;
  update eval_tracks set removed_at = now() where id = p_id or parent_id = p_id;
end;
$$;

create or replace function public.eval_template_save(p_track text, p_label text, p_note text, p_based_on uuid, p_rubric jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  perform require_permission('evals.templates');
  if not exists (select 1 from eval_tracks where id = p_track and removed_at is null) then
    raise exception 'That form no longer exists.';
  end if;
  if coalesce(trim(p_label), '') = '' then
    raise exception 'Give the version a name, e.g. Spring 2027.';
  end if;
  perform check_rubric(p_rubric);
  if exists (select 1 from eval_templates where track_id = p_track and lower(label) = lower(trim(p_label)) and removed_at is null) then
    raise exception 'This form already has a version called "%". Pick another name.', trim(p_label);
  end if;
  insert into eval_templates (track_id, label, note, based_on, rubric, author_id, author_name)
  values (p_track, trim(p_label), coalesce(trim(p_note), ''), p_based_on, p_rubric, auth.uid(), coalesce(my_name(), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.eval_template_remove(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_track eval_tracks;
begin
  perform require_permission('evals.templates');
  select t.* into v_track from eval_tracks t join eval_templates v on v.track_id = t.id where v.id = p_id and v.removed_at is null;
  if v_track.id is null then return; end if;
  if v_track.parent_id is null and (select count(*) from eval_templates where track_id = v_track.id and removed_at is null) = 1 then
    raise exception 'The "%" form needs at least one version.', v_track.name;
  end if;
  update eval_templates set removed_at = now(), removed_by = auth.uid() where id = p_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- Who can call what
-- ---------------------------------------------------------------------------
revoke execute on function
  public.eval_default_settings(), public.eval_lbl(jsonb, text), public.eval_rule_match(jsonb, uuid), public.eval_stage_ok(text, text),
  public.eval_check_rule(jsonb, text, text[]), public.eval_check_settings(jsonb),
  public.eval_visible_to_me(jsonb, text, uuid, uuid, uuid[]), public.eval_answers_visible(uuid),
  public.eval_check_ratings(jsonb, jsonb), public.eval_template_fits(text, jsonb), public.eval_latest_template(text),
  public.eval_type_for_new(text), public.eval_require_evaluator(jsonb, text), public.eval_check_inputs(jsonb, uuid[], uuid[], text, uuid),
  public.eval_inputs_from(jsonb), public.eval_notify_inputs(uuid, uuid[], uuid[]), public.eval_type_questions(jsonb, uuid),
  public.eval_subject_account(evals), public.eval_slug(text), public.eval_clean_questions(jsonb),
  public.eval_input_note_save(uuid, text), public.eval_inbox(),
  public.eval_type_save(text, text, text, boolean, jsonb, text), public.eval_type_delete(text), public.eval_type_apply(text),
  public.eval_group_save(text, text, uuid[]), public.eval_group_delete(text),
  public.eval_questionnaire_save(uuid, text, jsonb), public.eval_questionnaire_remove(uuid),
  public.eval_form_save(text, text, text, text), public.eval_form_remove(text)
from public, anon;
grant execute on function
  public.eval_default_settings(), public.eval_rule_match(jsonb, uuid), public.eval_stage_ok(text, text),
  public.eval_visible_to_me(jsonb, text, uuid, uuid, uuid[]), public.eval_answers_visible(uuid),
  public.eval_input_note_save(uuid, text), public.eval_inbox(),
  public.eval_type_save(text, text, text, boolean, jsonb, text), public.eval_type_delete(text), public.eval_type_apply(text),
  public.eval_group_save(text, text, uuid[]), public.eval_group_delete(text),
  public.eval_questionnaire_save(uuid, text, jsonb), public.eval_questionnaire_remove(uuid),
  public.eval_form_save(text, text, text, text), public.eval_form_remove(text)
to authenticated;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '36') where key = 'general';
