// Flood spots reported in the news (public/data/news-spots.json, built by scripts/news/).
// Pure functions shared by the pipeline (node, native type stripping) and the app: name
// normalising, the "is this a specific place?" filter, mention extraction from article text,
// own-words summaries, and de-duplication of mentions into spots. No DOM, no network.

export type SpotKind = 'underpass' | 'junction' | 'road' | 'layout' | 'other';
export type LngLat = [number, number];

export interface NewsReport {
  /** YYYY-MM-DD the article was published (GDELT seen date) */
  date: string;
  url: string;
  /** outlet domain, e.g. "deccanherald.com" */
  outlet: string;
  /** our own words, at most 15 words; never article text */
  summary: string;
}

export interface NewsSpot {
  id: string;
  name: string;
  coord: LngLat;
  kind: SpotKind;
  reports: NewsReport[];
  /** distinct flood days reported (dates within 2 days of each other count once) */
  count: number;
  firstYear: number;
  lastYear: number;
}

/** Bengaluru Urban, [west, south, east, north] */
export const BLR_BBOX: [number, number, number, number] = [77.38, 12.73, 77.79, 13.18];

export const inBBox = (p: LngLat, b: readonly number[] = BLR_BBOX) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/** metres between two points (equirectangular; fine at city scale) */
export function metres(a: LngLat, b: LngLat): number {
  const kx = 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110574);
}

// ------------------------------------------------------------------ names

const ABBR: [RegExp, string][] = [
  [/\brd\b/g, 'road'],
  [/\b(jn|jnc|jct|junc|jnctn)\b/g, 'junction'],
  [/\bcrs\b/g, 'cross'],
  [/\bmn\b/g, 'main'],
  [/\bst\b/g, 'street'],
  [/\bngr\b/g, 'nagar'],
  [/\bnagara\b/g, 'nagar'],
  [/\bunder pass\b/g, 'underpass'],
  [/\bfly over\b/g, 'flyover'],
  [/\bbengaluru\b|\bbangalore\b|\bbbmp\b/g, ' '],
  // spellings seen in the news for the same OSM name
  [/\bmehkri\b/g, 'mekhri'],
  [/\bsivananda\b/g, 'shivananda'],
  [/\bhebbala\b/g, 'hebbal'],
  [/\bsarjapura\b/g, 'sarjapur'],
  [/\boklipuram\b/g, 'okalipuram'],
];

/** Lower-case, punctuation-free, abbreviations expanded: "Silk Board Jn." -> "silk board junction". */
export function normName(s: string): string {
  let t = s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/(\w)\.(?=\w\.)/g, '$1') // H.S.R. -> HSR.
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
  for (const [re, to] of ABBR) t = t.replace(re, to);
  return t.replace(/\s+/g, ' ').trim();
}

const TYPE_WORDS: [SpotKind, RegExp][] = [
  ['underpass', /\b(underpass|subway|rub|railway under ?bridge)$/],
  ['junction', /\b(junction|circle|signal|chowk|interchange|cross ?roads?)$/],
  ['layout', /\b(layout|colony|apartments?|enclave|block|stage|phase|sector|extension|nagar layout)$/],
  ['other', /\b(flyover|bridge|bus stand|bus station|bus depot|metro station|railway station|tech park|business park|it park)$/],
  ['road', /\b(road|main road|main|street|highway|cross|avenue|lane|marg)$/],
];

/** Kind from the trailing type word, or null when the name has none. */
export function kindOf(name: string): SpotKind | null {
  const n = normName(name);
  for (const [k, re] of TYPE_WORDS) if (re.test(n)) return k;
  return null;
}

