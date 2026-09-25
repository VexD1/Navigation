const $ = id => document.getElementById(id);
const CLIENT_ID = 'vexd1-navigation.github.io';
const ROUTER = 'https://valhalla1.openstreetmap.de';
const KM_PER_MILE = 1.609344;
const useMiles = /^en-(GB|US)/i.test(navigator.language);
let screen = 'setup';
let locationFix = null;
let watchId = null;
let destination = null;
let route = null;
let isDemo = false;
let demoTimer = null;
let routeController = null;
let searchController = null;
let lastSearchAt = 0;
let lastRerouteAt = 0;
let offRouteCount = 0;
let progress = 0;
let segmentIndex = 0;
let routeUncertain = false;
let rerouting = false;
let lastAnnounced = -1;
let mapCenters = new WeakMap();
let postcodeBuffer = '';
let pendingPostcode = null;

function showScreen(name) {
  screen = name;
  for (const id of ['setup', 'preview', 'guidance']) $(id).classList.toggle('hidden', id !== name);
}

function status(text) { $('setup-status').textContent = text; }
function normalizedPostcode(value) { return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7); }
function isUkPostcode(value) { return /^(?:GIR0AA|[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2})$/.test(value); }
function displayPostcode(value) { return isUkPostcode(value) ? `${value.slice(0, -3)} ${value.slice(-3)}` : value; }
function updatePostcodePad() {
  $('postcode-preview').textContent = postcodeBuffer ? displayPostcode(postcodeBuffer) : '_';
  $('postcode-hint').textContent = isUkPostcode(postcodeBuffer) ? 'Postcode ready. Select Find postcode.' : 'Pinch letters and numbers. The space is added for you.';
}
function closePostcodePad() {
  $('postcode-pad').classList.add('hidden');
  $('postcode-pad-button').focus();
}
for (const row of ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM', '1234567890']) {
  for (const character of row) {
    const key = document.createElement('button');
    key.type = 'button';
    key.textContent = character;
    key.setAttribute('aria-label', `Add ${character}`);
    key.addEventListener('click', () => {
      if (postcodeBuffer.length < 7) postcodeBuffer += character;
      updatePostcodePad();
    });
    $('postcode-keys').append(key);
  }
  for (let i = row.length; i < 10; i++) {
    const spacer = document.createElement('span');
    spacer.setAttribute('aria-hidden', 'true');
    $('postcode-keys').append(spacer);
  }
}
$('postcode-pad-button').addEventListener('click', () => {
  updatePostcodePad();
  $('postcode-pad').classList.remove('hidden');
  document.querySelector('#postcode-keys button').focus();
});
$('postcode-backspace').addEventListener('click', () => { postcodeBuffer = postcodeBuffer.slice(0, -1); updatePostcodePad(); });
$('postcode-clear').addEventListener('click', () => { postcodeBuffer = ''; updatePostcodePad(); document.querySelector('#postcode-keys button').focus(); });
$('postcode-cancel').addEventListener('click', closePostcodePad);
$('postcode-use').addEventListener('click', () => {
  if (!isUkPostcode(postcodeBuffer)) { $('postcode-hint').textContent = 'Enter a full UK postcode, for example SW1A 1AA.'; return; }
  const query = displayPostcode(postcodeBuffer);
  $('postcode-pad-button').textContent = `Postcode: ${query} · Edit`;
  closePostcodePad();
  $('search-results').replaceChildren();
  if (validFix(locationFix)) void findPostcode(query);
  else {
    pendingPostcode = query;
    status(`${query} saved. Select Use my location, then search will start.`);
  }
});
function validFix(fix) { return fix && Date.now() - fix.timestamp < 12000 && fix.accuracy <= 60; }
function coords(fix) { return [fix.lon, fix.lat]; }
function meters(a, b) {
  const lat = (a[1] + b[1]) * Math.PI / 360;
  const dx = (a[0] - b[0]) * 111320 * Math.cos(lat);
  const dy = (a[1] - b[1]) * 111320;
  return Math.hypot(dx, dy);
}
function formatDistance(m) {
  if (useMiles) return m < 320 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1609.344).toFixed(m < 16093 ? 1 : 0)} mi`;
  return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
function formatSpeed(ms) { return Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms * (useMiles ? 2.236936 : 3.6))} ${useMiles ? 'mph' : 'km/h'}` : '—'; }
function formatLimit(kph) { return Number.isFinite(kph) && kph > 0 && kph < 180 ? `${Math.round(kph / (useMiles ? KM_PER_MILE : 1))} ${useMiles ? 'mph' : 'km/h'}` : '—'; }
function formatEta(seconds) { return new Date(Date.now() + Math.max(0, seconds) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

function decodePolyline6(value) {
  const points = [];
  let index = 0, lat = 0, lon = 0;
  while (index < value.length) {
    const numbers = [];
    for (let n = 0; n < 2; n++) {
      let result = 0, shift = 0, byte;
      do {
        if (index >= value.length || shift > 35) throw new Error('Invalid route shape');
        byte = value.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      numbers.push((result & 1) ? ~(result >> 1) : result >> 1);
    }
    lat += numbers[0]; lon += numbers[1];
    points.push([lon / 1e6, lat / 1e6]);
  }
  return points;
}

function normalizeRoute(data) {
  const trip = data?.trip;
  const leg = trip?.legs?.[0];
  if (!trip || !leg || !Array.isArray(leg.maneuvers) || typeof leg.shape !== 'string') throw new Error('Route data unavailable');
  const points = decodePolyline6(leg.shape);
  if (points.length < 2 || !points.every(p => p.every(Number.isFinite))) throw new Error('Invalid route geometry');
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + meters(points[i - 1], points[i]));
  const maneuvers = leg.maneuvers.map(item => ({
    at: cumulative[Math.min(points.length - 1, Math.max(0, item.begin_shape_index || 0))],
    index: item.begin_shape_index || 0,
    instruction: String(item.instruction || 'Continue').slice(0, 180),
    street: String(item.street_names?.[0] || '').slice(0, 70),
    lanes: Array.isArray(item.lanes) ? item.lanes : [],
    type: item.type,
  }));
  return { points, cumulative, maneuvers, shape: leg.shape, distance: cumulative.at(-1), duration: Number(trip.summary?.time) || Number(leg.summary?.time) || 0, edges: [] };
}

function startWatching() {
  if (!navigator.geolocation) { status('Location is unavailable in this browser.'); return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  locationFix = null;
  status('Waiting for your phone’s location…');
  watchId = navigator.geolocation.watchPosition(position => {
    if (isDemo) return;
    const { latitude, longitude, accuracy, speed, heading } = position.coords;
    locationFix = { lat: latitude, lon: longitude, accuracy, speed, heading, timestamp: position.timestamp };
    if (screen === 'setup') {
      status(accuracy <= 60 ? `Location ready · accuracy about ${Math.round(accuracy)} m` : `Location found, but accuracy is only about ${Math.round(accuracy)} m. Wait for a clearer fix.`);
      if (pendingPostcode && validFix(locationFix)) {
        const query = pendingPostcode;
        pendingPostcode = null;
        void findPostcode(query);
      }
    }
    if (screen === 'guidance' && !isDemo) updateGuidance();
  }, error => {
    locationFix = null;
    const message = error.code === 1 ? 'Location permission denied. Enable location for this Web App.' : 'Location unavailable. Check your phone connection and try again.';
    if (screen === 'setup') status(message);
    else showUnavailable(message);
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 });
}

async function searchDestination(query) {
  if (searchController) searchController.abort();
  const controller = new AbortController();
  searchController = controller;
  const wait = Math.max(0, 1100 - (Date.now() - lastSearchAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  if (controller.signal.aborted || searchController !== controller) throw new DOMException('Search superseded', 'AbortError');
  lastSearchAt = Date.now();
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('addressdetails', '0');
  if (isUkPostcode(normalizedPostcode(query))) url.searchParams.set('countrycodes', 'gb');
  const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Place search unavailable');
  const results = await response.json();
  if (controller.signal.aborted || searchController !== controller) throw new DOMException('Search superseded', 'AbortError');
  return Array.isArray(results) ? results.filter(item => Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon))) : [];
}

async function requestRoute(target, reroute = false) {
  if (!validFix(locationFix)) throw new Error('Waiting for an accurate location');
  if (routeController) routeController.abort();
  const controller = new AbortController();
  routeController = controller;
  const body = { locations: [{ lat: locationFix.lat, lon: locationFix.lon }, { lat: target.lat, lon: target.lon }], costing: 'auto', units: 'kilometers', turn_lanes: true, directions_options: { language: 'en-US' } };
  const response = await fetch(`${ROUTER}/route`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(response.status === 429 ? 'Routing is busy. Try again in a minute.' : 'Route service unavailable');
  const next = normalizeRoute(await response.json());
  if (controller !== routeController) return;
  route = next;
  progress = 0;
  segmentIndex = 0;
  offRouteCount = 0;
  routeUncertain = false;
  if (reroute) updateGuidance();
  else showPreview();
  void loadSpeedLimits(next, controller);
}

async function loadSpeedLimits(targetRoute, controller) {
  try {
    const body = { encoded_polyline: targetRoute.shape, costing: 'auto', shape_match: 'edge_walk', units: 'kilometers', filters: { action: 'include', attributes: ['edge.speed_limit', 'edge.begin_shape_index', 'edge.end_shape_index'] } };
    const response = await fetch(`${ROUTER}/trace_attributes`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: JSON.stringify(body) });
    if (!response.ok) return;
    const data = await response.json();
    if (route === targetRoute && Array.isArray(data.edges)) {
      targetRoute.edges = data.edges.filter(edge => Number.isInteger(edge.begin_shape_index) && Number.isInteger(edge.end_shape_index));
      if (screen === 'guidance') updateGuidance();
    }
  } catch { /* Speed limits are optional. */ }
}

function showPreview() {
  showScreen('preview');
  $('preview-name').textContent = destination?.name || 'Destination';
  $('preview-summary').textContent = `${formatDistance(route.distance)} · about ${Math.max(1, Math.round(route.duration / 60))} min`;
  const middle = route.points[Math.floor(route.points.length / 2)];
  const zoom = fitZoom(route.points, 536, 270);
  renderMap($('preview-map'), middle, zoom, route.points, coords(locationFix));
}

function projectWorld(point, zoom) {
  const sin = Math.sin(point[1] * Math.PI / 180);
  const scale = 256 * 2 ** zoom;
  return [scale * (point[0] + 180) / 360, scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI))];
}
function fitZoom(points, width, height) {
  for (let zoom = 16; zoom >= 4; zoom--) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of points) {
      const [x, y] = projectWorld(point, zoom);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (maxX - minX < width - 80 && maxY - minY < height - 65) return zoom;
  }
  return 4;
}
function routeBearing(a, b) {
  const lat1 = a[1] * Math.PI / 180, lat2 = b[1] * Math.PI / 180;
  const delta = (b[0] - a[0]) * Math.PI / 180;
  const x = Math.sin(delta) * Math.cos(lat2);
  const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(delta);
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}
function cameraAheadOf(marker, zoom, heading, height) {
  const [px, py] = projectWorld(marker, zoom);
  const radians = heading * Math.PI / 180;
  const offset = height / 2 - 59;
  const x = px + Math.sin(radians) * offset;
  const y = py - Math.cos(radians) * offset;
  const scale = 256 * 2 ** zoom;
  return [x / scale * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI];
}
function renderMap(element, center, zoom, points, marker, heading = null, turn = null) {
  const width = element.clientWidth || 536, height = element.clientHeight || 220;
  const base = element.querySelector('.basemap');
  let state = mapCenters.get(element);
  if (!state || state.zoom !== zoom) {
    base.replaceChildren();
    state = { zoom, tiles: new Map() };
    mapCenters.set(element, state);
  }
  const [cx, cy] = projectWorld(center, zoom);
  const tileZoom = Math.floor(zoom);
  const tileSpan = 256 * 2 ** (zoom - tileZoom);
  const radius = Math.hypot(width, height) / 2;
  const leftTile = Math.floor((cx - radius) / tileSpan), topTile = Math.floor((cy - radius) / tileSpan);
  const rightTile = Math.floor((cx + radius) / tileSpan), bottomTile = Math.floor((cy + radius) / tileSpan);
  const maxTile = 2 ** tileZoom;
  const needed = new Set();
  for (let x = leftTile; x <= rightTile; x++) for (let y = topTile; y <= bottomTile; y++) {
    if (y < 0 || y >= maxTile) continue;
    const key = `${x}/${y}`;
    needed.add(key);
    let image = state.tiles.get(key);
    if (!image) {
      image = document.createElement('img');
      image.className = 'tile';
      image.alt = '';
      image.decoding = 'async';
      image.src = `https://tile.openstreetmap.org/${tileZoom}/${((x % maxTile) + maxTile) % maxTile}/${y}.png`;
      base.append(image);
      state.tiles.set(key, image);
    }
    image.style.left = `${x * tileSpan - cx + width / 2}px`;
    image.style.top = `${y * tileSpan - cy + height / 2}px`;
    image.style.width = `${tileSpan + 1}px`;
    image.style.height = `${tileSpan + 1}px`;
  }
  for (const [key, image] of state.tiles) if (!needed.has(key)) { image.remove(); state.tiles.delete(key); }
  const local = point => { const p = projectWorld(point, zoom); return [p[0] - cx + width / 2, p[1] - cy + height / 2]; };
  const svg = element.querySelector('svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const rotation = Number.isFinite(heading) ? `rotate(${-heading}deg)` : 'none';
  element.querySelector('.basemap').style.transform = rotation;
  svg.style.transform = rotation;
  const path = points.map((p, i) => { const [x, y] = local(p); return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(' ');
  for (const selector of ['.route-halo', '.route-line']) element.querySelector(selector).setAttribute('d', path);
  const [mx, my] = local(marker);
  const dot = element.querySelector('.position-dot');
  dot.setAttribute('cx', mx); dot.setAttribute('cy', my);
  const arrow = element.querySelector('.position-arrow');
  arrow.setAttribute('transform', `translate(${mx} ${my}) rotate(${Number.isFinite(heading) ? heading : 0})`);
  arrow.style.display = Number.isFinite(heading) ? '' : 'none';
  const turnDot = element.querySelector('.maneuver-dot');
  if (turn) {
    const [tx, ty] = local(turn);
    turnDot.setAttribute('cx', tx); turnDot.setAttribute('cy', ty);
    turnDot.style.display = '';
  } else turnDot.style.display = 'none';
}

function nearestRoutePoint(fix) {
  const here = coords(fix);
  let best = null;
  const previous = progress;
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = route.points[i], b = route.points[i + 1];
    const lat = here[1] * Math.PI / 180;
    const scaleX = 111320 * Math.cos(lat), scaleY = 111320;
    const vx = (b[0] - a[0]) * scaleX, vy = (b[1] - a[1]) * scaleY;
    const wx = (here[0] - a[0]) * scaleX, wy = (here[1] - a[1]) * scaleY;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / Math.max(1, vx * vx + vy * vy)));
    const lateral = Math.hypot(wx - t * vx, wy - t * vy);
    const along = route.cumulative[i] + t * (route.cumulative[i + 1] - route.cumulative[i]);
    const jump = Math.max(0, Math.abs(along - previous) - 250);
    const score = lateral + jump * 0.15;
    if (!best || score < best.score) best = { score, lateral, along, segment: i, point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
  }
  return best;
}

function turnSymbol(instruction) {
  const s = instruction.toLowerCase();
  if (/u-turn|make a u-turn/.test(s)) return '↶';
  if (/sharp left/.test(s)) return '↙';
  if (/sharp right/.test(s)) return '↘';
  if (/bear left|keep left|slight left/.test(s)) return '↖';
  if (/bear right|keep right|slight right/.test(s)) return '↗';
  if (/left|counterclockwise/.test(s)) return '←';
  if (/right|clockwise/.test(s)) return '→';
  if (/roundabout|exit/.test(s)) return '↗';
  return '↑';
}
function shortInstruction(instruction) {
  return instruction.replace(/^Drive\s+/i, 'Continue ').replace(/\.$/, '').split('. ')[0].slice(0, 86);
}
function nextManeuverIndex(at) {
  return route.maneuvers.findIndex((item, i) => i > 0 && item.at >= at - 12);
}
function laneMaskSymbol(mask, instruction) {
  const choices = [[2, '↑'], [4, '↙'], [8, '←'], [16, '↖'], [32, '↗'], [64, '→'], [128, '↘'], [256, '↶'], [512, '↖'], [1024, '↗']]
    .filter(([bit]) => (mask & bit) !== 0);
  return choices.find(([, symbol]) => symbol === turnSymbol(instruction))?.[1] || choices[0]?.[1] || '·';
}
function renderLanes(maneuver, distance) {
  const panel = $('lane-panel'), holder = $('lanes');
  holder.replaceChildren();
  const lanes = maneuver?.lanes;
  if (!Array.isArray(lanes) || lanes.length < 2 || distance > 800) { panel.classList.add('hidden'); return; }
  let hasGuidance = false;
  lanes.forEach(lane => {
    const activeMask = Number(lane.active) || 0;
    const validMask = Number(lane.valid) || 0;
    const recommended = activeMask > 0;
    const usable = recommended || validMask > 0;
    if (usable) hasGuidance = true;
    const item = document.createElement('span');
    item.className = `lane${recommended ? ' active' : usable ? ' valid' : ''}`;
    item.textContent = laneMaskSymbol(activeMask || validMask || Number(lane.directions) || 0, maneuver.instruction);
    holder.append(item);
  });
  panel.classList.toggle('hidden', !hasGuidance);
}

function showUnavailable(message) {
  $('gps-status').textContent = message;
  $('turn-arrow').textContent = '·';
  $('turn-distance').textContent = '—';
  $('turn-text').textContent = 'Guidance paused';
  $('road-name').textContent = 'Wait for a fresh location or refresh the route';
  $('lane-panel').classList.add('hidden');
  $('speed-limit').textContent = '—';
  $('speed').textContent = '—';
  $('nav-map').classList.add('uncertain');
}

function beginReroute() {
  if (rerouting || Date.now() - lastRerouteAt < 45000) return;
  rerouting = true;
  lastRerouteAt = Date.now();
  void requestRoute(destination, true)
    .catch(() => showUnavailable('Off route · route service unavailable'))
    .finally(() => { rerouting = false; });
}

function updateGuidance() {
  if (screen !== 'guidance' || !route || !locationFix) return;
  if (!isDemo && !validFix(locationFix)) { showUnavailable('GPS unavailable or inaccurate'); return; }
  const near = nearestRoutePoint(locationFix);
  if (!near) { showUnavailable('Route position unavailable'); return; }
  const deviationLimit = Math.max(60, locationFix.accuracy * 2);
  if (!isDemo && routeUncertain) {
    if (near.lateral <= deviationLimit) { routeUncertain = false; offRouteCount = 0; }
    else { showUnavailable('Off route · refreshing'); beginReroute(); return; }
  }
  $('nav-map').classList.remove('uncertain');
  if (!isDemo && near.lateral > deviationLimit) {
    offRouteCount++;
    if (offRouteCount >= 3) {
      routeUncertain = true;
      showUnavailable('Off route · refreshing');
      beginReroute();
      return;
    }
  } else offRouteCount = 0;
  progress = Math.max(progress - 30, near.along);
  segmentIndex = near.segment;
  const remaining = Math.max(0, route.distance - progress);
  const nextIndex = nextManeuverIndex(progress);
  const maneuver = nextIndex >= 0 ? route.maneuvers[nextIndex] : null;
  const distance = maneuver ? Math.max(0, maneuver.at - progress) : remaining;
  $('gps-status').textContent = isDemo ? 'DEMO · simulated position' : `GPS live · ±${Math.round(locationFix.accuracy)} m`;
  $('remaining').textContent = formatDistance(remaining) + ' left';
  $('turn-arrow').textContent = maneuver ? turnSymbol(maneuver.instruction) : '↑';
  $('turn-distance').textContent = formatDistance(distance);
  $('turn-text').textContent = maneuver ? shortInstruction(maneuver.instruction) : remaining < 40 ? 'Arriving' : 'Continue to destination';
  $('road-name').textContent = maneuver?.street || destination?.name || '';
  $('eta').textContent = formatEta(route.duration * (remaining / Math.max(1, route.distance)));
  $('speed').textContent = isDemo ? '—' : formatSpeed(locationFix.speed);
  const edge = route.edges.find(item => item.begin_shape_index <= segmentIndex && item.end_shape_index > segmentIndex);
  const segmentConfident = isDemo || (locationFix.accuracy <= 25 && near.lateral <= 25);
  $('speed-limit').textContent = segmentConfident && edge ? formatLimit(Number(edge.speed_limit)) : '—';
  if (segmentConfident) renderLanes(maneuver, distance);
  else $('lane-panel').classList.add('hidden');
  const heading = Number.isFinite(locationFix.heading) && locationFix.speed >= 2 ? locationFix.heading : routeBearing(route.points[segmentIndex], route.points[Math.min(segmentIndex + 1, route.points.length - 1)]);
  const zoom = distance < 60 ? 19.25 : distance < 180 ? 18.35 : distance < 550 ? 17.35 : 16.35;
  const mapHeight = $('nav-map').clientHeight || 220;
  const mapPosition = segmentConfident ? near.point : coords(locationFix);
  const center = cameraAheadOf(mapPosition, zoom, heading, mapHeight);
  const turnPoint = maneuver ? route.points[maneuver.index] : null;
  renderMap($('nav-map'), center, zoom, route.points, mapPosition, heading, turnPoint);
  if (!isDemo && nextIndex >= 0 && nextIndex !== lastAnnounced && distance < 250) lastAnnounced = nextIndex;
  if (remaining < 35 && meters(coords(locationFix), route.points.at(-1)) < 45) {
    $('turn-distance').textContent = 'Arrived';
    $('turn-text').textContent = destination?.name || 'Destination';
    $('lane-panel').classList.add('hidden');
  }
}

function startGuidance() {
  if (!isDemo && !validFix(locationFix)) { showScreen('setup'); status('Wait for a fresh, accurate location before starting.'); return; }
  lastAnnounced = -1;
  showScreen('guidance');
  updateGuidance();
  if (isDemo) {
    let cursor = 0;
    demoTimer = setInterval(() => {
      if (screen !== 'guidance') return;
      cursor = Math.min(route.points.length - 1, cursor + 3);
      const point = route.points[cursor];
      locationFix = { lon: point[0], lat: point[1], accuracy: 8, speed: 8, heading: null, timestamp: Date.now() };
      updateGuidance();
      if (cursor >= route.points.length - 1) clearInterval(demoTimer);
    }, 1600);
  }
}

function stopGuidance() {
  clearInterval(demoTimer); demoTimer = null;
  if (routeController) routeController.abort();
  route = null; destination = null; isDemo = false; routeUncertain = false;
  $('nav-options').classList.add('hidden');
  showScreen('setup');
  if (watchId === null) startWatching();
}

$('location-button').addEventListener('click', startWatching);
async function findPostcode(query) {
  if (!validFix(locationFix)) { pendingPostcode = query; status(`${query} saved. Waiting for an accurate location.`); return; }
  pendingPostcode = null;
  status('Finding places…');
  $('search-results').replaceChildren();
  try {
    const results = await searchDestination(query);
    status(results.length ? 'Choose a destination:' : 'Postcode not found. Check it and try again.');
    for (const result of results) {
      const button = document.createElement('button');
      button.type = 'button';
      const name = String(result.display_name || 'Place').slice(0, 120);
      button.textContent = name;
      button.addEventListener('click', async () => {
        destination = { lat: Number(result.lat), lon: Number(result.lon), name: name.split(',')[0] };
        status('Calculating a driving route…');
        $('search-results').replaceChildren();
        try { await requestRoute(destination); }
        catch (error) { if (error.name !== 'AbortError') status(error.message || 'Could not calculate a route.'); }
      });
      $('search-results').append(button);
    }
    document.querySelector('#search-results button')?.focus();
  } catch (error) { if (error.name !== 'AbortError') status('Postcode search unavailable. Try again later.'); }
}
$('demo-button').addEventListener('click', async () => {
  try {
    status('Loading sample route…');
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (routeController) routeController.abort();
    clearInterval(demoTimer);
    const response = await fetch('./demo-route.json');
    if (!response.ok) throw new Error();
    route = normalizeRoute(await response.json());
    progress = 0; segmentIndex = 0; offRouteCount = 0; routeUncertain = false;
    destination = { name: 'St Paul’s Cathedral', lat: 51.5146, lon: -0.1022 };
    isDemo = true;
    locationFix = { lon: route.points[0][0], lat: route.points[0][1], accuracy: 8, speed: 8, heading: null, timestamp: Date.now() };
    showPreview();
  } catch { status('Sample route is unavailable.'); }
});
$('start-button').addEventListener('click', startGuidance);
$('preview-back').addEventListener('click', () => { if (isDemo) { isDemo = false; route = null; destination = null; locationFix = null; } showScreen('setup'); });
$('nav-menu-button').addEventListener('click', () => { $('nav-options').classList.remove('hidden'); $('reroute-button').focus(); });
$('close-options').addEventListener('click', () => { $('nav-options').classList.add('hidden'); $('nav-menu-button').focus(); });
$('stop-button').addEventListener('click', stopGuidance);
$('reroute-button').addEventListener('click', async () => {
  $('nav-options').classList.add('hidden');
  if (isDemo) { updateGuidance(); return; }
  routeUncertain = true;
  showUnavailable('Refreshing route…');
  try { await requestRoute(destination, true); }
  catch (error) { if (error.name !== 'AbortError') showUnavailable(error.message || 'Route unavailable'); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (screen === 'guidance' && !isDemo) showUnavailable('App inactive · GPS paused');
  } else if (!isDemo && (screen === 'guidance' || screen === 'setup' || screen === 'preview')) {
    locationFix = null;
    startWatching();
  }
});
setInterval(() => { if (screen === 'guidance' && !isDemo && !validFix(locationFix)) showUnavailable('GPS unavailable or inaccurate'); }, 2000);
