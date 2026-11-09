# I–V Analyzer

**https://solar-gators.github.io/one.solar/iv-analyzer/** · [`iv-analyzer/index.html`](../iv-analyzer/index.html)

Turns I–V tracer sweeps of the array's modules into a retest list. For each module it estimates power at standard
conditions (IEC 60891 Procedure 1), compares it with the other modules built from the same cells, and checks it
against the expected Maxeon Ne3 values. Every module ends up **OK**, **Review** or **Retest**, with the reasons.
It's a screening tool, not a certification. The **Guide & settings** tab explains every step.

## Using it
1. **Modules tab.** Enter the module ID, Ns × Np, irradiance and temperature. Then pick one or more tracer CSV / TSV
   files, or paste the voltage and current columns. Choose several files at once to review each before importing.
   Use the same module ID again to add a repeat sweep of the same module.
2. **Screening tab.** This has the retest list, the power-per-cell against fill-factor plot, and the statistics for each group.
3. **Load example data** fills in 11 made-up modules to try it out.

## Where the data lives
- **This browser only.** No account and nothing uploaded. Modules and settings are saved in this browser
  (localStorage `sg-iv-analyzer-v3`), so another computer starts empty.
- **Keeping results.** Use **Export results CSV**, **Export all points CSV** or **Export screening CSV**.
- **Sharing criteria.** Everyone screens the same way if one person uses **Export settings** (a small `.json`) and
  the others use **Import settings**.
- **Data from the old file.** Modules saved by the standalone `solar_gators_iv_analyzer_v3.html` file you opened from
  your computer don't carry over. Re-import the tracer files here.

## Updating it
`iv-analyzer/index.html` is the whole app: plain HTML, CSS and JavaScript, with no build step. The top bar is the shared
OneSolar one (`../shared/onesolar.css`, `account-menu.js` and `app-switcher.js`), and Light / Dark is the shared
setting (`../shared/theme.js`). The analyzer's own colours are the tokens at the top of its `<style>`.
To bring in a new standalone version, keep the `<head>` links, the top bar and the small module script from this
file, and replace the rest.
