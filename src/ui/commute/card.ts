// The share card: the checked trip as a 1080 x 1080 PNG for WhatsApp and the like, in the app's dark
// Apple-style look, set in the self-hosted Inter (never the system font, so no SF Pro on Apple
// devices). Shared through the system share sheet where the browser can share files, else
// downloaded. The words come from src/ui/commute/lines.ts; this module only draws and hands over.
import type { RiskLevel, RouteCandidate } from '../../commute/types';
import { iconSvg } from '../icons';
import { LEVEL_COLOR, LEVEL_SHORT } from './levels';
import type { CardSpot } from './lines';

export const SITE = 'https://achyuta0001.github.io/Logged/';

export interface CardInfo {
  /** the two ends, e.g. ["Indiranagar", "Bellandur"] */
  trip: [string, string];
  /** "Thursday 22 Oct · leaving 08:30" */
  when: string;
  /** the one-line answer, "Leave by 08:15", and its colour */
  headline: string;
  tone: string;
  /** the best route: letter, "32 min · 14 km", roads, level (null: no forecast for the trip yet, no pill) and its reason line */
  route: { id: RouteCandidate['id']; time: string; via: string; level: RiskLevel | null; reason: string } | null;
  spots: CardSpot[];
  /** the line in place of the hotspots when none has water expected */
  none: string;
  /** "Checked 18:05, Wed 21 Oct" */
  checked: string;
  /** "commute-2026-10-22-0830.png" */
  file: string;
}

/** 'retry': the tap had expired by the time the picture was ready; 'cancelled': the share sheet was closed */
export type CardOutcome = 'shared' | 'saved' | 'cancelled' | 'retry' | 'failed';

type Ctx = CanvasRenderingContext2D;
const S = 1080;
const M = 64;
const W = S - 2 * M;
const FONT = "Inter, 'Helvetica Neue', Arial, sans-serif";
const L1 = '#ffffff';
const L2 = 'rgba(235, 235, 245, 0.7)';
const L3 = 'rgba(235, 235, 245, 0.5)';
const ACCENT = '#64d2ff';
/** grouped cards on black: Apple's secondary fill, with a hairline of glass edge */
const CARD = 'rgba(118, 118, 128, 0.2)';
const EDGE = 'rgba(255, 255, 255, 0.1)';

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
/** a level colour lifted toward white, as the panel's pills colour their text */
const light = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(v + (255 - v) * 0.28);
  return `rgb(${c(n >> 16)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
};
const font = (ctx: Ctx, size: number, weight = 400, track = 0) => {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.letterSpacing = `${track}px`;
};
/** the baseline that centres capitals in a line box of height lh from y */
const mid = (y: number, lh: number, size: number) => y + lh / 2 + size * 0.36;

/** s cut with "…" to fit max px */
function fit(ctx: Ctx, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const k = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${s.slice(0, k).trimEnd()}…`).width <= max) lo = k;
    else hi = k - 1;
  }
  return `${s.slice(0, lo).trimEnd()}…`;
}

/** s in at most n lines of max px (the first `indent` px shorter), the last cut with "…" */
function wrap(ctx: Ctx, s: string, max: number, n: number, indent = 0): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let start = 0;
  for (let i = 1; i < words.length; i++) {
    if (ctx.measureText(words.slice(start, i + 1).join(' ')).width <= max - (out.length ? 0 : indent)) continue;
    if (out.length === n - 1) break;
    out.push(fit(ctx, words.slice(start, i).join(' '), max - (out.length ? 0 : indent)));
    start = i;
  }
  out.push(fit(ctx, words.slice(start).join(' '), max - (out.length ? 0 : indent)));
  return out;
}

function box(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient, edge?: string) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (!edge) return;
  ctx.lineWidth = 2;
  ctx.strokeStyle = edge;
  ctx.stroke();
}

