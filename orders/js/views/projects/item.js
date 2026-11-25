/**
 * Projects: one work item. What's expected, when it's due, who's responsible, what's holding it up, which
 * documents matter and what "done" means, then the working parts: checklist, sub-items, dependencies, linked
 * documents and one.solar records, files, comments and the full history. Which fields show, and which are required,
 * comes from the project's form layout for this kind of item. Each person can pin fields to the top of the side panel
 * and hide empty ones (kept on this device). "Copy this item" makes a new one like it.
 */
import { esc, fmtDate, fmtDateTime, askText, takeFlash, setFlash } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { auth } from '../../auth.js';
import { PRIORITIES, DEP_KINDS, layoutFor, fieldLabel, findMentions, relDay, newId } from '../../projects/core.js';
import { renderAttachments } from '../../attachments.js';
import { evalFormula } from '../../projects/formula.js';
import { appUrl } from '../../../../shared/onesolar.js';
import { needsDatabase, loadBase, loadConfig, can, header, itemHref, projectHref, personName, avatar, typeBadge, statusChip, dueChip, rich, formDialog, attempt, toast,
  fieldInput, readFields, loadParents, ie, choiceChips, infoTip } from './kit.js';
import { bindInline, saveField } from './inline.js';
import { quickAdd, bindQuickAdd } from './quick.js';
import { noteRecentItem, openCommandBar } from './command.js';
import { addDocDialog, docLink } from './docs.js';
import { linkTypes, describeLinks, searchLinks, linkOption, linkedProjectItems } from '../../related.js';
import { linkFromUrl, exactFirst } from '../../linkParse.js';
import { recentItems } from './command.js';
import { alumniShareCard, bindAlumniShare } from './alumni.js';

