import {wrap, distance, bearing, buildGraph, sequentialTarget} from './navigation.js';

const $ = id => document.getElementById(id);
let data, stations, byId, graph, viewer, map, marker, cone, surveyLayer;
let current = null, pending = null, busy = false, failed = null, serial = 0;
let lastAzimuth = null, lastFov = null, noticeTimer, loadStarted, preloadTimer = null;
const preloads = new Map();

const quality = () => $('quality') ? $('quality').value : '4096';

function panoUrl(station) {
  return data.imageTemplate.replace('{file}', encodeURIComponent(station.file)).replace('{width}', quality());
}

function notify(message, duration = 0) {
  clearTimeout(noticeTimer);
  const n = $('notice');
  if (!n) return;
  n.textContent = message;
  n.hidden = !message;
  if (duration) noticeTimer = setTimeout(() => { n.hidden = true; }, duration);
}

function controls() {
  const i = current ? stations.indexOf(current) : -1;
  const backBtn = $('back'), fwdBtn = $('forward'), qSelect = $('quality');
  if (backBtn) backBtn.disabled = busy || i < 0 || !sequentialTarget(stations, graph, i, -1);
  if (fwdBtn) fwdBtn.disabled = busy || i < 0 || !sequentialTarget(stations, graph, i, 1);
  if (qSelect) qSelect.disabled = busy;
  document.body.classList.toggle('loading', busy);
}

function preload(station) {
  if (!station) return Promise.resolve();
  const url = panoUrl(station);
  if (preloads.has(url)) return preloads.get(url);

  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      reject(Error('Image request timed out'));
    }, 15000);
    img.onload = () => {
      clearTimeout(timer);
      resolve(url);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(Error('Image unavailable'));
    };
    img.src = url;
  });

  preloads.set(url, promise);
  promise.catch(() => preloads.delete(url));
  // Keep memory bounded to 8 preloaded items
  while (preloads.size > 8) {
    preloads.delete(preloads.keys().next().value);
  }
  return promise;
}

function schedulePreload(stationId) {
  clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    const links = graph.get(stationId) || [];
    for (const id of links) {
      const target = byId.get(id);
      if (target) preload(target).catch(() => {});
    }
  }, 300);
}

function pruneScenes(currentId) {
  if (!viewer) return;
  try {
    const neighbors = new Set(graph.get(currentId) || []);
    neighbors.add(currentId);
    const cfg = viewer.getConfig();
    const scenes = cfg && cfg.scenes ? cfg.scenes : {};
    for (const id of Object.keys(scenes)) {
      if (!neighbors.has(id)) {
        viewer.removeScene(id);
      }
    }
  } catch (err) {
    // Graceful fallback if removeScene unsupported
  }
}

function hotspots(station) {
  return (graph.get(station.id) || []).map(id => {
    const target = byId.get(id);
    if (!target) return null;
    const d = distance(station, target);
    const label = target.seq === station.seq + 1 ? 'Walk forward' : target.seq === station.seq - 1 ? 'Walk back' : 'Follow trail branch';
    return {
      id: `walk-${id}`,
      yaw: wrap(bearing(station, target) - station.heading),
      pitch: -Math.atan2(data.cameraHeight || 1.95, Math.max(2, d)) * 180 / Math.PI,
      cssClass: 'ground-arrow',
      createTooltipFunc: div => {
        div.innerHTML = '<svg viewBox="0 0 72 44" aria-hidden="true"><path d="M8 32 L36 12 L64 32"/></svg>';
        const tip = document.createElement('span');
        tip.textContent = label;
        div.append(tip);
        div.tabIndex = 0;
        div.setAttribute('role', 'button');
        div.setAttribute('aria-label', label);
        div.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            go(target);
          }
        });
      },
      clickHandlerFunc: () => go(target)
    };
  }).filter(Boolean);
}

function scene(station) {
  return {
    type: 'equirectangular',
    panorama: panoUrl(station),
    northOffset: station.heading,
    ignoreGPanoXMP: true,
    hotSpots: hotspots(station)
  };
}

