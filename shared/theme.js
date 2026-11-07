/*
 * OneSolar: light or dark before the page draws (no white flash). Load it in <head> as a plain script:
 *   <script src="../shared/theme.js"></script>
 * localStorage "theme" is "light", "dark", or missing (follow the device). Every app shares it.
 * It also applies the team's accent color (localStorage "onesolar:brand"), so it's right from the first paint.
 */
(function () {
  var t = null;
  try { t = localStorage.getItem('theme'); } catch (e) {}
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  // The team's accent color, if an admin set one (Admin → Logo & accent; see getBrand in onesolar.js).
  try {
    var a = (JSON.parse(localStorage.getItem('onesolar:brand')) || {}).accent;
    if (/^#[0-9a-f]{6}$/i.test(a || '')) {
      var s = document.documentElement.style, d = '#';
      for (var i = 1; i < 7; i += 2) d += ('0' + Math.round(parseInt(a.slice(i, i + 2), 16) * 0.85).toString(16)).slice(-2);
      s.setProperty('--orange', a); s.setProperty('--orange-dark', d); s.setProperty('--focus', a + '55'); s.setProperty('--uf-orange', a);
    }
  } catch (e) {}
})();