/** words that never make a place specific on their own */
const GENERIC = new Set([
  'the', 'a', 'an', 'this', 'that', 'its', 'their', 'main', 'service', 'ring', 'outer', 'inner', 'new', 'old', 'arterial', 'major', 'key', 'nearby',
  'several', 'many', 'some', 'various', 'other', 'city', 'national', 'state', 'district', 'low', 'lying', 'busy', 'one', 'two', 'three', 'flooded',
  'cross', 'road', 'roads', 'junction', 'junctions', 'underpass', 'underpasses', 'layout', 'layouts', 'street', 'highway', 'flyover', 'bridge', 'circle',
  'signal', 'block', 'stage', 'phase', 'sector', 'colony', 'lane', 'avenue', 'apartment', 'apartments', 'extension', 'feet', 'ft', 'metre', 'meter', 'and', 'of', 'in', 'at',
  'north', 'south', 'east', 'west', 'stretch', 'area', 'areas', 'bus', 'stand', 'station', 'metro', 'railway', 'tech', 'park', 'enclave', 'karnataka', 'india',
]);
const ORDINAL = /^(\d+(st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|[ivx]+)$/;
/** city-scale corridors: tens of km long, so "X Road flooded" does not say where */
const CORRIDORS = /^(outer ring|inner ring|peripheral ring|nice|hosur|bellary|ballari|tumkur|tumakuru|mysore|mysuru|old madras|old airport|airport|sarjapur|bannerghatta|kanakapura|magadi|whitefield|varthur|hennur|thanisandra|old mumbai|national highway|nh \d+|intermediate ring|kr puram|k r puram|mg|m g|ring|service) (road|main road|highway)$/;

/** Core words of a place name (the type word and filler removed). */
export function coreTokens(name: string): string[] {
  return normName(name)
    .split(' ')
    .filter((w) => w && !GENERIC.has(w) && !ORDINAL.test(w));
}

/**
 * True when a name points at one place: it has a type word and a distinctive core
 * ("Silk Board junction", "Okalipuram underpass"), and is not a generic phrase ("the main road",
 * "5th Cross"), nor a city-scale corridor ("Outer Ring Road", "Hosur Road").
 */
export function isSpecific(name: string): boolean {
  const n = normName(name);
  if (!kindOf(n)) return false;
  if (CORRIDORS.test(n)) return false;
  const core = coreTokens(n);
  if (!core.length) return false;
  // the core must be a name, not a letter ("KR Circle", "HAL" ok; "A Road" no)
  return core.join('').length >= 2;
}

/** Same place, by name: one core contains the other, or they share at least half their core words. */
export function nameSimilar(a: string, b: string): boolean {
  const A = coreTokens(a), B = coreTokens(b);
  if (!A.length || !B.length) return false;
  const ja = A.join(' '), jb = B.join(' ');
  if (ja === jb || ja.includes(jb) || jb.includes(ja)) return true;
  const sb = new Set(B);
  const inter = A.filter((w) => sb.has(w)).length;
  return inter / Math.min(A.length, B.length) >= 0.5 && inter >= 1;
}

// ------------------------------------------------------------------ mentions in text

/** a sentence counts as a flood report when it carries one of these */
export const FLOOD_RE =
  /\b(flood(?:ed|ing|s)?|water-?logg(?:ed|ing)|waterlogg(?:ed|ing)|water logg(?:ed|ing)|inundat(?:ed|ion)|submerged|knee-deep|waist-deep|ankle-deep|under water|underwater|marooned|overflow(?:ed|ing)?|rain ?water entered|water entered)\b/i;

const TYPE_ALT =
  'Underpass|Under Pass|Subway|RUB|Junction|Jn|Jct|Circle|Signal|Chowk|Layout|Colony|Apartments?|Enclave|Block|Stage|Phase|Sector|Extension|Flyover|Bridge|Bus Stand|Bus Station|Metro Station|Railway Station|Tech Park|Business Park|Main Road|Road|Rd|Main|Street|Highway|Cross|Avenue|Lane';
// 1-5 capitalised or numeric words, then a type word: "Silk Board junction", "80 Feet Road", "HSR Layout 6th Sector"
const WORD = "(?:[A-Z][A-Za-z'’.-]*|\\d+(?:st|nd|rd|th)?|[A-Z]{2,})";
// the type word may be lower case ("KR Circle underpass"); no regex modifiers, so each word gets [Xx]
const TYPE_ANY = TYPE_ALT.replace(/\b([A-Z])(?=[a-z])/g, (c) => `[${c}${c.toLowerCase()}]`);
const MENTION_RE = new RegExp(`\\b((?:${WORD}\\s+){1,5}(?:${TYPE_ANY}))\\b`, 'g');

export interface Mention {
  /** the place phrase as written, e.g. "Silk Board junction" */
  phrase: string;
  kind: SpotKind;
  /** the flood word that made the sentence count */
  flood: string;
  /** the sentence (kept in the local cache for the spot-check only, never published) */
  sentence: string;
}

export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“‘])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && s.length < 600);
}

