/**
 * Vector artwork. Every function returns SVG markup drawn around a local origin
 * (feet / base centre at 0,0, y going up into negative numbers), so the park can place
 * each piece with a single translate + scale. The people, trees and clouds come from the invite site.
 */

export const C = {
  cream: "#FBF3E0",
  cream2: "#F3E6C8",
  line: "#2B5A45",
  ink: "#1F4D3A",
  sky: "#CDE9F5",
  skyLight: "#E6F4FA",
  grass: "#B7DB9C",
  grass2: "#A5D08B",
  hill: "#93C582",
  leaf: "#6FAE6A",
  leaf2: "#86BF73",
  leafDark: "#4E8F5A",
  butter: "#FFE08A",
  butterDeep: "#F7CE5B",
  coral: "#F26B5B",
  path: "#F7E9C6",
  pathEdge: "#E6D3A3",
  water: "#A9D8EE",
  waterLight: "#CDEBF7",
  trunk: "#B98A5E",
  wood: "#C99B6B",
  hairBlack: "#1D1A1A",
} as const;

const OUT = `stroke="${C.line}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"`;

type Circle = [cx: number, cy: number, r: number];

/** Overlapping circles drawn as one soft-outlined shape. */
function blob(circles: Circle[], fill: string, outline = true): string {
  const fills = circles.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`).join("");
  if (!outline) return fills;
  const edge = circles.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r + 2.5}" fill="${C.line}"/>`).join("");
  return edge + fills;
}

function shadow(rx: number, ry = 6): string {
  return `<ellipse cx="0" cy="2" rx="${rx}" ry="${ry}" fill="${C.ink}" opacity=".16"/>`;
}

/* ---------- People ---------- */

type HairStyle = "messy" | "bun" | "short" | "long" | "curly" | "cap" | "pony";

export interface PersonOpts {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  shirt: string;
  bottom: string;
  shoes?: string;
  grin?: boolean;
  pendant?: boolean;
  capColor?: string;
  partyHat?: boolean;
}

function hairMarkup(style: HairStyle, hair: string, capColor: string): string {
  const top = `<path d="M-19,-126 C-21,-151 21,-151 19,-126 C12,-138 -9,-140 -19,-126 Z" fill="${hair}"/>`;
  switch (style) {
    case "messy":
      return (
        `<path d="M-19.5,-126 C-26,-139 -18,-150 -10,-147 C-9,-156 3,-157 6,-150 C13,-156 24,-148 19,-139 C25,-135 22,-126 19.5,-124 C17,-133 10,-138 3,-135 C-4,-140 -12,-136 -15,-130 C-16,-127 -18,-124 -19.5,-126 Z" fill="${hair}"/>` +
        `<circle cx="-15" cy="-144" r="4.5" fill="${hair}"/><circle cx="13" cy="-149" r="4" fill="${hair}"/><circle cx="-2" cy="-152" r="4.5" fill="${hair}"/>` +
        `<path d="M-4,-137 q5,-5 10,-1" fill="none" stroke="${hair}" stroke-width="3.5" stroke-linecap="round"/>`
      );
    case "bun":
      return `<circle cx="0" cy="-151" r="8.5" fill="${hair}"/>` + top;
    case "long":
      return `<path d="M-20,-126 C-23,-153 23,-153 20,-126 L23,-98 L12,-98 L15,-124 C8,-138 -8,-138 -15,-124 L-12,-98 L-23,-98 Z" fill="${hair}"/>`;
    case "curly":
      return blob(
        [
          [-15, -137, 8],
          [-5, -145, 9],
          [6, -145, 9],
          [15, -137, 8],
          [-19, -127, 6],
          [19, -127, 6],
        ],
        hair,
        false,
      );
    case "cap":
      return (
        `<path d="M-19,-126 C-17,-120 -17,-118 -18,-116" fill="none" stroke="${hair}" stroke-width="4" stroke-linecap="round"/>` +
        `<path d="M-19.5,-130 C-19,-152 19,-152 19.5,-130 Z" fill="${capColor}" ${OUT}/>` +
        `<path d="M12,-132 h17 a3,3 0 0 1 0,6 h-17 z" fill="${capColor}" ${OUT}/>`
      );
    case "pony":
      return `<path d="M15,-138 C32,-140 31,-114 22,-106 C25,-118 21,-126 15,-128 Z" fill="${hair}"/>` + top;
    default:
      return top;
  }
}

