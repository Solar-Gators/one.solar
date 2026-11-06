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
`gatorwire/index.html` is a built, single-file app. Upload a new build over that file (GitHub → `gatorwire/` → **Add file → Upload files**, named `index.html`). It keeps its own dark look; the top bar of the other OneSolar apps isn't added to it, so a new build doesn't lose anything.