/** Specific places named in flood sentences. Case matters: place names are capitalised. */
export function extractMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  for (const s of sentences(text)) {
    const fm = FLOOD_RE.exec(s);
    if (!fm) continue;
    MENTION_RE.lastIndex = 0;
    for (let m = MENTION_RE.exec(s); m; m = MENTION_RE.exec(s)) {
      // drop a leading sentence word that is only capitalised because it starts the sentence
      let phrase = m[1].replace(/^(The|A|An|At|In|On|Near|Along|From|To|Of|And|Or|Several|Many|Some|Low-lying|Areas?|Roads?|Residents?|Parts?|While|Even|Also|But|Both|Including|Like|Such|As|With|By|Via|Under|Over)\s+/i, '');
      phrase = phrase.replace(/^(The|A|An)\s+/i, '').trim();
      const kind = kindOf(phrase);
      if (!kind || !isSpecific(phrase)) continue;
      const key = normName(phrase);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ phrase, kind, flood: fm[1].toLowerCase(), sentence: s });
    }
  }
  return out;
}

/** Our own words for a report, at most 15: what was reported, where. Never quotes the article. */
export function summarize(name: string, kind: SpotKind, flood: string, sentence: string): string {
  const f = flood.toLowerCase();
  const rain = /\brain|downpour|shower|cloudburst/i.test(sentence) ? ' after heavy rain' : '';
  const stuck = /\b(stranded|stalled|stuck|traffic (jam|snarl)|pile-?up|gridlock|crawl)/i.test(sentence) ? '; traffic slowed or stranded' : '';
  let what: string;
  if (/knee|waist|ankle/.test(f)) what = `${cap(f.replace(/-deep/, '-deep water'))} reported at ${name}`;
  else if (/water-?logg|waterlogg|water logg/.test(f)) what = `Waterlogging reported at ${name}`;
  else if (/submerged|under ?water|inundat|marooned/.test(f)) what = `${name} reported under water`;
  else if (/entered/.test(f)) what = `Rainwater reported entering homes at ${name}`;
  else if (/overflow/.test(f)) what = `Overflowing water reported at ${name}`;
  else what = `Flooding reported at ${name}`;
  const words = `${what}${rain}${stuck}.`.split(/\s+/);
  void kind;
  return words.length <= 15 ? words.join(' ') : `${what}.`.split(/\s+/).slice(0, 15).join(' ');
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ geocode filtering

export interface GeoHit {
  coord: LngLat;
  /** what the gazetteer / geocoder says the place is */
  kind?: SpotKind;
  /** roads: total length of the named way(s), metres */
  lengthM?: number;
  /** how far apart same-named objects lie (a name used in several places), metres */
  spreadM?: number;
}

/** longest road we still treat as one spot */
export const MAX_ROAD_M = 3000;
/** same-named objects further apart than this make a name ambiguous */
export const MAX_SPREAD_M = 1500;

/** Keep a geocoded mention only when it lands in Bengaluru Urban on one specific object. */
export function acceptHit(name: string, hit: GeoHit | null | undefined): boolean {
  if (!hit || !inBBox(hit.coord) || !isSpecific(name)) return false;
  if ((hit.spreadM ?? 0) > MAX_SPREAD_M) return false;
  const kind = kindOf(name);
  if (kind === 'road' && !(hit.lengthM !== undefined && hit.lengthM <= MAX_ROAD_M)) return false;
  return true;
}

// ------------------------------------------------------------------ de-duplication

export interface GeoMention {
  name: string;
  kind: SpotKind;
  coord: LngLat;
  report: NewsReport;
}

/** Reported flood days: sorted distinct dates, a date within `gapDays` of the previous one is the same event. */
export function eventCount(dates: string[], gapDays = 2): number {
  const days = [...new Set(dates.map((d) => d.slice(0, 10)))].map((d) => Date.parse(d)).filter(Number.isFinite).sort((a, b) => a - b);
  let n = 0, last = -Infinity;
  for (const t of days) {
    if (t - last > gapDays * 864e5) n++;
    last = t;
  }
  return n;
}

const KIND_RANK: Record<SpotKind, number> = { underpass: 5, junction: 4, other: 3, road: 2, layout: 1 };

/**
 * Merge mentions of one place: within `radiusM` and with similar names (or the same normalised
 * name anywhere within 2 x radius). The spot takes the most-used name, its kind, and the mean
 * position of the mentions that use that name. Reports are unique by URL.
 */
export function dedupeSpots(mentions: GeoMention[], radiusM = 150): NewsSpot[] {
  interface Cluster { ms: GeoMention[]; c: LngLat }
  const clusters: Cluster[] = [];
  const order = [...mentions].sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind] || a.name.localeCompare(b.name));
  for (const m of order) {
    let best: Cluster | null = null, bestD = Infinity;
    for (const c of clusters) {
      const d = metres(c.c, m.coord);
      const same = c.ms.some((x) => normName(x.name) === normName(m.name));
      if ((d <= radiusM && c.ms.some((x) => nameSimilar(x.name, m.name))) || (same && d <= 2 * radiusM)) {
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
    if (best) {
      best.ms.push(m);
      const k = best.ms.length;
      best.c = [best.c[0] + (m.coord[0] - best.c[0]) / k, best.c[1] + (m.coord[1] - best.c[1]) / k];
    } else clusters.push({ ms: [m], c: m.coord });
  }
  const spots: NewsSpot[] = clusters.map((c) => {
    const byName = new Map<string, GeoMention[]>();
    for (const m of c.ms) {
      const k = normName(m.name);
      byName.set(k, [...(byName.get(k) ?? []), m]);
    }
    const top = [...byName.values()].sort((a, b) => b.length - a.length || KIND_RANK[b[0].kind] - KIND_RANK[a[0].kind])[0];
    const coord: LngLat = [
      Math.round((top.reduce((s, m) => s + m.coord[0], 0) / top.length) * 1e5) / 1e5,
      Math.round((top.reduce((s, m) => s + m.coord[1], 0) / top.length) * 1e5) / 1e5,
    ];
    const byUrl = new Map<string, NewsReport>();
    for (const m of c.ms) if (!byUrl.has(m.report.url)) byUrl.set(m.report.url, m.report);
    const reports = [...byUrl.values()].sort((a, b) => b.date.localeCompare(a.date));
    const years = reports.map((r) => Number(r.date.slice(0, 4))).filter(Number.isFinite);
    const name = displayName(top[0].name);
    return {
      id: `${normName(name).replace(/ /g, '-')}-${coord[0].toFixed(3)}-${coord[1].toFixed(3)}`,
      name,
      coord,
      kind: top[0].kind,
      reports,
      count: eventCount(reports.map((r) => r.date)),
      firstYear: Math.min(...years),
      lastYear: Math.max(...years),
    };
  });
  return spots.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Title-case a phrase but keep acronyms ("HSR", "BTM") and ordinals ("6th"). */
export function displayName(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (/^[A-Z0-9]{2,}$/.test(w) || /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ')
    .replace(/\b(Jn|Jct)\b\.?/g, 'Junction')
    .replace(/\bRd\b\.?/g, 'Road');
}
