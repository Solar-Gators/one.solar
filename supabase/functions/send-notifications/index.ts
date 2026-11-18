/**
 * send-notifications — delivers queued messages from notification_outbox.
 *
 * The database queues a message whenever a request moves through the workflow
 * (see migration 010), when a watched Sponsors card moves or gets a note (015), and at the
 * Solar Evals steps (031: self-eval submitted, meeting scheduled, eval shared), and when an alum writes to a contact on the
 * alumni hub (052: emailed with Reply-To the alum, so replies go straight to them). The website calls this function right after each action,
 * and Admin → Notifications has a "Send now" button; each run sends everything
 * that's waiting and retries earlier failures (up to 5 tries).
 *
 * Secrets (Supabase → Edge Functions → Secrets). Set what you use:
 *   FLOW_URL     Power Automate "When a Teams webhook request is received" URL.
 *                Used for Teams messages, and for email too when SMTP isn't set
 *                (the flow sends it from Outlook).
 *   SMTP_USER    Gmail address that sends the emails, e.g. solargators.orders@gmail.com
 *   SMTP_PASS    That account's 16-letter Google "app password".
 *   SMTP_HOST / SMTP_PORT / SMTP_FROM_NAME   optional (smtp.gmail.com / 465 / team name).
 *   CRON_SECRET  optional: a long random string. The scheduled job (supabase/ops/cron_send_notifications.sql)
 *                sends it in an x-cron-secret header, so delayed messages go out without anyone on the site.
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
 *
 * Who may run it (S-7): someone signed in who is on the team (not a Guest or former member), or the
 * scheduled job with CRON_SECRET. Anything else gets 401, so the public key alone can't trigger runs.
 * That means "Verify JWT" can be off for this function: it checks callers itself (the scheduled job has
 * no sign-in to send).
 *
 * Deploy: see docs/MAINTAINING.md → "Email & Teams notifications".
 * This file has no imports at the top so it can also be loaded by the Node tests.
 */

type Row = {
  id: number;
  event: string;
  request_id: string | null;
  email: string;
  channel: 'email' | 'teams';
  payload: Record<string, unknown>;
};
type Template = { subject: string; body: string };
export type Message = {
  subject: string; lines: string[]; link: string; linkLabel: string; facts: [string, string][]; logo?: string;
  /** SGAA (052): replies go to the alum who wrote, and the email says who it's from. */
  replyTo?: string; fromName?: string; footer?: string;
};

/** A plain email address (no name, no line breaks): safe for a Reply-To header. */
export const plainEmail = (s: unknown) => {
  const v = String(s ?? '').trim();
  return /^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]+$/.test(v) && v.length <= 254 ? v : '';
};

/** The team logo under every message: the copy the website itself serves (needs Website address in Admin). */
export const logoUrl = (siteUrl: string) => (siteUrl ? `${siteUrl.replace(/#.*$/, '').replace(/\/?$/, '/')}assets/solar-gators-logo.png` : '');

const FALLBACK: Record<string, Template> = {
  submitted: { subject: '{request_number} needs your approval', body: '{requester} submitted "{title}": {total} from {vendor}.' },
  approved: { subject: '{request_number} was approved', body: '"{title}" was approved by {approver}.' },
  ready_to_order: { subject: '{request_number} is ready to order', body: '"{title}" ({total} from {vendor}) is ready to order.' },
  changes_requested: { subject: '{request_number}: changes requested', body: '{approver} asked for changes to "{title}":\n{comment}' },
  rejected: { subject: '{request_number} was rejected', body: '{approver} rejected "{title}":\n{comment}' },
  cancelled: { subject: '{request_number} was cancelled', body: '"{title}" was approved but cancelled by {approver} before it was ordered.\nWhy: {comment}' },
  ordered: { subject: '{request_number} has been ordered', body: '"{title}" has been ordered.\nOrder / ticket number: {ticket}' },
  received: { subject: '{request_number} has arrived', body: '"{title}" was marked received by {received_by}.\nWhere: {where}' },
  purchase_step: { subject: '{request_number}: {step}', body: '"{title}" is now at "{step}" with purchasing.' },
  items_changed: { subject: '{request_number}: the items changed', body: '{approver} changed the items on "{title}" (now {total}):\n{changes}\nWhy: {comment}' },
  request_update: { subject: '{request_number} is now {status}', body: '"{title}" ({requester}) is now {status}. You\'re getting this because you watch it.' },
  sponsor_update: { subject: '{sponsor}: {what}', body: '{actor} updated {sponsor} on the Sponsors board: {what}.' },
  eval_update: { subject: 'Solar Evals: {what}', body: 'Hi {first_name}, {details}' },
  project_update: { subject: '{what}', body: 'Hi {first_name}, {details}' },
  sgaa_message: {
    subject: 'Alumni hub: {what}',
    body: 'Hi {first_name}, {from_name} ({from_kind}) sent you a message on the alumni hub.\nAbout: {need}\n{details}\nReply to this email to answer {from_name} directly.',
  },
  test: {
    subject: 'Test message from the order form',
    body: 'Hi {first_name}, notifications are working. You will get messages like this when requests need you or change status.',
  },
};

