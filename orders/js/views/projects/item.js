/**
 * Projects: one work item. What's expected, when it's due, who's responsible, what's holding it up, which
 * documents matter and what "done" means, then the working parts: checklist, sub-items, dependencies, linked
 * documents and one.solar records, comments and the full history. Which fields show, and which are required,
 * comes from the project's form layout for this kind of item.
 */
import { esc, fmtDate, fmtDateTime, askText, takeFlash, setFlash } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { PRIORITIES, DEP_KINDS, layoutFor, movesFor, fieldLabel, findMentions, relDay } from '../../projects/core.js';
import { evalFormula } from '../../projects/formula.js';
import { appUrl } from '../../../../shared/onesolar.js';
import { needsDatabase, loadBase, loadConfig, can, header, itemHref, projectHref, personName, avatar, statusChip, typeBadge, priorityChip, dueChip, rich, formDialog, attempt, toast,
  formSections, readFields, bindOrgPickers, loadParents, runMove, createItemDialog } from './kit.js';
import { addDocDialog, docLink } from './docs.js';
import { alumniShareCard, bindAlumniShare } from './alumni.js';

export async function renderItem(el, { config, params, rerender }) {
  const missing = needsDatabase(config);
  if (missing) return void (el.innerHTML = missing);
  const b = await loadBase();
  const item = await pm.itemByKey(params.id.toUpperCase());
  if (!item) {
    el.innerHTML = `<section class="card no-access"><h1>No item "${esc(params.id)}"</h1><p>It doesn't exist, or it's in a project you can't see.</p>
      <div class="form-actions"><a class="btn btn-primary" href="#/projects">My work</a></div></section>`;
    return;
  }
  if (item.key !== params.id.toUpperCase()) return void (location.hash = itemHref(item.key)); // it moved projects: its new name
  const project = b.projectById.get(item.project_id);
  const [cfg, x] = await Promise.all([loadConfig(b, project.id), pm.itemExtras(item.id)]);
  const type = cfg.typeById.get(item.type_id);
  const status = cfg.statusById.get(item.status_id);
  const may = (cap) => can(b, project.id, cap);
  const collab = x.people.filter((p) => p.kind === 'collab').map((p) => p.user_id);
  const watchers = x.people.filter((p) => p.kind === 'watch').map((p) => p.user_id);
  const mayEdit = !item.archived_at && (may('edit') || (may('create') && (item.owner_id === b.me || item.reporter_id === b.me || collab.includes(b.me))));
  const moves = !item.archived_at && may('transition') ? movesFor(cfg, item, cfg.who) : [];
  const pending = x.approvals.find((a) => a.status === 'pending');
  const lastDecision = x.approvals.find((a) => a.status === 'rejected');

  // the other ends of dependencies, and linked records, read with my own access
  const others = await pm.itemsByIds([...new Set([...x.depsIn.map((d) => d.from_item), ...x.depsOut.map((d) => d.to_item), item.parent_id].filter(Boolean))]);
  const otherById = new Map(others.map((o) => [o.id, o]));
  const invIds = x.refs.filter((r) => r.kind === 'inventory').map((r) => r.ref_id);
  const [orders, stock, reserved] = await Promise.all([
    pm.requestsByIds(x.refs.filter((r) => r.kind === 'order').map((r) => r.ref_id)).catch(() => []),
    pm.inventoryByIds(invIds).catch(() => []),
    pm.inventoryReserved(invIds).catch(() => ({})),   // 061
  ]);
  /** 061: an Inventory part's stock for this item: what it needs, and whether what's left after other open items is enough. */
  const partLine = (r, o) => {
    if (!o) return '<span class="muted small">(open Inventory to see stock)</span>';
    const unit = esc(o.unit || '');
    const need = r.qty === null || r.qty === undefined ? null : Number(r.qty);
    const others = (Number(reserved[r.ref_id]?.total) || 0) - (item.category !== 'done' && !item.archived_at ? need || 0 : 0);
    const free = Number(o.available) - others;
    const short = need !== null && item.category !== 'done' ? need - free : 0;
    return `<span class="chip-tone tone-${short > 0 ? 'red' : Number(o.available) > 0 ? 'green' : 'amber'}">${esc(Number(o.available))} ${unit} available</span>`
      + (others > 0 ? ` <span class="muted small" title="${esc((reserved[r.ref_id]?.items || []).filter((q) => q.key !== item.key).map((q) => `${q.qty} for ${q.key ? `${q.key} ${q.title}` : q.project}`).join('\n'))}">${esc(others)} reserved for other items</span>` : '')
      + (need !== null ? ` · needs <strong>${esc(need)}</strong> ${unit}${short > 0 ? ` <span class="chip-tone tone-red">short by ${esc(short)}</span>` : ''}` : '')
      + (mayEdit ? ` <button type="button" class="btn btn-sm btn-ghost" data-ref-qty="${esc(r.id)}" data-qty="${esc(need ?? '')}">${need === null ? 'How many?' : 'Change'}</button>` : '');
  };
  const waitingOn = x.depsIn.filter((d) => otherById.get(d.from_item)?.category !== 'done');

  const read = (key) => {
    if (key.startsWith('cf.')) {
      const f = cfg.fields.find((q) => q.key === key.slice(3));
      if (!f) return null;
      const v = f.type === 'formula' ? evalFormula(f.formula, item) : item.custom?.[f.key];
      if (v === undefined || v === null || v === '') return '';
      if (f.type === 'url') return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v.replace(/^https?:\/\//, '').slice(0, 60))}</a>`;
      if (['user', 'multiuser'].includes(f.type)) return esc([].concat(v).map((id) => personName(b, id)).join(', '));
      if (f.type === 'longtext' || f.type === 'richtext') return `<div class="pm-rich">${rich(v)}</div>`;
      if (f.type === 'datetime') return esc(fmtDateTime(v));
      if (f.type === 'date') return esc(fmtDate(v));
      if (f.type === 'currency') return esc(Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
      if (f.type === 'duration') return `${esc(v)} h`;
      return esc(Array.isArray(v) ? v.join(', ') : v === true ? 'Yes' : v);
    }
    switch (key) {
      case 'priority': return esc(PRIORITIES.find(([k]) => k === item.priority)?.[1] || '');
      case 'owner': return item.owner_id ? `${avatar(b, item.owner_id)} ${esc(personName(b, item.owner_id))}` : '';
      case 'collaborators': return collab.map((id) => esc(personName(b, id))).join(', ');
      case 'division': return esc(b.divisionById.get(item.division_id)?.name || '');
      case 'subsystem': return esc(b.subsystemById.get(item.subsystem_id)?.name || '');
      case 'start_date': return item.start_date ? esc(fmtDate(item.start_date)) : '';
      case 'due_date': return dueChip(item);
      case 'estimate_hours': return item.estimate_hours === null ? '' : `${Number(item.estimate_hours)} h`;
      case 'progress': return `<progress max="100" value="${Number(item.progress)}"></progress> ${Number(item.progress)}%`;
      case 'parent': return otherById.get(item.parent_id) ? `<a href="${itemHref(otherById.get(item.parent_id).key)}">${esc(otherById.get(item.parent_id).key)} · ${esc(otherById.get(item.parent_id).title)}</a>` : '';
      case 'sprint': return esc(cfg.sprints.find((s) => s.id === item.sprint_id)?.name || '');
      case 'labels': return (item.labels || []).map((l) => `<span class="chip">${esc(l)}</span>`).join(' ');
      case 'vehicle': return esc(item.vehicle || '');
      default: return null; // description, acceptance and blocked have their own places on the page
    }
  };
  const viewLayout = layoutFor(cfg, item.type_id, 'view').some((s) => s.fields.length) && cfg.layouts.some((l) => l.kind === 'view')
    ? layoutFor(cfg, item.type_id, 'view') : layoutFor(cfg, item.type_id, 'edit');
  const details = viewLayout.map((s) => {
    const rows = s.fields.map((f) => [f.key, read(f.key)]).filter(([, v]) => v !== null);
    return rows.length ? `<h3>${esc(s.title || 'Details')}</h3><dl class="pm-dl">${rows.map(([k, v]) => `<div><dt>${esc(fieldLabel(k, cfg.fields))}</dt><dd>${v || '<span class="muted">—</span>'}</dd></div>`).join('')}</dl>` : '';
  }).join('');

  const depRow = (d, otherId, mine) => {
    const o = otherById.get(otherId);
    return `<li>${o ? `<a href="${itemHref(o.key)}">${esc(o.key)} · ${esc(o.title)}</a> ${o.category === 'done' ? '<span class="chip-tone tone-green">Done</span>' : o.due_date ? `<span class="muted small">due ${esc(fmtDate(o.due_date))}</span>` : ''}
        ${o.project_id !== project.id ? `<span class="chip">${esc(b.projectById.get(o.project_id)?.name || 'another project')}</span>` : ''}` : '<span class="muted">An item in a project you can\'t see</span>'}
      <span class="muted small">${esc(DEP_KINDS[d.kind])}${d.lag_days ? `, ${d.lag_days > 0 ? '+' : ''}${d.lag_days} working day${Math.abs(d.lag_days) === 1 ? '' : 's'}` : ''}</span>
      ${mine && may('plan') ? `<button type="button" class="btn btn-sm btn-ghost" data-unlink="${esc(d.id)}" aria-label="Remove this dependency">✕</button>` : ''}</li>`;
  };
  const eventRow = (e) => {
    const ch = e.data?.changes;
    const show = (k, v) => (v === null || v === undefined || v === '' ? 'nothing' : k === 'owner_id' ? personName(b, v) : k === 'status_id' ? cfg.statusById.get(v)?.name || 'a status' : k === 'type_id' ? cfg.typeById.get(v)?.name || 'a type'
      : k === 'subsystem_id' ? b.subsystemById.get(v)?.name || 'a subsystem' : k === 'division_id' ? b.divisionById.get(v)?.name || 'a division' : k === 'sprint_id' ? cfg.sprints.find((s) => s.id === v)?.name || 'a sprint'
      : k === 'parent_id' ? otherById.get(v)?.key || 'another item' : Array.isArray(v) ? v.join(', ') || 'nothing' : String(v));
    const lines = ch ? Object.entries(ch).filter(([, v]) => v.length === 2).map(([k, [from, to]]) => `<li>${esc(fieldLabel(k.replace(/_id$/, '').replace('estimate', 'estimate_hours'), cfg.fields))}: ${esc(show(k, from))} → <strong>${esc(show(k, to))}</strong></li>`).join('') : '';
    return `<li class="tl-${esc(e.kind)}"><div><strong>${esc(e.actor_name || 'one.solar')}</strong> ${esc(e.summary)} <span class="muted small">${esc(fmtDateTime(e.created_at))}</span></div>
      ${lines ? `<ul class="pm-changes">${lines}</ul>` : ''}${e.kind === 'status' && e.data?.comment ? `<blockquote>${esc(e.data.comment)}</blockquote>` : ''}${e.data?.note ? `<blockquote>${esc(e.data.note)}</blockquote>` : ''}</li>`;
  };
  const checkDone = x.checklist.filter((c) => c.done).length;
  const alumniCard = item.archived_at ? '' : await alumniShareCard({ projectId: project.id, itemId: item.id, mayEdit: may('edit'), what: 'this item' });

  el.innerHTML = `${takeFlash()}<a class="back-link" href="${projectHref(project.key, 'list')}">← ${esc(project.name)}</a>
    ${header(`${typeBadge(type)} ${esc(item.title)}`, `<span class="pm-key">${esc(item.key)}</span> · ${esc(type?.name || '')} · ${statusChip(status)} ${priorityChip(item.priority)}
        ${item.archived_at ? '<span class="chip-tone tone-gray">Archived</span>' : ''}`,
      `${moves.map((t) => `<button type="button" class="btn ${cfg.statusById.get(t.to_status)?.category === 'done' ? 'btn-primary' : ''}" data-do-move="${esc(t.id)}" title="${esc(t.description || `Move to ${cfg.statusById.get(t.to_status)?.name}`)}">${esc(t.name)}</button>`).join('')}
       ${mayEdit ? '<button type="button" class="btn" data-edit>Edit</button>' : ''}
       <button type="button" class="btn btn-ghost" data-watch>${watchers.includes(b.me) ? '★ Watching' : '☆ Watch'}</button>
       ${may('edit') || may('delete') ? `<details class="pm-more"><summary class="btn btn-ghost" aria-label="More">⋯</summary><div class="pm-more-pop">
          ${may('edit') && !item.archived_at ? '<button type="button" data-move-project>Move to another project</button>' : ''}
          ${may('delete') ? `<button type="button" data-archive>${item.archived_at ? 'Restore' : 'Archive'}</button>` : ''}</div></details>` : ''}`)}
    ${pending ? `<div class="alert alert-info pm-approval"><strong>Waiting for approval:</strong> ${esc(personName(b, pending.requested_by))} asked for "${esc(cfg.transitions.find((t) => t.id === pending.transition_id)?.name || 'a move')}" ${esc(relDay(pending.requested_at))}.
        ${may('approve') ? `<span class="card-actions"><button type="button" class="btn btn-sm btn-primary" data-approve="${esc(pending.id)}">Approve</button><button type="button" class="btn btn-sm" data-reject="${esc(pending.id)}">Send back</button></span>` : ''}</div>` : ''}
    ${!pending && lastDecision && item.category !== 'done' && lastDecision.decided_at > (x.events.find((e) => e.kind === 'status')?.created_at || '') ? `<div class="alert alert-error"><strong>Not approved</strong> by ${esc(personName(b, lastDecision.decided_by))}: ${esc(lastDecision.note)}</div>` : ''}
    ${item.blocked ? `<div class="alert alert-error"><strong>⛔ Blocked.</strong> ${esc(item.blocked_reason || 'No reason given.')}</div>` : ''}
    ${waitingOn.length && item.category !== 'done' ? `<div class="alert alert-info">⏳ Waiting on ${waitingOn.map((d) => (otherById.get(d.from_item) ? `<a href="${itemHref(otherById.get(d.from_item).key)}">${esc(otherById.get(d.from_item).key)}</a>` : 'an item')).join(', ')} to finish.</div>` : ''}
    ${item.category === 'done' ? `<div class="alert ${item.accepted_at ? 'alert-success' : 'alert-info'} pm-accept">${item.accepted_at
      ? `<strong>Finished and accepted.</strong> Reviewed by ${esc(personName(b, item.accepted_by))} on ${esc(fmtDate(item.accepted_at))}.${may('approve') ? ' <button type="button" class="btn btn-sm btn-ghost" data-accept="0">Withdraw</button>' : ''}`
      : `<strong>Finished${item.completed_at ? ` on ${esc(fmtDate(item.completed_at))}` : ''}.</strong> Not formally reviewed yet.${may('approve') ? ' <button type="button" class="btn btn-sm btn-primary" data-accept="1">Review and accept</button>' : ''}`}</div>` : ''}

    <div class="pm-item">
      <div class="pm-item-main">
        <section class="card"><h2>What's expected</h2>
          ${item.description ? `<div class="pm-rich">${rich(item.description)}</div>` : '<p class="muted">No description yet.</p>'}
          ${item.acceptance ? `<h3>Done means</h3><div class="pm-rich">${rich(item.acceptance)}</div>` : ''}</section>

        <section class="card"><h2>Checklist ${x.checklist.length ? `<span class="muted">${checkDone}/${x.checklist.length}</span>` : ''}</h2>
          <ul class="pm-checklist">${x.checklist.map((c) => `<li><label class="pm-check"><input type="checkbox" data-check="${esc(c.id)}" ${c.done ? 'checked' : ''} ${mayEdit ? '' : 'disabled'}> <span>${esc(c.text)}</span></label>
            ${mayEdit ? `<button type="button" class="btn btn-sm btn-ghost" data-check-del="${esc(c.id)}" aria-label="Remove">✕</button>` : ''}</li>`).join('')}</ul>
          ${mayEdit ? '<form data-check-add class="pm-inline-add"><input type="text" maxlength="300" placeholder="+ Add a step" aria-label="Add a checklist step"></form>' : x.checklist.length ? '' : '<p class="muted">No checklist.</p>'}</section>

        <section class="card"><h2>Items under this one ${x.children.length ? `<span class="muted">${x.children.filter((c) => c.category === 'done').length}/${x.children.length}</span>` : ''}</h2>
          ${x.children.length ? `<ul class="pm-mini">${x.children.map((c) => `<li>${typeBadge(cfg.typeById.get(c.type_id))} <a href="${itemHref(c.key)}">${esc(c.key)} · ${esc(c.title)}</a> ${statusChip(cfg.statusById.get(c.status_id))} ${avatar(b, c.owner_id)}</li>`).join('')}</ul>` : '<p class="muted">Nothing under it.</p>'}
          ${may('create') && !item.archived_at ? '<p><button type="button" class="btn btn-sm" data-add-child>+ Add an item under this</button></p>' : ''}</section>

        <section class="card"><h2>Dependencies</h2>
          <h3>This waits on</h3>${x.depsIn.length ? `<ul class="pm-mini">${x.depsIn.map((d) => depRow(d, d.from_item, true)).join('')}</ul>` : '<p class="muted">Nothing.</p>'}
          <h3>Waiting on this</h3>${x.depsOut.length ? `<ul class="pm-mini">${x.depsOut.map((d) => depRow(d, d.to_item, false)).join('')}</ul>` : '<p class="muted">Nothing.</p>'}
          ${may('plan') && !item.archived_at ? '<p><button type="button" class="btn btn-sm" data-add-dep>+ Add a dependency</button></p>' : ''}</section>

        <section class="card"><h2>Documents</h2>
          ${x.links.length ? `<ul class="pm-mini pm-docs">${x.links.map((l) => {
            const r = x.resources.find((q) => q.id === l.resource_id);
            return r ? `<li>${docLink(r)} ${mayEdit ? `<button type="button" class="btn btn-sm btn-ghost" data-unlink-doc="${esc(l.id)}" aria-label="Remove from this item">✕</button>` : ''}</li>` : '';
          }).join('')}</ul>` : '<p class="muted">No documents linked.</p>'}
          ${mayEdit || may('create') ? '<p><button type="button" class="btn btn-sm" data-add-doc>+ Link a document</button> <span class="muted small">Paste a link from Teams or SharePoint.</span></p>' : ''}</section>

        <section class="card"><h2>In other one.solar apps</h2>
          ${x.refs.length ? `<ul class="pm-mini">${x.refs.map((r) => {
            const o = r.kind === 'order' ? orders.find((q) => q.id === r.ref_id) : stock.find((q) => q.id === r.ref_id);
            const live = r.kind === 'order' ? (o ? `<span class="chip-tone tone-${o.status === 'Received' ? 'green' : o.status === 'Ordered' ? 'blue' : 'amber'}">${esc(o.status)}</span>${['Received'].includes(o.status) ? '' : ' <span class="muted small">not here yet</span>'}` : '')
              : partLine(r, o);
            const href = r.kind === 'order' ? appUrl(`orders/#/requests/${encodeURIComponent(o?.request_number || r.label.split(' · ')[0])}`) : appUrl(`inventory/#/inventory/items/${encodeURIComponent(r.ref_id)}`);
            return `<li><span class="chip">${r.kind === 'order' ? 'Order' : 'Inventory'}</span> <a href="${esc(href)}">${esc(r.label)}</a> ${live} ${r.note ? `<span class="muted small">${esc(r.note)}</span>` : ''}
              ${mayEdit ? `<button type="button" class="btn btn-sm btn-ghost" data-unref="${esc(r.id)}" aria-label="Remove this link">✕</button>` : ''}</li>`;
          }).join('')}</ul>` : '<p class="muted">No orders or inventory items linked.</p>'}
          ${mayEdit ? '<p><button type="button" class="btn btn-sm" data-add-ref="order">+ Link an order</button> <button type="button" class="btn btn-sm" data-add-ref="inventory">+ Link an inventory item</button></p>' : ''}
          <p class="hint">Status and stock are read live from Orders and Inventory. Nothing here orders anything or changes stock; saying how many of a part this needs reserves them (Inventory shows it) until it's done.</p></section>

        <section class="card"><h2>Comments</h2>
          <ul class="pm-comments">${x.comments.map((c) => `<li class="${c.deleted_at ? 'is-removed' : ''}"><div class="pm-comment-head">${c.author_id ? avatar(b, c.author_id) : '<span class="pm-avatar">⚙</span>'}
              <strong>${esc(c.author_id ? personName(b, c.author_id) : 'A rule')}</strong> <span class="muted small">${esc(fmtDateTime(c.created_at))}${c.edited_at ? ' · edited' : ''}</span>
              ${!c.deleted_at && (c.author_id === b.me || may('delete')) ? `<button type="button" class="btn btn-sm btn-ghost" data-del-comment="${esc(c.id)}">Remove</button>` : ''}</div>
            <div class="pm-rich">${rich(c.body)}</div></li>`).join('') || '<li class="muted">No comments yet.</li>'}</ul>
          ${may('comment') ? `<form data-comment class="pm-comment-form"><textarea rows="3" placeholder="Write a comment. @First Last mentions someone." aria-label="Comment" required></textarea>
            <div class="form-actions"><button type="submit" class="btn btn-primary">Comment</button></div></form>` : ''}</section>

        <details class="card" open><summary><h2>History</h2></summary><ul class="timeline pm-history">${x.events.map(eventRow).join('')}</ul></details>
      </div>
      <aside class="pm-item-side"><section class="card">${details}
        <h3>People</h3><dl class="pm-dl"><div><dt>Reporter</dt><dd>${esc(personName(b, item.reporter_id) || '—')}</dd></div>
          <div><dt>Watching</dt><dd>${watchers.map((id) => esc(personName(b, id))).join(', ') || '—'}</dd></div></dl>
        <p class="muted small">Created ${esc(fmtDate(item.created_at))}. Last changed ${esc(fmtDateTime(item.updated_at))}.</p></section>${alumniCard}</aside>
    </div>`;
  bindAlumniShare(el, { projectId: project.id, itemId: item.id, done: () => rerender() });

  const again = () => rerender();
  const fresh = async (fn, done) => (await attempt(fn, done)) && again();
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.doMove) (await runMove(b, cfg, item, cfg.transitions.find((q) => q.id === d.doMove))) && again();
    else if (d.edit !== undefined) (await editDialog(b, cfg, item, collab)) && again();
    else if (d.watch !== undefined) fresh(() => pm.watch(item.id, !watchers.includes(b.me)));
    else if (d.archive !== undefined) confirm(item.archived_at ? `Restore ${item.key}?` : `Archive ${item.key} and everything under it? It can be restored.`) && fresh(() => pm.archiveItem(item.id, !item.archived_at));
    else if (d.approve || d.reject) {
      const note = d.reject ? await askText({ title: 'Send it back', label: 'Why isn\'t it approved?', ok: 'Send back', multiline: true }) : '';
      if (d.reject && !note) return;
      fresh(() => pm.decideApproval(d.approve || d.reject, !!d.approve, note), d.approve ? 'Approved.' : 'Sent back.');
    } else if (d.accept !== undefined) fresh(() => pm.accept(item.id, d.accept === '1'), d.accept === '1' ? 'Accepted.' : 'Acceptance withdrawn.');
    else if (d.checkDel) fresh(() => pm.saveChecklist(item.id, x.checklist.filter((c) => c.id !== d.checkDel)));
    else if (d.addChild !== undefined) (await createItemDialog(b, cfg, { parent_id: item.id, division_id: item.division_id, subsystem_id: item.subsystem_id })) && again();
    else if (d.unlink) fresh(() => pm.unlink(d.unlink));
    else if (d.addDep !== undefined) (await depDialog(b, item)) && again();
    else if (d.addDoc !== undefined) (await addDocDialog(b, project, { projectId: project.id, itemId: item.id }, { siteUrl: config.siteUrl })) && again();
    else if (d.unlinkDoc) fresh(() => pm.removeResourceLink(d.unlinkDoc));
    else if (d.addRef) (await refDialog(item, d.addRef)) && again();
    else if (d.unref) fresh(() => pm.removeRef(d.unref));
    else if (d.refQty) {
      const v = await askText({ title: 'How many does this need?', label: 'Quantity', required: false, ok: 'Save', value: d.qty,
        hint: "While this item isn't done, that many are reserved for it in Inventory. Leave it empty to reserve none." });
      if (v === null) return;
      const n = v.trim() === '' ? null : Number(v);
      if (n !== null && !(n > 0)) return alert('Enter a quantity above 0, or leave it empty.');
      fresh(() => pm.setRefQty(d.refQty, n), n === null ? 'Not reserved.' : 'Reserved.');
    }
    else if (d.delComment) confirm('Remove this comment?') && fresh(() => pm.editComment(d.delComment, null));
    else if (d.moveProject !== undefined) {
      const moved = await moveDialog(b, item);
      if (moved) {
        setFlash(`${item.key} is now ${moved.key}. Its history, comments and documents came with it.`);
        location.hash = itemHref(moved.key);
      }
    }
  });
  el.addEventListener('change', (e) => {
    if (e.target.dataset.check) fresh(() => pm.saveChecklist(item.id, x.checklist.map((c) => (c.id === e.target.dataset.check ? { ...c, done: e.target.checked } : c))));
  });
  el.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.matches('[data-check-add]')) {
      const text = e.target.querySelector('input').value.trim();
      if (text) fresh(() => pm.saveChecklist(item.id, [...x.checklist, { text, done: false }]));
    } else if (e.target.matches('[data-comment]')) {
      const body = e.target.querySelector('textarea').value.trim();
      if (body) fresh(() => pm.comment(item.id, body, findMentions(body, b.people)));
    }
  });
}

