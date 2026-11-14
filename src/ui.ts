/** Small DOM helpers shared by the guest page and the master board. */
import type { BoardRow, Boards } from "./config.ts";
import { formatDistance, formatDuration } from "./geo.ts";
import { GAME } from "./config.ts";

type Child = Node | string | null | undefined | false;

/** Creates an element. Text always goes in as text, never as markup, so names can't inject anything. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "html") node.innerHTML = String(value); // only ever our own SVG artwork
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let toastTimer = 0;
export function toast(message: string, ms = 3200): void {
  const t = $("toast");
  t.textContent = message;
  t.classList.add("is-on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("is-on"), ms);
}

export interface Sheet {
  body: HTMLElement;
  /** `instant` skips the slide-down, for when another sheet is taking its place. */
  close(instant?: boolean): void;
}

let openSheetRef: Sheet | null = null;

/** A panel that slides up from the bottom, in thumb reach. One at a time. */
export function openSheet(title: string, onClose?: () => void): Sheet {
  openSheetRef?.close(true);
  const root = $("sheet-root");
  const body = el("div", { class: "sheet__body" });
  const closeBtn = el("button", { class: "sheet__close", type: "button", "aria-label": "Close" }, "×");
  const panel = el("div", { class: "sheet__panel", role: "dialog", "aria-modal": "true", "aria-label": title }, el("div", { class: "sheet__grip", "aria-hidden": "true" }), el("div", { class: "sheet__head" }, el("h2", {}, title), closeBtn), body);
  const backdrop = el("div", { class: "sheet" }, panel);
  let closed = false;
  const sheet: Sheet = {
    body,
    close(instant = false) {
      if (closed) return;
      closed = true;
      if (openSheetRef === sheet) openSheetRef = null;
      backdrop.classList.remove("is-on");
      document.removeEventListener("keydown", onKey);
      if (instant) backdrop.remove();
      else window.setTimeout(() => backdrop.remove(), 220);
      onClose?.();
    },
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") sheet.close();
  };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) sheet.close();
  });
  closeBtn.addEventListener("click", () => sheet.close());
  document.addEventListener("keydown", onKey);
  root.append(backdrop);
  // Next frame, so the slide-up transition runs.
  requestAnimationFrame(() => backdrop.classList.add("is-on"));
  closeBtn.focus({ preventScroll: true });
  openSheetRef = sheet;
  return sheet;
}

export function closeSheet(): void {
  openSheetRef?.close();
}

const clock = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: GAME.timeZone });
const shortClock = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: GAME.timeZone });
export const formatClock = (ms: number, seconds = false) => (seconds ? clock : shortClock).format(new Date(ms)).replace(/\s?(am|pm)/i, (_m, p: string) => ` ${p.toLowerCase()}`);

const MEDALS = ["", "🥇", "🥈", "🥉"];

function boardList(rows: BoardRow[], kind: "first" | "fastest", myKey: string | null): HTMLElement {
  if (!rows.length) return el("p", { class: "board__empty" }, "Nobody has found Jacob yet.");
  const list = el("ol", { class: "board__list" });
  for (const r of rows) {
    const main = kind === "first" ? formatClock(r.finishedAt, true) : formatDuration(r.durationMs);
    const side =
      kind === "first" ? `took ${formatDuration(r.durationMs)}` : r.startDistanceM !== null ? `from ${formatDistance(r.startDistanceM)} away` : "";
    list.append(
      el(
        "li",
        { class: `board__row${r.k === myKey ? " is-me" : ""}`, "data-key": r.k },
        el("span", { class: "board__rank" }, MEDALS[r.rank] ?? String(r.rank)),
        el("span", { class: "board__who" }, el("span", { class: "board__name" }, r.name), r.k === myKey ? el("span", { class: "board__you" }, "you") : null),
        el("span", { class: "board__time" }, el("b", {}, main), side ? el("small", {}, side) : null),
      ),
    );
  }
  return list;
}

/** The two rankings as two tabs. Remembers which tab was open across refreshes. */
export function boardsView(): { root: HTMLElement; update(b: Boards, myKey: string | null): void } {
  let tab: "first" | "fastest" = "first";
  let last: { b: Boards; myKey: string | null } | null = null;
  const firstBtn = el("button", { class: "tabs__tab", type: "button", role: "tab", "data-tab": "first" }, "First to arrive");
  const fastBtn = el("button", { class: "tabs__tab", type: "button", role: "tab", "data-tab": "fastest" }, "Fastest");
  const panel = el("div", { class: "board__panel", role: "tabpanel" });
  const root = el("section", { class: "board" }, el("div", { class: "tabs", role: "tablist" }, firstBtn, fastBtn), panel);
  const draw = () => {
    firstBtn.setAttribute("aria-selected", String(tab === "first"));
    fastBtn.setAttribute("aria-selected", String(tab === "fastest"));
    if (last) panel.replaceChildren(boardList(last.b[tab], tab, last.myKey));
  };
  for (const b of [firstBtn, fastBtn]) {
    b.addEventListener("click", () => {
      tab = b.dataset.tab as "first" | "fastest";
      draw();
    });
  }
  draw();
  return {
    root,
    update(b, myKey) {
      last = { b, myKey };
      draw();
    },
  };
}
