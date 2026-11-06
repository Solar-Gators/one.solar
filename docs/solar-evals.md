# Solar Evals

**https://solar-gators.github.io/one.solar/evals/** · [`evals/index.html`](../evals/index.html)

Semester member reviews, filled out online instead of on paper. Sign in with your **[OneSolar](https://solar-gators.github.io/one.solar/)** account; everything is kept in the OneSolar (Orders) database (it needs the migrations `028_solar_evals.sql`, `031_eval_self_reviews.sql` and `032_eval_questions.sql`).

**Rubrics** holds the master template and a version for each CE division. Every saved version is kept, so the next CE sees what the last one used and why they changed it.
- **Make your version:** open your division and click **Start from master** (or **Make a new version**). Click any text on the pages to change it, add or remove criterion rows, then **Save as new version** with a note on what changed.
- **History** lists every version. **Compare** shows exactly what changed between any two. If the master changes after you made your version, your division shows a note linking to the changes.

**Evaluations** is where members and CEs fill out reviews. The usual order each semester:
1. **The member** clicks **Fill out my self-eval**, picks their division, CE and lead, answers their CE's questions and clicks **Submit**. Their CE is emailed. (They can **Take back** until the CE starts theirs.)
2. **The CE** sees it under **Self-evals sent to you** and clicks **Start your eval** (same rubric). They fill it out with the lead's input. They don't see the member's answers yet.
3. When the CE clicks **Mark finished**, the member's answers appear above their eval. The CE clicks **Schedule meeting**, and the member is emailed the time and place.
4. After the meeting the CE clicks **Meeting done: share**. The member then reads the CE's eval and can add comments.

**Questions** (CEs) is where each CE sets the questions their members answer (up to 20). **Use this list** or **+ Add** copies another CE's questions (or the defaults) into yours. A CE who hasn't saved any uses the defaults. A submitted self-eval keeps the questions it was answered with.

CEs can still start an eval without a self-eval:
- **New evaluation:** pick the rubric (your division's latest), the member's name, their email (optional, for sharing) and the semester. Click a box to rate it (click again to clear), or N/O. Fill in the blanks and feedback boxes. It saves as you go.
- **Mark finished** checks for unrated rows, and for 1/2/4/5 ratings with no evidence. A finished eval can be read by every CE, the e-board, and the subsystem lead you picked. **Share with member** lets the member read it and add their comments; it needs a OneSolar account with that email.
- **Print / PDF** prints the filled-in form, on the same two landscape pages as the paper one.

Leads and members see only what's theirs; the database decides that, not the page.

For testing on your own computer, `/evals/?fake` on `localhost` uses a stand-in database from `evals/dev/fake-supabase.js` (kept out of the repo).
