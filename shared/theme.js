/*
 * OneSolar: light or dark before the page draws (no white flash). Load it in <head> as a plain script:
 *   <script src="../shared/theme.js"></script>
 * localStorage "theme" is "light", "dark", or missing (follow the device). Every app shares it.
 */
(function () {
  var t = null;
  try { t = localStorage.getItem('theme'); } catch (e) {}
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