/** one of the app's own 24px stroke icons (src/ui/icons.ts), at (x, y) and `size` px */
function icon(ctx: Ctx, name: string, x: number, y: number, size: number, color: string, stroke = 2) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = stroke;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const m of iconSvg(name).matchAll(/<path d="([^"]+)"/g)) ctx.stroke(new Path2D(m[1]));
  ctx.restore();
}

function dot(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = r * 1.6;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** a caption in small capitals, "BEST ROUTE", after an icon when given */
function caption(ctx: Ctx, ico: string | null, text: string, x: number, y: number) {
  if (ico) icon(ctx, ico, x, y - 1, 30, L2, 2);
  font(ctx, 22, 600, 1.6);
  ctx.fillStyle = L2;
  ctx.fillText(text.toUpperCase(), x + (ico ? 42 : 0), mid(y, 28, 22));
}

/** a level pill like the panel's, its right edge at `right`, centred on cy; returns its width */
function pill(ctx: Ctx, l: RiskLevel, right: number, cy: number): number {
  font(ctx, 26, 600);
  const w = ctx.measureText(LEVEL_SHORT[l]).width + 40, h = 46;
  box(ctx, right - w, cy - h / 2, w, h, h / 2, rgba(LEVEL_COLOR[l], 0.18), rgba(LEVEL_COLOR[l], 0.5));
  ctx.fillStyle = light(LEVEL_COLOR[l]);
  ctx.textAlign = 'center';
  ctx.fillText(LEVEL_SHORT[l], right - w / 2, cy + 26 * 0.36);
  ctx.textAlign = 'left';
  return w;
}

/** "Indiranagar → Bellandur" on one line, smaller for long names, then the longer one cut; the arrow is drawn (the self-hosted Inter subset has no →) */
function tripLine(ctx: Ctx, [a, b]: [string, string], y: number) {
  let size = 52, gap = 0, arrow = 0, room = 0, wa = 0, wb = 0;
  for (; size >= 40; size -= 2) {
    font(ctx, size, 700, -1);
    gap = size * 0.32;
    arrow = size * 0.6;
    room = W - arrow - 2 * gap;
    wa = ctx.measureText(a).width;
    wb = ctx.measureText(b).width;
    if (wa + wb <= room) break;
  }
  size = Math.max(size, 40);
  if (wa + wb > room) {
    if (wa > room / 2 && wb > room / 2) [a, b] = [fit(ctx, a, room / 2), fit(ctx, b, room / 2)];
    else if (wa > wb) a = fit(ctx, a, room - wb);
    else b = fit(ctx, b, room - wa);
    wa = ctx.measureText(a).width;
  }
  const base = mid(y, 58, size);
  ctx.fillStyle = L1;
  ctx.fillText(a, M, base);
  const x0 = M + wa + gap, x1 = x0 + arrow, ay = base - size * 0.34, head = size * 0.2;
  ctx.save();
  ctx.strokeStyle = L2;
  ctx.lineWidth = size * 0.07;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, ay);
  ctx.lineTo(x1, ay);
  ctx.moveTo(x1 - head, ay - head);
  ctx.lineTo(x1, ay);
  ctx.lineTo(x1 - head, ay + head);
  ctx.stroke();
  ctx.restore();
  ctx.fillText(b, x1 + gap, base);
}

/** Inter draws the page only where the system has no SF, so it may not be loaded yet: load what the card uses */
async function fontsReady() {
  try {
    await Promise.all([400, 500, 600, 700].map((w) => document.fonts.load(`${w} 32px Inter`)));
  } catch {
    // the fallbacks in FONT draw it
  }
}

