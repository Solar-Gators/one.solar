/**
 * one.solar: the top bar's page links stay on one line. On a laptop-sized screen, links that don't fit move into
 * "More ▾" at the end of the row instead of wrapping onto a second line (phones and tablets, up to 960px, keep
 * the folding "Menu" from shared/onesolar.css).
 *
 *   import { fitTopbarNav } from '../shared/nav-more.js';
 *   fitTopbarNav();   // app-switcher.js calls it, so every app with the shared top bar gets it
 *
 * It watches the row: links the app adds or removes later (after signing in, a new count badge) and window
 * resizes re-fit it. "More ▾" opens a small list of the hidden links; the current page's link lights it up.
 * A link marked data-fold="always" (less-used pages, e.g. Projects' Boards) is always under "More ▾" on a laptop;
 * phones list it with the rest.
 */

const WIDE = '(min-width: 961px)';

export function fitTopbarNav(nav = document.querySelector('.topbar .nav')) {
  if (!nav || nav.dataset.fit) return;
  nav.dataset.fit = '1';
  const more = document.createElement('div');
  more.className = 'nav-more';
  more.hidden = true;
  more.innerHTML = `<button type="button" class="nav-more-btn" aria-haspopup="true" aria-expanded="false">More <span aria-hidden="true">▾</span></button>
    <div class="nav-more-pop" role="menu" hidden></div>`;
  const btn = more.querySelector('button');
  const pop = more.querySelector('.nav-more-pop');
  let busy = false;
  let watcher = null;

  const links = () => [...nav.children].filter((el) => el.tagName === 'A' && !el.classList.contains('os-nav-apps') && !el.hidden);
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };

  function fit() {
    if (busy) return;
    busy = true;
    try {
      close();
      for (const a of nav.querySelectorAll(':scope > a.nav-folded')) a.classList.remove('nav-folded');
      if (more.parentNode !== nav) nav.append(more);
      more.hidden = true;
      if (!matchMedia(WIDE).matches) return;
      const all = links();
      const folded = all.filter((a) => a.dataset.fold === 'always');
      folded.forEach((a) => a.classList.add('nav-folded'));
      const rest = all.filter((a) => !folded.includes(a));
      if (folded.length || nav.scrollWidth > nav.clientWidth + 1) {
        more.hidden = false;   // it takes room too, so make space for it first
        while (nav.scrollWidth > nav.clientWidth + 1 && rest.length > 1) {
          const a = rest.pop();
          a.classList.add('nav-folded');
          folded.push(a);
        }
      }
      folded.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));   // in the row's order
      more.hidden = !folded.length;
      btn.classList.toggle('active', folded.some((a) => a.classList.contains('active')));
      pop.innerHTML = '';
      for (const a of folded) {
        const copy = a.cloneNode(true);
        copy.classList.remove('nav-folded');
        copy.removeAttribute('id');
        copy.setAttribute('role', 'menuitem');
        copy.addEventListener('click', (e) => { close(); if (a.onclick || a.dataset.navAct) { e.preventDefault(); a.click(); } });
        pop.append(copy);
      }
    } finally {
      watcher?.takeRecords();   // its own changes (moving links in and out) don't count as the app changing the row
      busy = false;
    }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      const r = btn.getBoundingClientRect();   // fixed, so the row's overflow:hidden doesn't clip it
      pop.style.top = `${r.bottom + 6}px`;
      pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 228))}px`;
    }
  });
  document.addEventListener('click', (e) => { if (!more.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); } });
  addEventListener('scroll', close, { passive: true });

  let queued = false;
  const soon = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; fit(); }); } };
  new ResizeObserver(soon).observe(nav.closest('.topbar-inner') || nav);
  watcher = new MutationObserver((list) => { if (list.some((m) => m.target !== pop && !pop.contains(m.target))) soon(); });
  watcher.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  matchMedia(WIDE).addEventListener?.('change', soon);
  fit();
}
