import type { ImpactReport, OsmKind, OsmProps, Severity, SimSnapshot, Terrain } from './types.ts';

/** Depth thresholds (m) from CONTRACT.md */
export const THRESHOLDS = {
  twoWheeler: 0.15,
  car: 0.3,
  bus: 0.5,
  groundFloor: 0.25,
  severe: 0.6,
  facility: 0.05,
  pedestrian: 0.15,
} as const;

const SEV_RANK: Record<Severity, number> = { none: 0, low: 1, moderate: 2, high: 3, severe: 4 };
const RANK_SEV: Severity[] = ['none', 'low', 'moderate', 'high', 'severe'];

export function maxSeverity(...s: Severity[]): Severity {
  return RANK_SEV[Math.max(0, ...s.map((x) => SEV_RANK[x]))];
}

/** Severity of a water depth at a point (m). */
export function depthSeverity(d: number): Severity {
  if (d < THRESHOLDS.facility) return 'none';
  if (d < THRESHOLDS.twoWheeler) return 'low';
  if (d < THRESHOLDS.car) return 'moderate';
  if (d < THRESHOLDS.severe) return 'high';
  return 'severe';
}

/** severity from a count using ascending cut-offs [low, moderate, high, severe] */
function countSeverity(n: number, cuts: [number, number, number, number]): Severity {
  if (n >= cuts[3]) return 'severe';
  if (n >= cuts[2]) return 'high';
  if (n >= cuts[1]) return 'moderate';
  if (n >= cuts[0]) return 'low';
  return 'none';
}

const FACILITY_KINDS: OsmKind[] = ['school', 'hospital', 'clinic', 'metro', 'police', 'fire_station', 'substation', 'market'];

const KIND_LABEL: Partial<Record<OsmKind, string>> = {
  school: 'School',
  hospital: 'Hospital',
  clinic: 'Clinic',
  metro: 'Metro station',
  police: 'Police station',
  fire_station: 'Fire station',
  substation: 'Substation',
  market: 'Market',
  bus_stop: 'Bus stop',
};

const cm = (m: number) => `${Math.round(m * 100)} cm`;
const km = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function listNames(names: string[], max = 3): string {
  const u = [...new Set(names.filter(Boolean))];
  if (!u.length) return '';
  const head = u.slice(0, max).join(', ');
  return u.length > max ? `${head} and ${u.length - max} more` : head;
}

/**
 * Daily-life impact of one simulated hour.
 * Roads: max depth over their sampled `cells`; buildings and point facilities: max depth over the
 * 3x3 block around `cell` (water at the gate / doorstep — the DEM is a smoothed surface model, so
 * the building footprint itself often reads dry).
 */
