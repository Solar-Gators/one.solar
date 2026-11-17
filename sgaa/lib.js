/**
 * SGAA: small helpers with no page or database in them (tested in tests/sgaaLib.test.mjs).
 */

/** Text made safe to put in HTML. */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Inline formatting on text that's already escaped: **bold**, *italic*, [a link](https://…). */
function inline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, text, href) =>
      `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`);
}

/**
 * The little formatting editors can use in needs, updates and the "how to help" page: paragraphs (blank
 * line), "- " bullet lists, "## " headings, **bold**, *italic* and https links. Everything else is plain
 * text: the input is escaped first, so no HTML gets through.
 */
export function formatText(src) {
  const lines = esc(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    para = [];
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-•]\s+(.*)$/);
    const heading = line.match(/^##\s+(.*)$/);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      out.push(`<h3>${inline(heading[1])}</h3>`);
    } else if (bullet) {
      if (para.length) flush();
      list.push(bullet[1]);
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return out.join('');
}

/** "$4,800" (no cents unless there are some); '' when unknown. */
export function money(n) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '';
  const v = Number(n);
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/** "Sat, Mar 14 · 6:00 PM" (and "– 9:00 PM" when it ends the same day). */
export function when(start, end, { tz } = {}) {
  const s = new Date(start);
  if (Number.isNaN(+s)) return '';
  const day = s.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: s.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', timeZone: tz });
  const time = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  if (!end) return `${day} · ${time(s)}`;
  const e = new Date(end);
  const sameDay = e.toLocaleDateString('en-US', { timeZone: tz }) === s.toLocaleDateString('en-US', { timeZone: tz });
  return sameDay ? `${day} · ${time(s)} – ${time(e)}` : `${day} ${time(s)} – ${when(e, null, { tz })}`;
}

/** "3 days ago", "today": for update dates. */
export function ago(at, now = Date.now()) {
  const days = Math.floor((now - new Date(at)) / 864e5);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A value for <input type="datetime-local"> from an ISO time (local time), and back. */
export const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');

/** Event split for the page: upcoming (soonest first) and past (latest first). */
export function splitEvents(events, now = Date.now()) {
  const end = (e) => new Date(e.endsAt || e.startsAt).getTime();
  return {
    upcoming: events.filter((e) => end(e) >= now).sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt)),
    past: events.filter((e) => end(e) < now).sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt)),
  };
}

/** Spots left at an event ('' when there's no limit). */
export const spotsLeft = (e) => (e.capacity ? Math.max(0, e.capacity - (e.going || 0)) : '');

export const KINDS = { parts: 'Parts & materials', money: 'Funding', expertise: 'Expertise', other: 'Other' };
export const URGENCY = { high: 'Urgent', normal: '', low: 'Nice to have' };

/** A safe file name for Storage: "My Photo (1).JPG" → "my-photo-1.jpg". */
export function fileSlug(name) {
  const m = String(name || '').toLowerCase().match(/^(.*?)(\.[a-z0-9]{1,5})?$/);
  const base = (m?.[1] || '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'photo';
  return base + (m?.[2] || '.jpg');
}
