/**
 * Jacob's private board. Needs the ADMIN_KEY set in Netlify (typed once, then remembered on this phone).
 * "Find me" marks the spot every compass points to. The list shows who is waiting for a confirmation,
 * who is looking and who has finished, and lets Jacob approve a finish once he has seen the guest.
 */
import { ApiError, getMaster, postApprove, postReset, postTarget } from "./api.ts";
import { C, cloud, pinColor } from "./art.ts";
import { GAME, POLL, type LatLng, type MasterRow, type MasterState } from "./config.ts";
import { averageReadings, bearingDeg, distanceM, formatDistance, formatDuration, type Reading } from "./geo.ts";
import { watchLocation, type Watcher } from "./location.ts";
import { loadMasterKey, storeMasterKey } from "./storage.ts";
import { $, boardsView, closeSheet, el, formatClock, openSheet, toast } from "./ui.ts";

const app = $("app");
let key = "";
let state: MasterState | null = null;
let offset = 0;
let pollTimer = 0;
let tab: "players" | "map" | "boards" = "players";
let knownPending = new Set<string>();
const boards = boardsView();

const serverNow = () => Date.now() + offset;

function sky(): HTMLElement {
  return el("div", { class: "sky", "aria-hidden": "true" }, el("span", { class: "sky__cloud sky__cloud--a", html: `<svg viewBox="-70 -50 140 85">${cloud()}</svg>` }));
}

/* ---------- Key ---------- */

function showKey(message: string, prefill = ""): void {
  window.clearTimeout(pollTimer);
  const input = el("input", { class: "field__input", id: "key", type: "password", autocomplete: "current-password", placeholder: "Host key" });
  input.value = prefill;
  const form = el(
    "form",
    { class: "start__form" },
    el("label", { class: "field__label", for: "key" }, "Host key"),
    input,
    el("p", { class: "field__error", role: "alert", id: "key-error" }, message),
    el("button", { class: "btn btn--primary btn--big", type: "submit" }, "Open the board"),
  );
  app.dataset.screen = "key";
  app.replaceChildren(sky(), el("section", { class: "card" }, el("h1", {}, "Master board"), el("p", {}, `Only ${GAME.host} gets in here. Enter the ADMIN_KEY you set in Netlify.`), form));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (input.value.trim()) void open(input.value.trim());
  });
}

async function open(candidate: string): Promise<void> {
  try {
    const s = await getMaster(candidate);
    key = candidate;
    storeMasterKey(key);
    // Keep the key out of the address bar, so a screenshot or shared link can't leak it.
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
    accept(s);
    buildBoard();
    schedule();
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "network";
    if (code === "unauthorized") {
      storeMasterKey(null);
      showKey("That key didn't match. Check the ADMIN_KEY you set in Netlify.");
    } else if (code === "admin_key_not_set") {
      showKey("ADMIN_KEY isn't set in Netlify yet. Add it under Site configuration → Environment variables, then redeploy.");
    } else {
      // Keep the key filled in, so a blip in the signal is one tap to get past.
      showKey("Couldn't reach the server. Check your connection and try again.", candidate);
    }
  }
}

function accept(s: MasterState): void {
  state = s;
  offset = s.serverNow - Date.now();
  const pending = new Set(s.rows.filter((r) => r.status === "pending").map((r) => r.id));
  for (const id of pending) {
    if (!knownPending.has(id)) {
      try {
        navigator.vibrate?.([120, 80, 120]);
      } catch {
        /* fine */
      }
      const row = s.rows.find((r) => r.id === id);
      if (row) toast(`${row.name} says they've found you`);
    }
  }
  knownPending = pending;
}

function schedule(): void {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => void refresh(), POLL.masterMs);
}

async function refresh(): Promise<void> {
  try {
    accept(await getMaster(key));
    $("net")?.toggleAttribute("hidden", true);
    draw();
  } catch (e) {
    if (e instanceof ApiError && e.code === "unauthorized") return showKey("That key no longer works. Enter the current one.");
    $("net")?.toggleAttribute("hidden", false);
  }
  schedule();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && key) void refresh();
});

/* ---------- Board ---------- */