export async function renderItem(el, { config, params, rerender }) {
  const missing = needsDatabase(config);
  if (missing) return void (el.innerHTML = missing);
  const b = await loadBase();
  const item = await pm.itemByKey(params.id.toUpperCase());
  if (!item) {
    el.innerHTML = `<section class="card no-access"><h1>No item "${esc(params.id)}"</h1><p>It doesn't exist, or it's in a space you can't see.</p>
      <div class="form-actions"><a class="btn btn-primary" href="#/projects">My work</a></div></section>`;
    return;
  }
  if (item.key !== params.id.toUpperCase()) return void (location.hash = itemHref(item.key)); // it moved projects: its new name
  const project = b.projectById.get(item.project_id);
  noteRecentItem(item);
  const [cfg, x] = await Promise.all([loadConfig(b, project.id), pm.itemExtras(item.id)]);
  const type = cfg.typeById.get(item.type_id);
  const may = (cap) => can(b, project.id, cap);
  const collab = x.people.filter((p) => p.kind === 'collab').map((p) => p.user_id);
  const watchers = x.people.filter((p) => p.kind === 'watch').map((p) => p.user_id);
  const mayEdit = !item.archived_at && (may('edit') || (may('create') && (item.owner_id === b.me || item.reporter_id === b.me || collab.includes(b.me))));
  const pending = x.approvals.find((a) => a.status === 'pending');
  const lastDecision = x.approvals.find((a) => a.status === 'rejected');

  // the other ends of dependencies, and linked records, read with my own access
  const others = await pm.itemsByIds([...new Set([...x.depsIn.map((d) => d.from_item), ...x.depsOut.map((d) => d.to_item), item.parent_id].filter(Boolean))]);
  const otherById = new Map(others.map((o) => [o.id, o]));
  const invIds = x.refs.filter((r) => r.kind === 'inventory').map((r) => r.ref_id);
  const [live, linkKinds, stock, reserved, relatedFrom] = await Promise.all([
    describeLinks(x.refs),                    // 068: every linked record as it is now, from its own app
    linkTypes().catch(() => []),
    pm.inventoryByIds(invIds).catch(() => []),
    pm.inventoryReserved(invIds).catch(() => ({})),   // 061
    linkedProjectItems('item', item.id).catch(() => []),   // 069: items that marked this one as related
  ]);
  const fromLive = relatedFrom.length ? (await describeLinks(relatedFrom.map((o) => ({ kind: 'item', ref_id: o.id })))).get('item') || new Map() : new Map();
  const liveChip = (d) => (d ? `${d.status ? `<span class="chip-tone tone-${esc(d.tone || 'gray')}">${esc(d.status)}</span>` : ''}${d.detail ? ` <span class="muted small">${esc(d.detail)}</span>` : ''}` : '');
  const kindLabel = (kind) => esc(linkKinds.find((k) => k.key === kind)?.label || kind);
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
      if (choiceChips(f, v)) return choiceChips(f, v);
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
  const editLayout = layoutFor(cfg, item.type_id, 'edit');
  const baseLayout = layoutFor(cfg, item.type_id, 'view').some((s) => s.fields.length) && cfg.layouts.some((l) => l.kind === 'view')
    ? layoutFor(cfg, item.type_id, 'view') : editLayout;
  // Every field the kind's form has is on the page and changes right here; one the "view" layout leaves out goes under "More".
  const onPage = new Set(baseLayout.flatMap((s) => s.fields.map((f) => f.key)));
  const leftOut = editLayout.flatMap((s) => s.fields).filter((f) => !onPage.has(f.key) && read(f.key) !== null);
  const viewLayout = leftOut.length ? [...baseLayout, { title: 'More', fields: leftOut }] : baseLayout;
  // quick pickers (the same as in lists and boards); every other field opens its own small editor in place (editInPlace)
  const INLINE = { owner: 'owner', priority: 'priority', start_date: 'start', due_date: 'due', estimate_hours: 'estimate', progress: 'progress' };
  const formulaKey = (k) => k.startsWith('cf.') && cfg.fields.find((f) => f.key === k.slice(3))?.type === 'formula';
  const inPlace = (k) => mayEdit && !INLINE[k] && !formulaKey(k);
  // a field is empty when there's nothing to show (an inline editor still counts as empty when the item has no value)
  const isEmpty = (k) => {
    if (k.startsWith('cf.')) return !read(k);
    const col = { owner: 'owner_id', start_date: 'start_date', due_date: 'due_date', estimate_hours: 'estimate_hours', priority: 'priority', parent: 'parent_id', sprint: 'sprint_id',
      division: 'division_id', subsystem: 'subsystem_id', vehicle: 'vehicle' }[k];
    if (k === 'collaborators') return !collab.length;
    if (k === 'labels') return !(item.labels || []).length;
    if (k === 'progress') return false;
    return col ? item[col] === null || item[col] === undefined || item[col] === '' : !read(k);
  };
  const prefs = itemPrefs();
  const sections = viewLayout.map((s) => ({ title: s.title, rows: s.fields.map((f) => [f.key, INLINE[f.key] && !item.archived_at ? ie(b, cfg, item, INLINE[f.key], f.key === 'owner' ? 'name' : '') : read(f.key)]).filter(([, v]) => v !== null) }));
  const allRows = sections.flatMap((s) => s.rows);
  const pinned = prefs.pinned.map((k) => allRows.find(([r]) => r === k)).filter(Boolean);
  // C2: empty fields are folded away (unless you choose to see them), except ones you can fill in right here
  const foldable = (k) => !prefs.pinned.includes(k) && isEmpty(k) && !(INLINE[k] && mayEdit);
  const emptyCount = allRows.filter(([k]) => foldable(k)).length;
  const dlRow = ([k, v]) => {
    const on = prefs.pinned.includes(k);
    const label = fieldLabel(k, cfg.fields);
    // a value I can change: click it (or Enter) and it turns into its own input, saved on its own
    const value = inPlace(k)
      ? `<div class="pm-fv" data-edit-field="${esc(k)}" role="button" tabindex="0" title="Click to change" aria-label="${esc(`Change ${label}`)}">${v || '<span class="pm-fv-add">+ Add</span>'}</div>`
      : v || '<span class="muted">—</span>';
    return `<div data-row="${esc(k)}"><dt>${esc(label)} <button type="button" class="pm-pin${on ? ' is-on' : ''}" data-pin-field="${esc(k)}" aria-pressed="${on}" title="${on ? 'Unpin' : 'Pin to the top (on every item, for you)'}" aria-label="${on ? 'Unpin' : 'Pin'} ${esc(label)}">📌</button></dt><dd>${value}</dd></div>`;
  };
  const details = (pinned.length ? `<h3>Pinned</h3><dl class="pm-dl pm-pinned">${pinned.map(dlRow).join('')}</dl>` : '')
    + sections.map((s) => {
      const rows = s.rows.filter(([k]) => !prefs.pinned.includes(k) && !(prefs.hideEmpty && foldable(k)));
      return rows.length ? `<h3>${esc(s.title || 'Details')}</h3><dl class="pm-dl">${rows.map(dlRow).join('')}</dl>` : '';
    }).join('')
    + (emptyCount ? `<p class="pm-side-tools"><button type="button" class="btn btn-sm btn-ghost" data-hide-empty>${prefs.hideEmpty ? `Show ${emptyCount} empty field${emptyCount === 1 ? '' : 's'}` : 'Hide empty fields'}</button></p>` : '');

  const depRow = (d, otherId, mine) => {
    const o = otherById.get(otherId);
    return `<li>${o ? `<a href="${itemHref(o.key)}">${esc(o.key)} · ${esc(o.title)}</a> ${o.category === 'done' ? '<span class="chip-tone tone-green">Done</span>' : o.due_date ? `<span class="muted small">due ${esc(fmtDate(o.due_date))}</span>` : ''}
        ${o.project_id !== project.id ? `<span class="chip">${esc(b.projectById.get(o.project_id)?.name || 'another space')}</span>` : ''}` : '<span class="muted">An item in a space you can\'t see</span>'}
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
  // Activity: comments and the history, newest first; "All" puts them in one list
  const commentRow = (c) => `<li class="pm-feed-comment${c.deleted_at ? ' is-removed' : ''}"><div class="pm-comment-head">${c.author_id ? avatar(b, c.author_id) : '<span class="pm-avatar">⚙</span>'}
      <strong>${esc(c.author_id ? personName(b, c.author_id) : 'A rule')}</strong> <span class="muted small">${esc(fmtDateTime(c.created_at))}${c.edited_at ? ' · edited' : ''}</span>
      ${!c.deleted_at && (c.author_id === b.me || may('delete')) ? `<button type="button" class="btn btn-sm btn-ghost" data-del-comment="${esc(c.id)}">Remove</button>` : ''}</div>
    <div class="pm-rich">${rich(c.body)}</div></li>`;
  const liveComments = x.comments.filter((c) => !c.deleted_at);
  const newest = (list) => [...list].sort((a, z) => (a.created_at < z.created_at ? 1 : -1));
  const feed = (tab) => {
    const rows = tab === 'comments' ? newest(x.comments).map(commentRow)
      : tab === 'history' ? newest(x.events).map(eventRow)
      : newest([...x.comments.map((c) => ({ ...c, isComment: true })), ...x.events]).map((r) => (r.isComment ? commentRow(r) : eventRow(r)));
    return rows.join('') || `<li class="muted">${tab === 'history' ? 'No changes yet.' : 'No comments yet.'}</li>`;
  };
  let activityTab = 'comments';
  try { activityTab = localStorage.getItem('onesolar:pm-activity') || 'comments'; } catch { /* private window */ }
  const checkDone = x.checklist.filter((c) => c.done).length;
  // Shared with alumni: a card says so (and how to stop); not shared yet: "Share with alumni…" is in the ⋯ menu.
  const mayShare = !item.archived_at && (may('edit') || auth.can('sgaa.edit'));
  const shared = mayShare ? await pm.sharedWithAlumni(project.id, item.id).catch(() => undefined) : undefined;
  const alumniCard = shared ? await alumniShareCard({ projectId: project.id, itemId: item.id, mayEdit: may('edit'), what: 'this item' }) : '';
  const iWatch = watchers.includes(b.me);
  const watchTitle = `${iWatch ? 'You\'re watching' : 'Watch'} (${watchers.length ? watchers.map((id) => personName(b, id)).join(', ') : 'nobody yet'})`;
  const menu = [
    '<button type="button" data-copy-link>Copy link</button>',
    may('create') && !project.archived_at ? '<button type="button" data-copy-item>Copy this item</button>' : '',
    may('edit') && !item.archived_at ? '<button type="button" data-move-project>Move to another space</button>' : '',
    mayEdit ? `<button type="button" data-block="${item.blocked ? '0' : '1'}">${item.blocked ? 'Not blocked any more' : 'Mark as blocked…'}</button>` : '',
    mayShare && shared === null ? '<button type="button" data-share-alumni>Share with alumni…</button>' : '',
    may('delete') ? `<button type="button" data-archive>${item.archived_at ? 'Restore' : 'Archive'}</button>` : '',
  ].filter(Boolean).join('');

  el.innerHTML = `${takeFlash()}<a class="back-link" href="${projectHref(project.key, 'list')}">← ${esc(project.name)}</a>
    ${header(`${typeBadge(type)} ${mayEdit ? `<span class="pm-title-edit" data-rename-title tabindex="0" role="button" title="Click to rename (E)">${esc(item.title)}</span>` : esc(item.title)}`,
      `<button type="button" class="pm-key pm-key-copy" data-copy-link title="Copy a link to ${esc(item.key)}">${esc(item.key)}</button> · ${esc(type?.name || '')}
        ${item.archived_at ? '<span class="chip-tone tone-gray">Archived</span>' : ''}`,
      `<span class="pm-status-btn">${ie(b, cfg, item, 'status', 'button')}</span>
       <button type="button" class="btn btn-ghost pm-watch${iWatch ? ' is-on' : ''}" data-watch aria-pressed="${iWatch}" title="${esc(watchTitle)}" aria-label="${esc(watchTitle)}"><span aria-hidden="true">👁</span> ${watchers.length}</button>
       <details class="pm-more"><summary class="btn btn-ghost" aria-label="More">⋯</summary><div class="pm-more-pop">${menu}</div></details>`)}
    ${pending ? `<div class="alert alert-info pm-approval"><strong>Waiting for approval:</strong> ${esc(personName(b, pending.requested_by))} asked for "${esc(cfg.transitions.find((t) => t.id === pending.transition_id)?.name || 'a move')}" ${esc(relDay(pending.requested_at))}.
        ${may('approve') ? `<span class="card-actions"><button type="button" class="btn btn-sm btn-primary" data-approve="${esc(pending.id)}">Approve</button><button type="button" class="btn btn-sm" data-reject="${esc(pending.id)}">Send back</button></span>` : ''}</div>` : ''}
    ${!pending && lastDecision && item.category !== 'done' && lastDecision.decided_at > (x.events.find((e) => e.kind === 'status')?.created_at || '') ? `<div class="alert alert-error"><strong>Not approved</strong> by ${esc(personName(b, lastDecision.decided_by))}: ${esc(lastDecision.note)}</div>` : ''}
    ${item.blocked ? `<div class="alert alert-error"><strong>⛔ Blocked.</strong> ${esc(item.blocked_reason || 'No reason given.')}${mayEdit ? ' <button type="button" class="btn btn-sm btn-ghost" data-block="0">Not blocked any more</button>' : ''}</div>` : ''}
    ${waitingOn.length && item.category !== 'done' ? `<div class="alert alert-info">⏳ Waiting on ${waitingOn.map((d) => (otherById.get(d.from_item) ? `<a href="${itemHref(otherById.get(d.from_item).key)}">${esc(otherById.get(d.from_item).key)}</a>` : 'an item')).join(', ')} to finish.</div>` : ''}
    ${item.category === 'done' ? `<div class="alert ${item.accepted_at ? 'alert-success' : 'alert-info'} pm-accept">${item.accepted_at
      ? `<strong>Finished and accepted.</strong> Reviewed by ${esc(personName(b, item.accepted_by))} on ${esc(fmtDate(item.accepted_at))}.${may('approve') ? ' <button type="button" class="btn btn-sm btn-ghost" data-accept="0">Withdraw</button>' : ''}`
      : `<strong>Finished${item.completed_at ? ` on ${esc(fmtDate(item.completed_at))}` : ''}.</strong> Not formally reviewed yet.${may('approve') ? ' <button type="button" class="btn btn-sm btn-primary" data-accept="1">Review and accept</button>' : ''}`}</div>` : ''}

    <div class="pm-item">
      <div class="pm-item-main">
        <section class="card" data-desc-card><h2>What's expected ${mayEdit ? '<button type="button" class="btn btn-sm btn-ghost" data-edit-desc>Edit</button>' : ''}</h2>
          <div data-desc>${item.description ? `<div class="pm-rich">${rich(item.description)}</div>` : `<p class="muted">No description yet.${mayEdit ? ' <button type="button" class="btn btn-sm btn-ghost" data-edit-desc>Add one</button>' : ''}</p>`}</div>
          ${item.acceptance || mayEdit ? `<h3>Done means</h3><div data-row="acceptance">${mayEdit
            ? `<div class="pm-fv pm-fv-block" data-edit-field="acceptance" role="button" tabindex="0" title="Click to change" aria-label="Change what done means">${item.acceptance ? `<div class="pm-rich">${rich(item.acceptance)}</div>` : '<span class="pm-fv-add">+ Say what has to be true for this to count as done</span>'}</div>`
            : `<div class="pm-rich">${rich(item.acceptance)}</div>`}</div>` : ''}</section>

        <section class="card"><h2>Checklist ${x.checklist.length ? `<span class="muted">${checkDone}/${x.checklist.length}</span>` : ''}</h2>
          <ul class="pm-checklist">${x.checklist.map((c) => `<li><label class="pm-check"><input type="checkbox" data-check="${esc(c.id)}" ${c.done ? 'checked' : ''} ${mayEdit ? '' : 'disabled'}> <span>${esc(c.text)}</span></label>
            ${mayEdit ? `<button type="button" class="btn btn-sm btn-ghost" data-check-del="${esc(c.id)}" aria-label="Remove">✕</button>` : ''}</li>`).join('')}</ul>
          ${mayEdit ? '<form data-check-add class="pm-inline-add"><input type="text" maxlength="300" placeholder="+ Add a step" aria-label="Add a checklist step"></form>' : x.checklist.length ? '' : '<p class="muted">No checklist.</p>'}</section>

        <section class="card pm-related"><h2>Related work</h2>
          <h3>Under it ${x.children.length ? `<span class="muted">${x.children.filter((c) => c.category === 'done').length}/${x.children.length} done</span>` : ''}</h3>
          ${x.children.length ? `<ul class="pm-mini">${x.children.map((c) => `<li>${typeBadge(cfg.typeById.get(c.type_id))} <a href="${itemHref(c.key)}">${esc(c.key)} · ${esc(c.title)}</a> ${statusChip(cfg.statusById.get(c.status_id))} ${avatar(b, c.owner_id)}</li>`).join('')}</ul>` : ''}
          ${may('create') && !item.archived_at ? quickAdd(b, { project_id: project.id, parent_id: item.id, parent_type_id: item.type_id, division_id: item.division_id || undefined, subsystem_id: item.subsystem_id || undefined },
            { placeholder: '+ Add an item under this (Enter to add)' }) : x.children.length ? '' : '<p class="muted">Nothing under it.</p>'}
          ${x.depsIn.length ? `<h3>Waits on</h3><ul class="pm-mini">${x.depsIn.map((d) => depRow(d, d.from_item, true)).join('')}</ul>` : ''}
          ${x.depsOut.length ? `<h3>Waiting on this</h3><ul class="pm-mini">${x.depsOut.map((d) => depRow(d, d.to_item, false)).join('')}</ul>` : ''}
          <p class="pm-related-foot">${x.depsIn.length || x.depsOut.length ? '' : '<span class="muted small">No dependencies.</span> '}${may('plan') && !item.archived_at ? '<button type="button" class="btn btn-sm btn-ghost" data-add-dep>+ Dependency</button>' : ''}</p></section>

        <section class="card pm-links"><h2>Links &amp; files ${infoTip('Linked records show as they are now in their own app; linking never changes them. Saying how many of a part this needs reserves them in Inventory until this is done. Documents are links to Teams or SharePoint. Files are uploaded here (10 MB each); whoever can edit the item adds and removes them.')}</h2>
          ${x.refs.length || relatedFrom.length ? `<ul class="pm-mini">${x.refs.map((r) => {
            const d = live.get(r.kind)?.get(r.ref_id);   // null when it's gone or this person can't see it
            const now = r.kind === 'inventory' ? partLine(r, stock.find((q) => q.id === r.ref_id))   // 061: stock and reservations
              : liveChip(d);
            const name = d?.path ? `<a href="${esc(appUrl(d.path))}">${esc(r.label)}</a>` : esc(r.label);
            return `<li><span class="chip">${kindLabel(r.kind)}</span> ${name} ${now} ${r.note ? `<span class="muted small">${esc(r.note)}</span>` : ''}
              ${mayEdit ? `<button type="button" class="btn btn-sm btn-ghost" data-unref="${esc(r.id)}" aria-label="Remove this link">✕</button>` : ''}</li>`;
          }).join('')}${relatedFrom.map((o) => {   // 069: related from the other item (removed there)
            const d = fromLive.get(o.id);
            return `<li><span class="chip">${kindLabel('item')}</span> <a href="${itemHref(o.key)}">${esc(o.key)} · ${esc(o.title)}</a> ${liveChip(d)}</li>`;
          }).join('')}</ul>` : ''}
          ${x.links.length ? `<ul class="pm-mini pm-docs">${x.links.map((l) => {
            const r = x.resources.find((q) => q.id === l.resource_id);
            return r ? `<li>${docLink(r)} ${mayEdit ? `<button type="button" class="btn btn-sm btn-ghost" data-unlink-doc="${esc(l.id)}" aria-label="Remove from this item">✕</button>` : ''}</li>` : '';
          }).join('')}</ul>` : ''}
          <div data-files></div>
          <p class="muted" data-links-empty hidden>Nothing linked or attached yet.</p>
          ${mayEdit || may('create') ? `<details class="pm-add-menu"><summary class="btn btn-sm">+ Add ▾</summary><div class="pm-more-pop">
            ${mayEdit && linkKinds.length ? '<button type="button" data-add-ref="">A record from another app</button>' : ''}
            <button type="button" data-add-doc>A document (Teams or SharePoint link)</button>
            ${mayEdit ? '<button type="button" data-add-file>A file or link (upload)</button>' : ''}</div></details>` : ''}</section>

        <section class="card pm-activity-card" data-activity><div class="pm-activity-head"><h2>Activity</h2>
          <div class="pm-seg" role="tablist" aria-label="Show">${[['comments', `Comments${liveComments.length ? ` <span class="muted">${liveComments.length}</span>` : ''}`], ['history', `History <span class="muted">${x.events.length}</span>`], ['all', 'All']]
            .map(([k, l]) => `<button type="button" role="tab" data-activity-tab="${k}" class="${activityTab === k ? 'is-on' : ''}" aria-selected="${activityTab === k}">${l}</button>`).join('')}</div></div>
          ${may('comment') ? `<form data-comment class="pm-comment-form"><textarea rows="2" placeholder="Add a comment. @First Last mentions someone. (M)" aria-label="Comment" required></textarea>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">Comment</button></div></form>` : ''}
          <ul class="pm-feed" data-feed>${feed(activityTab)}</ul></section>
      </div>
      <aside class="pm-item-side"><section class="card pm-side-card">${details}
        <h3>People</h3><dl class="pm-dl"><div><dt>Reporter</dt><dd>${esc(personName(b, item.reporter_id) || '—')}</dd></div>
          <div><dt>Watching</dt><dd>${watchers.map((id) => esc(personName(b, id))).join(', ') || '—'}</dd></div></dl>
        <p class="muted small">Created ${esc(fmtDate(item.created_at))}. Last changed ${esc(fmtDateTime(item.updated_at))}.</p></section>${alumniCard}</aside>
    </div>`;
  bindAlumniShare(el, { projectId: project.id, itemId: item.id, done: () => rerender() });
  // 069: files on the item (the same files & links as Orders and Sponsors), filled in after the page shows
  const filesBox = el.querySelector('[data-files]');
  // C1: files sit in "Links & files"; the card says "nothing yet" only when there are no links, documents or files
  const linksEmpty = () => {
    const none = !x.refs.length && !relatedFrom.length && !x.links.length && !filesBox.querySelector('.attach-list li, .attach-form');
    const msg = el.querySelector('[data-links-empty]');
    if (msg) msg.hidden = !none;
  };
  renderAttachments(filesBox, { kind: 'item', ownerId: item.id, canEdit: mayEdit, hint: 'Add a file or link', onChange: linksEmpty })
    .then(linksEmpty)
    .catch(() => (filesBox.innerHTML = '<p class="muted">Files couldn\'t be loaded.</p>'));
  new MutationObserver(linksEmpty).observe(filesBox, { childList: true, subtree: true });

  const again = () => rerender();
  const fresh = async (fn, done) => (await attempt(fn, done)) && again();
  // change in place; then the page refreshes quietly (history, warnings) behind the new value
  bindInline(el, { b, itemOf: (id) => (id === item.id ? item : null), cfgOf: () => cfg, after: () => again() });
  bindQuickAdd(el, { b, done: again });
  const renameTitle = (node) => {
    const input = Object.assign(document.createElement('input'), { type: 'text', value: item.title, maxLength: 200, className: 'pm-title-input' });
    input.setAttribute('aria-label', 'Title');
    node.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (!save || !title || title === item.title) return void input.replaceWith(node);
      node.textContent = title;
      input.replaceWith(node);
      if (!(await saveField({ b, item, cfg, root: el }, { title }))) node.textContent = item.title;
    };
    input.addEventListener('keydown', (e) => (e.key === 'Enter' ? (e.preventDefault(), finish(true)) : e.key === 'Escape' ? finish(false) : null));
    input.addEventListener('blur', () => finish(true));
  };
  el.querySelector('[data-rename-title]')?.addEventListener('click', (e) => renameTitle(e.currentTarget));
  el.querySelector('[data-rename-title]')?.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), renameTitle(e.currentTarget)));
  const editDescription = () => {
    const box = el.querySelector('[data-desc]');
    box.innerHTML = `<form class="pm-desc-form"><textarea rows="8" aria-label="What's expected">${esc(item.description || '')}</textarea>
      <div class="hint">**bold**, - lists, [text](https://link) and @Name work here. Ctrl+Enter saves, Esc cancels.</div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-cancel-desc>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div></form>`;
    const form = box.querySelector('form');
    const area = form.querySelector('textarea');
    area.focus();
    const save = async () => {
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      if (await saveField({ b, item, cfg, root: el, after: again }, { description: area.value })) return;
      btn.disabled = false;   // refused: what was typed stays, with the reason in the notice
      btn.textContent = 'Save';
    };
    form.onsubmit = (e) => (e.preventDefault(), save());
    area.addEventListener('keydown', (e) => (e.key === 'Enter' && (e.ctrlKey || e.metaKey) ? (e.preventDefault(), save()) : e.key === 'Escape' && area.value === (item.description || '') ? again() : null));
    form.querySelector('[data-cancel-desc]').onclick = () => (area.value === (item.description || '') || confirm('Throw away what you typed?')) && again();
  };
  /**
   * Change one field right where it shows: the value turns into that field's input (the same one the "new item"
   * form uses). A list, date or tick box saves as soon as it's changed; text saves with Enter (Ctrl+Enter in a
   * long box) or "Save". Esc puts it back. The save shows at once and the notice offers Undo.
   */
  const editInPlace = async (box) => {
    const key = box.dataset.editField;
    if (el.querySelector('.pm-ief')) return;   // one at a time
    const parents = key === 'parent' ? (await loadParents(project.id).catch(() => [])).filter((p) => {
      const pt = cfg.typeById.get(p.type_id);
      return pt && p.id !== item.id && (type.parent_type_ids?.length ? type.parent_type_ids.includes(pt.id) : pt.level < type.level);
    }) : [];
    const required = editLayout.flatMap((s) => s.fields).find((f) => f.key === key)?.required;
    const holder = document.createElement('form');
    holder.className = 'pm-ief';
    holder.noValidate = true;
    holder.innerHTML = `${fieldInput(key, { b, cfg, item, parents, collaborators: collab }, { required: !!required })}
      <div class="pm-ief-actions"><button type="submit" class="btn btn-sm btn-primary">Save</button><button type="button" class="btn btn-sm btn-ghost" data-ief-cancel>Cancel</button>
        <span class="muted small">Enter saves · Esc cancels</span></div>`;
    box.hidden = true;
    box.after(holder);
    const input = holder.querySelector('input:not([type=hidden]), select, textarea, summary');
    if (input?.tagName === 'SUMMARY') input.parentElement.open = true;
    else input?.focus();
    const close = () => (holder.remove(), (box.hidden = false), box.focus());
    let busy = false;
    const save = async () => {
      if (busy) return;
      if (!holder.checkValidity()) return holder.reportValidity();
      const patch = readFields(holder, cfg);
      if (patch.custom) patch.custom = { ...(item.custom || {}), ...patch.custom };
      busy = true;
      holder.querySelectorAll('button').forEach((x) => (x.disabled = true));
      if (await saveField({ b, item, cfg, root: el, after: again }, patch)) return;
      busy = false;   // refused: what was typed stays, with the reason in the notice
      holder.querySelectorAll('button').forEach((x) => (x.disabled = false));
    };
    holder.onsubmit = (e) => (e.preventDefault(), save());
    holder.querySelector('[data-ief-cancel]').onclick = close;
    holder.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close());
      else if (e.key === 'Enter' && e.target.tagName === 'TEXTAREA' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), save());
    });
    // a pick saves at once; typing waits for Enter or Save
    holder.addEventListener('change', (e) => {
      const one = (e.target.matches('select:not([multiple]), input[type=date], input[type=checkbox], .pm-people') && !e.target.closest('.pm-multi, .pm-checks') && key !== 'blocked')
        && !(e.target.matches('.pm-people') && e.target.dataset.multi === '1');   // several people: add them all, then Save
      if (one) save();
    });
  };
  el.addEventListener('click', (e) => {
    const box = e.target.closest('[data-edit-field]');
    if (box && !e.target.closest('a')) editInPlace(box);
  });
  el.addEventListener('keydown', (e) => {
    const box = e.target.closest?.('[data-edit-field]');
    if (box && (e.key === 'Enter' || e.key === ' ') && e.target === box) (e.preventDefault(), editInPlace(box));
  });
  const copyLink = async () => {
    const url = location.href.split('#')[0] + itemHref(item.key);
    try { await navigator.clipboard.writeText(url); toast(`Link to ${item.key} copied.`); } catch { prompt('Copy this link:', url); }
  };
  // Item-page keys (shown under "?"): A assign to me, M comment, S status, E rename, . the command bar
  const keys = (e) => {
    if (!el.isConnected) return document.removeEventListener('keydown', keys);
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (document.querySelector('dialog[open], .pm-pick, .pm-cmd, .pm-ief')) return;
    const k = e.key.toLowerCase();
    if (k === 'a' && mayEdit && item.owner_id !== b.me) (e.preventDefault(), saveField({ b, item, cfg, root: el, after: again }, { owner_id: b.me }));
    else if (k === 'm' && may('comment')) {
      e.preventDefault();
      const area = el.querySelector('[data-comment] textarea');
      area.scrollIntoView({ block: 'center' });
      area.focus();
    } else if (k === 's') { const s = el.querySelector('.pm-status-btn [data-ie="status"]'); if (s) (e.preventDefault(), s.click()); }
    else if (k === 'e') { const t = el.querySelector('[data-rename-title]'); if (t) (e.preventDefault(), renameTitle(t)); }
    else if (e.key === '.') (e.preventDefault(), openCommandBar());
  };
  document.addEventListener('keydown', keys);
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (t.closest('.pm-more-pop')) t.closest('details')?.removeAttribute('open');
    if (d.activityTab) {
      activityTab = d.activityTab;
      try { localStorage.setItem('onesolar:pm-activity', activityTab); } catch { /* fine */ }
      el.querySelectorAll('[data-activity-tab]').forEach((x) => { x.classList.toggle('is-on', x === t); x.setAttribute('aria-selected', String(x === t)); });
      el.querySelector('[data-feed]').innerHTML = feed(activityTab);
      return;
    }
    if (d.copyLink !== undefined) return void copyLink();
    if (d.block) {
      if (d.block === '0') return void saveField({ b, item, cfg, root: el, after: again }, { blocked: false, blocked_reason: '' });
      const why = await askText({ title: `Mark ${item.key} as blocked`, label: 'What is it waiting on?', ok: 'Mark as blocked', required: false });
      if (why === null) return;
      return void saveField({ b, item, cfg, root: el, after: again }, { blocked: true, blocked_reason: why.trim() });
    }
    if (d.shareAlumni !== undefined) {
      const ok = confirm(`Share ${item.key} with alumni? It goes on the alumni hub's "What we need" list${auth.can('sgaa.edit') ? '' : ' as a draft that someone with "Edit the alumni hub" makes public'}, so alumni can offer parts, money or know-how.`);
      if (ok) fresh(() => pm.shareWithAlumni(project.id, item.id, true), 'Shared with alumni.');
      return;
    }
    if (d.addFile !== undefined) {
      t.closest('details')?.removeAttribute('open');
      return void filesBox.querySelector('.attach-open')?.click();
    }
    if (t.closest('.pm-add-menu')) t.closest('details').removeAttribute('open');
    if (d.pinField) return void (togglePin(d.pinField), again());
    if (d.hideEmpty !== undefined) return void (setItemPrefs({ ...itemPrefs(), hideEmpty: !itemPrefs().hideEmpty }), again());
    if (d.copyItem !== undefined) {
      const made = await copyDialog(b, cfg, item, x.checklist);
      if (made) ((location.hash = itemHref(made.key)), toast(`Made ${made.key}, a copy of ${item.key}.`));
      return;
    }
    if (d.editDesc !== undefined) editDescription();
    else if (d.watch !== undefined) fresh(() => pm.watch(item.id, !watchers.includes(b.me)));
    else if (d.archive !== undefined) confirm(item.archived_at ? `Restore ${item.key}?` : `Archive ${item.key} and everything under it? It can be restored.`) && fresh(() => pm.archiveItem(item.id, !item.archived_at));
    else if (d.approve || d.reject) {
      const note = d.reject ? await askText({ title: 'Send it back', label: 'Why isn\'t it approved?', ok: 'Send back', multiline: true }) : '';
      if (d.reject && !note) return;
      fresh(() => pm.decideApproval(d.approve || d.reject, !!d.approve, note), d.approve ? 'Approved.' : 'Sent back.');
    } else if (d.accept !== undefined) fresh(() => pm.accept(item.id, d.accept === '1'), d.accept === '1' ? 'Accepted.' : 'Acceptance withdrawn.');
    else if (d.checkDel) fresh(() => pm.saveChecklist(item.id, x.checklist.filter((c) => c.id !== d.checkDel)));
    else if (d.unlink) fresh(() => pm.unlink(d.unlink));
    else if (d.addDep !== undefined) (await depDialog(b, item)) && again();
    else if (d.addDoc !== undefined) (await addDocDialog(b, project, { projectId: project.id, itemId: item.id }, { siteUrl: config.siteUrl })) && again();
    else if (d.unlinkDoc) fresh(() => pm.removeResourceLink(d.unlinkDoc));
    else if (d.addRef !== undefined) (await refDialog(item, d.addRef || null)) && again();
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

