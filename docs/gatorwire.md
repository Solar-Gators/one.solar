# GatorWire

**https://solar-gators.github.io/one.solar/gatorwire/** · [`gatorwire/index.html`](../gatorwire/index.html)

Turns a draw.io wiring diagram into a full wiring spec: every connector, conductor, and splice defined in one place.

## Work on Car 5 with the team
The Car 5 project lives in **[Solar-Gators/Gator-Wire](https://github.com/Solar-Gators/Gator-Wire)**, and everyone edits it at the same time.

1. **Make a token, once.** Follow the steps in the [Gator-Wire README](https://github.com/Solar-Gators/Gator-Wire#getting-started). It takes about five minutes.
2. **Connect.** Open GatorWire, click **In this browser · Share** at the top right, paste your token, and click **Connect**.
3. **Work.** Your edits save on their own, and teammates' changes show up within about half a minute. If two people change the same thing, the app asks which version to keep.

Without a token you can still connect and look at Car 5, but you can't save.

## Workflow
1. **Upload drawing:** bring in a `.drawio` wiring diagram. GatorWire finds every shape and asks which are components and which are just zones.
2. **Click anything on the diagram:** a wire, component, or connector opens the connection editor. Name pins and cavities, and lay conductors two clicks at a time.
3. **Add connectors and splices** anywhere along a run, then place them on the drawing when prompted. **Edit drawing** opens Draw.io in the page whenever the diagram itself needs changing.
4. **Export finalised:** one read-only `.html` of the finished diagram. It opens in any browser, still shows what every wire joins, and can't be edited.

## Working on your own
Skip the **Share** button and GatorWire works entirely offline, with no account and nothing uploaded. **Save file** writes one `.json` holding the data, the drawing, and its picture, and **Open file** picks it back up on any computer. This is useful for trying things out without touching the team's project.

## Updating GatorWire
`gatorwire/index.html` is a built, single-file app. To put in a new build:

1. Replace `gatorwire/index.html` with the new build.
2. Run `npm run gatorwire` (from the repo folder), then commit both `gatorwire/index.html` and `gatorwire/onesolar-light.css`.

`npm run gatorwire` ([`tools/gatorwire-onesolar.mjs`](../tools/gatorwire-onesolar.mjs)) makes the build fit one.solar, and it's safe to run more than once:
- **Picking the shared file:** the Share dialog lists every `.json` file in the repository (with its size) to pick from, plus **A new file…** to start a separate project, instead of a box where you had to type the exact file name. **↻ Refresh** looks again. Private repositories are listed once you paste your token. (Code: [`tools/gatorwire/file-picker.js`](../tools/gatorwire/file-picker.js).)
- **The Share button** (top right) is a real button with plainer words: **Share with the team** (orange, not shared yet), **View only · add a token to edit** (shared, no token), **Shared · up to date**, and so on. Click it to share, add your token or check for changes.
- **The one.solar look:** the one.solar top bar (logo back to the home screen, and the shared Light / Dark switch) above GatorWire's toolbar, from [`gatorwire/onesolar-skin.css`](../gatorwire/onesolar-skin.css) and [`onesolar-skin.js`](../gatorwire/onesolar-skin.js). GatorWire's dark colours are already one.solar's; `gatorwire/onesolar-light.css` is generated with the light version of every colour the build writes into its styles.

The build is minified, so the tool finds the parts it changes by what the code looks like. If a future build is very different, it stops and says what it couldn't find. The longer-term fix is to move the file picker into GatorWire's own source.
