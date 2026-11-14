/**
 * The guest's game. One screen at a time:
 * waiting (Jacob hasn't hidden yet) → start (name) → locating → countdown → looking → found.
 * The compass, distance and flowers are worked out on the phone, so they keep going through
 * patchy signal. Starts and finishes are queued and sent when the network is back.
 */
import { ApiError, getBoard, getState, postFinish, postPing, postRequest, postStart } from "./api.ts";
import { cloud, compassPlane, finishIcon, flowerIcon, jacobPortrait, pinColor as pinColorFor, planeIcon, tree } from "./art.ts";
import { CompassView, type Pin } from "./compassView.ts";
import { COUNTDOWN_S, FINISH, GAME, LIMITS, POLL, type AttemptStatus, type Boards, type Searcher, type Target } from "./config.ts";
import { FinishGate, bearingDeg, bloomSteps, distanceM, formatDistance, formatDuration, ordinal, warmth, type GateVerdict, type Reading } from "./geo.ts";
import { Heading } from "./heading.ts";
import { problemAdvice, watchLocation, type LocationProblem, type Watcher } from "./location.ts";
import { Meadow, seedShower } from "./meadow.ts";
import { clearAttempt, loadAttempt, loadName, newIdentity, storeAttempt, storeName, type LocalAttempt } from "./storage.ts";
import { $, boardsView, closeSheet, el, openSheet, toast } from "./ui.ts";

const app = $("app");
const params = new URLSearchParams(window.location.search);
const DEBUG = params.has("debug");
const GAME_CACHE = "cf.game.v1";

let round = 0;
let target: Target | null = null;
let attempt: LocalAttempt | null = null;
let reading: Reading | null = null;
let searchers: Searcher[] = [];
let searchersAt = 0;
/** People who have already found Jacob, as far as this phone has heard. */
let finishers: { k: string; name: string }[] = [];
let heardFinishers = false;
let status: AttemptStatus = "looking";
let watcher: Watcher | null = null;
let problem: LocationProblem | null = null;
let myKey: string | null = null;
let lastVerdict: GateVerdict | null = null;
const heading = new Heading();
const gate = new FinishGate();
const timers = new Set<number>();
/** Runs when the current screen is replaced, to stop its timers and animation. */
let leave: (() => void) | null = null;

/* ---------- Small helpers ---------- */

function show(screen: string, ...children: (Node | null)[]): void {
  leave?.();
  leave = null;
  for (const t of timers) window.clearTimeout(t);
  timers.clear();
  closeSheet();
  app.dataset.screen = screen;
  app.replaceChildren(...children.filter((c): c is Node => !!c));
  window.scrollTo(0, 0);
}

/** A timeout that is dropped automatically when the screen changes. */
function later(fn: () => void, ms: number): number {
  const id = window.setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
  return id;
}

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported: fine */
  }
}

function cacheGame(): void {
  try {
    localStorage.setItem(GAME_CACHE, JSON.stringify({ round, target }));
  } catch {
    /* fine */
  }
}

function cachedGame(): { round: number; target: Target | null } | null {
  try {
    const v = JSON.parse(localStorage.getItem(GAME_CACHE) ?? "null") as { round: number; target: Target | null } | null;
    return v && typeof v.round === "number" ? v : null;
  } catch {
    return null;
  }
}

async function computeKey(id: string): Promise<string | null> {
  try {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`searcher:${id.toLowerCase()}`));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
  } catch {
    return null;
  }
}

