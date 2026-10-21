// Minimal 24px stroke icons, hand-drawn for this app. Rendered with currentColor.

const P: Record<string, string> = {
  school: '<path d="M3 9.5 12 5l9 4.5-9 4.5-9-4.5Z"/><path d="M7 11.5V16c0 1.2 2.2 2.5 5 2.5s5-1.3 5-2.5v-4.5"/><path d="M21 9.5V15"/>',
  hospital: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
  clinic: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/><path d="M12 10v4M10 12h4"/>',
  metro: '<rect x="6" y="3.5" width="12" height="13" rx="3"/><path d="M6 11h12M9.5 14h.01M14.5 14h.01M8.5 20.5l2-4M15.5 20.5l-2-4"/>',
  bus: '<rect x="5" y="4" width="14" height="13" rx="2.5"/><path d="M5 11h14M8.5 14.5h.01M15.5 14.5h.01M7.5 17v2.5M16.5 17v2.5"/>',
  bus_stop: '<rect x="6" y="4" width="12" height="13" rx="2.5"/><path d="M6 11h12M9 14h.01M15 14h.01M8 17v2.5M16 17v2.5"/>',
  police: '<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z"/><path d="m9.5 12 2 2 3.5-4"/>',
  fire_station: '<path d="M12 21c3.9 0 6.5-2.6 6.5-6.1 0-3.4-2.5-5.4-3.7-8.4-.9 1.8-1.9 2.6-3 3-.3-2.6-1.3-4.7-3.3-6.5.2 3.3-3 5.7-3 10.4C5.5 18.4 8.1 21 12 21Z"/>',
  fire: '<path d="M12 21c3.9 0 6.5-2.6 6.5-6.1 0-3.4-2.5-5.4-3.7-8.4-.9 1.8-1.9 2.6-3 3-.3-2.6-1.3-4.7-3.3-6.5.2 3.3-3 5.7-3 10.4C5.5 18.4 8.1 21 12 21Z"/>',
  substation: '<path d="M13 3 6 13h5l-1 8 7-10h-5l1-8Z"/>',
  power: '<path d="M13 3 6 13h5l-1 8 7-10h-5l1-8Z"/>',
  market: '<path d="M4 9.5 5.5 4h13L20 9.5"/><path d="M4 9.5c0 1.4 1.1 2.5 2.7 2.5s2.6-1.1 2.6-2.5c0 1.4 1.2 2.5 2.7 2.5s2.7-1.1 2.7-2.5c0 1.4 1.1 2.5 2.6 2.5S20 10.9 20 9.5"/><path d="M5.5 12v8h13v-8M10 20v-4h4v4"/>',
  worship: '<path d="M12 3v3M10.5 4.5h3"/><path d="M6 21v-8l6-5 6 5v8"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/>',
  park: '<path d="M12 21v-6"/><path d="M12 15c-3.6 0-6-2.1-6-5.2C6 6.4 8.7 3 12 3s6 3.4 6 6.8c0 3.1-2.4 5.2-6 5.2Z"/>',
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  building: '<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  road: '<path d="M8 3 5 21M16 3l3 18M12 4v3M12 10.5v3M12 17v3"/>',
  car: '<path d="M5 16.5v-4l1.8-4.7A2 2 0 0 1 8.7 6.5h6.6a2 2 0 0 1 1.9 1.3l1.8 4.7v4"/><path d="M4 12.5h16v4H4z"/><path d="M6.5 16.5v2M17.5 16.5v2M7.5 14.5h.01M16.5 14.5h.01"/>',
  bike: '<circle cx="6" cy="16" r="3"/><circle cx="18" cy="16" r="3"/><path d="M6 16h5l3-6h3M9 10h4M14 10l4 6"/>',
  two_wheeler: '<circle cx="6" cy="16" r="3"/><circle cx="18" cy="16" r="3"/><path d="M6 16h5l3-6h3M9 10h4M14 10l4 6"/>',
  water: '<path d="M12 3.5s6 6.4 6 10.6A6 6 0 0 1 6 14.1C6 9.9 12 3.5 12 3.5Z"/>',
  flood: '<path d="M3 15c1.5 0 1.5 1.5 3 1.5S7.5 15 9 15s1.5 1.5 3 1.5 1.5-1.5 3-1.5 1.5 1.5 3 1.5 1.5-1.5 3-1.5"/><path d="M3 19.5c1.5 0 1.5 1.5 3 1.5s1.5-1.5 3-1.5 1.5 1.5 3 1.5 1.5-1.5 3-1.5 1.5 1.5 3 1.5 1.5-1.5 3-1.5"/><path d="M6 12V7l6-4 6 4v5"/>',
  drain: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 5v14M12 5v14M16 5v14"/>',
  rain: '<path d="M7 15a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6 1.5A3.3 3.3 0 0 1 17 15"/><path d="m9 18-1 2.5M13 17l-1 2.5M17 18l-1 2.5"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  work: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V5.5h6v2M3.5 12.5h17"/>',
  office: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V5.5h6v2M3.5 12.5h17"/>',
  health: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  ambulance: '<path d="M3 16.5V8h11v8.5M14 11h4l3 3v2.5h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/><path d="M8.5 10.5v3M7 12h3"/>',
  trash: '<path d="M4.5 7h15M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  garbage: '<path d="M4.5 7h15M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  mosquito: '<circle cx="12" cy="13" r="2.5"/><path d="M12 10.5V8M9.5 13 5 9.5M14.5 13 19 9.5M10 15l-3 4M14 15l3 4M12 15.5V21"/>',
  disease: '<circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  wifi: '<path d="M5 10a10 10 0 0 1 14 0M8 13.5a5.5 5.5 0 0 1 8 0M12 17.5h.01"/>',
  food: '<path d="M5 3v7a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V3M7 12v9M16 21V3c-2 1-3 3.5-3 6.5V13h3"/>',
  groceries: '<path d="M4 6h2l2.2 10h9.6L20 9H7"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="16.5" cy="19.5" r="1.3"/>',
  elderly: '<circle cx="11" cy="4.5" r="2"/><path d="M11 7.5v6l-2.5 7M11 13.5l3 7M8 10l3-1 3 2.5M16.5 12v8.5"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5"/><circle cx="17" cy="9" r="2.3"/><path d="M15.5 14.8c2.8-.3 5 1.6 5 4.7"/>',
  basement: '<path d="M4 10 12 4l8 6"/><path d="M6 9v11h12V9"/><path d="M6 15c1.5 0 1.5 1 3 1s1.5-1 3-1 1.5 1 3 1 1.5-1 3-1"/>',
  tree: '<path d="M12 21v-6"/><path d="M12 15c-3.6 0-6-2.1-6-5.2C6 6.4 8.7 3 12 3s6 3.4 6 6.8c0 3.1-2.4 5.2-6 5.2Z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  play: '<path d="M7 4.5v15l12-7.5L7 4.5Z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  // layout chrome
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.4"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  book: '<path d="M4 5.5h5.5A2.5 2.5 0 0 1 12 8v12a2 2 0 0 0-2-2H4Z"/><path d="M20 5.5h-5.5A2.5 2.5 0 0 0 12 8v12a2 2 0 0 1 2-2h6Z"/>',
  news: '<path d="M6.5 19.5h11a2 2 0 0 0 2-2v-11a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v11a2 2 0 0 1-4 0V10h4"/><path d="M11.5 8.5h5M11.5 12h5M11.5 15.5h3"/>',
  focus: '<path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/>',
  panel_close: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15M16 10l-2 2 2 2"/>',
  panel_open: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15M14 10l2 2-2 2"/>',
  key: '<path d="M4 6h16M4 12h10M4 18h6"/>',
  updown: '<path d="m8 9.5 4-4 4 4M8 14.5l4 4 4-4"/>',
};