function buildBoard(): void {
  app.dataset.screen = "board";
  const playersTab = el("button", { class: "tabs__tab", type: "button", role: "tab", id: "tab-players" }, "Players");
  const mapTab = el("button", { class: "tabs__tab", type: "button", role: "tab", id: "tab-map" }, "Map");
  const boardsTab = el("button", { class: "tabs__tab", type: "button", role: "tab", id: "tab-boards" }, "Results");
  app.replaceChildren(
    el(
      "section",
      { class: "mb" },
      el(
        "header",
        { class: "mb__head" },
        el("h1", {}, "Master board"),
        el("button", { class: "pill pill--icon", type: "button", id: "menu", "aria-label": "More" }, "⋯"),
      ),
      el("p", { class: "mb__net", id: "net", hidden: true, role: "status" }, "No signal. Showing the last update."),
      el("div", { id: "spot" }),
      el("div", { class: "mb__counts", id: "counts" }),
      el("div", { class: "tabs tabs--three", role: "tablist" }, playersTab, mapTab, boardsTab),
      el("div", { id: "players" }),
      el("div", { id: "radar", hidden: true }),
      el("div", { id: "boards", hidden: true }, boards.root),
    ),
  );
  playersTab.addEventListener("click", () => {
    tab = "players";
    draw();
  });
  mapTab.addEventListener("click", () => {
    tab = "map";
    draw();
  });
  boardsTab.addEventListener("click", () => {
    tab = "boards";
    draw();
  });
  $("menu").addEventListener("click", openMenu);
  draw();
  // Elapsed times tick every second without waiting for the next update.
  window.setInterval(() => {
    if (app.dataset.screen === "board" && tab === "players") drawPlayers();
  }, 1000);
}

function draw(): void {
  if (!state || app.dataset.screen !== "board") return;
  drawSpot();
  const n = (status: MasterRow["status"]) => state!.rows.filter((r) => r.status === status).length;
  $("counts").replaceChildren(
    el("span", { class: "count-chip count-chip--pending", id: "n-pending" }, el("b", {}, String(n("pending"))), " waiting"),
    el("span", { class: "count-chip", id: "n-looking" }, el("b", {}, String(n("looking"))), " looking"),
    el("span", { class: "count-chip count-chip--found", id: "n-found" }, el("b", {}, String(n("found"))), " found"),
  );
  $("counts").hidden = !state.target && state.rows.length === 0;
  drawRadar();
  $("tab-players").setAttribute("aria-selected", String(tab === "players"));
  $("tab-boards").setAttribute("aria-selected", String(tab === "boards"));
  $("tab-map").setAttribute("aria-selected", String(tab === "map"));
  $("radar").hidden = tab !== "map";
  $("players").hidden = tab !== "players";
  $("boards").hidden = tab !== "boards";
  boards.update(state.boards, null);
  drawPlayers();
}

function drawSpot(): void {
  const t = state!.target;
  const spot = $("spot");
  if (!t) {
    if (spot.dataset.mode === "empty") return;
    spot.dataset.mode = "empty";
    const button = el("button", { class: "btn btn--primary btn--big", type: "button", id: "find-me" }, "Find me");
    spot.replaceChildren(
      el("div", { class: "spot spot--empty" }, el("h2", {}, "Nobody can start yet"), el("p", {}, "Stand where you'll wait, then tap Find me. Every compass will point to that spot, and it stays put when you walk around."), button),
    );
    button.addEventListener("click", () => openFindMe(false));
    return;
  }
  spot.dataset.mode = "set";
  spot.replaceChildren(
    el(
      "div",
      { class: "spot", id: "spot-set" },
      el("span", { class: "spot__pin", "aria-hidden": "true" }, "📍"),
      el("div", {}, el("b", {}, "Your spot is marked"), el("small", {}, `${formatClock(t.publishedAt)} · accurate to about ±${Math.max(1, Math.round(t.accuracy))} m`)),
    ),
  );
}

/** Distance from the spot, squeezed so both 20 m and 800 m fit on one small radar. */
function radarRadius(d: number): number {
  return Math.min(94, 14 + (80 * Math.log(1 + d / 12)) / Math.log(1 + 800 / 12));
}

