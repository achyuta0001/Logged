// Turn rules for the city router (./router.ts), compiled from the graph's turn restrictions (OSM
// type=restriction relations; format in ./format.ts, resolved by scripts/route/build-graph.mjs).
//
// The search is edge-based: a state is an arc, "arrived at its head along it", and a turn is a step
// from one arc to the next. Every turn is allowed except a U-turn (back along the edge arrived by,
// allowed only where nothing else leads on: a dead end) and those a restriction rules out. A
// restriction is an arc sequence: from, via ways (if any), to. no_* forbids driving it; only_* forbids
// every other way on from (from, via ...) and allows its own, even when that is a U-turn. A via-node
// restriction is two arcs long and only changes what its from arc may turn into. A via-way one must
// remember more than the last arc: each proper prefix of 2+ arcs becomes an extra state (a copy of its
// last arc), as in an Aho-Corasick automaton. After a turn the search is in the longest suffix of the
// arcs driven so far that is such a prefix, else simply in the new arc. Extra states have their arc's
// head, edge and weight, so the landmark bounds hold for them as they do for arcs.
import type { RawGraph } from './format.ts';

/** The router's forward arcs: out arcs of node u are outOff[u] .. outOff[u+1] (see Router). */
export interface Arcs {
  outOff: Int32Array;
  outHead: Int32Array;
  outEdge: Int32Array;
  /** 1 = the arc drives its edge u -> v */
  outAlong: Uint8Array;
  /** arc of edge e driven u -> v (arcFwd) or v -> u (arcBwd), -1 where that way is closed */
  arcFwd: Int32Array;
  arcBwd: Int32Array;
}

export interface TurnRules {
  /** restrictions in force (one naming an arc the graph lacks, or arcs that do not join, is ignored) */
  count: number;
  /** extra states, numbered after the arcs (arcs + k): the arc each one copies */
  extraArc: Int32Array;
  /** per state (arcs, then extra states): its row of rules, -1 = none (any turn but a U-turn) */
  row: Int32Array;
  /** row k has one entry per out arc j of the state's head node u, rule[rowOff[k] + j - outOff[u]]:
   *  -1 = forbidden, else the state after the turn * 2, + 1 when allowed even as a U-turn */
  rowOff: Int32Array;
  rule: Int32Array;
}

export function compileTurns(g: RawGraph, a: Arcs): TurnRules {
  const A = a.outHead.length;
  const tail = (j: number) => (a.outAlong[j] ? g.eU[a.outEdge[j]] : g.eV[a.outEdge[j]]);
  const key = (arcs: number[]) => arcs.join(',');
  const banned = new Set<string>(), allowed = new Set<string>();
  /** proper prefixes of 2+ arcs -> their extra state */
  const prefix = new Map<string, number>();
  const extra: number[][] = [];
  /** arcs some restriction starts with */
  const first = new Set<number>();
  const note = (p: number[]) => {
    first.add(p[0]);
    for (let k = 2; k < p.length; k++) {
      const q = p.slice(0, k);
      if (prefix.has(key(q))) continue;
      prefix.set(key(q), A + extra.length);
      extra.push(q);
    }
  };
  let count = 0;
  for (let r = 0; r < g.turnOnly.length; r++) {
    const p: number[] = [];
    for (let k = g.turnOff[r]; k < g.turnOff[r + 1]; k++) {
      const c = g.turnArc[k], e = Math.floor(c / 2);
      p.push(e < g.header.m ? (c % 2 ? a.arcBwd : a.arcFwd)[e] : -1);
    }
    if (p.length < 2 || p.some((j, k) => j < 0 || (k > 0 && tail(j) !== a.outHead[p[k - 1]]))) continue;
    count++;
    note(p);
    if (!g.turnOnly[r]) {
      banned.add(key(p));
      continue;
    }
    allowed.add(key(p));
    const pre = p.slice(0, -1), u = a.outHead[pre[pre.length - 1]];
    for (let j = a.outOff[u]; j < a.outOff[u + 1]; j++) if (j !== p[p.length - 1]) banned.add(key([...pre, j]));
  }

  // a row for every state a restriction can apply to: the arcs one starts with, and the extra states
  const seqs: [number, number[]][] = [...first].map((j) => [j, [j]]);
  extra.forEach((q, k) => seqs.push([A + k, q]));
  const row = new Int32Array(A + extra.length).fill(-1);
  const rowOff = [0], rule: number[] = [];
  for (const [x, seq] of seqs) {
    row[x] = rowOff.length - 1;
    const u = a.outHead[seq[seq.length - 1]];
    for (let j = a.outOff[u]; j < a.outOff[u + 1]; j++) {
      // the suffixes of seq + j, longest first: every restriction ending in one applies, and the
      // longest one a restriction goes on from is the state after the turn
      const full = [...seq, j];
      let ban = false, ok = false, next = -1;
      for (let i = 0; i + 1 < full.length; i++) {
        const k = key(full.slice(i));
        if (banned.has(k)) ban = true;
        if (allowed.has(k)) ok = true;
        if (next < 0) next = prefix.get(k) ?? -1;
      }
      rule.push(ban ? -1 : (next < 0 ? j : next) * 2 + (ok ? 1 : 0));
    }
    rowOff.push(rule.length);
  }
  return {
    count,
    extraArc: Int32Array.from(extra, (q) => q[q.length - 1]),
    row,
    rowOff: Int32Array.from(rowOff),
    rule: Int32Array.from(rule),
  };
}
