// Tiny guarded localStorage wrapper. Storage can be missing or throw (private windows,
// blocked site data, previews), so every access falls back to the default silently.
const PREFIX = 'rrn560098:';

export function load<T>(key: string, fallback: T): T {
  try {
    const v = window.localStorage.getItem(PREFIX + key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the state just won't persist */
  }
}