function syncMap() {
  if (!viewer || !current || busy || !viewer.isLoaded()) return;
  const az = wrap(current.heading + viewer.getYaw()), fov = viewer.getHfov();
  if (lastAzimuth !== null && Math.abs(wrap(az - lastAzimuth)) < 0.3 && Math.abs(fov - lastFov) < 0.3) return;
  lastAzimuth = az;
  lastFov = fov;

  const r = Math.PI / 180, radius = 45, points = [[current.lat, current.lon]];
  for (let i = 0; i <= 12; i++) {
    const a = (az - fov / 2 + fov * i / 12) * r;
    points.push([
      current.lat + radius * Math.cos(a) / 111320,
      current.lon + radius * Math.sin(a) / (111320 * Math.cos(current.lat * r))
    ]);
  }
  if (cone) cone.setLatLngs(points);
}

function finish() {
  if (!pending) return;
  current = pending;
  pending = null;
  busy = false;
  failed = null;
  if ($('retry')) $('retry').hidden = true;

  const panoEl = $('panorama');
  if (panoEl) {
    panoEl.dataset.station = current.id;
    panoEl.dataset.transitionMs = String(Math.round(performance.now() - loadStarted));
  }

  if (marker) marker.setLatLng([current.lat, current.lon]);
  if (map && marker && !map.getBounds().pad(-0.15).contains(marker.getLatLng())) {
    map.panTo(marker.getLatLng(), {animate: true});
  }

  lastAzimuth = null;
  syncMap();
  controls();

  if ($('image-info')) {
    $('image-info').textContent = `${current.id} · ${current.lat.toFixed(6)}, ${current.lon.toFixed(6)} · ${current.date.slice(0, 10)}`;
  }

  const url = new URL(location.href);
  url.searchParams.set('station', current.id);
  url.hash = '';
  for (const key of ['yaw', 'pitch', 'fov']) url.searchParams.delete(key);
  history.replaceState(null, '', url);

  if ($('share-url')) $('share-url').value = shareUrl();

  const links = graph.get(current.id) || [];
  notify(links.length < 2 ? 'End of this recorded section. Use the map to explore another section.' : '', links.length < 2 ? 6500 : 0);

  // Free WebGL GPU textures from previously visited scenes to prevent VRAM memory leak and stalls
  pruneScenes(current.id);

  // Debounced background preloading for adjacent views
  schedulePreload(current.id);
}

function fail(error) {
  console.error(error);
  busy = false;
  failed = pending;
  pending = null;
  controls();
  if ($('retry')) $('retry').hidden = false;
  notify('This view could not load. Try again or choose another map point.');
}

async function go(target, {initial = false, reset = false, view = null} = {}) {
  if (!target || busy) return;
  busy = true;
  pending = target;
  controls();
  if ($('retry')) $('retry').hidden = true;

  const token = ++serial;
  loadStarted = performance.now();
  const loadingTimer = setTimeout(() => notify('Opening view…'), 250);

  try {
    await preload(target);
    if (token !== serial) return;
    clearTimeout(loadingTimer);

    const index = stations.indexOf(target);
    const next = sequentialTarget(stations, graph, index, 1);
    const previous = sequentialTarget(stations, graph, index, -1);
    const openingDirection = target.id === data.initialView.station_id
      ? target.heading + wrap(data.initialView.hlookat_deg)
      : next ? bearing(target, next) : previous ? bearing(previous, target) : target.heading;

    const world = current && viewer && !reset ? current.heading + viewer.getYaw() : openingDirection;
    const pitch = view?.pitch ?? (current && viewer && !reset ? viewer.getPitch() : data.initialView.vlookat_deg || 0);
    const yaw = view?.yaw ?? wrap(world - target.heading);
    const hfov = view?.hfov ?? (current && viewer && !reset ? viewer.getHfov() : innerWidth < 600 ? 75 : 105);

    if (!viewer) {
      viewer = pannellum.viewer('panorama', {
        default: {
          firstScene: target.id,
          autoLoad: true,
          showControls: false,
          compass: false,
          sceneFadeDuration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,
          minHfov: 45,
          maxHfov: 120,
          minPitch: -90,
          maxPitch: 70,
          friction: 0.16,
          capturedKeyNumbers: [37, 39, 187, 189],
          backgroundColor: [0.06, 0.09, 0.16]
        },
        scenes: {[target.id]: {...scene(target), pitch, yaw, hfov}}
      });
      viewer.on('load', finish);
      viewer.on('error', fail);
    } else {
      viewer.addScene(target.id, scene(target));
      viewer.loadScene(target.id, pitch, yaw, hfov);
    }
  } catch (error) {
    clearTimeout(loadingTimer);
    fail(error);
  }
}