function arm(side: -1 | 1, skin: string, shirt: string): string {
  const s = side;
  const limb = `M0,2 L${6 * s},36`;
  const sleeve = `M0,1 L${2.5 * s},14`;
  return (
    `<g transform="translate(${19 * s},-98)"><g class="arm ${s === 1 ? "arm-r" : "arm-l"}">` +
    `<path d="${limb}" fill="none" stroke="${C.line}" stroke-width="12.5" stroke-linecap="round"/>` +
    `<path d="${limb}" fill="none" stroke="${skin}" stroke-width="8" stroke-linecap="round"/>` +
    `<path d="${sleeve}" fill="none" stroke="${C.line}" stroke-width="15.5" stroke-linecap="round"/>` +
    `<path d="${sleeve}" fill="none" stroke="${shirt}" stroke-width="11" stroke-linecap="round"/>` +
    `</g></g>`
  );
}

function partyHat(): string {
  return (
    `<g transform="rotate(-10 0 -146)">` +
    `<path d="M-14,-144 L1,-186 L16,-144 Z" fill="${C.butter}" ${OUT}/>` +
    `<path d="M-9,-158 L11,-158 M-4.5,-171 L6.5,-171" fill="none" stroke="#8FCBE6" stroke-width="4.5"/>` +
    `<path d="M-14,-144 L1,-186 L16,-144 Z" fill="none" ${OUT}/>` +
    `<path d="M-16,-144 h34" fill="none" stroke="${C.line}" stroke-width="4" stroke-linecap="round"/>` +
    `<circle cx="1" cy="-188" r="5" fill="#FFFDF5" ${OUT}/>` +
    `</g>`
  );
}

/** A standing figure about 155 units tall. */
export function person(o: PersonOpts): string {
  const shoes = o.shoes ?? "#ffffff";
  const mouth = o.grin
    ? `<path d="M-8.5,-121 Q0,-108 8.5,-121 Z" fill="#fff" stroke="${C.hairBlack}" stroke-width="1.6" stroke-linejoin="round"/>`
    : `<path d="M-6,-120 Q0,-114 6,-120" fill="none" stroke="${C.hairBlack}" stroke-width="1.8" stroke-linecap="round"/>`;
  const pendant = o.pendant
    ? `<path d="M-7,-104 L0,-90 L7,-104" fill="none" stroke="#f3f6f6" stroke-width="1.5" stroke-linecap="round"/><circle cx="0" cy="-89" r="2.8" fill="#8fd0e8" stroke="${C.line}" stroke-width="1"/>`
    : "";
  return (
    shadow(26) +
    `<g class="figure">` +
    `<rect x="-13" y="-42" width="10" height="40" rx="5" fill="${o.skin}" ${OUT}/>` +
    `<rect x="3" y="-42" width="10" height="40" rx="5" fill="${o.skin}" ${OUT}/>` +
    `<ellipse cx="-9" cy="-2" rx="9" ry="5" fill="${shoes}" ${OUT}/>` +
    `<ellipse cx="9" cy="-2" rx="9" ry="5" fill="${shoes}" ${OUT}/>` +
    `<path d="M-19,-68 h38 l2,32 h-18 l-3,-15 l-3,15 h-18 z" fill="${o.bottom}" ${OUT}/>` +
    arm(-1, o.skin, o.shirt) +
    arm(1, o.skin, o.shirt) +
    `<rect x="-20" y="-106" width="40" height="44" rx="11" fill="${o.shirt}" ${OUT}/>` +
    `<rect x="-5" y="-113" width="10" height="10" fill="${o.skin}"/>` +
    pendant +
    `<circle cx="-18" cy="-125" r="4" fill="${o.skin}" ${OUT}/><circle cx="18" cy="-125" r="4" fill="${o.skin}" ${OUT}/>` +
    `<circle cx="0" cy="-126" r="18.5" fill="${o.skin}" ${OUT}/>` +
    `<circle cx="-6.5" cy="-128" r="2.1" fill="${C.hairBlack}"/><circle cx="6.5" cy="-128" r="2.1" fill="${C.hairBlack}"/>` +
    mouth +
    hairMarkup(o.hairStyle, o.hair, o.capColor ?? o.shirt) +
    (o.partyHat ? partyHat() : "") +
    `</g>`
  );
}