let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake(): Promise<void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
    if (!wakeLock && nav.wakeLock && document.visibilityState === "visible") {
      wakeLock = await nav.wakeLock.request("screen");
    }
  } catch {
    /* the phone may refuse on low battery: the game still works */
  }
}
function allowSleep(): void {
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function sky(): HTMLElement {
  return el(
    "div",
    { class: "sky", "aria-hidden": "true" },
    el("span", { class: "sky__cloud sky__cloud--a", html: `<svg viewBox="-70 -50 140 85">${cloud()}</svg>` }),
    el("span", { class: "sky__cloud sky__cloud--b", html: `<svg viewBox="-70 -50 140 85">${cloud()}</svg>` }),
  );
}

function hero(): HTMLElement {
  return el(
    "div",
    { class: "hero", "aria-hidden": "true" },
    el("span", { class: "hero__tree hero__tree--l", html: `<svg viewBox="-85 -195 170 200">${tree(0)}</svg>` }),
    el("span", { class: "hero__tree hero__tree--r", html: `<svg viewBox="-85 -195 170 200">${tree(1)}</svg>` }),
    el("span", { class: "hero__jacob", html: jacobPortrait() }),
    el("span", { class: "hero__plane", html: compassPlane() }),
  );
}

/* ---------- Boot ---------- */

function isPhone(): boolean {
  return window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 760 || params.has("anyway");
}

function showDesktop(): void {
  const link = window.location.origin + window.location.pathname;
  show(
    "desktop",
    sky(),
    el(
      "section",
      { class: "card card--center" },
      hero(),
      el("h1", {}, "This one's for your phone"),
      el("p", {}, `The compass needs to be out in ${GAME.park} with you. Open this link on your phone:`),
      el("p", { class: "card__link" }, link),
      el("a", { class: "btn btn--link", href: "?anyway=1" }, "Continue here anyway"),
    ),
  );
}

async function boot(): Promise<void> {
  show("loading", sky(), el("div", { class: "loading" }, el("span", { class: "loading__plane", html: compassPlane() }), el("p", {}, "Unfolding the paper plane…")));
  attempt = loadAttempt();
  if (attempt) myKey = await computeKey(attempt.id);
  try {
    const s = await getState();
    round = s.round;
    target = s.target;
    cacheGame();
  } catch {
    const cached = cachedGame();
    if (attempt && cached && cached.round === attempt.round && cached.target) {
      // Reloaded with no signal mid-hunt: carry on with what the phone already knows.
      round = cached.round;
      target = cached.target;
    } else {
      showOffline();
      return;
    }
  }
  decide();
}

function decide(): void {
  if (attempt && attempt.round !== round) {
    clearAttempt();
    attempt = null;
  }
  if (attempt && (attempt.result || attempt.pendingFinish)) return showFound();
  if (attempt) return showResume();
  if (!target) return showWaiting();
  showStart();
}

function showOffline(): void {
  show(
    "offline",
    sky(),
    el(
      "section",
      { class: "card card--center" },
      hero(),
      el("h1", {}, "No signal just now"),
      el("p", {}, "The compass couldn't reach the park. It will try again by itself."),
      el("button", { class: "btn btn--primary", type: "button", id: "retry" }, "Try again"),
    ),
  );
  $("retry").addEventListener("click", () => void boot());
  later(() => void boot(), 4000);
}

/** While nobody is hunting on this phone, keep an eye on whether Jacob has marked or moved his spot. */
function watchState(onChange: () => void): void {
  const tick = async () => {
    try {
      const s = await getState();
      const changed = s.round !== round || !!s.target !== !!target || s.target?.publishedAt !== target?.publishedAt;
      round = s.round;
      target = s.target;
      cacheGame();
      if (changed) return onChange();
    } catch {
      /* try again next time */
    }
    later(() => void tick(), POLL.waitingMs);
  };
  later(() => void tick(), POLL.waitingMs);
}

/* ---------- Waiting for Jacob ---------- */

function showWaiting(): void {
  show(
    "waiting",
    sky(),
    el(
      "section",
      { class: "card card--center" },
      hero(),
      el("h1", {}, `${GAME.host} is still finding a spot`),
      el("p", {}, "The moment he's hidden, this page turns into a compass. Keep it open."),
      el("p", { class: "dots", "aria-hidden": "true" }, el("span"), el("span"), el("span")),
    ),
  );
  watchState(() => {
    if (target) {
      vibrate(60);
      toast(`${GAME.host} is hidden. Go!`);
    }
    decide();
  });
}

/* ---------- Start: name and one tap ---------- */

function howItWorks(): HTMLElement {
  return el(
    "ul",
    { class: "how" },
    el("li", {}, el("span", { class: "how__icon", html: planeIcon() }), el("span", {}, el("b", {}, "The paper plane points at Jacob. "), "It points straight there, through trees and fences. Use the park's paths and find your own way round.")),
    el("li", {}, el("span", { class: "how__icon", html: flowerIcon() }), el("span", {}, el("b", {}, "Dandelions open as you get closer. "), "They show how far you are right now. If a path takes you the long way, they may close a little first.")),
    el("li", {}, el("span", { class: "how__icon", html: finishIcon() }), el("span", {}, el("b", {}, `Get within ${FINISH.radiusM} metres and you've found him. `), "Your time stops by itself. If it doesn't, ask Jacob to confirm.")),
  );
}

function showStart(): void {
  const input = el("input", {
    class: "field__input",
    id: "name",
    type: "text",
    name: "name",
    autocomplete: "given-name",
    autocapitalize: "words",
    enterkeyhint: "go",
    maxlength: String(LIMITS.nameMax),
    placeholder: "Your first name",
    "aria-describedby": "name-error",
  });
  input.value = loadName();
  const error = el("p", { class: "field__error", id: "name-error", role: "alert" });
  const button = el("button", { class: "btn btn--primary btn--big", type: "submit", id: "start" }, "Start the hunt");
  const form = el(
    "form",
    { class: "start__form", novalidate: true },
    el("label", { class: "field__label", for: "name" }, "Who's hunting?"),
    input,
    error,
    button,
  );
  const fine = el("p", { class: "fine" }, `Friends who are also searching will see roughly where you are until you find ${GAME.host}. Nothing else is kept.`);
  show(
    "start",
    sky(),
    el(
      "section",
      { class: "card start" },
      hero(),
      el("h1", {}, `Find ${GAME.host}`),
      el("p", { class: "start__lede" }, `He's hiding somewhere in ${GAME.park}. Follow the paper plane.`),
      form,
      el("h2", { class: "start__how" }, "How it works"),
      howItWorks(),
      fine,
    ),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.replace(/\s+/g, " ").trim();
    if (!name) {
      error.textContent = "Add your name so Jacob knows who's coming.";
      input.focus();
      return;
    }
    storeName(name);
    input.blur();
    // Motion access must be asked for inside this tap (iPhones), so it goes first.
    void heading.enable().then(() => showLocating(name));
  });
  watchState(decide);
}

