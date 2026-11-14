/**
 * QR codes for inventory labels, made in the browser (no outside service). They hold a one.solar address with the
 * item's or location's id (core.js inventoryLink), so a label keeps working after a rename; any phone camera opens it.
 */
import qrcode from '../../../shared/vendor/qrcode-generator.mjs';

/** The QR code's module grid for `text` (true = dark), error correction M (survives a scuff on the label). */
export function qrMatrix(text, level = 'M') {
  const qr = qrcode(0, level);
  qr.addData(String(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** An <svg> of the code, scaling to its box. Always black on white (what scanners and printers expect). */
export function qrSvg(text, { margin = 4, title = '' } = {}) {
  const m = qrMatrix(text);
  const n = m.length + margin * 2;
  let d = '';
  m.forEach((row, r) => row.forEach((dark, c) => dark && (d += `M${c + margin},${r + margin}h1v1h-1z`)));
  const t = title ? `<title>${title.replace(/[<&"]/g, (x) => ({ '<': '&lt;', '&': '&amp;', '"': '&quot;' })[x])}</title>` : '';
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img">${t}<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
