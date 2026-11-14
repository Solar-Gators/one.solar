# Releasing and reverting one.solar

**This covers the website only:** HTML, CSS and JavaScript. Database updates are separate; see [MAINTAINING.md → Database updates](MAINTAINING.md#database-updates).

**Live site:** https://one.ufsolargators.org/ (Orders at `/orders/`). Old `solar-gators.github.io/one.solar/…`
links redirect there. Publishing has gone through the tested deploy below since 2026-11-14.

## How a change reaches the live site

```
push to main (or merge a pull request) ──► Deploy site: tests ──► build ──► deploy ──► live in ~5 minutes
                                                  │
                                       red = nothing is published; the site stays on the last good version
```

Pushing straight to `main` is allowed while there's no ruleset (step 6 below is optional). Pull requests
still get the **CI** check, which is handy when more than one person is changing the code.

**The two workflows** (`.github/workflows/`):
- **`ci.yml` ("CI")** runs on every pull request and every push to a branch other than `main`.
  - `npm ci` installs exactly what `package-lock.json` lists.
  - `npm test`:
    - every script parses;
    - only the site gets published, and none of its links are broken;
    - CDN libraries name exact versions;
    - the workflows keep these rules;
    - unit tests;
    - the database security and workflow tests.
  - `npm run test:smoke` (`tests/e2e/`): every app opens in Chromium on the fake backend with no JavaScript errors (Content-Security-Policy violations count as errors), signed out and as an Admin; the app switcher and tabs work; and the everyday workflows: submit → approve → order → Finances, a Finances purchase, a sponsor card, Recently deleted, an eval draft, and what a Guest or a new member sees.
- **`deploy.yml` ("Deploy site")** runs on every push to `main`. It runs the same tests first; **if they fail, nothing is built or published.**
  - **Build:** `tools/build-site.mjs` copies only the site: `index.html`, `hub/`, `orders/`, `finances/`, `sponsors/`, `admin/`, `evals/`, `gatorwire/`, `scope-map/` and `shared/`. It adds `version.json` (the commit) so you can tell what's live.
  - **Not published:** `docs/`, `supabase/`, `tools/`, `tests/`, `README.md` and the package files. They stay readable on GitHub.
  - **Deploy:** publishes to GitHub Pages, only once the switch below is done.

**After a deploy, open pages notice:** `shared/version-check.js` compares the page's commit with `version.json` (on load and when a tab regains focus), and shows "one.solar was updated. Reload." If the database is behind the page (a migration not run yet) the banner says so instead.

## One-time setup (a repo admin, in GitHub): done 2026-11-14

Kept for reference, or for setting up a copy of the site.

1. **Merge this change.** Wait for the first green **CI** run on the pull request.
2. **Add the switch:** Settings → Secrets and variables → Actions → **Variables** tab → New repository variable.
   - Name: `PAGES_FROM_ACTIONS`
   - Value: `true`
3. **Change the source:** Settings → Pages → Build and deployment → **Source: GitHub Actions**.
4. **Publish once:** Actions → **Deploy site** → **Run workflow** (branch `main`, leave the box unticked). When it's green, check `https://one.ufsolargators.org/version.json`: the `sha` should be the latest commit on `main`.
5. **Prove the gate (do this once):**
   - Actions → **Deploy site** → **Run workflow** → tick **"Fail the tests on purpose"**.
   - Expected: **test** fails, **build** and **deploy** show as *skipped*, and `version.json` doesn't change.
6. **Protect `main` (optional; not turned on as of 2026-11-14):** Settings → Rules → Rulesets → New branch ruleset.
   - Target: the default branch.
   - Turn on **Require a pull request before merging** with 0 required approvals (one developer can merge their own).
   - Turn on **Require status checks to pass** and add the check **Tests** (it appears after the first CI run).
   - Turn on **Block force pushes** and **Restrict deletions**.
   - Leave yourself in the bypass list only if you accept using it for emergencies.
7. **Check the environment:** Settings → Environments → `github-pages`. Its deployment branches should allow only `main`. GitHub sets this when you choose "GitHub Actions"; confirm it.

With a ruleset, direct pushes to `main` are refused: push a branch, open a pull request, and merge it when **Tests** is green.

**Custom domain** (`one.ufsolargators.org`): a `CNAME` record at Cloudflare pointing to `solar-gators.github.io`, set to **DNS only** (grey cloud; the proxy stops GitHub issuing the certificate). Settings → Pages → Custom domain, with **Enforce HTTPS** ticked. If the domain changes, also update Supabase → Authentication → URL Configuration and Admin → one.solar → Notifications → Website address.

## Releasing a change
1. Run `npm test`.
2. Run `npm run test:smoke`. (Run `npx playwright install chromium` once on a new computer.)
3. Push to `main`, or push a branch and merge its pull request when **CI** is green.
4. **Deploy site** runs: tests, build, deploy (about 5 minutes).
5. **Check it's live:**
   - Actions → Deploy site → the run is green, and the **deploy** job shows the page URL. A red **test** job means nothing was published: open it, expand the failed step, and fix the test or the code.
   - `https://one.ufsolargators.org/version.json` shows the commit.
   - Admin → one.solar → **Diagnostics**: no new errors from the new version in the next hour or so.
   - GitHub Pages lets browsers keep files for up to 10 minutes. Use **Ctrl+Shift+R** (**Cmd+Shift+R** on a Mac) to see the change at once.
6. **Smoke checklist** (about 5 minutes, on a computer and on a phone):
   1. Signed out: the home screen and the sign-in page load.
   2. Sign in. The home screen shows your apps. Orders Home and Requests open, and one request opens.
   3. As a lead: Queue, Finances, Sponsors and Admin → Users open.
   4. Solar Evals opens and lists evals.
   5. GatorWire and the CE Scope Map open.
   6. The ⊞ app switcher jumps between apps.
   7. Sign out from one app signs you out of the others.
7. If the change needs a database update, run it **before** pushing (see MAINTAINING.md). The site must never need something the database doesn't have yet.

## Reverting a front-end change

**Normal (about 5 minutes):**

```bash
git revert <commit>
```

Then push it to `main` (or through a pull request). The revert goes through the same tests and deploy.

**Emergency, when the tests themselves are broken or GitHub is slow:**
- Actions → **Deploy site** → open the last green run from before the bad change → **Re-run all jobs**. That re-tests and re-publishes that older commit. Then revert the bad commit properly as above, so the next deploy doesn't bring it back.
- Afterwards, ask people to reload (**Ctrl+Shift+R**). Pages caching can keep the bad files for up to 10 minutes.

## Going back to the old publishing setup
1. Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
2. Settings → Secrets and variables → Actions → Variables: delete `PAGES_FROM_ACTIONS`, or set it to `false`, so the deploy job stays skipped.

The site then publishes the whole repository on every push to `main`, exactly as before. The CI workflow can stay; it only reports. To also allow direct pushes again, turn off the ruleset (Settings → Rules → Rulesets).

## Content-Security-Policy (what pages may load)
Every app page carries a `<meta http-equiv="Content-Security-Policy">` written by `tools/csp.mjs` (S-6). It allows scripts only from this site and cdn.jsdelivr.net, and connections only to this site and our Supabase project, so an injected script can't send data elsewhere. Images may come from any https site (logos and attachment previews can be links).
- **Adding something from a new site** (a font, a script, an API): change `cspFor()` in `tools/csp.mjs`, run `node tools/csp.mjs`, and commit the updated pages. `npm test` fails if a page's policy is missing or out of date; `npm run test:smoke` fails if a page hits something the policy blocks.
- **A new app** made with `tools/new-app.mjs` gets the policy automatically; add its page to `PAGES` in `tools/csp.mjs`.
- **New Supabase project:** the policy is built from `shared/config.js`; run `node tools/csp.mjs` after changing the URL there.
- GatorWire is a built bundle and doesn't carry it.

## Upgrading a library loaded from a CDN
- `orders/js/supabase.js` (2.119.0), `hub/home.js` and `evals/index.html` (2.45.4) and `orders/js/excel.js` pin exact versions. `npm test` refuses `@2`-style ranges.
- To upgrade, change one file's version in its own pull request. Run `npm run test:smoke`, which includes a check that the pinned supabase-js works with our client options. Then do the smoke checklist on a deploy preview or right after merging.
- Prefer versions at least two weeks old.