/* ---------- Locating ---------- */

function startWatching(): void {
  watcher?.stop();
  problem = null;
  watcher = watchLocation(
    (r) => {
      problem = null;
      reading = r;
      heading.feedPosition(r);
      onReading?.(r);
    },
    (p) => {
      problem = p;
      onProblem?.(p);
    },
  );
}
let onReading: ((r: Reading) => void) | null = null;
let onProblem: ((p: LocationProblem) => void) | null = null;

function showLocating(name: string): void {
  const note = el("p", {}, "Tap Allow if your phone asks for location.");
  show(
    "locating",
    sky(),
    el("section", { class: "card card--center" }, el("div", { class: "pulse", "aria-hidden": "true" }, el("span", { class: "pulse__plane", html: compassPlane() })), el("h1", {}, "Finding you…"), note),
  );
  later(() => (note.textContent = "Still looking. Stepping out from under the trees helps."), 9000);
  onReading = () => {
    onReading = null;
    onProblem = null;
    showCountdown(name);
  };
  onProblem = (p) => {
    // A slow first fix isn't a failure yet; a refusal is.
    if (p === "denied" || p === "unsupported") showProblem(p, () => showLocating(name));
  };
  later(() => {
    if (!reading) showProblem(problem ?? "timeout", () => showLocating(name));
  }, 30_000);
  if (reading && Date.now() - reading.at < 15_000 && watcher) later(() => onReading?.(reading!), 400);
  else startWatching();
}

