# Solar Evals

**https://one.ufsolargators.org/evals/** · [`evals/index.html`](../evals/index.html)

Semester reviews, filled out online instead of on paper. Sign in with your **[one.solar](https://one.ufsolargators.org/)** account; everything is kept in the one.solar (Orders) database (migrations `028`, `031`, `032`, `036_eval_types.sql`, `037_eval_form_names.sql`, `038_eval_communication.sql`, `039_eval_more_forms.sql`, `053_eval_assignments.sql`, `054_eval_chart.sql` and `055_eval_see_every.sql`).

Everything below is set up on the page, not in code: the forms, the questionnaires, and the whole flow for each kind of eval.

## Kinds of eval (Settings tab)

People with **Set up Solar Evals** (`evals.types`, Admin and E-board by default) see **Setup**. Each **eval type** is the whole rundown for one kind of eval:

- **What to call people:** e.g. Officer / President / Lead / Position. Buttons, messages and emails use these words.
- **Who evaluates whom:** who is evaluated, who evaluates, and who gives input. Each one is anyone, a permission ("Fill out evals"), a one.solar position, a **group**, or one person. Groups (Setup → Groups) are named lists of people, so nobody needs a new position just for evals.
- **From the evaluation chart** (a choice for who is evaluated and who evaluates): the **Chart** tab (below) decides. **Assigned** (on or off) keeps the type's own rules but uses the chart page's exceptions.
- **Input from:** on or off; up to how many people; whether the person evaluated, the evaluator or either picks them; and whether they can leave **private notes** for the evaluator while it's a draft. The person evaluated never sees the notes.
- **The form:** which form it uses, and whether people pick a variant of it (a division or a position). **Other forms they can pick** lists more forms: whoever starts an eval then picks any of them (or their variants) instead.
- **Self-eval questionnaire:** on or off. The questions come from each evaluator's own list, or from a shared questionnaire.
- **Steps:** whether there's a meeting, and whether the person can comment on their eval.
- **Who sees what, and when:** for the self-eval answers and for the eval: the person evaluated, the evaluator, the people giving input, "See all evals", and one more group you choose (e.g. the E-board position). The database enforces this.
- **Emails:** self-eval submitted, asked for input, eval finished, meeting scheduled, eval shared.

At the top, **How a … eval goes** spells out the flow in plain words as you change it, and it warns you about anything that won't work.

Every eval keeps a copy of its type's settings from when it started, so changing a type only changes new evals. **Apply to evals in progress** gives the open ones (anything not shared yet) the new settings. **History** keeps every save. A type nobody has used can be deleted; a used one is turned off instead.

**E-board eval** (added by 039): the E-board position evaluates the E-board. When you start one you pick the form: the person's position on the Leadership eval, or the Member eval (tick more under Other forms they can pick). Up to 3 people give input, picked by the evaluator, with private notes; no self-eval; a meeting, then it's shared. Change any of it in Setup.

**Member eval** is the original flow: the member answers their CE's questions → the CE writes the eval with the subsystem lead's input → once it's finished, the CE sees the answers and schedules the meeting → after the meeting the CE shares it, and the member reads both and can comment.

Example, **the President evaluates the CEs with feedback from their leads**:
1. Make a "Leads" group with the leads in it.
2. Make a type: the person evaluated is the Chief Engineer position, the evaluator is one person (the President), and input comes from the Leads group, picked by the evaluator, with notes. The form is Leadership eval with variants (the position). Turn the questionnaire off. The CE sees the eval once it's finished, the leads see it while it's being written, and the E-board sees it once it's finished.

## The evaluation chart: who evaluates whom (053, 054)

People with **Assign evaluators** (`evals.assign`, Admin and the **President** position by default) see the **Chart** tab: one org chart for the whole team, drawn from the chart's settings (on a phone, as an indented outline). It starts as the team's "Evaluation Flow" drawing:

- **President** at the top, evaluated by the **VP**, with feedback from the rest of the E-board and the Chief Engineers.
- Under the President: **Chief Engineer** (feedback from the other CEs), **Vice President**, **Treasurer** (feedback from the CEs), **Secretary**, **Business Coordinator**, each evaluated by the President.
- Under the CE: **Subsystem Lead** and **Integration Project Manager** (feedback from the other PMs), evaluated by the CEs.
- **Members**, evaluated by their CE on the Member eval, with input they pick from the **Subsystem Leads**.

Click a box to change it: where it **sits**, its **eval type**, who it's **evaluated by**, **feedback from** (everyone in those positions is added as input when the eval starts, never the person or their evaluator; ticking its own position means "the others in it"; the input limit doesn't count them), **input picked from** (instead of everyone: the person or evaluator picks, e.g. their own subsystem lead), its **form** (picked for them, e.g. the Treasurer's), and a **note** shown on the box. **+ Add a position** puts another one.solar position on the chart; **Take off the chart** moves the boxes under it up.

**Which evals use the chart:** a switch per eval type (Admin, the President, or anyone who can "Set up Solar Evals"). On, "Who evaluates" (and "Who is evaluated", unless anyone can be) become **From the evaluation chart**: nobody else can be picked or start the eval, and the database enforces it, also on submit. Off puts back the rules the type had. Nothing switches by itself: after 054 the Member eval and the E-board eval work as before until someone turns the chart on. Setup offers "From the evaluation chart" in the same two places.

- **Boxes are positions.** Give people their positions in Admin → Users. E-board members keep **E-board** (it decides what they can do) and add their title; the titles carry no permissions except the President's "Assign evaluators". 053 added **President**, **Vice President** and **Secretary**; 054 added **Subsystem Lead** and **Integration Project Manager**. Add more in Admin → Roles & permissions → New position.
- **Exceptions for one person** (below the chart): "Kim, evaluated by Cy". A person's own rows replace what the chart says for them.
- **Someone the chart doesn't place** (or whose evaluator position is empty right now) picks from the list as before. **Everyone who gets … evals** shows who evaluates each person, whose feedback goes in, and who isn't on the chart.
- **Assigned** (053, in Setup) is the older switch for a type that keeps its own rules but uses the exceptions.

## Guardrails: who gets each eval and who may write it (065)

Set per eval type in **Setup**; the database enforces each one, so nobody gets around them by editing the page.

- **Leave out people whose position has its own eval** (under Who is evaluated; on for the Member eval). Subsystem Leads, the Integration PM, the E-board titles and the CEs also hold Member, but the evaluation chart gives their position its own eval (Leadership), which already covers their member work. With this on they can't start the Member eval self-eval and nobody can start one about them. Turn it off if someone should get both.
- **Except people in these positions** (under Who is evaluated and Who evaluates): tick positions to leave out of the rule above even when they fit it, for anything the switch above doesn't cover.
- **Feedback isn't evaluating.** Someone the chart lists under **Feedback from** on a person's eval can't write that eval; they're told who does and are added as input when it's started. (E-board members give feedback on each other; the person the chart assigns writes the eval.)
- **Only who's assigned** (shown when the type uses assignments or the chart): when on, someone nobody is assigned to can't be evaluated until an Admin or the President assigns an evaluator. Off, anyone on Who evaluates may, as before.
- **Check these rules**: lists evals already started that don't fit the type's rules now (someone left out of it, an evaluator who isn't the one assigned, someone who only gives feedback), with **Open**, **Change evaluator** and **Delete…** on each. Nothing changes by itself; deleted evals can be put back. It checks the saved rules, so save first.

## Changing the evaluator (059)

Picked the wrong CE? Whoever can **Assign evaluators** (Admin and the President) sees **Change…** next to the evaluator on Evaluations. On a self-eval it changes who it goes to, and an evaluation already started from it moves along while it's still a draft (the new evaluator carries on with what's written); on an evaluation it changes who writes it. It works even when the assignments or the chart say someone else. A finished or shared evaluation has to go back to a draft first. Each change is kept with who, when and why, and the new evaluator is told about a submitted self-eval.

## Deleting a wrong eval (059)

Someone made an eval by mistake (the wrong type, the wrong person, a duplicate)? Whoever can **Assign evaluators** sees **Delete…** on each row of Evaluations, at any stage (the writer can still delete their own drafts as before). When an evaluation has a self-eval with it, a box also deletes the self-eval. A copy is kept: **Deleted evals**, at the bottom of Evaluations, lists who, when and why, and **Put back** restores it as it was, with its input notes (a self-eval is linked to its evaluation again).

## Troubleshooting: see every eval (055)

**See every eval (troubleshooting)** (`evals.all`, Admin only by default) reads every evaluation, drafts included, and every submitted self-eval, whatever each type's "Who sees what" says. It's read only: it doesn't let anyone change, finish, share or delete an eval, and nobody is told. The eval shows a note saying why you can read it. Self-eval drafts stay private, and so do input notes. Untick it in Admin → Roles & permissions once you're done troubleshooting.

**Divisions & subsystems (056).** Once people are in their divisions and subsystems (My account, or Admin → Divisions & people), a self-eval fills in their subsystem and division form, a new eval about someone does the same, and the input picker lists people from the same subsystem first. See docs/orders.md → Divisions & subsystems for people.

**Picking the CE division and subsystem.** A self-eval asks for the **CE division** and then that division's **subsystem**, both from the team's lists in Admin → Divisions & people (archived ones aren't offered), already filled in with the person's own if they're set. **Other (not listed)…** on either opens a box to type it in. The division is required to start; both can be changed at the top of the form while it's a draft. When a type's form has a variant per division, the division picked also picks that form, so nobody is asked twice. Eval types whose variants are something else (e.g. leadership positions) still pick the variant. An evaluator's eval shows the same lists. On the Summary, everyone is placed by their division and subsystem in Admin → Divisions & people, so it matches Admin whatever their eval says. Someone not listed there is placed from their eval, read loosely ("Aero-Structures" counts as "Aero / Structures"; a division typed as the subsystem, like "Electrical", counts as that division), and Team makeup names them so they can be added in Admin. Keep Admin → Divisions & people up to date: it's the list everyone picks from.

**Preview as a member.** On the Settings tab, **Preview as a member** (for types with a self-eval) opens the start window exactly as a member sees it, then the self-eval form with your name in it. Type, pick and press anything: nothing is saved, submitted or emailed, and the dashed banner says so. **Back to Setup** (or End preview) leaves it. Save changes to the type first; the preview uses the saved settings.

## Forms

**Forms** holds every form and its versions. A form can have **variants**, e.g. one per CE division or per leadership position; a variant starts as a copy of the main form. Every saved version is kept, and evals keep their own copy.
- **+ New form** / **+ Add a variant**, then **Start from a blank form** or a copy of any version. **Rename** and **Remove** (only when no eval type uses it) are in the toolbar.
- **Editing:** click any text on the pages to change it. The bar above the pages sets the **rating scale** (2 to 10 levels), whether **N/O** is offered, **+ Add page** and **↶ Undo**.
- **On each page:** move, copy or delete the page. For rows: move, copy, write-in line, move to another page, and remove.
- **Header fields:** each one says what it's filled in with (who it's for, the semester, the variant, the evaluator, the people giving input, a date, or free text).
- **Written boxes:** each one is a plain answer, the person's own comments, or **Evidence** (needed for ratings away from the middle).
- **No empty rating table:** a page with no rating rows has no rating table.
- **Before saving**, the save dialog lists anything that looks wrong (missing level descriptions, empty pages, no "who it's for" field).
- **History** and **Compare** show what changed between any two versions.

The **Leadership eval** form came from the leadership positions PDF: a main form plus a variant for each position (8 of them since 037: one **Chief Engineer** and one **Integration Project Manager** form for both divisions, with a **Division** field). The **Member eval** form has a variant for each division's members. On every form, **Communication** also rates the personable side: how approachable and easy to work with someone is (038, as v1.1 of each form). The main form's second page has four "Position duty" write-in rows, and their level text is placeholder.

## Questionnaires

- **Your own questions** (anyone with "Fill out evals"): the self-eval questions people answer when they pick you, for eval types whose questions come from the evaluator.
- **Shared questionnaires** (anyone with "Edit eval rubrics"): named lists of questions to pick for an eval type in Setup.

You can copy questions from the defaults, other questionnaires and other evaluators. A submitted self-eval keeps the questions it was answered with.

## Evaluations

- **Fill out my self-eval** (for kinds with a questionnaire): pick the kind, your variant, your evaluator and (if allowed) who gives input, then answer and **Submit**. You can **Take back** until they start theirs.
- **Self-evals sent to you** → **Start your eval**. Or **New evaluation**: pick the kind, the form version and who it's for.
- **On the eval:** click a box to rate it (click again to clear). Add or remove the people giving input; notes from them appear above the form. It saves as you go.
- **Mark finished** checks for unrated rows and for missing evidence. Then the buttons follow the kind: **Schedule meeting**, **Share**.
- **The banner** on every eval says who can read it now and who will next.
- **Print / PDF** prints the filled-in form on the same landscape pages as the paper one.

For testing on your own computer, `/evals/?fake` on `localhost` uses the same in-browser database as Orders' fake mode (`tools/fake-supabase.js`, every migration).
