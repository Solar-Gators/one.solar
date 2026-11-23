/**
 * Sign in / create account / forgot password. Shown for every route while
 * signed out.
 */
import { auth } from '../auth.js';
import { esc, errorBox, renderRichText } from '../ui.js';
import { emailLink, emailLinkProblem } from '../emailLink.js';
import { appUrl } from '../../../shared/onesolar.js';

let mode = 'signin'; // 'signin' | 'signup' | 'forgot' | 'check'
let notice = '';
/** "Check your email": where the confirmation link went and when it was last sent (kept through a reload). */
const CHECK_KEY = 'sg-check-email';
let check = (() => {
  try { return JSON.parse(sessionStorage.getItem(CHECK_KEY)) || null; } catch { return null; }
})();
if (check?.email) mode = 'check';
const saveCheck = () => {
  try { check ? sessionStorage.setItem(CHECK_KEY, JSON.stringify(check)) : sessionStorage.removeItem(CHECK_KEY); } catch { /* private mode */ }
};
let lastEmail = '';
let unconfirmed = '';   // the address a sign-in was refused for because it isn't confirmed yet
const WAIT = 60;        // Supabase sends one confirmation email a minute per address
let ticker = null;
/** Sent here by the one.solar home screen (main.js keeps ?next until signed in). */
const returning = () => {
  try { return !!sessionStorage.getItem('sg-next'); } catch { return false; }
};

/** Friendlier wording for common Supabase auth errors. */
function explain(err) {
  const msg = err?.message || '';
  if (/invalid login credentials/i.test(msg)) return new Error('Incorrect email or password.');
  if (/user is banned/i.test(msg)) return new Error('Your one.solar access has ended. If you graduated, ask someone on the team to mark you as an alum; if this is a mistake, ask an Admin to reactivate you.');
  if (/email not confirmed/i.test(msg)) return new Error('Please confirm your email first: click the link we emailed you. Not there? Check Junk, or send it again below.');
  if (/database error saving new user/i.test(msg)) return new Error('That email address is not allowed to sign up.');
  if (/rate limit/i.test(msg)) return new Error('Too many emails sent recently. Please wait a few minutes and try again.');
  return err;
}

