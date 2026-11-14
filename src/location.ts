/** The phone's position as a stream of readings, with errors turned into things a guest can act on. */
import type { Reading } from "./geo.ts";

export type LocationProblem = "denied" | "unavailable" | "timeout" | "unsupported";

const OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 };

function toReading(p: GeolocationPosition): Reading {
  const now = Date.now();
  // Trust the reading's own time unless it is clearly off (some browsers report odd timestamps).
  const at = p.timestamp <= now && now - p.timestamp < 30_000 ? p.timestamp : now;
  return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at };
}

function toProblem(e: GeolocationPositionError): LocationProblem {
  return e.code === e.PERMISSION_DENIED ? "denied" : e.code === e.TIMEOUT ? "timeout" : "unavailable";
}

export interface Watcher {
  stop(): void;
  /** Asks for one fresh reading now, for when the phone has gone quiet near the finish. */
  poke(): void;
}

export function watchLocation(onReading: (r: Reading) => void, onProblem: (p: LocationProblem) => void): Watcher {
  if (!("geolocation" in navigator)) {
    onProblem("unsupported");
    return { stop() {}, poke() {} };
  }
  const ok = (p: GeolocationPosition) => onReading(toReading(p));
  const id = navigator.geolocation.watchPosition(ok, (e) => onProblem(toProblem(e)), OPTIONS);
  return {
    stop: () => navigator.geolocation.clearWatch(id),
    poke: () => navigator.geolocation.getCurrentPosition(ok, () => {}, OPTIONS),
  };
}

/** What to tell a guest when location doesn't work. */
export function problemAdvice(p: LocationProblem): { title: string; steps: string[] } {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (p === "denied") {
    return {
      title: "The compass needs your location",
      steps: ios
        ? [
            "Open Settings → Privacy & Security → Location Services and check it's on.",
            "In the same place, tap Safari Websites (or your browser) and choose While Using the App.",
            "Come back here and tap Try again, then choose Allow.",
          ]
        : [
            "Tap the lock or settings icon next to the address bar.",
            "Tap Permissions → Location and choose Allow.",
            "Check that Location is switched on in your phone's quick settings, then tap Try again.",
          ],
    };
  }
  if (p === "unsupported") return { title: "This browser can't share location", steps: ["Open the link in Safari or Chrome on your phone."] };
  return {
    title: "Still looking for you",
    steps: ["Step out from under the trees so your phone can see the sky.", "Check that Location is switched on in your phone's settings.", "Then tap Try again."],
  };
}