/** Find another item (any project I can see) and say which way the dependency goes. */
function depDialog(b, item) {
  let found = [];
  return formDialog({
    title: `Add a dependency to ${esc(item.key)}`, submit: 'Add',
    body: `<div class="field"><label for="dep-q">Find the other item</label><input id="dep-q" type="search" placeholder="Title or key, in any space you can see" autocomplete="off">
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

/** Link a record from another one.solar app (any kind in the link registry, 068): search, pick, optional note. */
/**
 * Link a record from another app, or a related item (V1: one button, the kind picked inside). Kinds the person's role
 * can't use (the app's own rule, checked by the database) aren't offered.
 */
export async function refDialog(item, first) {
  const all = await linkTypes().catch(() => []);
  const usable = (await Promise.all(all.map((t) => searchLinks(t.key, '').then(() => t, () => null)))).filter(Boolean);
  if (!usable.length) return toast('Your role can\'t link any kind of record here.', 'bad'), null;
  let kind = usable.some((t) => t.key === first) ? first : usable[0].key;
  const typeOf = () => usable.find((t) => t.key === kind);
  return formDialog({
    title: 'Link a record', submit: 'Link it',
    body: `<div class="field"><span class="small muted" id="ref-kind-label">What kind</span>
        <span role="tablist" class="pm-seg" aria-labelledby="ref-kind-label">${usable.map((t) => `<button type="button" role="tab" data-ref-kind="${esc(t.key)}" aria-selected="${t.key === kind}">${esc(t.label)}</button>`).join('')}</span></div>
      <div class="field"><label for="ref-q">Find it</label><input id="ref-q" type="search" placeholder="${esc(typeOf().search_hint)}" autocomplete="off">
        <div class="hint" data-ref-hint>Type to search, type its number (like ${esc(item.key)}), or paste a one.solar link.</div>
        <select name="ref" size="6" required aria-label="Matches"></select></div>
      <div class="field"><label for="ref-note">Note (optional)</label><input id="ref-note" name="note" type="text" maxlength="300" placeholder="${esc(typeOf().note_hint)}"></div>`,
    onOpen(form) {
      let timer;
      const q = form.querySelector('#ref-q');
      const hint = form.querySelector('[data-ref-hint]');
      const pick = (key) => {
        kind = key;
        form.querySelectorAll('[data-ref-kind]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.refKind === key)));
        q.placeholder = typeOf().search_hint;
        form.querySelector('#ref-note').placeholder = typeOf().note_hint;
      };
      const search = async () => {
        const text = q.value.trim();
        let rows = [];
        let note = 'Type to search, type its number, or paste a one.solar link.';
        const pasted = linkFromUrl(text);
        if (pasted) {
          // a pasted link: go to its kind and show just that record
          if (!usable.some((t) => t.key === pasted.kind)) note = 'Your role can\'t link that kind of record.';
          else {
            pick(pasted.kind);
            rows = pasted.id ? [...(((await describeLinks([{ kind: pasted.kind, ref_id: pasted.id }])).get(pasted.kind) || new Map()).values())]
              : (await searchLinks(pasted.kind, pasted.code).catch(() => [])).filter((r) => String(r.code || '').toUpperCase() === pasted.code);
            note = rows.length ? 'Found the record that link points to.' : 'That link\'s record doesn\'t exist, or you can\'t see it.';
          }
        } else if (text) {
          rows = exactFirst(await searchLinks(kind, text).catch((err) => (toast(err.message, 'bad'), [])), text);
        } else if (kind === 'item') {
          // nothing typed: the items opened lately on this device
          const keys = recentItems().map((r) => r.key).filter((k) => k !== item.key);
          rows = keys.length ? (await pm.search({ filter: { f: 'key', op: 'in', v: keys }, limit: 8 }).catch(() => ({ items: [] }))).items
            .sort((a, c) => keys.indexOf(a.key) - keys.indexOf(c.key)).map((i) => ({ id: i.id, code: i.key, title: i.title })) : [];
          if (rows.length) note = 'Recently viewed. Type to search for others.';
        }
        rows = rows.filter((r) => !(kind === 'item' && r.id === item.id));
        hint.textContent = note;
        form.elements.ref.innerHTML = rows.map((r) => `<option value="${esc(r.id)}">${esc(linkOption(r))}</option>`).join('');
        if (rows.length) form.elements.ref.selectedIndex = 0;   // Enter links the first (an exact number match comes first)
      };
      q.oninput = () => (clearTimeout(timer), (timer = setTimeout(search, 250)));
      form.querySelectorAll('[data-ref-kind]').forEach((btn) => (btn.onclick = () => {
        pick(btn.dataset.refKind);
        if (linkFromUrl(q.value)) q.value = '';
        search();
        q.focus();
      }));
      q.addEventListener('paste', () => setTimeout(search, 0));
      search();
      q.focus();
    },
    onSubmit: (form) => pm.addRef(item.id, kind, form.elements.ref.value, form.elements.note.value.trim()),
  });
}

/** Move to another project: pick the project, then what kind of item it becomes there. */
async function moveDialog(b, item) {
  const targets = b.projects.filter((p) => p.id !== item.project_id && !p.archived_at && can(b, p.id, 'create'));
  if (!targets.length) return toast('There\'s no other space you can add items to.', 'bad'), null;
  const shapes = new Map();
  const typesOf = async (id) => shapes.get(id) || shapes.set(id, (await pm.shapes([id])).types.filter((t) => !t.archived_at)).get(id);
  return formDialog({
    title: `Move ${esc(item.key)} to another space`, submit: 'Move it',
    body: `<p class="muted">It gets the other space's next number; its old name still opens it. History, comments, checklist, documents and links come along. Items under it stay here.
        Custom fields the other space doesn't have are kept in the history only.</p>
      <div class="field"><label for="mv-project">Space</label><select id="mv-project" name="project">${targets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.key)})</option>`).join('')}</select></div>
      <div class="field"><label for="mv-type">It becomes a</label><select id="mv-type" name="type" required></select></div>`,
    onOpen(form) {
      const fill = async () => (form.elements.type.innerHTML = (await typesOf(form.elements.project.value)).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join(''));
      form.elements.project.onchange = fill;
      fill();
    },
    onSubmit: (form) => pm.moveItem(item.id, { project_id: form.elements.project.value, type_id: form.elements.type.value }),
  });
}