const money = (n: unknown) =>
  Number.isFinite(Number(n)) ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';

/** Placeholder values for a queued message. */
export function placeholders(payload: Record<string, unknown>, siteUrl: string): Record<string, string> {
  const s = (k: string) => (payload[k] == null ? '' : String(payload[k]).trim());
  const base = siteUrl ? siteUrl.replace(/#.*$/, '').replace(/\/?$/, '/') : '';
  // Other one.solar apps on the same site. The website address is the Orders app (…/one.solar/orders/),
  // so the one.solar root is one folder up, and app paths like "evals/#/evals/…" are relative to it.
  const origin = base.match(/^https?:\/\/[^/]+/)?.[0] || '';
  const root = /\/orders\/$/.test(base) ? base.slice(0, -'orders/'.length) : '';
  let appPath = s('app_path');
  // Solar Evals moved from /Custom-Apps/solarevals to evals/ when the apps were combined (2026-11).
  if (root) appPath = appPath.replace(/^\/Custom-Apps\/solarevals\/?/, 'evals/');
  const appLink = !appPath ? '' : appPath.startsWith('/') ? (origin ? origin + appPath : '') : root ? root + appPath : '';
  // Sponsors, Finances and Admin are their own apps next to Orders (…/one.solar/sponsors/#/sponsors/…).
  const own = s('path').match(/^\/(sponsors|finances|admin)(\/|$)/)?.[1];
  const pathLink = root && own ? `${root}${own}/#${s('path')}` : '';
  return {
    request_number: s('request_number'),
    title: s('title'),
    requester: s('requester'),
    status: s('status'),
    season: s('season'),
    total: payload.total == null ? '' : money(payload.total),
    vendor: s('vendor'),
    comment: s('comment'),
    changes: s('changes'),
    step: s('step'),
    approver: s('approver'),
    ticket: s('ticket'),
    where: s('where'),
    received_by: s('received_by'),
    rule: s('rule'),
    recipient_name: s('recipient_name'),
    first_name: s('recipient_name').split(/\s+/)[0] || 'there',
    // Sponsors board
    sponsor: s('sponsor'),
    stage: s('stage'),
    what: s('what'),
    actor: s('actor'),
    kind: s('kind'),
    amount: payload.amount == null ? '' : money(payload.amount),
    // Solar Evals
    details: s('details'),
    member: s('member'),
    semester: s('semester'),
    // SGAA messages (052)
    from_name: s('from_name'),
    from_kind: s('from_kind'),
    need: s('need'),
    reply_to: plainEmail(payload.reply_to),
    link: appLink ? appLink : pathLink ? pathLink : base && s('path') ? `${base}#${s('path')}` : base && s('request_number') ? `${base}#/requests/${encodeURIComponent(s('request_number'))}` : base,
  };
}

/**
 * Fill {placeholders}. A line whose placeholders all came out empty is dropped
 * (so "Comment: {comment}" disappears when there's no comment).
 */
export function fill(template: string, values: Record<string, string>): string {
  return String(template || '')
    .split('\n')
    .filter((line) => {
      const keys = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => k in values);
      return !keys.length || keys.some((k) => values[k] !== '');
    })
    .map((line) => line.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m)))
    .join('\n')
    .trim();
}