const ALIASES: Record<string, string> = {
  hospitals: 'hospital',
  schools: 'school',
  transit: 'bus',
  bus_stops: 'bus_stop',
  electricity: 'power',
  outage: 'power',
  homes: 'home',
  house: 'home',
  houses: 'home',
  roads: 'road',
  traffic: 'car',
  commute: 'car',
  vehicle: 'car',
  scooter: 'two_wheeler',
  motorcycle: 'two_wheeler',
  emergency: 'ambulance',
  medical: 'hospital',
  sewage: 'drain',
  sanitation: 'drain',
  water_supply: 'water',
  drinking_water: 'water',
  shop: 'market',
  shops: 'market',
  temple: 'worship',
  train: 'metro',
  rail: 'metro',
  waste: 'trash',
  dengue: 'mosquito',
  health_risk: 'disease',
  fire_station: 'fire_station',
};

export function iconSvg(name: string, size = 18, stroke = 1.6): string {
  const key = (name || '').toLowerCase().replace(/[\s-]+/g, '_');
  const body = P[key] ?? P[ALIASES[key] ?? ''] ?? matchLoose(key) ?? P.alert;
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function matchLoose(key: string): string | undefined {
  for (const k of Object.keys(P)) if (key.includes(k)) return P[k];
  for (const [a, k] of Object.entries(ALIASES)) if (key.includes(a)) return P[k];
  return undefined;
}

/** Build a raster marker image (for maplibre symbol layers) from an icon. */
export function markerImage(name: string, fg: string, bg: string, ring: string, px = 64): Promise<HTMLImageElement> {
  const inner = (P[name] ?? P.alert).replace(/currentColor/g, fg);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="14" fill="${bg}" stroke="${ring}" stroke-width="1.6"/>
    <g transform="translate(7 7) scale(0.75)" fill="none" stroke="${fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>
  </svg>`;
  return new Promise((res, rej) => {
    const img = new Image(px, px);
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}