function drawRadar(): void {
  const t = state!.target;
  const looking = state!.rows.filter((r) => r.status !== "found" && r.pos);
  const box = $("radar");
  if (!t || !looking.length) {
    box.replaceChildren(el("p", { class: "board__empty" }, t ? "Nobody is out searching right now." : "Mark your spot first."));
    return;
  }
  const rings = [50, 200, 800]
    .map(
      (d) =>
        `<circle r="${radarRadius(d).toFixed(1)}" fill="none" stroke="${C.line}" stroke-width="1" stroke-dasharray="2 5" opacity=".4"/>` +
        `<text y="${(radarRadius(d) - 3).toFixed(1)}" text-anchor="middle" font-size="7.5" fill="${C.ink}" opacity=".65">${d} m</text>`,
    )
    .join("");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "-100 -100 200 200");
  svg.innerHTML =
    `<circle r="98" fill="#FFFDF5" stroke="${C.line}" stroke-width="2.5"/>` +
    rings +
    `<text y="-88" text-anchor="middle" font-size="9" font-weight="700" fill="${C.coral}">N</text>` +
    `<circle r="7" fill="${C.coral}" stroke="${C.line}" stroke-width="2"/>`;
  for (const r of looking) {
    const pos = r.pos as LatLng & { age: number };
    const d = distanceM(t, pos);
    const a = (bearingDeg(t, pos) * Math.PI) / 180;
    const rr = radarRadius(d);
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", `translate(${(Math.sin(a) * rr).toFixed(1)},${(-Math.cos(a) * rr).toFixed(1)})`);
    g.setAttribute("opacity", pos.age > 60_000 ? "0.4" : "1");
    g.setAttribute("class", "radar__dot");
    g.setAttribute("data-id", r.id);
    g.innerHTML = `<circle r="8.5" fill="${pinColor(r.id)}" stroke="${C.line}" stroke-width="1.8"/>`;
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("y", "3.2");
    label.setAttribute("font-size", "9");
    label.setAttribute("font-weight", "700");
    label.setAttribute("fill", C.ink);
    label.textContent = [...r.name][0]?.toUpperCase() ?? "?";
    g.append(label);
    svg.append(g);
  }
  const legend = el("ul", { class: "people" });
  for (const r of [...looking].sort((a, b) => distanceM(t, a.pos!) - distanceM(t, b.pos!))) {
    const dot = el("span", { class: "pin__dot pin__dot--list" }, [...r.name][0]?.toUpperCase() ?? "?");
    dot.style.setProperty("--pin", pinColor(r.id));
    legend.append(el("li", {}, dot, el("span", { class: "people__name" }, r.name), el("span", { class: "people__meta" }, `${formatDistance(distanceM(t, r.pos!))} away`)));
  }
  box.replaceChildren(
    el("div", { class: "radar", role: "img", "aria-label": `${looking.length} searching around your spot. North is up.` }, svg),
    el("p", { class: "fine radar__note" }, "Your spot is the red dot. North is up. Distances are squeezed so near and far both fit."),
    legend,
  );
}

interface RowView {
  status: MasterRow["status"];
  li: HTMLElement;
  small: HTMLElement;
  rank: HTMLElement | null;
}
const rowViews = new Map<string, RowView>();
let rowList: HTMLElement | null = null;

function rowText(r: MasterRow, now: number): string {
  if (r.status === "pending") return `Says they've found you · asked ${formatDuration(now - r.requestedAt!)} ago`;
  if (r.status === "looking") {
    const far = r.pos && state?.target ? ` · ${formatDistance(distanceM(state.target, r.pos))} from your spot` : "";
    return `Looking for ${formatDuration(now - r.startedAt)} · started ${formatClock(r.startedAt)}${far}`;
  }
  return `Found you at ${formatClock(r.finishedAt!, true)} · took ${formatDuration(r.durationMs!)} · ${r.method === "approved" ? "approved by you" : "by compass"}`;
}

