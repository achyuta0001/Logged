// Loads public/data/news-spots.json once per page (shared by the map layer, the city overview and
// the commute check). A missing or broken file means "no news spots", never an error on screen.
import type { NewsSpot } from './spots.ts';

let pending: Promise<NewsSpot[]> | null = null;

export function loadNewsSpots(): Promise<NewsSpot[]> {
  if (pending) return pending;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const base = (env?.BASE_URL ?? '/').replace(/\/?$/, '/');
  pending = fetch(`${base}data/news-spots.json`)
    .then((r) => (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html') ? r.json() : null))
    .then((j: { spots?: NewsSpot[] } | null) => (Array.isArray(j?.spots) ? j!.spots.filter((s) => Array.isArray(s.coord) && s.reports?.length) : []))
    .catch(() => []);
  return pending;
}