// ---- per-person item page settings (this device): pinned fields, hide empty ones ----------------------------
const PREFS = 'pm.itemPrefs';
function itemPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || '{}');
    return { pinned: Array.isArray(p.pinned) ? p.pinned.slice(0, 20) : [], hideEmpty: p.hideEmpty !== false };   // C2: hidden unless you show them
  } catch {
    return { pinned: [], hideEmpty: true };
  }
}
function setItemPrefs(p) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch { /* private window: it just isn't kept */ }
}
function togglePin(key) {
  const p = itemPrefs();
  p.pinned = p.pinned.includes(key) ? p.pinned.filter((k) => k !== key) : [...p.pinned, key];
  setItemPrefs(p);
}

/**
 * Copy an item: a new one in the same project with the same kind, fields and (if ticked) checklist and parent.
 * It starts in the first status, with you as its reporter; comments, history, files and links aren't copied.
 */
function copyDialog(b, cfg, item, checklist) {
  return formDialog({ title: `Copy ${esc(item.key)}`, submit: 'Make the copy',
    body: `<div class="field"><label for="cp-title">Title</label><input id="cp-title" name="title" type="text" maxlength="200" required value="${esc(`Copy of ${item.title}`.slice(0, 200))}"></div>
      <label class="pm-check"><input type="checkbox" name="checklist" ${checklist.length ? 'checked' : 'disabled'}> The checklist (${checklist.length} step${checklist.length === 1 ? '' : 's'}, unticked)</label>
      ${item.parent_id ? '<label class="pm-check"><input type="checkbox" name="parent" checked> Under the same parent</label>' : ''}
      <label class="pm-check"><input type="checkbox" name="dates"> The same start and due dates</label>
      <p class="hint">Fields, owner, priority, labels and the description come along. Comments, history, files and links don't. It starts in the first status.</p>`,
    onOpen: (f) => f.elements.title.select(),
    onSubmit: (f) => pm.createItem(newId(), {
      project_id: item.project_id, type_id: item.type_id, title: f.elements.title.value.trim(),
      description: item.description || '', acceptance: item.acceptance || '', priority: item.priority, owner_id: item.owner_id || null,
      division_id: item.division_id || null, subsystem_id: item.subsystem_id || null, vehicle: item.vehicle || '', estimate_hours: item.estimate_hours,
      labels: item.labels || [], custom: item.custom || {},
      ...(f.elements.parent?.checked ? { parent_id: item.parent_id } : {}),
      ...(f.elements.dates.checked ? { start_date: item.start_date, due_date: item.due_date } : {}),
      checklist: f.elements.checklist.checked ? checklist.map((c) => c.text) : [],
    }),
  });
}
