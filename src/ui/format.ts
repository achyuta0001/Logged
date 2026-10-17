const TZ = 'Asia/Kolkata';

export const fmtHour = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
export const fmtDay = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
export const fmtDayShort = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: TZ });
export const istHour = (t: number) => Number(new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }).slice(0, 2)) % 24;

export function fmtDepth(m: number): string {
  if (!(m >= 0.02)) return 'dry';
  if (m < 1) return `${Math.round(m * 100)} cm`;
  return `${m.toFixed(2)} m`;
}
export function fmtNum(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString('en-IN');
  return v.toFixed(digits);
}
export function fmtArea(m2: number): string {
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`;
  if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(1)} ha`;
  return `${Math.round(m2).toLocaleString('en-IN')} m²`;
}
export function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export function relHours(h: number, now: number | undefined): string {
  if (now === undefined) return `hour ${h}`;
  const d = h - now;
  if (d === 0) return 'now';
  return d > 0 ? `in ${d} h` : `${-d} h ago`;
}