function showProblem(p: LocationProblem, retry: () => void): void {
  const advice = problemAdvice(p);
  watcher?.stop();
  watcher = null;
  onReading = null;
  onProblem = null;
  const steps = el("ol", { class: "steps" });
  for (const s of advice.steps) steps.append(el("li", {}, s));
  const button = el("button", { class: "btn btn--primary", type: "button" }, "Try again");
  show("problem", sky(), el("section", { class: "card", role: "alert" }, el("h1", {}, advice.title), steps, button, el("p", { class: "fine" }, `Stuck? Message ${GAME.host} on WhatsApp.`)));
  button.addEventListener("click", retry);
}

/* ---------- Countdown ---------- */

function showCountdown(name: string): void {
  const number = el("div", { class: "count__number", "aria-live": "assertive" }, String(COUNTDOWN_S));
  show("countdown", sky(), el("section", { class: "count" }, el("p", { class: "count__label" }, `Ready, ${name}?`), number));
  let n = COUNTDOWN_S;
  const tick = () => {
    n -= 1;
    if (n > 0) {
      number.textContent = String(n);
      number.classList.remove("is-pop");
      void number.offsetWidth;
      number.classList.add("is-pop");
      vibrate(30);
      later(tick, 1000);
    } else {
      vibrate([60, 40, 120]);
      beginAttempt(name);
    }
  };
  number.classList.add("is-pop");
  later(tick, 1000);
}

function beginAttempt(name: string): void {
  attempt = {
    round,
    ...newIdentity(),
    name,
    startedLocal: Date.now(),
    startAt: reading ? { lat: reading.lat, lng: reading.lng } : null,
    synced: false,
    requested: false,
    pendingFinish: null,
    result: null,
  };
  storeAttempt(attempt);
  status = "looking";
  void computeKey(attempt.id).then((key) => (myKey = key));
  showLooking();
  void sync();
}

/* ---------- Coming back mid-hunt ---------- */

function showResume(): void {
  const a = attempt!;
  status = a.requested ? "pending" : "looking";
  const button = el("button", { class: "btn btn--primary btn--big", type: "button" }, "Back to the compass");
  show(
    "resume",
    sky(),
    el("section", { class: "card card--center" }, hero(), el("h1", {}, `Welcome back, ${a.name}`), el("p", {}, `Your timer never stopped. ${GAME.host} is still out there.`), button),
  );
  button.addEventListener("click", () => {
    void heading.enable().then(() => {
      startWatching();
      showLooking();
      void sync();
    });
  });
}

/* ---------- Talking to the server ---------- */

let syncing = false;
let syncTimer = 0;

function resetToFreshRound(): void {
  clearAttempt();
  attempt = null;
  searchers = [];
  finishers = [];
  heardFinishers = false;
  toast(`${GAME.host} started a fresh round`);
  void boot();
}

/** Sends whatever the server doesn't have yet: the start, then a finish. Retries until it lands. */
async function sync(): Promise<void> {
  if (syncing || !attempt) return;
  syncing = true;
  window.clearTimeout(syncTimer);
  let retryMs = 0;
  try {
    const a = attempt;
    if (!a.synced) {
      const r = await postStart(a, { name: a.name, round: a.round, ageMs: Date.now() - a.startedLocal, ...(a.startAt ?? {}) });
      a.synced = true;
      storeAttempt(a);
      applyStatus(r.status, r.result);
    }
    if (a.pendingFinish && !a.result) {
      const f = a.pendingFinish;
      const r = await postFinish(a, { lat: f.lat, lng: f.lng, accuracy: f.accuracy, ageMs: Date.now() - f.at });
      applyStatus(r.status, r.result);
    }
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "network";
    if (code === "round_changed" || code === "not_published" || code === "unknown_attempt") {
      syncing = false;
      return resetToFreshRound();
    }
    if (code === "too_far" || code === "weak_reading" || code === "invalid") {
      // The server disagrees (Jacob may have moved the spot). Back to the hunt.
      if (attempt?.pendingFinish) {
        attempt.pendingFinish = null;
        storeAttempt(attempt);
        gate.reset();
        toast("Not quite there yet. Keep going!");
        showLooking();
      }
    } else {
      retryMs = code === "rate_limited" ? 15_000 : 3_000;
    }
  } finally {
    syncing = false;
  }
  if (retryMs) syncTimer = window.setTimeout(() => void sync(), retryMs);
}

