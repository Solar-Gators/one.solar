/**
 * Events pages (064): what they share. The team (members, divisions, subsystems, who's where, positions) and the
 * categories are loaded once and kept until something changes. Dialogs and notices are Projects' (kit.js there).
 */
import { auth } from '../../auth.js';
import { api } from '../../api.js';
import { esc } from '../../ui.js';
import { ev } from '../../events/api.js';
import { phase, inviteText, STANDING_LABELS, STANDING_TONES } from '../../events/core.js';
export { formDialog, toast, attempt, friendly } from '../projects/kit.js';

/** Who can do what (the database checks again). */
export const mayCreate = () => auth.can('events.create') || auth.hasRole('admin');
export const seesAll = () => auth.can('events.attendance') || auth.hasRole('admin');
export const runs = (e) => !!e && (e.host_id === auth.user?.id || (e.cohosts || []).includes(auth.user?.id) || auth.hasRole('admin'));

/** The database has Events (064)? Otherwise pages say so instead of failing. */
export function needsDatabase(config) {
  if (Number(config.schemaVersion) >= 64) return '';
  return `<section class="card no-access"><h1>Events isn't set up yet</h1>
    <p>The database needs the update <code>supabase/migrations/064_events.sql</code>. ${auth.can('settings.edit') ? 'See the yellow banner above.' : 'Ask an Admin.'}</p></section>`;
}

let base = null;
let synced = 0;
/** Members, divisions, subsystems, who's where, positions and categories. Kept until invalidate(). */
export async function loadBase({ fresh = false } = {}) {
  // Upcoming events' invite lists follow the team (new members, people who moved): at most every 5 minutes.
  if (Date.now() - synced > 300000) {
    synced = Date.now();
    await ev.sync().catch(() => {});
  }
  if (!base || fresh) {
    base = Promise.all([api.listProfiles(), ev.divisions().catch(() => []), ev.subsystems().catch(() => []), ev.personOrg().catch(() => []), ev.categories()])
      .then(([profiles, divisions, subsystems, org, categories]) => {
        const people = profiles.filter((p) => (p.roles || []).some((r) => r !== 'guest' && r !== 'alumni'));
        const positions = (auth.roles || []).filter((r) => !['guest', 'alumni'].includes(r.key));
        return {
          me: auth.user?.id, people, divisions, subsystems, org, positions, categories,
          personById: new Map(profiles.map((p) => [p.id, p])),
          categoryById: new Map(categories.map((c) => [c.id, c])),
          names: {
            division: new Map(divisions.map((d) => [d.id, d.name])),
            subsystem: new Map(subsystems.map((s) => [s.id, s.name])),
            role: new Map(positions.map((r) => [r.key, r.label])),
            person: new Map(profiles.map((p) => [p.id, p.full_name || p.email])),
          },
        };
      });
    base.catch(() => (base = null));
  }
  return base;
}
export const invalidate = () => (base = null);

export const personName = (b, id) => b.names.person.get(id) || 'Someone';
/** "Electrical · Battery" for a person (their main place first). */
export function placeOf(b, userId) {
  const rows = b.org.filter((o) => o.user_id === userId).sort((a, z) => (z.main ? 1 : 0) - (a.main ? 1 : 0));
  return rows.map((o) => [b.names.division.get(o.division_id), o.subsystem_id ? b.names.subsystem.get(o.subsystem_id) : ''].filter(Boolean).join(' · ')).join(', ');
}

export const header = (title, subtitle = '', actions = '') => `<div class="page-header ev-head">
  <div><h1>${title}</h1>${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}</div>
  ${actions ? `<div class="card-actions">${actions}</div>` : ''}</div>`;

export const eventHref = (id, tab = '') => `#/events/e/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}`;
export const categoryChip = (b, id) => {
  const c = b.categoryById.get(id);
  return c ? `<span class="chip-tone tone-${esc(c.color)} ev-cat">${esc(c.name)}</span>` : '';
};
const PHASES = { upcoming: ['Upcoming', 'blue'], now: ['Happening now', 'green'], over: ['Over', 'gray'], cancelled: ['Cancelled', 'red'] };
export const phaseChip = (e) => {
  const [label, tone] = PHASES[phase(e)];
  return `<span class="chip-tone tone-${tone} ev-phase" data-phase="${phase(e)}">${label}${e.checkin_open && !e.cancelled_at ? ' · check-in open' : ''}</span>`;
};
export const standingChip = (s) => (s ? `<span class="chip-tone tone-${STANDING_TONES[s]} ev-standing" data-standing="${s}">${STANDING_LABELS[s]}</span>` : '');
export const inviteWords = (b, e) => inviteText(e.invite, b.names);

/** Download a file made in the browser. */
export function downloadFile(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([type === 'text/csv' ? `﻿${text}` : text], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export const fileDate = () => new Date().toISOString().slice(0, 10);
export const safeName = (s) => String(s || 'event').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'event';

/** Remembered in this browser (columns, views, filters). */
export const remember = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`ev.${key}`);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ev.${key}`, JSON.stringify(value));
    } catch { /* not kept: fine */ }
  },
};


/** An Excel file: one sheet, a bold frozen header row with filters. */
export async function downloadXlsx(filename, sheetName, header, rows) {
  const { loadExcelJS } = await import('../../excel.js');
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'one.solar Events';
  const ws = wb.addWorksheet(String(sheetName).replace(/[\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  ws.columns = header.map((h) => ({ header: h, width: Math.min(40, Math.max(10, String(h).length + 4)) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) ws.addRow(r.map((v) => (v === '' || v === null || v === undefined ? null : v)));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
  downloadFile(filename, await wb.xlsx.writeBuffer(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
