// Pack JSON over HTTP. Format-2 packs store their big JSON gzip-compressed as `<file>.gz`
// (scripts/lib/pack-files.mjs): GitHub Pages serves a .gz as it is, with no Content-Encoding, and the
// site (app + 117 packs) has to stay under Pages' 1 GB limit. The browser inflates it with its own
// DecompressionStream. The plain file stays the fallback: packs built before the .gz layout and the
// dev server's sample packs keep loading.

/** pack files a format-2 pack stores as `<name>.gz` (scripts/lib/pack-files.mjs writes them) */
export const GZ_FILES: readonly string[] = ['osm.geojson', 'depressions.json'];

export type FetchFn = (url: string) => Promise<Response>;

/** not the file: an HTTP error, or the dev server's SPA fallback page (index.html for any unknown path) */
const missing = (r: Response) => !r.ok || (r.headers.get('content-type') ?? '').includes('text/html');

/** gzip magic (RFC 1952). A host that does send Content-Encoding: gzip hands over the inflated bytes, so sniff, don't trust the name. */
const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Parse a JSON response body that may be gzip-compressed. */
export async function parseJsonBody<T>(r: Response): Promise<T> {
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (!isGzip(bytes)) return JSON.parse(new TextDecoder().decode(bytes)) as T;
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot inflate gzip (no DecompressionStream)');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return (await new Response(stream).json()) as T;
}

/** an error's message; a failed inflate is a TypeError with an empty message and the reason in `cause` */
const why = (e: unknown): string => (e instanceof Error ? e.message || (e.cause !== undefined ? why(e.cause) : e.name) : String(e));

/**
 * Fetch one JSON file of a pack. With `gz`, `<url>.gz` is tried first; the plain `url` is the fallback
 * when the .gz is missing, cannot be fetched or does not inflate. Throws when neither loads.
 */
export async function fetchPackJson<T>(url: string, opts: { gz?: boolean; fetch?: FetchFn } = {}): Promise<T> {
  const get = opts.fetch ?? ((u: string) => fetch(u));
  let gzErr = '';
  if (opts.gz) {
    try {
      const r = await get(`${url}.gz`);
      if (!missing(r)) return await parseJsonBody<T>(r);
    } catch (e) {
      gzErr = why(e);
    }
  }
  const r = await get(url);
  if (missing(r)) throw new Error(`${url}: ${r.ok ? 'missing' : `HTTP ${r.status}`}${gzErr ? ` (and ${url}.gz: ${gzErr})` : ''}`);
  return await parseJsonBody<T>(r);
}
