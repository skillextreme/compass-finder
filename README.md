# Compass: find Jacob in the park

Part two of the birthday invite. Guests open one link in Cubbon Park. A paper plane points at the spot Jacob marked, a meadow of dandelions blooms across the screen as they get closer, tiny arrows show friends who are also searching, and they win as soon as they come within 50 metres. Jacob has a private board to mark his spot, see who's looking, and confirm a finish in person.

It is built for phones only. On a computer the page asks to be opened on a phone.

| Page | Who | Address |
|---|---|---|
| The game | Guests | `/` |
| Master board | Jacob | `/master` (no password; nothing links to it, so only someone who knows the address finds it) |

## Deploy on Netlify

1. In Netlify, choose **Add new site → Import an existing project**, pick this GitHub repo and the `main` branch. Build settings are read from [`netlify.toml`](netlify.toml).
2. Deploy. There are no environment variables to set.

Results are stored in Netlify Blobs, which is built in. There is no database to set up.

## On the day

1. Open `/master` on your phone.
2. Stand where you'll wait and tap **Find me**. Hold still for a few seconds, then **Mark this spot**. Every compass points there from now on. The spot does not move when you walk around.
3. Share the plain site link. Guests enter a name and tap **Start the hunt**.
4. The **Players** tab lists people waiting for you to confirm (top, yellow), people looking, and finishers. **Map** shows where searchers are around your spot. **Results** has both leaderboards.
5. If someone is standing with you and their compass hasn't finished, they tap **I'm with Jacob!** and you tap **Approve finish**. You can also tap **Seen them** on anyone who is looking.

In the **⋯** menu: **Move my spot** (runs Find me again; everyone's compass swings round), **Start a fresh round** (wipes attempts and leaderboards after a practice run) and **Copy the guest link**.

## The rules

All of these live in [`src/config.ts`](src/config.ts). Change a number and push.

- **Automatic finish:** a reading within 50 m of the spot, accurate to 35 m or better, less than 10 seconds old, confirmed by a second such reading at least 2 seconds later. One stray reading under trees can't end a hunt. The guest sees "You won!" and is told Jacob is within about 50 metres.
- **Host-approved finish:** counts on both leaderboards. Its time is the moment the guest asked, so nobody is penalised while Jacob is busy. If Jacob approves without a request, it is the moment he tapped.
- **One result per attempt.** The compass, a request, an approval, a double tap and a retry can all race; whichever is recorded first is the result and the rest get that same answer back.
- **First to arrive** ranks by finish time. **Fastest** ranks by time from the end of the guest's own countdown, and shows how far away they started. Guests can start anywhere. Ties share a rank.
- **One attempt per phone per round.** Reloading or reopening the link resumes it; the timer keeps running.
- **Flowers:** the whole screen is a meadow seen from above. Every dandelion is a bud at 600 m or more (about the park edge) and they open one by one until all are in bloom at 50 m.
- **Unsure compass:** if the phone's compass swings about, or points one way while the guest walks another, the screen says "Slow down a moment. I'm double-checking your direction." until it settles.
- **Friends:** while someone is looking, their phone shares its position (rounded to about 10 m) every few seconds. Other searchers see it as a small arrow. It stops when they find Jacob, and they drop off after a minute of silence.
- **No signal:** the compass, distance and flowers run on the phone. A start or finish made with no signal is sent when the signal returns and keeps its real time.

The master board has no password. It is kept private only by not being linked from anywhere: anyone who learned or guessed the `/master` address could move the spot, approve finishes or clear the round. That is accepted for a game among friends; don't share that address or a screenshot showing it.

A guest's phone needs the marked spot to work out the direction, so someone who opens the browser's developer tools could read the coordinates. That is accepted for this game.

## Test walk in the park

Do this before guests arrive, then use **Start a fresh round** to clear it.

- Mark your spot under the trees where you'll actually wait. Note the accuracy it reports. If it says ±20 m or worse, step into the open, mark, and wait near that point.
- Walk in from the metro entrance and from one other gate, on an iPhone (Safari) and an Android phone (Chrome).
- Stand about 70 m, 55 m and 40 m from the spot for 30 seconds each. Does it finish early outside the circle? How long does it take inside?
- Turn on the spot: does the plane keep pointing the same real-world way?
- Lock and unlock the phone mid-walk. Switch on airplane mode for 30 seconds and switch it off.
- Refuse the location prompt once and follow the on-screen steps to recover.
- Try **I'm with Jacob!** and approve it from the board.

Add `?debug=1` to the guest link to see raw readings on the compass screen (position, accuracy, age, heading, distance, finish check). Tap that panel to save the log as a file. If finishes are too eager or too slow, adjust `FINISH` in `src/config.ts`.

## Develop

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

`npm run dev` serves the game with a local stand-in for the API (same rules, stored in memory), so no Netlify login is needed. On a computer, add `?anyway=1` to skip the "open on your phone" card, and use the browser's sensor tools to set a location.

`npm test` builds the site and runs:

- unit tests for the geometry, the finish rule (including simulated GPS noise), the server rules and the storage wrapper under concurrent writes;
- full walkthroughs in a phone-sized browser with a simulated GPS and compass sensor: two approaches on foot, friends' arrows, Ask Jacob, approvals racing the compass, no signal at the start and the finish, reloads, refused permissions, and the master board;
- layout checks at four phone sizes (no scrolling on the compass screen, nothing overlapping, tap targets at least 44 px). These save screenshots to `shots/`.

## Layout of the code

| Path | What it is |
|---|---|
| `src/config.ts` | Rules, tuning and shared types |
| `src/geo.ts` | Distance, bearing, bloom scale, the finish rule |
| `src/heading.ts` | Compass sensor, with walking direction as a fallback |
| `src/location.ts` | Position readings and what to tell a guest when they fail |
| `src/main.ts` | The guest's screens: waiting, start, countdown, compass, found |
| `src/compassView.ts`, `src/meadow.ts` | The dial with the plane and arrows; the dandelions |
| `src/master.ts` | Jacob's board |
| `src/art.ts` | SVG artwork. Jacob, trees and clouds come from the invite site; the dandelions are new |
| `netlify/lib/core.ts` | Every server rule, independent of Netlify, unit tested |
| `netlify/lib/store.ts` | Netlify Blobs wrapper (write-once and compare-and-swap) |
| `netlify/functions/api.mts` | The one function behind `/api/*` |
| `tests/` | Playwright tests |
