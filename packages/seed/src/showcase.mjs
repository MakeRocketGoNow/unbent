/**
 * The ten presentable notes `pnpm seed:demo` has always made, and the whole of
 * `--small`. The store listing's screenshots are of these, so they stay the newest notes
 * in the account: the loader dates them after everything else it makes, and the list,
 * newest first, opens on them.
 */

/**
 * The showcase: ten notes written for screenshots.
 *
 * Written to look like somebody's actual notes without being anybody's: no names, no
 * addresses, no real accounts. Between them they cover what the app is for (a table, a
 * fenced block, checkboxes, headings, tags and notebooks) so one screenshot of the list
 * and one of an open note show most of the feature surface.
 *
 * Keep the first line of every body a plain sentence. The note list renders a preview from
 * it verbatim, so a body that opens on `**bold**` or a `##` heading puts raw markdown in
 * the shot and reads as a rendering bug.
 */
export const SHOWCASE = [
  {
    title: 'Sourdough: the loaf that finally worked',
    notebook: 'Recipes',
    tags: ['baking', 'weekend'],
    body: `Third attempt, and the crumb is finally open.

## What changed

- Starter fed **twice** the day before, not once
- Hydration down to 72%: easier to shape, same crumb
- Cold retard overnight in the fridge

## Timings

| Step | Time |
| --- | --- |
| Autolyse | 45 min |
| Bulk | 4 h |
| Retard | 12 h |
| Bake | 20 min lid on, 22 off |

> Steam matters more than temperature. The lid *is* the steam.

Next: try 10% rye and see if the flavour carries.`,
  },
  {
    title: 'Balcony garden plan',
    notebook: 'Home',
    tags: ['garden', 'spring'],
    body: `South-facing, so mostly sun after 11am.

- [x] Measure the rail planters
- [x] Order potting mix
- [ ] Start basil and mint indoors
- [ ] Move tomatoes out after the last frost
- [ ] Set up the drip timer

Herbs in the two long boxes, tomatoes in the fabric pots at the sunny end.

Watering: every other day once it warms up, daily in the tomato pots. The mint stays in
its own pot or it takes everything.`,
  },
  {
    title: 'Trail notes: the ridge loop',
    notebook: 'Travel',
    tags: ['hiking', 'day-trip'],
    body: `About 11 km, four hours with stops. Marked blue the whole way.

## Getting there

Bus to the trailhead runs hourly until 6pm. Last one back is the one that matters:
missing it means a long road walk.

## Along the way

The first climb is the steep part; it eases after the saddle. Water at the halfway hut,
nothing after that, so fill up there.

Best view is *not* the summit: it's the bench about twenty minutes past it, looking back
over the valley.

## Bring

- 2 L water
- Layers, it's windy on the ridge
- Something for lunch at the hut`,
  },
  {
    title: 'Bookshelf build: measurements',
    notebook: 'Projects',
    tags: ['woodworking', 'build'],
    body: `The alcove is not square: the left side is 8 mm narrower at the top.

\`\`\`
Alcove width  (bottom)  912 mm
Alcove width  (top)     904 mm
Height                 2180 mm
Depth                   300 mm
\`\`\`

Cut the shelves to 895 mm and scribe the ends. Uprights get a rebate for the back panel.

- [x] Template the wall profile with cardboard
- [ ] Cut uprights
- [ ] Dry fit before glue
- [ ] Two coats of oil

Shelf spacing: 320 mm for the bottom three, 260 mm above.`,
  },
  {
    title: 'Reading list',
    notebook: 'Reading',
    tags: ['books'],
    body: `Books on the go, and the ones after them.

## Reading now

- A history of the sea trade routes: slow, but the maps are worth it

## Next

1. The one about typefaces someone recommended
2. Short stories collection, for the commute
3. The gardening book with the terrible cover

## Finished

- [x] Essays on walking: *the chapter on paths as arguments was the good one*
- [x] A novel about a lighthouse keeper

> Note to self: stop buying faster than reading.`,
  },
  {
    title: 'Coffee: dialling in the new bag',
    notebook: 'Recipes',
    tags: ['coffee'],
    body: `Medium roast, washed. Tastes thin at the shop's suggested setting.

| Grind | Dose | Yield | Time | Verdict |
| --- | --- | --- | --- | --- |
| 18 | 18 g | 36 g | 22 s | sour, too fast |
| 15 | 18 g | 36 g | 27 s | better |
| 13 | 18 g | 38 g | 31 s | **this one** |

Settled on 13. Anything finer and it chokes.`,
  },
  {
    title: 'Weeknight meals that actually happen',
    notebook: 'Recipes',
    tags: ['cooking', 'weeknight'],
    body: `Rules: under 30 minutes, one pan where possible, ingredients that keep.

- **Lentils and greens**: onion, garlic, tin of lentils, whatever green is wilting
- **Fried rice**: needs day-old rice, so cook extra on Sunday
- **Sheet pan sausages**: sausages, potatoes, red onion, 220°C for 35
- **Noodle soup**: stock, ginger, noodles, an egg

Keep in the cupboard: tinned tomatoes, lentils, coconut milk, noodles, stock paste.`,
  },
  {
    title: 'Bike tune-up checklist',
    notebook: 'Home',
    tags: ['bike', 'maintenance'],
    body: `Every few months, or when something starts making a noise.

- [x] Tyre pressure
- [x] Chain clean and lube
- [ ] Brake pads: check the wear line
- [ ] Cable tension
- [ ] Bolts: stem, seatpost, rack

The creak turned out to be the seatpost, not the bottom bracket. Grease and re-torque
fixed it.`,
  },
  {
    title: 'Ideas parking lot',
    notebook: 'Projects',
    tags: ['ideas'],
    body: `Things worth doing eventually, kept here so they stop rattling around.

- A proper index for the recipe notes: tag by main ingredient
- Scan the old paper maps before they fall apart
- Fix the squeaky door properly instead of oiling it every winter
- Work out whether the tomato variety from two summers ago is still sold anywhere

*Nothing here is urgent. That is the point of the list.*`,
  },
  {
    title: 'Packing list: long weekend',
    notebook: 'Travel',
    tags: ['packing', 'travel'],
    body: `Carry-on only. If it doesn't fit, it doesn't come.

- [x] Passport / tickets
- [x] Charger and cable
- [ ] Rain shell
- [ ] Two shirts, one warm layer
- [ ] Book
- [ ] Refillable bottle

Learned the hard way: pack the charger *first*, it's the one thing that ruins the trip.`,
  },
];