function step(direction) {
  if (!current || busy) return;
  go(sequentialTarget(stations, graph, stations.indexOf(current), direction));
}

function initMap() {
  map = L.map('map', {zoomControl: false, attributionControl: true}).setView([data.initialView.lat, data.initialView.lon], 17);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 19,
    maxZoom: 21,
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  }).addTo(map);

  L.control.zoom({position: 'bottomright'}).addTo(map);

  // Original high-contrast map symbology on satellite imagery
  L.geoJSON(data.tourLines, {
    interactive: false,
    style: {color: '#f0d69c', weight: 3, opacity: 0.9}
  }).addTo(map);

  surveyLayer = L.geoJSON(data.surveyedTrails, {
    interactive: false,
    style: {color: '#f5a75b', weight: 3, dashArray: '6 6'}
  });

  const renderer = L.canvas({padding: 0.5});
  stations.forEach(s => L.circleMarker([s.lat, s.lon], {
    renderer,
    radius: 4,
    color: '#ffffff',
    weight: 1,
    fillColor: '#4c91a2',
    fillOpacity: 1
  }).bindTooltip('Explore here').on('click', () => go(s)).addTo(map));

  cone = L.polygon([], {color: '#f0c56f', weight: 1, fillOpacity: 0.35, interactive: false}).addTo(map);
  marker = L.circleMarker([data.initialView.lat, data.initialView.lon], {
    interactive: false,
    radius: 7,
    color: '#ffffff',
    weight: 2,
    fillColor: '#f0b958',
    fillOpacity: 1
  }).addTo(map);
}

function shareUrl() {
  let base = location.href;
  if (data?.shareBaseUrl) {
    base = data.shareBaseUrl;
  } else if (window.self !== window.top && document.referrer && /^https?:\/\//i.test(document.referrer)) {
    base = document.referrer;
  }
  const url = new URL(base);
  if (current) url.searchParams.set('station', current.id);
  if (viewer && viewer.isLoaded()) {
    url.searchParams.set('yaw', viewer.getYaw().toFixed(2));
    url.searchParams.set('pitch', viewer.getPitch().toFixed(2));
    url.searchParams.set('fov', viewer.getHfov().toFixed(2));
  }
  return url.href;
}

function settings(open) {
  const panel = $('settings');
  if (!panel) return;
  panel.hidden = !open;
  if ($('options')) $('options').setAttribute('aria-expanded', String(open));
  if (open) {
    if ($('share-url')) $('share-url').value = shareUrl();
    if ($('close-settings')) $('close-settings').focus();
  } else {
    if ($('options')) $('options').focus();
  }
}

