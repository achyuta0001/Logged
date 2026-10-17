// Colour ramps shared by the map overlays and the UI legends.

type RGBA = [number, number, number, number];

/** Water depth ramp (CONTRACT): 0.02–0.1 pale cyan, 0.1–0.3 cyan, 0.3–0.6 blue, 0.6–1.0 deep blue, >1 violet. */
export const DEPTH_STOPS: { d: number; c: RGBA }[] = [
  { d: 0.02, c: [170, 240, 255, 0.0] },
  { d: 0.05, c: [170, 240, 255, 0.42] },
  { d: 0.1, c: [110, 228, 255, 0.6] },
  { d: 0.3, c: [30, 200, 255, 0.74] },
  { d: 0.6, c: [40, 120, 255, 0.84] },
  { d: 1.0, c: [40, 70, 230, 0.9] },
  { d: 1.6, c: [120, 90, 255, 0.93] },
];

export const DEPTH_LEGEND = [
  { label: '2–10 cm', color: 'rgb(170,240,255)' },
  { label: '10–30 cm', color: 'rgb(30,200,255)' },
  { label: '30–60 cm', color: 'rgb(40,115,255)' },
  { label: '0.6–1 m', color: 'rgb(36,58,215)' },
  { label: '> 1 m', color: 'rgb(120,90,255)' },
];

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function rampAt(stops: { d: number; c: RGBA }[], v: number): RGBA {
  if (v <= stops[0].d) return stops[0].c;
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i].d) {
      const a = stops[i - 1];
      const b = stops[i];
      const t = (v - a.d) / (b.d - a.d);
      return [lerp(a.c[0], b.c[0], t), lerp(a.c[1], b.c[1], t), lerp(a.c[2], b.c[2], t), lerp(a.c[3], b.c[3], t)];
    }
  }
  return stops[stops.length - 1].c;
}

/** 512-entry LUT covering depth 0..2.0 m, packed RGBA bytes (alpha 0..255). */
export const DEPTH_LUT_MAX = 2.0;
export const DEPTH_LUT = (() => {
  const n = 512;
  const lut = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const d = (i / (n - 1)) * DEPTH_LUT_MAX;
    const c = d < 0.02 ? ([0, 0, 0, 0] as RGBA) : rampAt(DEPTH_STOPS, d);
    lut[i * 4] = c[0];
    lut[i * 4 + 1] = c[1];
    lut[i * 4 + 2] = c[2];
    lut[i * 4 + 3] = c[3] * 255;
  }
  return lut;
})();

/** Depression (ponding potential) ramp — magenta/orchid, distinct from water. */
export const DEPRESSION_STOPS: { d: number; c: RGBA }[] = [
  { d: 0.05, c: [255, 120, 230, 0] },
  { d: 0.2, c: [255, 120, 230, 0.28] },
  { d: 0.6, c: [236, 90, 255, 0.5] },
  { d: 1.5, c: [190, 70, 255, 0.68] },
  { d: 3.0, c: [140, 60, 255, 0.8] },
];
export function depressionRGBA(d: number): RGBA {
  return d < 0.05 ? [0, 0, 0, 0] : rampAt(DEPRESSION_STOPS, d);
}

/** UI status colours (pills, cards, the header answer): Apple dark system colours. */
export const SEVERITY_COLOR: Record<string, string> = {
  none: '#8e8e93',
  low: '#64d2ff',
  moderate: '#ffd60a',
  high: '#ff9f0a',
  severe: '#ff453a',
};

export const SEVERITY_LABEL: Record<string, string> = {
  none: 'Dry',
  low: 'Minor',
  moderate: 'Moderate',
  high: 'High',
  severe: 'Severe',
};