function applyStatus(next: AttemptStatus, result: LocalAttempt["result"]): void {
  if (!attempt) return;
  if (next === "found" && result) {
    const first = !attempt.result;
    attempt.result = result;
    attempt.pendingFinish = null;
    storeAttempt(attempt);
    status = "found";
    if (app.dataset.screen !== "found") showFound();
    else if (first) refreshFound?.();
    return;
  }
  if (next === "pending" && !attempt.requested) {
    attempt.requested = true;
    storeAttempt(attempt);
  }
  if (!attempt.pendingFinish) status = next;
}
let refreshFound: (() => void) | null = null;

window.addEventListener("online", () => void sync());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void sync();
    if (app.dataset.screen === "looking") void keepAwake();
  }
});

/* ---------- Looking: the compass ---------- */

function showLooking(): void {
  const a = attempt!;
  const compass = new CompassView();
  const meadow = new Meadow();
  const timer = el("span", { class: "pill pill--timer", id: "timer", "aria-label": "Your time" }, formatDuration(Date.now() - a.startedLocal));
  const info = el("button", { class: "pill pill--icon", type: "button", id: "info", "aria-label": "How it works" }, "?");
  const cue = el("p", { class: "cue", id: "cue" }, `Dandelions open as you get closer to ${GAME.host}`);
  const distance = el("div", { class: "readout__distance", id: "distance" }, "…");
  const hint = el("p", { class: "readout__hint", id: "hint", "aria-live": "polite" }, "Finding you…");
  const friendsCount = el("span", { id: "friends-count" }, "0");
  const friends = el("button", { class: "chip", type: "button", id: "friends" }, el("span", { class: "chip__dot", "aria-hidden": "true" }), friendsCount, " searching");
  const ask = el("button", { class: "chip chip--ask", type: "button", id: "ask" }, "With Jacob?");
  const debug = DEBUG ? el("pre", { class: "debug", id: "debug" }) : null;

  show(
    "looking",
    sky(),
    el(
      "section",
      { class: "look" },
      el("header", { class: "look__top" }, info, cue, timer),
      el("div", { class: "look__compass" }, compass.root),
      el("div", { class: "readout" }, distance, hint),
      el("div", { class: "look__ground" }, meadow.root, el("div", { class: "look__chips" }, friends, ask)),
    ),
    debug,
  );
  document.documentElement.classList.add("is-looking");
  compass.start();
  void keepAwake();
  if (!watcher) startWatching();
  (window as unknown as { __compass?: CompassView }).__compass = compass;

  const log: unknown[] = [];
  let nearSince = 0;
  let lastSteps = -1;

  const update = () => {
    const now = Date.now();
    const h = heading.current(now);
    compass.setHeading(h.deg);
    const fresh = reading && now - reading.at < 20_000 ? reading : null;
    let d: number | null = null;
    if (reading && target) {
      d = distanceM(reading, target);
      compass.setBearing(bearingDeg(reading, target));
      distance.textContent = formatDistance(d);
      distance.dataset.metres = String(Math.round(d));
      const steps = bloomSteps(d);
      if (meadow.set(steps) && steps > lastSteps) vibrate(25);
      lastSteps = steps;
      nearSince = d <= 30 ? nearSince || now : 0;
    }
    ask.classList.toggle("is-nudge", status === "looking" && nearSince > 0 && now - nearSince > 15_000);
    ask.classList.toggle("is-pending", status === "pending");
    ask.textContent = status === "pending" ? "Waiting for Jacob…" : nearSince ? "I'm with Jacob!" : "With Jacob?";
    compass.root.classList.toggle("is-near", d !== null && d <= 30);

    let text: string;
    let tone = "";
    if (problem === "denied") {
      text = "Location is switched off. Tap ? for help.";
      tone = "warn";
    } else if (!fresh) {
      text = reading ? "Lost you for a moment. Open sky helps." : "Finding you…";
      tone = "warn";
    } else if (fresh.accuracy > 35) {
      text = `Weak signal (±${Math.round(fresh.accuracy)} m). Open sky helps.`;
      tone = "warn";
    } else if (h.deg === null) {
      text = heading.permission === "denied" ? "Walk a few steps and the plane will turn with you." : "Waking the compass: wave your phone in a figure of 8, or walk a few steps.";
      tone = "warn";
    } else if (d !== null) {
      text = h.source === "walk" && d > 25 ? `${warmth(d)} · the plane turns as you walk` : warmth(d);
    } else {
      text = "…";
    }
    hint.textContent = text;
    hint.dataset.tone = tone;

    const others = pinsFor(now);
    friendsCount.textContent = String(others.length);
    friends.hidden = others.length === 0 && finishers.length === 0;
    compass.setPins(others.sort((x, y) => x.distanceM - y.distanceM).slice(0, LIMITS.maxArrows));

    if (debug) {
      debug.textContent =
        `lat ${reading?.lat.toFixed(6) ?? "-"}  lng ${reading?.lng.toFixed(6) ?? "-"}\n` +
        `acc ±${reading ? Math.round(reading.accuracy) : "-"} m  age ${reading ? ((now - reading.at) / 1000).toFixed(1) : "-"} s\n` +
        `dist ${d !== null ? d.toFixed(1) : "-"} m  gate ${lastVerdict ?? "-"}\n` +
        `heading ${h.deg !== null ? Math.round(h.deg) : "-"}° (${h.source ?? "none"})  ${status}${a.synced ? "" : " · unsynced"}\n` +
        `tap here to save the log (${log.length})`;
    }
  };

  onReading = (r) => {
    if (DEBUG && log.length < 20_000) log.push({ ...r, heading: heading.current().deg, d: target ? distanceM(r, target) : null });
    if (target && !a.pendingFinish && !a.result) {
      lastVerdict = gate.offer(r, target, Date.now());
      if (lastVerdict === "finished") {
        a.pendingFinish = { lat: r.lat, lng: r.lng, accuracy: r.accuracy, at: r.at };
        storeAttempt(a);
        showFound();
        void sync();
        return;
      }
    }
    update();
  };
  onProblem = () => update();

  debug?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ target, readings: log }, null, 1)], { type: "application/json" });
    const link = el("a", { href: URL.createObjectURL(blob), download: `compass-log-${Date.now()}.json` });
    link.click();
  });

  // The dial follows the sensor every animation frame; the words and numbers only need a few updates a second.
  const fast = window.setInterval(() => compass.setHeading(heading.current().deg), 60);
  const slow = window.setInterval(() => {
    timer.textContent = formatDuration(Date.now() - a.startedLocal);
    update();
    // Near the finish, make sure fresh readings keep coming even if the phone thinks nothing changed.
    if (reading && target && distanceM(reading, target) < 40 && Date.now() - reading.at > 2500) watcher?.poke();
    else if (reading && Date.now() - reading.at > 12_000) watcher?.poke();
  }, 1000);

  let pingTimer = 0;
  const ping = async () => {
    if (!attempt) return;
    if (!attempt.synced) void sync();
    else {
      try {
        const r = await postPing(attempt, reading ? { lat: reading.lat, lng: reading.lng } : null);
        if (app.dataset.screen !== "looking" || !attempt) return;
        if (r.round !== round) return resetToFreshRound();
        if (r.target) {
          if (target && r.target.publishedAt !== target.publishedAt) {
            gate.reset();
            toast(`${GAME.host} moved! The plane has a new heading.`);
          }
          target = r.target;
          cacheGame();
        }
        searchers = r.searchers;
        searchersAt = Date.now();
        // Tell the guest when a friend gets there first. The first reply only catches up quietly.
        for (const d of r.done ?? []) {
          if (d.k === myKey || finishers.some((f) => f.k === d.k)) continue;
          finishers.push({ k: d.k, name: d.name });
          if (heardFinishers) {
            toast(`🎉 ${d.name} just found ${GAME.host}!`, 4200);
            vibrate([40, 60, 40]);
          }
        }
        heardFinishers = true;
        applyStatus(r.status, r.result);
        if (app.dataset.screen !== "looking") return;
        update();
      } catch (e) {
        if (e instanceof ApiError && e.code === "unknown_attempt") return resetToFreshRound();
      }
    }
    pingTimer = window.setTimeout(() => void ping(), status === "pending" ? POLL.pendingMs : POLL.lookingMs);
  };
  pingTimer = window.setTimeout(() => void ping(), 600);

  info.addEventListener("click", () => {
    const s = openSheet("How it works");
    s.body.append(howItWorks());
    if (problem === "denied") {
      const advice = problemAdvice("denied");
      const steps = el("ol", { class: "steps" });
      for (const step of advice.steps) steps.append(el("li", {}, step));
      s.body.append(el("h3", {}, advice.title), steps);
    }
  });

  friends.addEventListener("click", () => {
    const s = openSheet("Also searching");
    const list = el("ul", { class: "people" });
    const others = pinsFor(Date.now()).sort((x, y) => x.distanceM - y.distanceM);
    for (const p of others) {
      const dot = el("span", { class: "pin__dot pin__dot--list" }, [...p.name][0]?.toUpperCase() ?? "?");
      dot.style.setProperty("--pin", pinColorFor(p.k));
      list.append(el("li", {}, dot, el("span", { class: "people__name" }, p.name), el("span", { class: "people__meta" }, `${formatDistance(p.distanceM)} from you`)));
    }
    s.body.append(others.length ? list : el("p", {}, "Nobody else is searching right now."));
    if (finishers.length) s.body.append(el("p", { id: "already-found" }, el("b", {}, `Already found ${GAME.host}: `), finishers.map((f) => f.name).join(", ")));
    s.body.append(el("p", { class: "fine" }, "The little arrows around your compass show which way each friend is."));
  });

  ask.addEventListener("click", () => openAskSheet(update));

  leave = () => {
    window.clearInterval(fast);
    window.clearInterval(slow);
    window.clearTimeout(pingTimer);
    compass.stop();
    onReading = null;
    onProblem = null;
    allowSleep();
    document.documentElement.classList.remove("is-looking");
  };
  update();
}