export async function renderLogin(el, { config }) {
  if (emailLink.tokenHash && !emailLink.used) return renderEmailLink(el, { config });
  clearInterval(ticker);
  if (mode === 'check' && check?.email) return renderCheckEmail(el, { config });
  const domains = config.allowedEmailDomains || [];
  const domainHint = domains.length ? `Use your ${domains.map((d) => '@' + d).join(' or ')} email.` : '';

  const titles = { signin: 'Sign in', signup: 'Create an account', forgot: 'Reset your password' };
  const fields = {
    signin: `
      <div class="field"><label for="l-email">Email</label>
        <input id="l-email" name="email" type="email" autocomplete="email" value="${esc(lastEmail)}" required></div>
      <div class="field"><label for="l-pass">Password</label>
        <input id="l-pass" name="password" type="password" autocomplete="current-password" required></div>`,
    signup: `
      <div class="field"><label for="l-name">Full name</label>
        <input id="l-name" name="fullName" type="text" autocomplete="name" required></div>
      <div class="field"><label for="l-email">Email</label>
        <input id="l-email" name="email" type="email" autocomplete="email" required>
        ${domainHint ? `<div class="hint">${esc(domainHint)}</div>` : ''}</div>
      <div class="field"><label for="l-pass">Password</label>
        <input id="l-pass" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <div class="hint">At least 8 characters.</div></div>`,
    forgot: `
      <div class="field"><label for="l-email">Email</label>
        <input id="l-email" name="email" type="email" autocomplete="email" required></div>`,
  };
  const submitLabel = { signin: 'Sign in', signup: 'Create account', forgot: 'Send reset link' };

  const links = {
    signin: `<button type="button" class="link-btn" data-mode="forgot">Forgot password?</button>
             <span>First time using one.solar? <button type="button" class="link-btn" data-mode="signup">Create an account</button></span>`,
    signup: `<span>Already have an account? <button type="button" class="link-btn" data-mode="signin">Sign in</button></span>
             ${config.alumniCanSignUp !== false ? `<span>A Solar Gators alum without a UF email? <a href="${esc(appUrl('sgaa/#/join'))}">Join as an alum</a></span>` : ''}`,
    forgot: `<button type="button" class="link-btn" data-mode="signin">← Back to sign in</button>`,
  };

  // Problems with the email link this page was opened from (expired, already used, opened in another browser).
  const urlError = emailLinkProblem(auth.signedIn);

  el.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card card">
        <div class="auth-brand">one.solar · ${esc(config.teamName)}</div>
        <h1>${titles[mode]}</h1>
        ${mode === 'signin' ? `<p class="muted small auth-sub">One account for every Solar Gators app${returning() ? '. You\'ll go back to the one.solar home screen after signing in' : ''}.</p>` : ''}
        ${urlError ? `<div class="alert alert-error">${esc(urlError)}</div>` : ''}
        ${auth.removed && mode === 'signin' ? '<div class="alert alert-warning">Your one.solar account was removed, so you were signed out. If that\'s a mistake, ask a Chief Engineer or an Admin.</div>' : ''}
        ${notice ? `<div class="alert alert-success">${esc(notice)}</div>` : ''}
        <div id="auth-errors"></div>
        <div id="auth-resend"></div>
        <form id="auth-form" novalidate>
          ${fields[mode]}
          <button type="submit" class="btn btn-primary btn-block">${submitLabel[mode]}</button>
        </form>
        <div class="auth-links">${links[mode]}</div>
      </div>
      ${config.appearance?.signInMessage ? `<div class="auth-message">${renderRichText(config.appearance.signInMessage)}</div>` : ''}
      <p class="muted small auth-foot">${esc(config.teamName)} · ${esc(config.season)} season</p>
    </div>`;

  const switchMode = (next) => {
    mode = next;
    notice = '';
    renderLogin(el, { config });
  };
  el.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));

  const form = el.querySelector('#auth-form');
  const errors = el.querySelector('#auth-errors');
  const resendBox = el.querySelector('#auth-resend');
  const offerResend = () => {
    resendBox.innerHTML = unconfirmed
      ? '<button type="button" class="btn btn-block auth-resend" id="l-resend">Send the confirmation email again</button>' : '';
    resendBox.querySelector('#l-resend')?.addEventListener('click', () => {
      check = { email: unconfirmed, sentAt: 0 };
      saveCheck();
      mode = 'check';
      renderLogin(el, { config }).then(() => el.querySelector('#c-resend')?.click());
    });
  };
  (lastEmail ? form.querySelector('#l-pass') : form.querySelector('input'))?.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const email = (data.email || '').trim().toLowerCase();
    errors.innerHTML = '';

    // Friendly checks first; the database enforces the same rules.
    const problems = [];
    if (!email.includes('@')) problems.push('Enter a valid email address.');
    if (mode === 'signup') {
      if (!data.fullName?.trim()) problems.push('Enter your full name.');
      const domain = email.split('@')[1] || '';
      if (domains.length && !domains.some((d) => domain === d || domain.endsWith('.' + d))) problems.push(domainHint);
      if ((data.password || '').length < 8) problems.push('Password must be at least 8 characters.');
    }
    if (mode === 'signin' && !data.password) problems.push('Enter your password.');
    if (problems.length) {
      errors.innerHTML = errorBox(Object.assign(new Error('Please fix the following:'), { details: problems }));
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    unconfirmed = '';
    offerResend();
    try {
      if (mode === 'signin') {
        await auth.signIn(email, data.password);
        // The auth listener in main.js re-renders once the session is ready.
      } else if (mode === 'signup') {
        const needsConfirm = await auth.signUp({ email, password: data.password, fullName: data.fullName.trim() });
        if (needsConfirm) {
          check = { email, sentAt: Date.now() };
          saveCheck();
          mode = 'check';
          notice = '';
          renderLogin(el, { config });
        }
      } else {
        await auth.sendPasswordReset(email);
        mode = 'signin';
        notice = `If ${email} has an account, a password reset link is on its way.`;
        renderLogin(el, { config });
      }
    } catch (err) {
      errors.innerHTML = errorBox(explain(err));
      button.disabled = false;
      if (mode === 'signin' && /email not confirmed/i.test(err?.message || '')) {
        unconfirmed = email;
        offerResend();
      }
    }
  });
}

/** After creating an account: where the link went, what to do if it doesn't show up, and a button to send it again. */
function renderCheckEmail(el, { config }) {
  const email = check.email;
  el.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card card">
        <div class="auth-brand">one.solar · ${esc(config.teamName)}</div>
        <h1>Check your email</h1>
        <p class="auth-sub">We sent a confirmation link to <b>${esc(email)}</b>. Click it to finish setting up your account, then sign in.</p>
        <div id="auth-errors"></div>
        <div id="c-sent"></div>
        <ul class="auth-tips small">
          <li><b>It can take a few minutes</b> to arrive.</li>
          <li><b>Not in your inbox?</b> Check <b>Junk</b> or Spam, and Outlook's <b>Other</b> tab. Search your mail for “confirm”.</li>
          <li>If it's in Junk, mark it <b>Not junk</b> so the next one lands in your inbox.</li>
          <li>Only the newest link works. The button on the page it opens finishes it.</li>
        </ul>
        <button type="button" class="btn btn-block" id="c-resend">Send it again</button>
        <div class="auth-links">
          <button type="button" class="link-btn" data-go="signin">Confirmed? Sign in</button>
          <span>Wrong address? <button type="button" class="link-btn" data-go="signup">Start over</button></span>
        </div>
      </div>
      <p class="muted small auth-foot">${esc(config.teamName)} · ${esc(config.season)} season</p>
    </div>`;

  const btn = el.querySelector('#c-resend');
  const errors = el.querySelector('#auth-errors');
  const sent = el.querySelector('#c-sent');
  const tick = () => {
    const left = Math.ceil(WAIT - (Date.now() - (check?.sentAt || 0)) / 1000);
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Send it again (in ${left}s)` : 'Send it again';
    if (left <= 0) clearInterval(ticker);
  };
  const start = () => {
    clearInterval(ticker);
    tick();
    ticker = setInterval(() => (el.contains(btn) ? tick() : clearInterval(ticker)), 1000);
  };
  start();

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    errors.innerHTML = '';
    try {
      await auth.resendConfirmation(email);
      check.sentAt = Date.now();
      saveCheck();
      sent.innerHTML = `<div class="alert alert-success">Sent again at ${esc(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}. Use the link in the newest email.</div>`;
    } catch (err) {
      const wait = /after (\d+) seconds?/i.exec(err?.message || '');
      if (wait) {
        check.sentAt = Date.now() - (WAIT - +wait[1]) * 1000;
        saveCheck();
        errors.innerHTML = errorBox(new Error(`You can send it again in ${wait[1]} seconds.`));
      } else errors.innerHTML = errorBox(explain(err));
    }
    start();
  });

  el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.go;
    lastEmail = mode === 'signin' ? email : '';
    check = null;
    saveCheck();
    notice = '';
    renderLogin(el, { config });
  }));
}

/** A password-reset or confirm-your-email link: one button uses it (see emailLink.js for why it isn't automatic). */
function renderEmailLink(el, { config }) {
  const reset = emailLink.type === 'recovery';
  el.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card card">
        <div class="auth-brand">one.solar · ${esc(config.teamName)}</div>
        <h1>${reset ? 'Reset your password' : 'Confirm your email'}</h1>
        <p class="muted small auth-sub">${reset ? 'Press the button to choose a new password.' : 'Press the button to finish setting up your account.'}</p>
        <div id="auth-errors"></div>
        <button type="button" class="btn btn-primary btn-block" id="link-go">${reset ? 'Choose a new password' : 'Confirm my email'}</button>
        <p class="muted small" style="margin-top:12px">This extra step stops email scanners from using up your link before you do.</p>
      </div>
    </div>`;
  el.querySelector('#link-go').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    emailLink.used = true;
    try {
      await auth.verifyEmailLink(emailLink.tokenHash, emailLink.type);
      // Signed in: main.js re-renders (a reset link opens "Choose a new password").
    } catch (err) {
      emailLink.error = err?.message || 'That email link did not work.';
      renderLogin(el, { config });
    }
  });
}
