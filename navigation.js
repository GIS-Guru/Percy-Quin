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

// Group only connected captures with exactly the same recorded position. Keep
// every photograph available; do not invent bearings for zero-length steps.
export function buildNavigation(stations, reviewedLinks = []) {
  const raw = buildGraph(stations, reviewedLinks);
  const byId = new Map(stations.map(s => [s.id, s]));
  const groups = new Map(), stops = [];
  for (const station of stations) {
    if (groups.has(station.id)) continue;
    const members = [], queue = [station.id];
    groups.set(station.id, members);
    while (queue.length) {
      const id = queue.pop();
      members.push(byId.get(id));
      for (const next of raw.get(id)) {
        const b = byId.get(next);
        if (!groups.has(next) && b.lat === station.lat && b.lon === station.lon) {
          groups.set(next, members); queue.push(next);
        }
      }
    }
    members.sort((a,b) => a.seq-b.seq);
    stops.push(members[0]);
  }
  const graph = new Map();
  for (const station of stations) {
    const members = groups.get(station.id), targets = new Set();
    for (const member of members) for (const id of raw.get(member.id)) {
      if (groups.get(id) !== members) targets.add(groups.get(id)[0].id);
    }
    graph.set(station.id, [...targets]);
  }
  const sectionById = new Map(), sections = [];
  for (const stop of stops) {
    if (sectionById.has(stop.id)) continue;
    const section = {number: sections.length+1, stops: []}, queue = [stop.id];
    sectionById.set(stop.id, section);
    while (queue.length) {
      const id = queue.pop();
      section.stops.push(byId.get(id));
      for (const member of groups.get(id)) sectionById.set(member.id, section);
      for (const next of graph.get(id)) if (!sectionById.has(next)) {
        sectionById.set(next, section); queue.push(next);
      }
    }
    sections.push(section);
  }
  const features = [];
  for (const a of stops) for (const id of graph.get(a.id)) if (a.id < id) {
    const b = byId.get(id);
    features.push({type:'Feature', properties:{from:a.id,to:id},
      geometry:{type:'LineString',coordinates:[[a.lon,a.lat],[b.lon,b.lat]]}});
  }
  return {graph, groups, stops, sections, sectionById,
    lines:{type:'FeatureCollection',features}};
}

export function facingTarget(station, graph, byId, azimuth) {
  const candidates = (graph.get(station.id) || []).map(id => byId.get(id))
    .map(target => ({target, angle:Math.abs(wrap(bearing(station,target)-azimuth))}))
    .filter(c => c.angle <= 65).sort((a,b) => a.angle-b.angle);
  // At a fork with similar bearings, require an explicit ground-arrow choice.
  if (!candidates.length || (candidates[1] && candidates[1].angle-candidates[0].angle < 20)) return null;
  return candidates[0].target;
}
