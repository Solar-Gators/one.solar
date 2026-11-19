/** "My account": name, role, notifications, change password, sign out. Also the password-reset landing page. */
import { homePath } from '../appMode.js';
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, errorBox, setFlash, takeFlash } from '../ui.js';
import { accountOrgSection } from './peopleOrg.js';

function passwordForm(buttonLabel) {
  return `
    <form id="password-form" novalidate>
      <div class="field"><label for="a-pass">New password</label>
        <input id="a-pass" name="password" type="password" autocomplete="new-password" minlength="8"></div>
      <div class="field"><label for="a-pass2">Confirm new password</label>
        <input id="a-pass2" name="confirm" type="password" autocomplete="new-password"></div>
      <div id="password-errors"></div>
      <button type="submit" class="btn">${buttonLabel}</button>
    </form>`;
}

function bindPasswordForm(el, onDone) {
  const form = el.querySelector('#password-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { password, confirm } = Object.fromEntries(new FormData(form));
    const errors = el.querySelector('#password-errors');
    errors.innerHTML = '';
    if (password.length < 8) return (errors.innerHTML = errorBox(new Error('Password must be at least 8 characters.')));
    if (password !== confirm) return (errors.innerHTML = errorBox(new Error('Passwords do not match.')));
    try {
      await auth.updatePassword(password);
      onDone();
    } catch (err) {
      errors.innerHTML = errorBox(err);
    }
  });
}

/** A UF address (also @something.ufl.edu): turned off soon after graduation. */
export const SCHOOL_EMAIL = /@([\w-]+\.)*ufl\.edu$/i;

/** The messages this person can get, worded for them. */
function myEvents(config) {
  const me = auth.user.id;
  const namedInRule = (config.workflow?.rules || []).some((r) => !r.disabled && (r.then?.people || []).includes(me));
  const approver = auth.can('request.review') || auth.can('workflow.edit') || namedInRule;
  return [
    approver && { key: 'submitted', mine: 'A request needs your approval' },
    auth.can('request.order') && { key: 'ready_to_order', mine: 'A request is approved and ready to order' },
    { key: 'approved', mine: 'Your request was approved' },
    { key: 'changes_requested', mine: 'Changes were requested on your request' },
    { key: 'rejected', mine: 'Your request was rejected' },
    { key: 'cancelled', mine: 'Your approved request was cancelled before ordering' },
    { key: 'ordered', mine: 'Your request was ordered' },
    { key: 'received', mine: 'Your request arrived' },
    (config.ledger?.showStepsInOrders === 'requester' || config.ledger?.showStepsInOrders === 'team') &&
      { key: 'purchase_step', mine: 'Your approved request (or one you watch) moves to another purchasing step, e.g. "Request sent"' },
    { key: 'items_changed', mine: 'The Treasurer changed the items on your request (e.g. something was out of stock)' },
    { key: 'request_update', mine: 'A request you watch changes status' },
    (auth.can('sponsors.view') || auth.can('sponsors.edit')) && { key: 'sponsor_update', mine: 'A sponsor card you watch moves or gets a note' },
    (auth.can('projects.view') || auth.can('projects.create') || auth.can('projects.manage')) && { key: 'project_update', mine: "Projects: something is assigned to you, you're mentioned, someone asks for your approval, or a deadline is close (more choices in Projects → Inbox)" },
    { key: 'eval_update', mine: 'Solar Evals: someone submits a self-eval to you, you\'re asked for input on an eval, or your own eval / eval meeting is ready' },
  ].filter(Boolean);
}

