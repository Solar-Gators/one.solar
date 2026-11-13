# Solar Evals

**https://solar-gators.github.io/one.solar/evals/** · [`evals/index.html`](../evals/index.html)

Semester reviews, filled out online instead of on paper. Sign in with your **[one.solar](https://solar-gators.github.io/one.solar/)** account; everything is kept in the one.solar (Orders) database (migrations `028`, `031`, `032`, `036_eval_types.sql`, `037_eval_form_names.sql`, `038_eval_communication.sql` and `039_eval_more_forms.sql`).

Everything below is set up on the page, not in code: the forms, the questionnaires, and the whole flow for each kind of eval.

## Kinds of eval (Setup tab)

People with **Set up Solar Evals** (`evals.types`, Admin and E-board by default) see **Setup**. Each **eval type** is the whole rundown for one kind of eval:

- **What to call people:** e.g. Officer / President / Lead / Position. Buttons, messages and emails use these words.
- **Who evaluates whom:** who is evaluated, who evaluates, and who gives input. Each one is anyone, a permission ("Fill out evals"), a one.solar position, a **group**, or one person. Groups (Setup → Groups) are named lists of people, so nobody needs a new position just for evals.
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