export const JACOB: PersonOpts = {
  skin: "#B97A50",
  hair: C.hairBlack,
  hairStyle: "messy",
  shirt: C.coral,
  bottom: "url(#checks)",
  grin: true,
  pendant: true,
  partyHat: true,
};

export function jacob(): string {
  return person(JACOB);
}

/** Jacob's head and shoulders for the arrival screen. */
export function jacobPortrait(): string {
  return (
    `<svg viewBox="-48 -198 96 96" aria-hidden="true" focusable="false">` +
    `<circle cx="0" cy="-150" r="48" fill="${C.butter}"/>` +
    `<circle cx="0" cy="-150" r="40" fill="${C.cream}" opacity=".55"/>` +
    person(JACOB) +
    `<circle cx="0" cy="-150" r="46.5" fill="none" stroke="${C.line}" stroke-width="3"/>` +
    `</svg>`
  );
}

/* ---------- Scenery ---------- */

export function tree(variant: 0 | 1 = 0): string {
  const fill = variant === 0 ? C.leaf : C.leaf2;
  return (
    shadow(40, 8) +
    `<path d="M-10,0 L-6,-78 L6,-78 L10,0 Z" fill="${C.trunk}" ${OUT}/>` +
    `<g class="canopy">` +
    blob(
      [
        [-36, -108, 35],
        [32, -110, 37],
        [0, -146, 43],
        [0, -98, 31],
      ],
      fill,
    ) +
    `<circle cx="-14" cy="-150" r="9" fill="#fff" opacity=".14"/><circle cx="-34" cy="-112" r="7" fill="#fff" opacity=".12"/>` +
    `</g>`
  );
}

export function cloud(): string {
  return blob(
    [
      [-40, 0, 24],
      [-8, -14, 32],
      [30, -2, 26],
      [0, 6, 24],
    ],
    "#FFFDF5",
    false,
  );
}

export function butterfly(fill: string): string {
  const wing = (x: number, rot: number) =>
    `<ellipse cx="${x}" cy="-3" rx="6.5" ry="9" transform="rotate(${rot} ${x} -3)" fill="${fill}" stroke="${C.line}" stroke-width="1.6"/>`;
  return `<circle r="24" cy="-3" fill="transparent"/><g class="butterfly">${wing(-6, -28)}${wing(6, 28)}<path d="M0,-9 V5" stroke="${C.line}" stroke-width="2.2" stroke-linecap="round"/></g>`;
}

export function tuft(): string {
  return `<rect x="-12" y="-18" width="24" height="22" fill="transparent"/><g class="tuft-blades"><path d="M0,0 L-6,-11 M0,0 L0,-15 M0,0 L6,-11" fill="none" stroke="${C.leafDark}" stroke-width="2.6" stroke-linecap="round"/></g>`;
}

