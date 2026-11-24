# Jira hands-on run vs one.solar Projects (2026-11-23)

A real Jira Cloud site (`ufl-team-vktyh7iu.atlassian.net`, team-managed Kanban space **Car 6 Battery Pack**) was set up and used to build a small battery-pack project, then compared with one.solar Projects on `origin/main`. Local research branch only; nothing here is a change to one.solar.

**Important caveat:** the site is on a **Premium trial**, not Free. Anything marked (P) may be Premium-only.

Legend: ✅ tested by hand in Jira · 📖 seen in Jira's UI/menus but not exercised · ❌ couldn't test (see the checklist at the end).

## What was built

- 4 epics (Modules, BMS, Enclosure, Integration & Testing), 11 tasks under them, 3 subtasks under "BMS PCB layout". ✅
- A custom **Subsystem** dropdown field on Task (Modules / BMS / Enclosure / Integration). ✅
- A custom **electrical workflow** for Task + Subtask: To Do → Schematic Review → Fab → Bench Test → Done (plus the original "any status" moves). ✅
- Dates, an assignee, a "blocks" link (Cell characterization blocks Module busbar design), a bulk priority change, Calendar view added. ✅

## Findings, area by area

### 1. Creating work
| Jira | Status | one.solar today | Take it? |
|---|---|---|---|
| Inline create row on Timeline: type picker + title + date + assignee, **Enter keeps the row open** for the next one. 4 epics in ~15 s. | ✅ | Quick add with Enter, same idea (`quick.js`). | Already have it. |
| Hover a row → **edit / + (add child) / ⋯** right on the row. | ✅ | Timeline row ⋯ → "Add under it". | Small win: a visible **+** on hover (visual, needs approval). |
| New children are inserted **at the top** (reverse of typing order). | ✅ | — | Jira annoyance; don't copy. |
| Onboarding asks for statuses as a plain editable list (To Do / In Progress / In Review / Done + Add status). | ✅ | Templates (Simple board / Engineering design / Manufacturing). | Ours is fine. |

### 2. Fields and forms
| Jira | Status | one.solar today | Take it? |
|---|---|---|---|
| A work type's settings page **is** its form: "Description fields" (main column) and "Context fields" (side), a "Hide when empty" line, and a **field palette on the right** (Short text, Paragraph, Date, Number, Formula, Time stamp, Labels, Dropdown, Checkbox, People, Dependent dropdown, URL). Clicking a palette tile adds the field in place with its options; Ctrl+S saves. | ✅ | Fields and Forms are **separate** pages under Settings (more power: per-move forms, sections, limits). | **Strongest UX idea from the run.** Keep our engine, but offer a combined "type → its form + field palette" editor. Visual → needs approval. |
| Dropdown options each get a **color**. | ✅ | Check: our dropdown options have no color (to verify). | Small, worth it. |
| In a team-managed space a field belongs to **one work type**; a "global field" goes through a separate Fields page. | ✅ | Ours: project fields, limited to types. | Ours is simpler. |
| Per-person **"Pin to top"** for fields on the item page. | 📖 | No. | Nice-to-have. |

### 3. Workflows
| Jira | Status | one.solar today | Take it? |
|---|---|---|---|
| Default workflow: every status has an **"Any"** move into it (free movement). Specific moves are opt-in. | ✅ | Same mechanism (`from_status null`); "Simple board" is free, Engineering/Manufacturing are one step at a time. | Same. |
| **Diagram and Text views** of the same workflow; the Text view is a status → incoming-moves table. Keyboard: M move, Delete, arrows pan, +/− zoom. | ✅ | Drawing + status/move tables. | Same idea. |
| A status nobody can reach gets a **dashed orange outline + "This status needs a transition"** warning; the panel lists Incoming / Outgoing with + buttons. | ✅ | Not found in `workflowEditor.js`. | **Take it** (validation, small). |
| Statuses need a **category** (To do / In progress / Done) that also sets the color; Jira warns a team-managed status only exists in this space. | ✅ | Same categories. | Same. |
| Edits are a **draft** until "Update workflow"; on save Jira asks **which work types** use it. Splitting into several workflows **locks board columns** (they move to settings). | ✅ | Saves show a preview; types pick workflows; board columns are a separate saved mapping. | Ours is better here. |
| Move rules: **Restrict** (subtasks in a status, field value, has been through a status, not the person who did an earlier move, only certain people), **Validate** (field value, has been through a status, parent in a status, has a permission), **Actions** (assign, copy a field, update a field, run an agent). | 📖 | Roles, required fields, comment, approval (optionally not the owner), a condition, follow-up actions. | Gaps worth adding: **"all subtasks done"**, **"parent is in status X"**, **"has been through status X"**. No approval step exists in Jira Software itself; ours is ahead. |