/** Edit an item with its kind's "edit" form. A save from an out-of-date page is refused, not merged. */
async function editDialog(b, cfg, item, collaborators) {
  const type = cfg.typeById.get(item.type_id);
  const parents = (await loadParents(cfg.project.id).catch(() => [])).filter((p) => {
    const pt = cfg.typeById.get(p.type_id);
    return pt && (type.parent_type_ids?.length ? type.parent_type_ids.includes(pt.id) : pt.level < type.level);
  });
  return formDialog({
    title: `Edit ${esc(item.key)}`, submit: 'Save', wide: true,
    body: `<div class="field"><label for="ei-title">Title</label><input id="ei-title" name="title" type="text" maxlength="200" required value="${esc(item.title)}"></div>
      ${formSections(layoutFor(cfg, item.type_id, 'edit'), { b, cfg, item, parents, collaborators })}`,
    onOpen: bindOrgPickers,
    async onSubmit(form) {
      try {
        return await pm.updateItem(item.id, item.version, { title: form.elements.title.value.trim(), ...readFields(form, cfg) });
      } catch (err) {
        if (err.conflict) err.message += ' Copy anything you typed that you want to keep, then close this and reload.';
        throw err;
      }
    },
  });
}

/** Find another item (any project I can see) and say which way the dependency goes. */
function depDialog(b, item) {
  let found = [];
  return formDialog({
    title: `Add a dependency to ${esc(item.key)}`, submit: 'Add',
    body: `<div class="field"><label for="dep-q">Find the other item</label><input id="dep-q" type="search" placeholder="Title or key, in any project you can see" autocomplete="off">
        <select name="other" size="6" required aria-label="Matching items"></select></div>
      <fieldset class="pm-section"><legend>Which comes first?</legend>
        <label class="pm-check"><input type="radio" name="dir" value="in" checked> ${esc(item.key)} waits on the other item</label>
        <label class="pm-check"><input type="radio" name="dir" value="out"> The other item waits on ${esc(item.key)}</label></fieldset>
      <div class="form-grid"><div class="field span-2"><label for="dep-kind">How</label><select id="dep-kind" name="kind">
          <option value="FS">Starts after the first one finishes (most common)</option><option value="SS">Starts after the first one starts</option>
          <option value="FF">Finishes after the first one finishes</option><option value="SF">Finishes after the first one starts</option></select></div>
        <div class="field span-2"><label for="dep-lag">Gap (working days)</label><input id="dep-lag" name="lag" type="number" value="0" min="-365" max="365"><div class="hint">Negative means they can overlap by that much.</div></div></div>`,
    onOpen(form) {
      let timer;
      const search = async () => {
        const q = form.querySelector('#dep-q').value.trim();
        found = q ? (await pm.search({ q, limit: 20, sort: 'updated', dir: 'desc' }).catch(() => ({ items: [] }))).items.filter((i) => i.id !== item.id) : [];
        form.elements.other.innerHTML = found.map((i) => `<option value="${esc(i.id)}">${esc(i.key)} · ${esc(i.title)} (${esc(b.projectById.get(i.project_id)?.name || '')})</option>`).join('');
      };
      form.querySelector('#dep-q').oninput = () => (clearTimeout(timer), (timer = setTimeout(search, 250)));
    },
    onSubmit(form) {
      const other = form.elements.other.value;
      const inbound = form.elements.dir.value === 'in';
      return pm.link({ from: inbound ? other : item.id, to: inbound ? item.id : other, kind: form.elements.kind.value, lag_days: Number(form.elements.lag.value) || 0 });
    },
  });
}

