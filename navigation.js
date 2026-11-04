export const wrap = angle => ((angle + 180) % 360 + 360) % 360 - 180;
export function distance(a, b) {
  const r = Math.PI / 180, p = (b.lat - a.lat) * r, q = (b.lon - a.lon) * r;
  return 12742017.6 * Math.asin(Math.min(1, Math.sqrt(Math.sin(p/2)**2 + Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(q/2)**2)));
}
export function bearing(a, b) {
  const r = Math.PI / 180, d = (b.lon-a.lon)*r;
  return wrap(Math.atan2(Math.sin(d)*Math.cos(b.lat*r), Math.cos(a.lat*r)*Math.sin(b.lat*r)-Math.sin(a.lat*r)*Math.cos(b.lat*r)*Math.cos(d))/r);
}
// Conservative capture-order links. Cross-route branches require an explicitly reviewed link.
export function buildGraph(stations, reviewedLinks = []) {
  const graph = new Map(stations.map(s => [s.id, []]));
  const byId = new Map(stations.map(s => [s.id, s]));
  const connect = (a,b) => {
    if (!graph.get(a).includes(b)) graph.get(a).push(b);
    if (!graph.get(b).includes(a)) graph.get(b).push(a);
  };
  for (let i=1;i<stations.length;i++) {
    const a=stations[i-1], b=stations[i];
    if (a.segmentId === b.segmentId && b.seq === a.seq+1 && distance(a,b) <= 40) connect(a.id,b.id);
  }
  for (const link of reviewedLinks) {
    if (link.verified !== true) continue;
    if (!byId.has(link.from) || !byId.has(link.to) || link.from === link.to) throw Error('Invalid reviewed connection');
    connect(link.from,link.to);
  }
  return graph;
}
export function sequentialTarget(stations, graph, index, direction) {
  const next = stations[index + direction];
  return next && graph.get(stations[index].id).includes(next.id) ? next : null;
}
