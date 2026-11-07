/**
 * GatorWire in OneSolar: the OneSolar top bar above GatorWire (hooked into the build by
 * tools/gatorwire-onesolar.mjs; looks in onesolar-skin.css). The logo goes to the OneSolar home
 * screen, and the switch at the right is the shared Light / Dark setting. GatorWire has no
 * OneSolar accounts, so there's no account menu (like the CE Scope Map).
 */
import { setTheme } from '../shared/onesolar.js';
import { syncLogo } from '../shared/account-menu.js';

const bar = document.createElement('header');
bar.className = 'os-bar';
bar.innerHTML = `
  <a class="os-brand" href="../" aria-label="OneSolar: all Solar Gators apps">
    <img class="os-logo brand-logo" data-auto-logo src="../shared/assets/solar-gators-logo.png" alt="Solar Gators" width="800" height="237">
    <span class="os-divider" aria-hidden="true"></span>
    <span>One<span class="os-accent">Solar</span></span>
    <span class="os-app">GatorWire</span>
  </a>
  <div class="os-end"><button type="button" class="os-theme"></button></div>`;
document.body.prepend(bar);
syncLogo();

const flip = bar.querySelector('.os-theme');
const draw = () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  flip.textContent = dark ? '☀️' : '🌙';
  flip.title = flip.ariaLabel = `Switch to ${dark ? 'light' : 'dark'}`;
};
flip.onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
draw();