export async function renderAccount(el, { config, rerender }) {
  const user = auth.user;
  const notify = config.notifications || {};
  // 052: a UF address stops working soon after graduation, so alumni (and former members) are asked to switch.
  const schoolEmail = SCHOOL_EMAIL.test(user.email || '');
  const leaving = schoolEmail && (auth.isFormer || auth.signedUpAsAlum || ['alum', 'pending'].includes(await api.myAlumStatus(user.id)));
  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>My account</h1></div>
      <button type="button" class="btn btn-sm" id="sign-out">Sign out</button></div>
    <div class="account-page">
      <section class="card">
        <h2>Profile</h2>
        <form id="profile-form" novalidate>
          <div class="field"><label for="a-name">Full name</label>
            <input id="a-name" name="full_name" type="text" value="${esc(user.full_name)}" autocomplete="name"></div>
          <dl class="meta-grid compact">
            <div><dt>Email</dt><dd>${esc(user.email)}</dd></div>
            <div><dt>Role</dt><dd>${esc(auth.roleLabel)}</dd></div>
          </dl>
          <p class="muted small">Roles are given by your team leads.</p>
          <div id="profile-errors"></div>
          <button type="submit" class="btn btn-primary">Save profile</button>
        </form>
      </section>
      <section class="card" id="org-card"></section>
      <section class="card" id="email">
        <h2>Email address</h2>
        ${schoolEmail && leaving ? `<div class="alert alert-warning"><strong>Switch to a personal email.</strong> UF turns off
          ${esc(user.email)} soon after you graduate. After that you couldn't sign in or reset your password, and
          messages from the team wouldn't reach you.</div>` : ''}
        <form id="email-form" novalidate>
          <div class="field"><label for="a-email">New email address</label>
            <input id="a-email" name="email" type="email" autocomplete="email" placeholder="you@example.com">
            <div class="hint">${schoolEmail && !leaving
              ? 'Graduating soon? Switch to a personal address before your UF one is turned off, so you keep your account as an alum.'
              : 'We send a link to the new address. Your email changes once you click it.'}</div></div>
          <div id="email-errors"></div>
          <button type="submit" class="btn${schoolEmail && leaving ? ' btn-primary' : ''}">Change email</button>
        </form>
      </section>
      <section class="card">
        <h2>Notifications</h2>
        <p class="muted small">${notify.enabled
          ? `Messages go to <strong>${esc(user.email)}</strong> (email and/or Teams). Untick anything you don't want; changes save right away.`
          : 'Email and Teams messages are turned off for the whole team right now. Your choices here apply once they are turned on.'}</p>
        <div id="notify-table"></div>
        <div id="notify-errors"></div>
        <p class="muted small" id="notify-saved" hidden>Saved.</p>
      </section>
      <section class="card">
        <h2>Change password</h2>
        ${passwordForm('Update password')}
      </section>
    </div>`;

  accountOrgSection(el, config);   // 056: your division & subsystems (fills in after loading)
  el.querySelector('#email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = e.target.email.value.trim().toLowerCase();
    const errors = el.querySelector('#email-errors');
    errors.innerHTML = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return (errors.innerHTML = errorBox(new Error('Enter a valid email address.')));
    if (email === (user.email || '').toLowerCase()) return (errors.innerHTML = errorBox(new Error('That\'s already your email address.')));
    const button = e.target.querySelector('button');
    button.disabled = true;
    try {
      const changed = await auth.changeEmail(email);
      setFlash(changed ? `Your email is now ${email}.`
        : `Almost done: we sent a link to ${email}. Click it to finish the change. (If you also get one at your old address, click that one too.)`);
      await rerender();
    } catch (err) {
      errors.innerHTML = errorBox(/already been registered|already registered/i.test(err.message)
        ? new Error('Another one.solar account already uses that email address.') : err);
      button.disabled = false;
    }
  });

  el.querySelector('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.full_name.value.trim();
    try {
      await api.updateMyProfile(name);
      await auth.refresh();
      setFlash('Profile saved.');
      await rerender();
    } catch (err) {
      el.querySelector('#profile-errors').innerHTML = errorBox(err);
    }
  });

  // ---- Notifications: an overall switch per channel, then one row per event ----
  const CHANNELS = [['email', 'Email', 'notify_email'], ['teams', 'Teams', 'notify_teams']];
  const choices = structuredClone(user.notify_events || {});
  const teamOn = (ev, ch) => notify.events?.[ev]?.[ch] === true;
  const mineOn = (ev, ch) => choices[ev]?.[ch] !== false;
  const events = myEvents(config);

  const drawNotify = () => {
    const box = (checked, attrs, disabled, title = '') =>
      `<input type="checkbox" ${attrs} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} ${title ? `title="${esc(title)}"` : ''}>`;
    el.querySelector('#notify-table').innerHTML = `
      <div class="table-wrap flat"><table class="table events-table">
        <thead><tr><th></th>${CHANNELS.map(([, label]) => `<th class="center">${label}</th>`).join('')}</tr></thead>
        <tbody>
          <tr class="notify-all"><td><strong>All messages</strong><div class="muted small">Turn a channel off completely</div></td>
            ${CHANNELS.map(([ch, label, col]) => `<td class="center">${box(user[col] !== false, `data-all="${ch}" aria-label="All ${label}"`, false)}</td>`).join('')}</tr>
          ${events
            .map(
              (ev) => `<tr><td>${esc(ev.mine)}</td>
                ${CHANNELS.map(([ch, label, col]) => {
                  const off = !teamOn(ev.key, ch);
                  return `<td class="center">${
                    off ? `<span class="muted small" title="Your leads turned ${label} off for this message">—</span>`
                      : box(mineOn(ev.key, ch), `data-ev="${ev.key}" data-ch="${ch}" aria-label="${esc(label)}: ${esc(ev.mine)}"`, user[col] === false)
                  }</td>`;
                }).join('')}</tr>`
            )
            .join('')}
        </tbody>
      </table></div>
      <p class="muted small">— means your leads don't send that message by that channel (Admin → Approvals &amp; alerts → Notifications).</p>`;
  };

  const saved = async (fn) => {
    try {
      await fn();
      el.querySelector('#notify-errors').innerHTML = '';
      el.querySelector('#notify-saved').hidden = false;
    } catch (err) {
      el.querySelector('#notify-errors').innerHTML = errorBox(err);
    }
  };
  el.querySelector('#notify-table').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.all) {
      const email = el.querySelector('[data-all="email"]').checked;
      const teams = el.querySelector('[data-all="teams"]').checked;
      await saved(async () => {
        await api.updateMyNotificationPrefs(email, teams);
        Object.assign(user, { notify_email: email, notify_teams: teams });
      });
      drawNotify();
    } else if (t.dataset.ev) {
      const { ev, ch } = t.dataset;
      choices[ev] = { ...(choices[ev] || {}), [ch]: t.checked };
      if (t.checked) delete choices[ev][ch]; // on is the default; only "off" is stored
      if (!Object.keys(choices[ev]).length) delete choices[ev];
      await saved(async () => {
        await api.updateMyNotificationEvents(choices);
        user.notify_events = structuredClone(choices);
      });
    }
  });
  drawNotify();

  bindPasswordForm(el, async () => {
    setFlash('Password updated.');
    await rerender();
  });

  el.querySelector('#sign-out').addEventListener('click', () => auth.signOut());
}

/** Landing page after clicking a password-reset email link. */
export async function renderResetPassword(el) {
  el.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card card">
        <h1>Choose a new password</h1>
        ${passwordForm('Save new password')}
      </div>
    </div>`;
  bindPasswordForm(el, () => {
    setFlash('Password updated. You are signed in.');
    location.hash = `#${homePath()}`;
  });
}