function pinsFor(now: number): Pin[] {
  if (!reading) return [];
  const sinceReply = now - searchersAt;
  return searchers
    .filter((s) => s.age + sinceReply <= LIMITS.searcherStaleMs)
    .map((s) => ({ k: s.k, name: s.name, bearing: bearingDeg(reading!, s), distanceM: distanceM(reading!, s), ageMs: s.age + sinceReply }));
}

function openAskSheet(onChange: () => void): void {
  const s = openSheet("With Jacob?");
  const body = s.body;
  const draw = (state: "idle" | "sending" | "failed") => {
    if (status === "pending") {
      body.replaceChildren(
        el("div", { class: "ask ask--pending", id: "ask-state", "data-state": "pending" }, el("span", { class: "ask__icon", "aria-hidden": "true" }, "🙋"), el("h3", {}, "Jacob has your request"), el("p", {}, "Wave at him! Your name is at the top of his board. Your time stopped when you asked.")),
      );
      return;
    }
    const button = el("button", { class: "btn btn--primary btn--big", type: "button", id: "ask-send", disabled: state === "sending" }, state === "sending" ? "Asking…" : state === "failed" ? "Try again" : "Ask Jacob to confirm");
    body.replaceChildren(
      el(
        "div",
        { class: "ask", id: "ask-state", "data-state": state },
        el("p", {}, "Standing right next to Jacob but the compass hasn't finished? Phones can be a few metres off under trees."),
        el("p", {}, "Tell him in person, then send the request. He'll confirm it on his board."),
        state === "failed" ? el("p", { class: "field__error", role: "alert" }, "That didn't reach Jacob. Check your signal and try again.") : null,
        button,
      ),
    );
    button.addEventListener("click", () => {
      draw("sending");
      void (async () => {
        try {
          if (!attempt) return;
          if (!attempt.synced) await sync();
          if (!attempt?.synced) throw new ApiError("network", "start not sent");
          const r = await postRequest(attempt);
          applyStatus(r.status, r.result);
          if (r.status === "found") return;
          vibrate(40);
          draw("idle");
          onChange();
        } catch (e) {
          if (e instanceof ApiError && e.code === "unknown_attempt") return resetToFreshRound();
          draw("failed");
        }
      })();
    });
  };
  draw("idle");
}