function buildRow(r: MasterRow): RowView {
  const small = el("small", {});
  const main = el("div", { class: "row__main" }, el("b", { class: "row__name" }, r.name), small);
  if (r.status === "pending") {
    const b = el("button", { class: "btn btn--primary", type: "button", "data-approve": r.id }, "Approve finish");
    b.addEventListener("click", () => void approve(r, b));
    return { status: r.status, small, rank: null, li: el("li", { class: "row row--pending", "data-id": r.id, "data-status": "pending" }, main, b) };
  }
  if (r.status === "looking") {
    const b = el("button", { class: "btn btn--small", type: "button", "data-approve": r.id }, "Seen them");
    b.addEventListener("click", () => confirmApprove(r));
    return { status: r.status, small, rank: null, li: el("li", { class: "row", "data-id": r.id, "data-status": "looking" }, main, b) };
  }
  const rank = el("span", { class: "row__rank" });
  return { status: r.status, small, rank, li: el("li", { class: "row row--found", "data-id": r.id, "data-status": "found" }, rank, main) };
}

/**
 * Rows are kept and updated in place, and only rebuilt when a guest's status changes,
 * so a tap on Approve is never lost to a refresh happening under the finger.
 */
function drawPlayers(): void {
  if (!state) return;
  const now = serverNow();
  const box = $("players");
  if (!state.rows.length) {
    rowViews.clear();
    rowList = null;
    const empty = state.target ? "Nobody has started yet. Share the link!" : "Mark your spot first. Then guests can start.";
    if (box.dataset.empty !== empty) {
      box.dataset.empty = empty;
      box.replaceChildren(el("p", { class: "board__empty" }, empty));
    }
    return;
  }
  delete box.dataset.empty;
  if (!rowList || !rowList.isConnected) {
    rowList = el("ul", { class: "rows" });
    rowViews.clear();
    box.replaceChildren(rowList);
  }
  const seen = new Set<string>();
  let rank = 0;
  let prev: Element | null = null;
  for (const r of state.rows) {
    seen.add(r.id);
    let view = rowViews.get(r.id);
    if (!view || view.status !== r.status) {
      const fresh = buildRow(r);
      if (view) view.li.replaceWith(fresh.li);
      view = fresh;
      rowViews.set(r.id, view);
    }
    const text = rowText(r, now);
    if (view.small.textContent !== text) view.small.textContent = text;
    if (view.rank) view.rank.textContent = String(++rank);
    // Keep the server's order: waiting first, then looking, then finishers.
    const want: Element | null = prev ? prev.nextElementSibling : rowList.firstElementChild;
    if (want !== view.li) rowList.insertBefore(view.li, want);
    prev = view.li;
  }
  for (const [id, view] of rowViews) {
    if (!seen.has(id)) {
      view.li.remove();
      rowViews.delete(id);
    }
  }
}

async function approve(r: MasterRow, button: HTMLButtonElement | null): Promise<void> {
  if (button) button.disabled = true;
  try {
    const res = await postApprove(key, r.id);
    toast(res.already ? `${r.name} had already finished` : `${r.name}'s finish is approved`);
    closeSheet();
    await refresh();
  } catch {
    toast("That didn't go through. Try again.");
    if (button) button.disabled = false;
  }
}

function confirmApprove(r: MasterRow): void {
  const s = openSheet(`Seen ${r.name}?`);
  const yes = el("button", { class: "btn btn--primary btn--big", type: "button", id: "approve-yes" }, "Approve finish");
  const no = el("button", { class: "btn btn--big", type: "button" }, "Not yet");
  s.body.append(el("p", {}, `This ends ${r.name}'s hunt now and puts them on the leaderboards. It can't be undone.`), yes, no);
  yes.addEventListener("click", () => void approve(r, yes));
  no.addEventListener("click", () => s.close());
}

/* ---------- Find me ---------- */