export function render(row: Pick<Row, 'event' | 'payload'>, settings: Record<string, any>): Message {
  const values = placeholders(row.payload || {}, settings?.siteUrl || '');
  const t: Template = { ...FALLBACK[row.event], ...(settings?.templates?.[row.event] || {}) };
  const sponsor = row.event.startsWith('sponsor_');
  const evals = row.event.startsWith('eval_');
  const projects = row.event.startsWith('project_');
  const sgaa = row.event.startsWith('sgaa_');
  const all: [string, string][] = sgaa
    ? [['From', values.from_name], ['Reply to', values.reply_to]]
    : projects
    ? []
    : evals
    ? [['Member', values.member], ['Semester', values.semester]]
    : sponsor
    ? [['Sponsor', values.sponsor], ['Stage', values.stage], ['Type', values.kind], ['Amount', values.amount]]
    : [
        ['Request', values.request_number],
        ['Title', values.title],
        ['Requester', values.requester],
        ['Total', values.total],
        ['Vendor', values.vendor],
        ['Status', values.status],
      ];
  const facts = all.filter(([, v]) => v);
  return {
    subject: fill(t.subject || '{request_number}', values).split('\n')[0] || 'Order form',
    lines: fill(t.body || '', values).split('\n').filter(Boolean),
    link: values.link,
    linkLabel: sgaa ? 'See your alumni messages' : projects ? 'Open in Projects' : evals ? 'Open Solar Evals' : sponsor ? 'Open on the Sponsors board' : values.request_number ? `Open ${values.request_number}` : 'Open the order form',
    facts: row.event === 'test' ? [] : facts,
    logo: logoUrl(settings?.siteUrl || ''),
    ...(sgaa ? {
      replyTo: values.reply_to || undefined,
      // "Alex Alum via one.solar": recognizable in the inbox; the address is still the team's sender.
      fromName: values.from_name ? `${values.from_name.replace(/["<>\r\n]/g, '').slice(0, 60)} via one.solar` : undefined,
      footer: 'You get these because you\'re a contact on the Solar Gators alumni hub. Your email address isn\'t shown there; it\'s only revealed if you reply.',
    } : {}),
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function emailHtml(m: Message, teamName = 'Solar Gators'): string {
  const facts = m.facts
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`)
    .join('');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#1f2937;max-width:560px">
${m.lines.map((l) => `<p style="margin:0 0 10px">${escapeHtml(l)}</p>`).join('\n')}
${facts ? `<table style="border-collapse:collapse;margin:12px 0;font-size:14px">${facts}</table>` : ''}
${m.link ? `<p style="margin:18px 0"><a href="${escapeHtml(m.link)}" style="background:#f26b1d;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(m.linkLabel)}</a></p>` : ''}
${m.logo ? `<img src="${escapeHtml(m.logo)}" alt="${escapeHtml(teamName)}" width="140" style="display:block;width:140px;height:auto;border:0;margin:28px 0 0">` : ''}
<p style="margin:${m.logo ? '10px' : '24px'} 0 0;font-size:12px;color:#9ca3af">${escapeHtml(m.footer || `${teamName} order form. You can turn these messages off on your Account page.`)}</p>
</div>`;
}

export function emailText(m: Message): string {
  return [...m.lines, '', ...m.facts.map(([k, v]) => `${k}: ${v}`), '', m.link ? `${m.linkLabel}: ${m.link}` : '']
    .join('\n')
    .trim();
}

/** Adaptive card for Teams. */
export function teamsCard(m: Message) {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: m.subject, weight: 'Bolder', size: 'Medium', wrap: true },
      ...m.lines.map((text) => ({ type: 'TextBlock', text, wrap: true, spacing: 'Small' })),
      ...(m.facts.length ? [{ type: 'FactSet', facts: m.facts.map(([title, value]) => ({ title, value })) }] : []),
      ...(m.logo ? [{ type: 'Image', url: m.logo, altText: 'Solar Gators', width: '120px', spacing: 'Large' }] : []),
    ],
    actions: m.link ? [{ type: 'Action.OpenUrl', title: m.linkLabel, url: m.link }] : [],
  };
}

/**
 * What's POSTed to the Power Automate flow. `type`/`attachments` is the shape
 * Teams webhook flows expect; the rest is for the "who / which channel" steps.
 */
export function flowPayload(row: Pick<Row, 'email' | 'channel'>, m: Message, teamName = 'Solar Gators') {
  const card = teamsCard(m);
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }],
    channel: row.channel,
    recipient: row.email,
    subject: m.subject,
    text: emailText(m),
    html: emailHtml(m, teamName),
    link: m.link,
    card: JSON.stringify(card),
    // SGAA messages: the flow's "Send an email" step can put this in Reply To ('' otherwise).
    replyTo: m.replyTo || '',
  };
}

// ---------------------------------------------------------------------------

async function sendViaFlow(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Power Automate answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

let transport: any = null;
async function sendViaSmtp(env: (k: string) => string | undefined, to: string, m: Message, teamName: string) {
  if (!transport) {
    const nodemailer = (await import('npm:nodemailer@6.9.16')).default;
    const port = Number(env('SMTP_PORT') || 465);
    transport = nodemailer.createTransport({
      host: env('SMTP_HOST') || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: env('SMTP_USER'), pass: (env('SMTP_PASS') || '').replace(/\s+/g, '') },
    });
  }
  await transport.sendMail({
    from: { name: m.fromName || env('SMTP_FROM_NAME') || `one.solar · ${teamName}`, address: env('SMTP_USER')! },
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    to,
    subject: m.subject,
    text: emailText(m),
    html: emailHtml(m, teamName),
  });
}

/** Two strings equal, in time that doesn't depend on where they differ. */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Who is calling: 'cron' (the scheduled job's secret), 'member' (a signed-in team member), or '' (refuse).
 * The sign-in token is checked with Supabase Auth, and membership in profile_roles (any role but Guest or
 * former member). Exported for tests, with fetch passed in.
 */
export async function caller(
  req: Request,
  env: (k: string) => string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<'cron' | 'member' | ''> {
  const cronSecret = env('CRON_SECRET') || '';
  if (cronSecret && sameSecret(req.headers.get('x-cron-secret') || '', cronSecret)) return 'cron';
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !token.includes('.')) return ''; // not a sign-in token (e.g. the public key)
  const url = env('SUPABASE_URL')!;
  const key = env('SUPABASE_SERVICE_ROLE_KEY')!;
  const who = await fetchFn(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!who.ok) return '';
  const user = await who.json().catch(() => null);
  if (!user?.id || !/^[0-9a-f-]{36}$/i.test(user.id)) return '';
  const roles = await fetchFn(
    `${url}/rest/v1/profile_roles?user_id=eq.${user.id}&role=not.in.(guest,alumni)&select=role&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!roles.ok) return '';
  const rows = await roles.json().catch(() => []);
  return Array.isArray(rows) && rows.length ? 'member' : '';
}

async function handle(req: Request): Promise<Response> {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // @ts-ignore Deno global
  const env = (k: string): string | undefined => Deno.env.get(k);
  if (!(await caller(req, env))) {
    return new Response(JSON.stringify({ error: 'Only someone signed in on the team (or the scheduled job) can send notifications.' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  const url = env('SUPABASE_URL')!;
  const key = env('SUPABASE_SERVICE_ROLE_KEY')!;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const rest = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };

  const [[notif], [general]] = await Promise.all([
    rest('app_settings?key=eq.notifications&select=value'),
    rest('app_settings?key=eq.general&select=value'),
  ]);
  const settings = notif?.value || {};
  const teamName = general?.value?.teamName || 'Solar Gators';
  const flowUrl = env('FLOW_URL');
  const smtp = env('SMTP_USER') && env('SMTP_PASS');

  const results = { sent: 0, failed: 0, errors: [] as string[] };
  for (let round = 0; round < 10; round++) {
    const rows: Row[] = await rest('rpc/claim_notifications', { method: 'POST', body: JSON.stringify({ p_limit: 25 }) });
    if (!rows.length) break;
    for (const row of rows) {
      let error = '';
      try {
        const m = render(row, settings);
        if (row.channel === 'email' && smtp) await sendViaSmtp(env, row.email, m, teamName);
        else if (flowUrl) await sendViaFlow(flowUrl, flowPayload(row, m, teamName));
        else throw new Error(row.channel === 'email' ? 'Email isn\'t set up: add SMTP_USER and SMTP_PASS (or FLOW_URL).' : 'Teams isn\'t set up: add FLOW_URL.');
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await rest('rpc/finish_notification', { method: 'POST', body: JSON.stringify({ p_id: row.id, p_ok: !error, p_error: error }) });
      if (error) {
        results.failed++;
        if (!results.errors.includes(error)) results.errors.push(error);
      } else results.sent++;
    }
  }
  return new Response(JSON.stringify(results), { headers: { ...cors, 'Content-Type': 'application/json' } });
}

// @ts-ignore Deno global (absent when the tests import this file in Node)
if (typeof Deno !== 'undefined') Deno.serve((req: Request) => handle(req).catch((err) =>
  new Response(JSON.stringify({ error: String(err?.message || err) }), {
    status: 500,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  })));