/** The card as a PNG. Top down: the trip, the advice, the best route; the footer sits at the bottom and the hotspots fill what is left (up to three). */
export async function drawCard(c: CardInfo): Promise<Blob> {
  await fontsReady();
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas');

  // black, with the advice's colour glowing in from the top and the accent at the foot
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  for (const [gx, gy, gr, gc] of [[S * 0.12, -S * 0.12, S * 1.05, rgba(c.tone, 0.3)], [S * 1.05, S * 1.08, S * 0.75, rgba(ACCENT, 0.13)]] as const) {
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    g.addColorStop(0, gc);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }

  // what this is, the trip and when
  let y = 56;
  caption(ctx, null, 'Commute prediction', M, y);
  y += 28 + 8;
  tripLine(ctx, c.trip, y);
  y += 58;
  font(ctx, 29, 500);
  ctx.fillStyle = L2;
  ctx.fillText(fit(ctx, c.when, W), M, mid(y, 38, 29));
  y += 38 + 26;

  // the advice, on a card in its colour: one line when it fits at a smaller size, else two
  {
    const pad = 28, tx = M + pad + 28 + 24, max = M + W - pad - tx;
    let size = 58;
    font(ctx, size, 700, -1.5);
    while (size > 46 && ctx.measureText(c.headline).width > max) font(ctx, (size -= 2), 700, -1.5);
    const lines = wrap(ctx, c.headline, max, 2), lh = Math.round(size * 1.14);
    const h = 2 * pad + lines.length * lh;
    box(ctx, M, y, W, h, 36, rgba(c.tone, 0.16), rgba(c.tone, 0.45));
    dot(ctx, M + pad + 14, y + pad + lh / 2, 13, c.tone);
    ctx.fillStyle = L1;
    lines.forEach((l, i) => ctx.fillText(l, tx, mid(y + pad + i * lh, lh, size)));
    y += h + 18;
  }

  // the footer, from the bottom up: the app's signature row, and above it the advisory
  const sign = S - 56 - 48;
  const ADV = 'Advisory only.';
  font(ctx, 24, 700);
  const aw = ctx.measureText(`${ADV} `).width;
  font(ctx, 24, 400);
  const fine = wrap(ctx, 'A prediction from the rain forecast (Open-Meteo.com), low ground and past flood reports, not measured on the road.', W, 2, aw);
  const foot = sign - 16 - fine.length * 30;

  // the best route and why
  if (c.route) {
    const r = c.route, pad = 28, badge = 60, tx = M + pad + badge + 22, right = M + W - pad;
    font(ctx, 28, 500);
    const why = wrap(ctx, r.reason, right - tx, 2);
    const h = 2 * pad + 28 + 14 + 50 + 36 + why.length * 36;
    box(ctx, M, y, W, h, 36, CARD, EDGE);
    caption(ctx, 'car', 'Best route', M + pad, y + pad);
    let ry = y + pad + 28 + 14;
    box(ctx, M + pad, ry + 2, badge, badge, 17, ACCENT);
    font(ctx, 32, 700);
    ctx.fillStyle = '#00202e';
    ctx.textAlign = 'center';
    ctx.fillText(r.id, M + pad + badge / 2, mid(ry + 2, badge, 32));
    ctx.textAlign = 'left';
    const pw = r.level ? pill(ctx, r.level, right, ry + 25) : 0;
    font(ctx, 40, 600, -0.8);
    ctx.fillStyle = L1;
    ctx.fillText(fit(ctx, r.time, right - pw - 20 - tx), tx, mid(ry, 50, 40));
    ry += 50;
    font(ctx, 28, 400);
    ctx.fillStyle = L2;
    ctx.fillText(fit(ctx, r.via, right - tx), tx, mid(ry, 36, 28));
    ry += 36;
    font(ctx, 28, 500);
    ctx.fillStyle = L1;
    why.forEach((l, i) => ctx.fillText(l, tx, mid(ry + i * 36, 36, 28)));
    y += h + 18;
  }

  // the hotspots, as many rows as fit above the footer
  {
    const pad = 26, cap = 28 + 10, row = 56, right = M + W - pad, nx = M + pad + 34;
    const room = Math.floor((foot - 22 - y - 2 * pad - cap) / row);
    const n = Math.min(Math.max(c.spots.length, 1), 3, room);
    if (n > 0) {
      box(ctx, M, y, W, 2 * pad + cap + n * row, 36, CARD, EDGE);
      caption(ctx, 'water', 'Hotspots', M + pad, y + pad);
      let ry = y + pad + cap;
      if (!c.spots.length) {
        font(ctx, 28, 400);
        ctx.fillStyle = L2;
        ctx.fillText(fit(ctx, c.none, W - 2 * pad), M + pad, mid(ry, row, 28));
      }
      c.spots.slice(0, n).forEach((s, i) => {
        if (i) {
          ctx.fillStyle = 'rgba(84, 84, 88, 0.6)';
          ctx.fillRect(nx, ry, right - nx, 1.5);
        }
        const base = mid(ry, row, 29);
        dot(ctx, M + pad + 10, ry + row / 2, 9, LEVEL_COLOR[s.level]);
        ctx.textAlign = 'right';
        font(ctx, 27, 500);
        ctx.fillStyle = L2;
        ctx.fillText(s.when, right, base);
        const ww = ctx.measureText(s.when).width;
        font(ctx, 27, 600);
        ctx.fillStyle = light(LEVEL_COLOR[s.level]);
        ctx.fillText(LEVEL_SHORT[s.level], right - ww - 11, base);
        const lw = ctx.measureText(LEVEL_SHORT[s.level]).width;
        ctx.textAlign = 'left';
        font(ctx, 29, 600, -0.3);
        ctx.fillStyle = L1;
        ctx.fillText(fit(ctx, s.name, right - ww - 11 - lw - 28 - nx), nx, base);
        ry += row;
      });
    }
  }

  // footer: the advisory, then the app's flood mark, name and address, and when this was checked
  font(ctx, 24, 700);
  ctx.fillStyle = L1;
  ctx.fillText(ADV, M, mid(foot, 30, 24));
  font(ctx, 24, 400);
  ctx.fillStyle = L2;
  fine.forEach((l, i) => ctx.fillText(l, M + (i ? 0 : aw), mid(foot + i * 30, 30, 24)));
  const tile = 48;
  const tg = ctx.createLinearGradient(M, sign, M + tile, sign + tile);
  tg.addColorStop(0, ACCENT);
  tg.addColorStop(1, '#0a84ff');
  box(ctx, M, sign, tile, tile, 13, tg);
  icon(ctx, 'flood', M + 9, sign + 9, 30, '#ffffff', 2);
  font(ctx, 24, 600, -0.2);
  ctx.fillStyle = L1;
  ctx.fillText('Bengaluru Flood Explorer', M + tile + 16, sign + 20);
  font(ctx, 24, 600);
  ctx.fillStyle = ACCENT;
  ctx.fillText(SITE.replace(/^https:\/\//, ''), M + tile + 16, sign + 46);
  font(ctx, 23, 400);
  ctx.fillStyle = L3;
  ctx.textAlign = 'right';
  ctx.fillText(c.checked, M + W, sign + 46);
  ctx.textAlign = 'left';

  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('the card could not be encoded'))), 'image/png'));
}

/**
 * Hands the card over: the system share sheet (WhatsApp, Messages, ...) where the browser can share
 * files, else a download. `fresh`: the PNG was drawn during this tap, which may have outlasted the
 * browser's window for a share; then 'retry' asks for another tap, which shares the ready card at once.
 */
export async function shareCard(png: Blob, c: CardInfo, fresh: boolean): Promise<CardOutcome> {
  const file = new File([png], c.file, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: `${c.trip[0]} to ${c.trip[1]}: ${c.headline}. Advisory only. ${SITE}` });
      return 'shared';
    } catch (err) {
      const name = (err as DOMException | null)?.name;
      if (name === 'AbortError') return 'cancelled';
      if (name === 'NotAllowedError' && fresh) return 'retry';
      // the share itself failed: save the picture instead
    }
  }
  const url = URL.createObjectURL(png);
  const a = Object.assign(document.createElement('a'), { href: url, download: c.file });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60e3);
  return 'saved';
}