function openFindMe(moving: boolean): void {
  const readings: Reading[] = [];
  let watcher: Watcher | null = null;
  let timer = 0;
  const s = openSheet(moving ? "Move your spot" : "Find me", () => {
    watcher?.stop();
    window.clearInterval(timer);
  });
  const status = el("p", { class: "find__status", id: "find-status" }, "Finding you…");
  const accuracy = el("div", { class: "find__accuracy", id: "find-accuracy" }, "±…");
  const mark = el("button", { class: "btn btn--primary btn--big", type: "button", id: "mark", disabled: true }, "Mark this spot");
  s.body.append(
    el("div", { class: "pulse pulse--small", "aria-hidden": "true" }, el("span", { class: "pulse__pin" }, "📍")),
    accuracy,
    status,
    moving ? el("p", { class: "fine" }, "Everyone's compass will swing round to the new spot.") : el("p", { class: "fine" }, "Stand still for a few seconds. The reading sharpens as your phone settles."),
    mark,
  );
  const started = Date.now();
  const update = () => {
    const avg = averageReadings(readings);
    if (!avg) return;
    accuracy.textContent = `±${Math.max(1, Math.round(avg.accuracy))} m`;
    const settled = Date.now() - started > 6000 || (readings.length >= 3 && avg.accuracy <= 8);
    mark.disabled = false;
    status.textContent =
      avg.accuracy > 25 ? "That's a rough reading. Step out from under the trees if you can." : settled ? "Got you. Mark the spot when you're ready." : "Sharpening… hold still.";
    status.dataset.tone = avg.accuracy > 25 ? "warn" : "";
  };
  watcher = watchLocation(
    (r) => {
      readings.push(r);
      if (readings.length > 40) readings.shift();
      update();
    },
    (p) => {
      if (p === "denied") status.textContent = "Location is switched off for this site. Allow it in your browser's site settings, then try again.";
      else if (!readings.length) status.textContent = "Still looking for you. Open sky helps.";
    },
  );
  timer = window.setInterval(() => {
    update();
    watcher?.poke();
  }, 2000);
  mark.addEventListener("click", () => {
    const avg = averageReadings(readings);
    if (!avg) return;
    mark.disabled = true;
    void (async () => {
      try {
        await postTarget(key, avg);
        toast(moving ? "Spot moved. Compasses are turning." : "Spot marked. Compasses are live!");
        s.close();
        await refresh();
      } catch {
        mark.disabled = false;
        status.textContent = "Couldn't save the spot. Check your signal and try again.";
        status.dataset.tone = "warn";
      }
    })();
  });
}

/* ---------- Menu ---------- */

function openMenu(): void {
  const s = openSheet("More");
  const link = `${window.location.origin}/`;
  const move = el("button", { class: "btn btn--big", type: "button", id: "menu-move" }, state?.target ? "Move my spot" : "Find me");
  const share = el("button", { class: "btn btn--big", type: "button", id: "menu-share" }, "Copy the guest link");
  const fresh = el("button", { class: "btn btn--big", type: "button", id: "menu-reset" }, "Start a fresh round…");
  const forget = el("button", { class: "btn btn--link", type: "button" }, "Forget the key on this phone");
  s.body.append(el("div", { class: "menu" }, move, share, fresh, forget));
  move.addEventListener("click", () => openFindMe(!!state?.target));
  share.addEventListener("click", () => {
    void navigator.clipboard?.writeText(link).then(
      () => toast("Guest link copied"),
      () => toast(link, 8000),
    );
  });
  forget.addEventListener("click", () => {
    storeMasterKey(null);
    key = "";
    s.close();
    showKey("");
  });
  fresh.addEventListener("click", () => {
    const c = openSheet("Start a fresh round?");
    const keep = el("button", { class: "btn btn--primary btn--big", type: "button", id: "reset-keep" }, "Clear players, keep my spot");
    const all = el("button", { class: "btn btn--big", type: "button", id: "reset-all" }, "Clear players and my spot");
    c.body.append(el("p", {}, "Everyone's attempts and both leaderboards are wiped. Use this after a practice run. Guests go back to the start screen."), el("div", { class: "menu" }, keep, all));
    const go = (keepTarget: boolean) => async () => {
      try {
        await postReset(key, keepTarget);
        toast("Fresh round started");
        c.close();
        await refresh();
      } catch {
        toast("That didn't go through. Try again.");
      }
    };
    keep.addEventListener("click", () => void go(true)());
    all.addEventListener("click", () => void go(false)());
  });
}

/* ---------- Go ---------- */

const fromUrl = new URLSearchParams(window.location.search).get("key");
const saved = fromUrl ?? loadMasterKey();
if (saved) void open(saved);
else showKey("");