### 4. Board
| Jira | Status | one.solar today | Take it? |
|---|---|---|---|
| New statuses **auto-create columns appended after Done**, in creation order (Fab, Bench Test, Schematic Review). | ✅ | Columns are a saved mapping. | Jira weakness; ours is better. |
| Cards show the **parent epic as a chip with a dropdown** (change parent from the card). | ✅ | To verify on our cards. | Small, worth it (visual). |
| Right-click a card: Move, **Change status (only allowed moves shown)**, Copy link/key, Link work item, Change parent, Labels, Flag, Archive. | ✅ | Card **Move** menu; moves checked by the DB. | Add Change parent / Copy link / Flag to our card menu (visual). |
| Board ⋯ → **Stand-up** mode, Configure columns, Manage workflows. | 📖 | Weekly review dashboard. | Stand-up mode is a cheap idea for subsystem meetings. |
| Drag-and-drop. | ❌ | Native DnD + Move menu. | You test it (checklist). |

### 5. List and bulk edit
| Jira | Status | one.solar today | Take it? |
|---|---|---|---|
| Tree list (parents expand), **one click turns a cell into an editor**, Enter saves (start date sometimes needed a click away). | ✅ | Edit in place with Undo. | Same; ours has Undo, Jira doesn't. |
| Default list shows **36 of 49 columns**: very wide. | ✅ | Chosen columns. | Jira weakness. |
| Bulk bar: N selected · Select all · Edit fields · Change status · Watch · Delete. **Edit fields** side panel: every field "Keep as is" / Clear, searchable, then a **review step** with an opt-in "Send mail" box. | ✅ | Bulk bar; bulk edits never email. | Consider the **review step** for big bulk edits. |

### 6. Links and dependencies
| Jira | Status | one.solar today | Take it? |
|---|---|---|---|
| Link types: **blocks / is blocked by, clones, duplicates, relates to**. Picker takes a key, search, or **pasted URL**; multi-select; "Recently viewed"; AI "link similar". | ✅ | Only **scheduling dependencies** (FS/SS/FF/SF + lag). No "relates to" / "duplicates". | **Gap.** Fits the related-records registry: item ↔ item "relates to" as just another link type. |
| Linked items show their **live status, changeable in place**. | ✅ | Orders/Inventory links show live status. | Same pattern; keep it for every registry type. |
| **Escape discards the whole link form.** | ✅ | — | Don't copy. |
| Timeline draws the dependency arrow; clicking it shows "A (due Dec 18) blocks B (starts Dec 21)". | ✅ | Arrows, four kinds, lag, critical path, what-if. | Ours is far ahead. |
| JQL `issueLinkType = "is blocked by"` finds blocked work. | ✅ | My work shows "blocked (and why)". | Ours is friendlier. |
| Warning when a plan breaks a dependency. | ❌ | Schedule warnings name the item holding it up. | You test it (checklist). |