export function computeImpact(terrain: Terrain, osm: GeoJSON.FeatureCollection, snap: SimSnapshot): ImpactReport {
  const { width: W, height: H, cellSizeM } = terrain.meta;
  const depth = snap.depth;
  const inside = terrain.grids.boundaryMask as Uint8Array | undefined;
  const isIn = (c: number) => c >= 0 && c < depth.length && (!inside || inside[c] === 1);
  const at = (c: number) => (c >= 0 && c < depth.length ? depth[c] : 0);
  const around = (c: number) => {
    if (c < 0 || c >= depth.length) return 0;
    const r0 = Math.floor(c / W), c0 = c % W;
    let m = 0;
    for (let r = Math.max(0, r0 - 1); r <= Math.min(H - 1, r0 + 1); r++)
      for (let cc = Math.max(0, c0 - 1); cc <= Math.min(W - 1, c0 + 1); cc++) {
        const d = depth[r * W + cc];
        if (d > m) m = d;
      }
    return m;
  };

  // ---------------------------------------------------------------- roads
  let totalKm = 0, carKm = 0, bikeKm = 0, busKm = 0;
  const roadWorst = new Map<string, number>();
  const majorCut: { name: string; d: number }[] = [];
  let busStopsCut = 0;
  const busStopNames: string[] = [];
  let buildingsTotal = 0, gfWet = 0, bSevere = 0;
  const facilities: ImpactReport['facilities'] = [];
  // standing water area (> 5 cm) for mosquito / health cards
  let standingCells = 0;
  for (let i = 0; i < depth.length; i++) if (depth[i] > 0.05 && isIn(i)) standingCells++;
  const standingM2 = standingCells * cellSizeM * cellSizeM;

  for (const f of osm.features) {
    const p = f.properties as OsmProps | null;
    if (!p) continue;
    if (p.kind === 'road') {
      const cells = p.cells?.length ? p.cells : [p.cell];
      if (!cells.some(isIn)) continue;
      const lenKm = (p.lengthM ?? cells.length * cellSizeM) / 1000;
      totalKm += lenKm;
      let mx = 0, nBike = 0, nCar = 0, nBus = 0;
      for (const c of cells) {
        const d = at(c);
        if (d > mx) mx = d;
        if (d > THRESHOLDS.twoWheeler) nBike++;
        if (d > THRESHOLDS.car) nCar++;
        if (d > THRESHOLDS.bus) nBus++;
      }
      const k = lenKm / cells.length;
      bikeKm += nBike * k;
      carKm += nCar * k;
      busKm += nBus * k;
      if (mx > 0.1) {
        const name = p.name || '';
        if (name) roadWorst.set(name, Math.max(roadWorst.get(name) ?? 0, mx));
        if (nCar && name && /^(motorway|trunk|primary|secondary)/.test(p.highway ?? '')) majorCut.push({ name, d: mx });
      }
    } else if (p.kind === 'building') {
      if (!isIn(p.cell)) continue;
      buildingsTotal++;
      const d = around(p.cell);
      if (d > THRESHOLDS.groundFloor) gfWet++;
      if (d > THRESHOLDS.severe) bSevere++;
    } else if (p.kind === 'bus_stop') {
      if (!isIn(p.cell)) continue;
      const d = around(p.cell);
      if (d > THRESHOLDS.pedestrian) {
        busStopsCut++;
        if (p.name) busStopNames.push(p.name);
      }
    } else if (FACILITY_KINDS.includes(p.kind)) {
      if (!isIn(p.cell)) continue;
      const d = around(p.cell);
      if (d > THRESHOLDS.facility) {
        facilities.push({
          id: p.id,
          kind: p.kind,
          name: p.name || `${KIND_LABEL[p.kind] ?? p.kind} (unnamed)`,
          depthM: Math.round(d * 100) / 100,
          severity: depthSeverity(d),
        });
      }
    }
  }
  facilities.sort((a, b) => b.depthM - a.depthM);
  const worst = [...roadWorst.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, d]) => ({ name, depthM: Math.round(d * 100) / 100 }));

  // ---------------------------------------------------------------- daily-life cards
  type Card = ImpactReport['dailyLife'][number] & { prio: number };
  const cards: Card[] = [];
  const fac = (k: OsmKind) => facilities.filter((x) => x.kind === k);
  const worstNames = listNames(worst.map((w) => w.name));
  const floodedAreaKm2 = snap.floodedAreaM2 / 1e6;

  // Health access
  const hosp = [...fac('hospital'), ...fac('clinic')];
  if (hosp.length) {
    const deep = hosp.filter((h) => h.depthM > THRESHOLDS.car);
    cards.push({
      icon: 'health',
      title: deep.length ? `${plural(deep.length, 'hospital/clinic', 'hospitals/clinics')} hard to reach by car` : 'Water outside hospitals and clinics',
      detail: `${listNames(hosp.map((h) => `${h.name} (${cm(h.depthM)})`), 2)}. Ambulances may need to detour; patients on foot will wade.`,
      severity: maxSeverity(...hosp.map((h) => h.severity)),
      prio: 10,
    });
  }

  // Homes
  if (gfWet > 0) {
    cards.push({
      icon: 'home',
      title: `Ground floors wet in ${plural(gfWet, 'building')}`,
      detail:
        `Water above plinth height (${cm(THRESHOLDS.groundFloor)}) at ${gfWet} of ${buildingsTotal} mapped buildings` +
        (bSevere ? `, over ${cm(THRESHOLDS.severe)} at ${bSevere}` : '') +
        '. Expect damaged furniture and appliances, flooded basements and sumps; move valuables and vehicles to higher ground.',
      severity: maxSeverity(countSeverity(gfWet, [1, 20, 150, 600]), bSevere >= 50 ? 'severe' : 'none'),
      prio: 9,
    });
  }

  // Two-wheelers
  if (bikeKm >= 0.05) {
    cards.push({
      icon: 'bike',
      title: `Two-wheelers stall on ${km(bikeKm)} km of roads`,
      detail: `Water deeper than ${cm(THRESHOLDS.twoWheeler)} floods scooter and motorcycle exhausts${worstNames ? `, worst on ${worstNames}` : ''}. Expect breakdowns and riders pushing vehicles.`,
      severity: countSeverity(bikeKm, [0.05, 0.5, 2, 6]),
      prio: 8,
    });
  }

  // Cars
  if (carKm >= 0.05) {
    cards.push({
      icon: 'car',
      title: `Cars blocked on ${km(carKm)} km of roads`,
      detail:
        `Over ${cm(THRESHOLDS.car)} of water — engines can ingest water and stall.` +
        (majorCut.length ? ` Main roads affected: ${listNames(majorCut.sort((a, b) => b.d - a.d).map((m) => m.name))}; expect diversions and jams.` : ''),
      severity: countSeverity(carKm, [0.05, 0.3, 1.5, 4]),
      prio: 7,
    });
  }

  // Buses
  if (busStopsCut > 0 || busKm >= 0.1) {
    cards.push({
      icon: 'bus',
      title: busStopsCut ? `${plural(busStopsCut, 'bus stop')} cut off` : 'Bus routes disrupted',
      detail:
        (busStopsCut ? `Water over ankle depth around ${listNames(busStopNames) || 'stops'}; BMTC buses likely to skip or divert. ` : '') +
        (busKm >= 0.1 ? `${km(busKm)} km of road deeper than ${cm(THRESHOLDS.bus)} — even buses turn back.` : ''),
      severity: maxSeverity(countSeverity(busStopsCut, [1, 3, 8, 20]), countSeverity(busKm, [0.1, 0.5, 2, 5])),
      prio: 6,
    });
  }

  // Schools
  const schools = fac('school');
  if (schools.length) {
    const deep = schools.filter((s) => s.depthM > THRESHOLDS.twoWheeler);
    cards.push({
      icon: 'school',
      title: `School commute disrupted at ${plural(schools.length, 'school')}`,
      detail:
        `${deep.length ? `${deep.length} with water over ${cm(THRESHOLDS.twoWheeler)} at the gate` : 'Shallow water at the gate'}: ${listNames(schools.map((s) => `${s.name} (${cm(s.depthM)})`), 3)}. ` +
        'Children walking or riding pillion are most at risk; schools may declare a holiday.',
      severity: maxSeverity(countSeverity(deep.length, [1, 2, 5, 10]), schools.length ? 'low' : 'none'),
      prio: 7.5,
    });
  }

  // Power
  const subs = fac('substation').filter((x) => x.depthM > THRESHOLDS.twoWheeler);
  if (subs.length || gfWet >= 20) {
    cards.push({
      icon: 'power',
      title: subs.length ? `Power: ${plural(subs.length, 'substation')} in water` : 'Power cuts likely in flooded blocks',
      detail:
        (subs.length ? `${listNames(subs.map((s) => `${s.name} (${cm(s.depthM)})`), 2)}. ` : '') +
        'BESCOM may switch off supply to flooded streets to prevent electrocution; borewell pumps and lifts stop, so expect water-supply and mobile-charging problems too.',
      severity: maxSeverity(subs.length ? maxSeverity(...subs.map((s) => s.severity)) : 'none', countSeverity(gfWet, [20, 100, 400, 1000])),
      prio: 8.5,
    });
  }

  // Metro
  const metro = fac('metro');
  if (metro.length) {
    cards.push({
      icon: 'metro',
      title: `Water at ${plural(metro.length, 'metro station')}`,
      detail: `${listNames(metro.map((m) => `${m.name} (${cm(m.depthM)})`))}. Trains may run but station access and feeder autos/buses will be hit.`,
      severity: maxSeverity(...metro.map((m) => m.severity)),
      prio: 5,
    });
  }

  // Emergency services
  const emerg = [...fac('fire_station'), ...fac('police')];
  if (emerg.length) {
    cards.push({
      icon: 'emergency',
      title: 'Emergency services slowed',
      detail: `${listNames(emerg.map((m) => `${m.name} (${cm(m.depthM)})`))}: water outside — response times rise when it is needed most.`,
      severity: maxSeverity(...emerg.map((m) => m.severity)),
      prio: 6.5,
    });
  }

  // Markets
  const mk = fac('market');
  if (mk.length) {
    cards.push({
      icon: 'market',
      title: `${plural(mk.length, 'market')} waterlogged`,
      detail: `${listNames(mk.map((m) => m.name))}. Vegetable and daily-wage vendors lose a day's trade; prices for perishables tick up.`,
      severity: maxSeverity(...mk.map((m) => m.severity)),
      prio: 4,
    });
  }

  // Sewage / drinking water
  if (gfWet >= 5 || floodedAreaKm2 >= 0.05) {
    cards.push({
      icon: 'sewage',
      title: 'Sewage mixing with floodwater',
      detail:
        'Stormwater drains here also carry sewage; overflowing water can contaminate underground sumps and borewells. Boil or treat drinking water, and disinfect sumps after the water recedes.',
      severity: countSeverity(floodedAreaKm2, [0.05, 0.2, 0.6, 1.5]),
      prio: 5.5,
    });
  }

  // Mosquitoes
  if (standingM2 >= 2000) {
    cards.push({
      icon: 'mosquito',
      title: 'Standing water: mosquito breeding risk',
      detail: `About ${(standingM2 / 10000).toFixed(1)} ha of standing water deeper than 5 cm. Ponds lasting more than a week can breed Aedes and Anopheles mosquitoes (dengue, malaria) — clear stagnant water around homes.`,
      severity: countSeverity(standingM2, [2000, 20000, 100000, Infinity]),
      prio: 3,
    });
  }

  cards.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.prio - a.prio);
  const dailyLife: ImpactReport['dailyLife'] = cards
    .filter((c) => c.severity !== 'none')
    .map(({ icon, title, detail, severity }) => ({ icon, title, detail, severity }));

  const overall = maxSeverity(
    countSeverity(floodedAreaKm2, [0.02, 0.15, 0.5, 1.5]),
    countSeverity(carKm, [0.1, 0.5, 2, 5]),
    countSeverity(gfWet, [5, 50, 250, 800]),
    ...facilities.filter((f) => f.kind === 'hospital' || f.kind === 'substation').map((f) => f.severity),
  );

  if (!dailyLife.length) {
    dailyLife.push({
      icon: 'rain',
      title: 'No significant disruption',
      detail: 'Drains and soil absorb this rain; expect only puddles at the usual low spots.',
      severity: 'none',
    });
  }

  return {
    floodedAreaKm2: Math.round(floodedAreaKm2 * 1000) / 1000,
    roads: {
      totalKm: Math.round(totalKm * 10) / 10,
      impassableCarKm: Math.round(carKm * 100) / 100,
      impassableTwoWheelerKm: Math.round(bikeKm * 100) / 100,
      worst,
    },
    buildings: { total: buildingsTotal, groundFloorWet: gfWet, severe: bSevere },
    facilities,
    busStopsCut,
    dailyLife,
    overall,
  };
}