export function flower(fill: string): string {
  return `<path d="M0,0 v-10" stroke="${C.leafDark}" stroke-width="2.2" stroke-linecap="round"/><circle cx="0" cy="-13" r="5.5" fill="${fill}" stroke="${C.line}" stroke-width="1.6"/><circle cx="0" cy="-13" r="1.8" fill="${C.butterDeep}"/>`;
}


/* ---------- Compass pieces ---------- */

/** The paper plane from the invite, redrawn large and pointing up, for the middle of the compass. */
export function compassPlane(): string {
  return (
    `<svg viewBox="-50 -62 100 132" aria-hidden="true" focusable="false">` +
    `<g class="plane-bob">` +
    `<path d="M0,44 v9 M0,61 v6" fill="none" stroke="${C.line}" stroke-width="3" stroke-linecap="round" opacity=".5"/>` +
    `<path d="M0,-52 L32,34 L0,18 L-32,34 Z" fill="#FFFDF5" ${OUT}/>` +
    `<path d="M0,-52 L0,18 L-32,34 Z" fill="${C.cream2}"/>` +
    `<path d="M0,-52 L32,34 L0,18 L-32,34 Z" fill="none" ${OUT}/>` +
    `<path d="M0,-52 V18" fill="none" stroke="${C.line}" stroke-width="2.2" stroke-linecap="round"/>` +
    `</g></svg>`
  );
}

/** The compass face: a soft disc with tick marks and a small N. It turns so N always faces north. */
export function compassFace(): string {
  let ticks = "";
  for (let a = 0; a < 360; a += 30) {
    if (a === 0) continue;
    const big = a % 90 === 0;
    ticks += `<path d="M0,-${big ? 86 : 88} V-93" transform="rotate(${a})" stroke="${C.line}" stroke-width="${big ? 3 : 2}" stroke-linecap="round" opacity="${big ? 0.55 : 0.3}"/>`;
  }
  return (
    `<svg viewBox="-100 -100 200 200" aria-hidden="true" focusable="false">` +
    `<circle r="97" fill="#FFFDF5" stroke="${C.line}" stroke-width="3"/>` +
    `<circle r="80" fill="${C.skyLight}" opacity=".7"/>` +
    `<circle r="80" fill="none" stroke="${C.line}" stroke-width="1.6" stroke-dasharray="2 7" stroke-linecap="round" opacity=".45"/>` +
    ticks +
    `<text y="-83.5" text-anchor="middle" font-size="12" font-weight="700" fill="${C.coral}" font-family="inherit">N</text>` +
    `</svg>`
  );
}

/** Colours for other searchers' arrows, picked by their key so each friend keeps one colour. */
export const PIN_COLORS = ["#7EC3E6", "#B79AE0", "#6CCDBB", "#F5A9C4", "#FFD25E", "#8FCB7A", "#F2A45B"];

export function pinColor(key: string): string {
  let n = 0;
  for (const ch of key) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return PIN_COLORS[n % PIN_COLORS.length];
}

/* ---------- Dandelions ---------- */

function petals(count: number, radius: number, rx: number, ry: number, fill: string, offset = 0): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    const a = (360 / count) * i + offset;
    out += `<ellipse cx="0" cy="${-radius}" rx="${rx}" ry="${ry}" transform="rotate(${a})" fill="${fill}" stroke="${C.line}" stroke-width="1.3"/>`;
  }
  return out;
}