/** Link an Orders request or an Inventory item: search, pick, optional note. */
function refDialog(item, kind) {
  return formDialog({
    title: kind === 'order' ? 'Link an order' : 'Link an inventory item', submit: 'Link it',
    body: `<div class="field"><label for="ref-q">Find it</label><input id="ref-q" type="search" placeholder="${kind === 'order' ? 'Request number or title' : 'SKU or name'}" autocomplete="off">
        <select name="ref" size="6" required aria-label="Matches"></select></div>
      <div class="field"><label for="ref-note">Note (optional)</label><input id="ref-note" name="note" type="text" maxlength="300" placeholder="${kind === 'order' ? 'e.g. Waiting on delivery before layup' : 'e.g. Needs 12 for the pack'}"></div>`,
    onOpen(form) {
      let timer;
      const search = async () => {
        const q = form.querySelector('#ref-q').value.trim();
        const rows = !q ? [] : await (kind === 'order' ? pm.findRequests(q) : pm.findInventory(q)).catch((err) => (toast(err.message, 'bad'), []));
        form.elements.ref.innerHTML = rows.map((r) => `<option value="${esc(r.id)}">${esc(kind === 'order' ? `${r.request_number} · ${r.title} (${r.status})` : `${r.sku} · ${r.name}`)}</option>`).join('');
      };
      form.querySelector('#ref-q').oninput = () => (clearTimeout(timer), (timer = setTimeout(search, 250)));
    },
    onSubmit: (form) => pm.addRef(item.id, kind, form.elements.ref.value, form.elements.note.value.trim()),
  });
}