/* ---------- Found ---------- */

function showFound(): void {
  const a = attempt!;
  status = "found";
  watcher?.stop();
  watcher = null;
  const meadow = new Meadow();
  meadow.set(10);
  const time = el("div", { class: "found__time", id: "found-time" });
  const saving = el("p", { class: "found__saving", id: "found-saving", "aria-live": "polite" });
  const badges = el("div", { class: "found__badges", id: "found-badges" });
  const boards = boardsView();
  const still = el("p", { class: "found__still", id: "found-still" });
  const quip = el("p", { class: "found__quip", id: "found-quip" });
  const portrait = el("div", { class: "found__jacob", html: jacobPortrait() });

  show(
    "found",
    sky(),
    seedShower(),
    el(
      "section",
      { class: "found" },
      el("div", { class: "found__top" }, portrait, el("h1", {}, `You found ${GAME.host}!`), time, saving, badges, quip),
      boards.root,
      still,
      el("div", { class: "found__ground" }, meadow.root),
    ),
  );
  later(() => meadow.puff(), 900);
  vibrate([80, 60, 80, 60, 220]);

  let latest: Boards | null = null;
  const draw = () => {
    const r = a.result;
    const localMs = a.pendingFinish ? a.pendingFinish.at - a.startedLocal : null;
    time.textContent = r ? formatDuration(r.durationMs) : localMs !== null ? formatDuration(localMs) : "";
    saving.textContent = r ? (r.method === "approved" ? "Confirmed by Jacob in person" : "") : "Saving your time… keep this page open";
    saving.hidden = !saving.textContent;
    badges.replaceChildren();
    if (latest && myKey) {
      const first = latest.first.find((row) => row.k === myKey);
      const fast = latest.fastest.find((row) => row.k === myKey);
      if (first) badges.append(el("span", { class: "badge", id: "badge-first" }, `${ordinal(first.rank)} to arrive`));
      if (fast) badges.append(el("span", { class: "badge badge--alt", id: "badge-fast" }, `${ordinal(fast.rank)} fastest`));
      if (first) {
        quip.textContent =
          first.rank === 1
            ? "First one here! Pick the best spot on the blanket."
            : fast?.rank === 1
              ? "Not first, but nobody got here quicker. Go say hi!"
              : first.rank <= 3
                ? "On the podium! Go give the birthday boy a hug."
                : "Made it! Go give the birthday boy a hug.";
      }
    }
    if (latest) {
      boards.update(latest, myKey);
      still.textContent = latest.searching > 0 ? `${latest.searching} still searching…` : "Everyone who started has found him!";
    }
  };
  let pollTimer = 0;
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    window.clearTimeout(pollTimer);
    try {
      const b = await getBoard();
      if (b.round !== round && a.result) {
        // Jacob cleared the boards for a new round: this result belongs to the old one.
        return resetToFreshRound();
      }
      latest = b.boards;
      draw();
    } catch {
      /* keep what we have */
    } finally {
      polling = false;
    }
    if (app.dataset.screen !== "found") return;
    // Until this guest's own row shows up, look again quickly.
    const listed = !!myKey && !!latest?.first.some((row) => row.k === myKey);
    pollTimer = window.setTimeout(() => void poll(), listed ? POLL.boardMs : 1500);
  };
  // When the saved result arrives, redraw and fetch the boards straight away.
  refreshFound = () => {
    draw();
    void poll();
  };
  draw();
  void poll();
  void sync();
  leave = () => {
    refreshFound = null;
    window.clearTimeout(pollTimer);
  };
}

/* ---------- Go ---------- */

if (isPhone()) void boot();
else showDesktop();