/** The four heads a dandelion can wear: closed bud, opening, full flower, and the seed puff at the finish. */
function dandelionHeads(): string {
  const bud =
    `<path d="M-7,3 C-10,-8 -5,-19 0,-24 C5,-19 10,-8 7,3 Z" fill="${C.leaf}" ${OUT}/>` +
    `<path d="M-3,-17 Q0,-27 3,-17 Z" fill="${C.butterDeep}" stroke="${C.line}" stroke-width="1.3" stroke-linejoin="round"/>` +
    `<path d="M0,2 V-10" fill="none" stroke="${C.leafDark}" stroke-width="1.6" stroke-linecap="round"/>`;
  let fan = "";
  for (const a of [-48, -24, 0, 24, 48]) {
    fan += `<ellipse cx="0" cy="-17" rx="3.4" ry="9" transform="rotate(${a} 0 -4)" fill="${a % 48 === 0 ? C.butterDeep : C.butter}" stroke="${C.line}" stroke-width="1.3"/>`;
  }
  const opening = fan + `<path d="M-9,3 C-10,-5 -6,-10 0,-10 C6,-10 10,-5 9,3 Z" fill="${C.leaf}" ${OUT}/>`;
  const open =
    petals(14, 11, 3.4, 8.5, C.butterDeep) +
    petals(10, 6.5, 3, 6.5, C.butter, 18) +
    `<circle r="4.6" fill="#F2B632" stroke="${C.line}" stroke-width="1.3"/>`;
  let seeds = "";
  for (let i = 0; i < 14; i++) {
    const a = (360 / 14) * i + 8;
    seeds += `<g transform="rotate(${a})"><path d="M0,-3 V-15" stroke="${C.line}" stroke-width="1" opacity=".45"/><circle cy="-16.5" r="2.4" fill="#FFFDF5" stroke="${C.line}" stroke-width="1"/></g>`;
  }
  const puff =
    `<circle r="19" fill="#FFFDF5" opacity=".85"/>` +
    `<circle r="19" fill="none" stroke="${C.line}" stroke-width="1.4" stroke-dasharray="1.5 4.5" stroke-linecap="round" opacity=".6"/>` +
    seeds +
    `<circle r="3.4" fill="${C.cream2}" stroke="${C.line}" stroke-width="1.2"/>`;
  return [bud, opening, open, puff].map((m, i) => `<g class="dl-head dl-head--${i}">${m}</g>`).join("");
}

/** One dandelion growing up from 0,0. `height` is the stem length; the head sits on top. */
export function dandelion(height: number, lean: number): string {
  const leaf = (s: 1 | -1) =>
    `<path d="M0,0 C${-6 * s},-3 ${-13 * s},-3 ${-24 * s},-15 l${6 * s},0 l${-2 * s},-6 l${6 * s},3 l${-1 * s},-7 C${-7 * s},-17 ${-2 * s},-8 0,0 Z" fill="${C.leaf}" stroke="${C.line}" stroke-width="2" stroke-linejoin="round"/>`;
  return (
    leaf(1) +
    leaf(-1) +
    `<g class="dl-sway">` +
    `<path d="M0,0 C${-lean},${-height * 0.4} ${lean * 1.6},${-height * 0.7} 0,${-height}" fill="none" stroke="${C.line}" stroke-width="6" stroke-linecap="round"/>` +
    `<path d="M0,0 C${-lean},${-height * 0.4} ${lean * 1.6},${-height * 0.7} 0,${-height}" fill="none" stroke="${C.leaf2}" stroke-width="3" stroke-linecap="round"/>` +
    `<g transform="translate(0,${-height})">${dandelionHeads()}</g>` +
    `</g>`
  );
}

/** A single drifting seed for the finish celebration. */
export function seed(): string {
  return (
    `<svg viewBox="-12 -14 24 30" aria-hidden="true" focusable="false">` +
    `<path d="M0,12 V-2 M0,-2 L-8,-10 M0,-2 L-4,-12 M0,-2 L0,-13 M0,-2 L4,-12 M0,-2 L8,-10" fill="none" stroke="${C.line}" stroke-width="1.4" stroke-linecap="round" opacity=".8"/>` +
    `<ellipse cx="0" cy="13" rx="1.8" ry="3" fill="${C.trunk}"/>` +
    `</svg>`
  );
}