/** Move to another project: pick the project, then what kind of item it becomes there. */
async function moveDialog(b, item) {
  const targets = b.projects.filter((p) => p.id !== item.project_id && !p.archived_at && can(b, p.id, 'create'));
  if (!targets.length) return toast('There\'s no other project you can add items to.', 'bad'), null;
  const shapes = new Map();
  const typesOf = async (id) => shapes.get(id) || shapes.set(id, (await pm.shapes([id])).types.filter((t) => !t.archived_at)).get(id);
  return formDialog({
    title: `Move ${esc(item.key)} to another project`, submit: 'Move it',
    body: `<p class="muted">It gets the other project's next number; its old name still opens it. History, comments, checklist, documents and links come along. Items under it stay here.
        Custom fields the other project doesn't have are kept in the history only.</p>
      <div class="field"><label for="mv-project">Project</label><select id="mv-project" name="project">${targets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.key)})</option>`).join('')}</select></div>
      <div class="field"><label for="mv-type">It becomes a</label><select id="mv-type" name="type" required></select></div>`,
    onOpen(form) {
      const fill = async () => (form.elements.type.innerHTML = (await typesOf(form.elements.project.value)).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join(''));
      form.elements.project.onchange = fill;
      fill();
    },
    onSubmit: (form) => pm.moveItem(item.id, { project_id: form.elements.project.value, type_id: form.elements.type.value }),
  });
}