function bind() {
  if ($('back')) $('back').onclick = () => step(-1);
  if ($('forward')) $('forward').onclick = () => step(1);
  if ($('home')) $('home').onclick = () => go(byId.get(data.initialView.station_id) || stations[0], {reset: true});
  if ($('retry')) $('retry').onclick = () => go(failed || current || stations[0]);
  if ($('quality')) $('quality').onchange = () => { preloads.clear(); go(current); };
  if ($('options')) $('options').onclick = () => settings($('settings') ? $('settings').hidden : true);
  if ($('close-settings')) $('close-settings').onclick = () => settings(false);
  if ($('survey')) $('survey').onchange = e => e.target.checked ? surveyLayer.addTo(map) : map.removeLayer(surveyLayer);

  const zoomFullTrail = () => {
    if (map && stations.length) {
      map.fitBounds(L.latLngBounds(stations.map(s => [s.lat, s.lon])), {padding: [18, 18]});
    }
  };
  if ($('overview')) $('overview').onclick = zoomFullTrail;

  const toggleMapAction = () => {
    const panel = $('map-panel');
    if (!panel) return;
    const collapsed = panel.classList.toggle('collapsed');
    if ($('toggle-map')) {
      $('toggle-map').textContent = collapsed ? '+' : '−';
      $('toggle-map').setAttribute('aria-label', collapsed ? 'Show map' : 'Hide map');
      $('toggle-map').setAttribute('aria-expanded', String(!collapsed));
    }
    setTimeout(() => map && map.invalidateSize(), 250);
  };

  if ($('toggle-map')) $('toggle-map').onclick = toggleMapAction;

  if ($('expand-map')) {
    $('expand-map').onclick = () => {
      const panel = $('map-panel');
      if (!panel) return;
      const expanded = panel.classList.toggle('expanded');
      $('expand-map').setAttribute('aria-expanded', String(expanded));
      $('expand-map').setAttribute('aria-label', expanded ? 'Shrink map' : 'Expand map');
      setTimeout(() => map && map.invalidateSize(), 250);
    };
  }

  if ($('fullscreen')) {
    $('fullscreen').onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        notify('Full screen is unavailable in this browser.', 4000);
      }
    };
  }

  if ($('share-url')) $('share-url').onclick = () => $('share-url').select();
  if ($('share')) {
    $('share').onclick = async () => {
      if (!current || busy) return;
      const url = shareUrl();
      try {
        await navigator.clipboard.writeText(url);
        notify('Link to this view copied to clipboard.', 3000);
      } catch {
        settings(true);
        if ($('share-fallback')) $('share-fallback').hidden = false;
        if ($('share-url')) {
          $('share-url').value = url;
          $('share-url').focus();
          $('share-url').select();
        }
      }
    };
  }

  addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('settings') && !$('settings').hidden) {
      settings(false);
      return;
    }
    if (e.target.closest('input,select,textarea,button,[role="button"],summary') || ($('settings') && !$('settings').hidden)) return;
    if (['w', 'W', 'ArrowUp', 's', 'S', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      step(['w', 'W', 'ArrowUp'].includes(e.key) ? 1 : -1);
    }
  });

  const mapPanel = $('map-panel');
  if (mapPanel) {
    new ResizeObserver(() => {
      map?.invalidateSize();
      viewer?.resize();
    }).observe(mapPanel);
  }

  setInterval(syncMap, 80);
}

async function boot() {
  const response = await fetch('data/walkthrough.json?v=' + Date.now());
  if (!response.ok) throw Error('Catalog unavailable');
  data = await response.json();
  stations = data.stations;
  byId = new Map(stations.map(s => [s.id, s]));
  graph = buildGraph(stations, data.reviewedLinks);

  initMap();
  bind();

  const params = new URLSearchParams(location.search);
  const requested = params.get('station');
  const target = byId.get(requested) || byId.get(data.initialView.station_id) || stations[0];
  const finite = (name, fallback, min, max) =>
    params.has(name) && Number.isFinite(Number(params.get(name)))
      ? Math.max(min, Math.min(max, Number(params.get(name))))
      : fallback;
  const view = params.has('yaw')
    ? {yaw: finite('yaw', 0, -180, 180), pitch: finite('pitch', 0, -90, 70), hfov: finite('fov', 105, 45, 120)}
    : null;

  await go(target, {initial: true, view});
}

boot().catch(error => {
  console.error(error);
  notify('The walkthrough could not start. Please refresh.');
});