/** Small icons for the how-it-works list, drawn in the same style as everything else. */
export function planeIcon(): string {
  return `<svg viewBox="-36 -56 72 94" aria-hidden="true" focusable="false"><g transform="rotate(35)"><path d="M0,-52 L32,34 L0,18 L-32,34 Z" fill="#FFFDF5" ${OUT}/><path d="M0,-52 L0,18 L-32,34 Z" fill="${C.cream2}"/><path d="M0,-52 L32,34 L0,18 L-32,34 Z M0,-52 V18" fill="none" ${OUT}/></g></svg>`;
}

export function flowerIcon(): string {
  return `<svg viewBox="-22 -22 44 44" aria-hidden="true" focusable="false">${petals(14, 11, 3.4, 8.5, C.butterDeep)}${petals(10, 6.5, 3, 6.5, C.butter, 18)}<circle r="4.6" fill="#F2B632" stroke="${C.line}" stroke-width="1.3"/></svg>`;
}

export function finishIcon(): string {
  return `<svg viewBox="-22 -22 44 44" aria-hidden="true" focusable="false"><circle r="18" fill="${C.butter}" stroke="${C.line}" stroke-width="2.5" stroke-dasharray="3 5" stroke-linecap="round"/><circle r="7" fill="${C.coral}" stroke="${C.line}" stroke-width="2.5"/></svg>`;
}

/**
 * A dandelion seen from above: a rosette of jagged leaves with the flower in the middle.
 * The four heads are stacked and the page shows one at a time: bud, opening, open, seed puff.
 */
export function dandelionTop(): string {
  let leaves = "";
  for (let i = 0; i < 6; i++) {
    leaves += `<path transform="rotate(${i * 60 + (i % 2 ? 9 : -6)})" d="M0,0 C3,-5 5,-7 3.5,-11 l3,0.5 l-2.5,-4 l3,0.5 C6,-19 2,-22 0,-${i % 2 ? 23 : 20} C-2,-22 -6,-19 -7,-14 l3,-0.5 l-2.5,4 l3,-0.5 C-5,-7 -3,-5 0,0 Z" fill="${i % 2 ? C.leaf : C.leaf2}" stroke="${C.line}" stroke-width="1.2" stroke-linejoin="round"/>`;
  }
  const bud =
    `<circle r="6" fill="${C.leaf}" stroke="${C.line}" stroke-width="1.5"/>` +
    `<path d="M0,-6 V6 M-5.2,-3 L5.2,3 M-5.2,3 L5.2,-3" stroke="${C.leafDark}" stroke-width="1.1" stroke-linecap="round"/>` +
    `<circle r="2" fill="${C.butterDeep}" stroke="${C.line}" stroke-width="0.9"/>`;
  const opening = petals(10, 5.5, 2.5, 5, C.butterDeep, 9) + `<circle r="4.2" fill="${C.leaf2}" stroke="${C.line}" stroke-width="1.2"/><circle r="1.8" fill="${C.butter}"/>`;
  const open = petals(14, 11, 3.4, 8.5, C.butterDeep) + petals(10, 6.5, 3, 6.5, C.butter, 18) + `<circle r="4.6" fill="#F2B632" stroke="${C.line}" stroke-width="1.3"/>`;
  let seeds = "";
  for (let i = 0; i < 14; i++) {
    seeds += `<g transform="rotate(${(360 / 14) * i + 8})"><path d="M0,-3 V-15" stroke="${C.line}" stroke-width="1" opacity=".45"/><circle cy="-16.5" r="2.4" fill="#FFFDF5" stroke="${C.line}" stroke-width="1"/></g>`;
  }
  const puff = `<circle r="19" fill="#FFFDF5" opacity=".88"/>` + seeds + `<circle r="3.4" fill="${C.cream2}" stroke="${C.line}" stroke-width="1.2"/>`;
  const heads = [bud, opening, open, puff].map((m, i) => `<g class="dl-head dl-head--${i}">${m}</g>`).join("");
  return `<svg viewBox="-26 -26 52 52" aria-hidden="true" focusable="false"><g class="dl-leaves">${leaves}</g>${heads}</svg>`;
}