### 7. Timeline, Calendar, views
| Jira | Status | one.solar today | Take it? |
|---|---|---|---|
| Timeline: epic bars **roll up** children; Weeks / Months / Quarters; view settings are only: hide done, inline hierarchy, show Assignee/Status/Warnings/Dependencies, bar color by status or custom. Expand state **isn't remembered**; the left table takes most of the width. | ✅ | Levels, Fit, Rows, Plan, Present; remembers state. | Ours is ahead; Jira's **short settings list** is a lesson in restraint. |
| **Calendar**: month grid, items span start→due, an **"Unscheduled work" side panel** you drag onto a day to schedule. | ✅ (drag ❌) | Calendar + Timeline "Only undated" filter. | **Take the always-visible unscheduled panel** (visual). |
| Views are **optional tabs per space** (Archived, Attachments, Backlog, Calendar, Capacity, Development, Goals, List, Releases, Reports, Shortcuts) added with "+". | ✅ | Fixed tabs. | Good idea for a small team: fewer tabs by default (visual). |

### 8. Summary, For you, search
| Jira | Status | one.solar today | Take it? |
|---|---|---|---|
| Summary: 7-day cards (completed / updated / created / due soon), status donut, recent activity, priority breakdown, types of work, **team workload**, **epic progress**. | ✅ | Summary: progress three ways, coming up, people, latest changes; Workload dashboard. | Close; "due soon" + epic progress cards are cheap adds. |
| "For you": recent spaces, Assigned to me / Starred / Worked on / Viewed. | ✅ | My work (richer). | Ours is ahead; "Worked on / Viewed" tabs are a cheap add. |
| Search: Basic ↔ JQL toggle, **Ask AI**, Save filter, default filters (My open, Reported by me, Open, Done, Viewed / Created / Resolved / Updated recently). | ✅ | Condition builder, saved views. | The **default filter list** is worth copying (no UI change needed beyond a list). |

### 9. Automation, access
| Jira | Status | one.solar today | Take it? |
|---|---|---|---|
| Automation is **template-first**: 83 templates, "try these 3 simple flows" (assign on move, close parent when children done, close children when parent done). **Recurring work = a "Schedule a recurring ticket" template**, not its own feature. | 📖 | Rules engine (when / if / then, try it, logs). | **Ship starter rule templates**; build recurring work as a rule template, not a new table. |
| Access: Open / Limited / Private + access requests + a role per person. | 📖 | Visible-to-team or private + project roles. | Same shape. |

## What this changes in the plan

1. **Recurring work:** build it as a **scheduled rule template** on the existing rules engine, not a new `pm_recurrences` table.
2. **Related records registry:** add **item ↔ item "relates to / duplicates"** as registry link types, separate from scheduling dependencies. Every registry link shows live status, changeable where the owning app allows it.
3. **Workflow editor:** add the **unreachable-status warning**, and three move rules: all subtasks done, parent in status X, has been through status X.
4. **Starter rule templates:** close parent when all children are done; assign on move; remind before due.
5. **Visual proposals for your approval (not built):**
   - V5: combined "work type → form + field palette" editor.
   - V6: always-visible "Unscheduled" panel on the Calendar.
   - V7: optional view tabs per project.
   - V8: hover **+** to add a child on rows; parent chip on cards; a richer card right-click menu.
   - V9: Stand-up mode on the board.
6. **Don't copy:** reverse-order children, auto columns after Done, 36 default list columns, Escape discarding forms, unremembered expand state.

## Your 10-minute checklist (I couldn't do these)

Signed in to the same site, space **Car 6 Battery Pack**:
1. **Board drag:** drag "Module spot-weld build" from To Do to Schematic Review, then try dropping it straight on Bench Test. Does Jira block the move or hide that column while dragging?
2. **Column reorder:** board ⋯ → Configure columns. Drag Schematic Review, Fab and Bench Test between In Progress and Done, then click Publish. How easy is it?
3. **Timeline drag:** drag the Module busbar design bar left so it starts before Dec 18. Does a warning or a red dependency line appear?
4. **Calendar:** drag an item from "Unscheduled work" onto a day.
5. **Second person (optional):** invite a second email as a Member and check what they can change in settings.

Tell me what you saw (or screenshots), and I'll fold it in.
