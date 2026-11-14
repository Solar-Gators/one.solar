/**
 * Scan a label. Any phone camera app already opens a label's address; this page is for scanning from inside
 * one.solar (the browser's built-in BarcodeDetector where it exists, e.g. Chrome on Android), or typing what's
 * on the label: a SKU, a location code, or the address itself.
 */
import { esc } from '../../ui.js';
import { parseInventoryLink } from '../../inventory/core.js';
import { loadBase, header, needsDatabase, itemHref, locHref } from './kit.js';

/** A scanned or typed text → the page to open, or null. */
export function resolveCode(text, b) {
  const t = String(text || '').trim();
  if (!t) return null;
  const link = parseInventoryLink(t);
  if (link) return link.kind === 'location' ? locHref(link.id) : itemHref(link.id);
  const up = t.toUpperCase();
  const item = b.items.find((i) => String(i.sku).toUpperCase() === up);
  if (item) return itemHref(item.id);
  const loc = b.locations.find((l) => l.code === up.replace(/\s+/g, '-'));
  if (loc) return locHref(loc.id);
  return null;
}

let stopCamera = () => {};

export async function renderInvScan(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  stopCamera();
  const b = await loadBase();
  const hasDetector = 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia;
  el.innerHTML = `${header('Scan a label', 'Point the camera at a QR label, or type the code printed under it.')}
    <section class="card inv-scan">
      ${hasDetector ? `<div class="inv-scan-view"><video data-video playsinline muted aria-label="Camera"></video><div class="inv-scan-frame" aria-hidden="true"></div></div>
        <div class="form-actions"><button type="button" class="btn btn-primary" data-start>Start the camera</button></div>`
        : '<p class="muted">This browser can\'t read QR codes itself. Use the phone\'s camera app on the label (it opens the page), or type the code below.</p>'}
      <form data-type class="inv-find"><input name="code" placeholder="SKU, location code or label address" aria-label="Code" autocomplete="off" autocapitalize="characters"><button class="btn" type="submit">Open</button></form>
      <div data-msg aria-live="polite"></div>
    </section>`;

  const msg = (t) => (el.querySelector('[data-msg]').innerHTML = t ? `<p class="alert alert-warning">${t}</p>` : '');
  const go = (text) => {
    const href = resolveCode(text, b);
    if (!href) return msg(`Nothing in Inventory matches "${esc(String(text).slice(0, 80))}".`), false;
    stopCamera();
    location.hash = href;
    return true;
  };
  el.querySelector('[data-type]').addEventListener('submit', (e) => {
    e.preventDefault();
    go(e.target.code.value);
  });

  el.querySelector('[data-start]')?.addEventListener('click', async (e) => {
    const video = el.querySelector('[data-video]');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      return msg('The camera didn\'t start (no permission, or none here). Type the code instead.');
    }
    e.target.hidden = true;
    video.srcObject = stream;
    await video.play();
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    let on = true;
    stopCamera = () => {
      on = false;
      stream.getTracks().forEach((t) => t.stop());
      stopCamera = () => {};
    };
    window.addEventListener('hashchange', () => stopCamera(), { once: true });
    const tick = async () => {
      if (!on || !video.isConnected) return stopCamera();
      try {
        const codes = await detector.detect(video);
        for (const c of codes) if (go(c.rawValue)) return;
      } catch {
        /* a frame that couldn't be read */
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}
