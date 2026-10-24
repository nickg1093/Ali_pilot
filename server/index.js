import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { BOATS, TIDE_CHECKPOINTS, TIDE_URLS } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const app = express();
const port = process.env.PORT || 10000;
app.disable('x-powered-by');
app.use(express.json());

function readCsv(name) {
  const file = path.join(root, 'data', 'gtfs', name);
  if (!fs.existsSync(file)) return [];
  return parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), { columns: true, skip_empty_lines: true, bom: true, relax_quotes: true });
}
const gtfs = {
  routes: readCsv('routes.txt'), trips: readCsv('trips.txt'), stops: readCsv('stops.txt'),
  stopTimes: readCsv('stop_times.txt'), shapes: readCsv('shapes.txt'), calendar: readCsv('calendar.txt'),
  agency: readCsv('agency.txt'), feedInfo: readCsv('feed_info.txt')
};
const stopById = new Map(gtfs.stops.map(s => [s.stop_id, s]));
const routeById = new Map(gtfs.routes.map(r => [r.route_id, r]));
const shapeGroups = new Map();
for (const p of gtfs.shapes) {
  if (!shapeGroups.has(p.shape_id)) shapeGroups.set(p.shape_id, []);
  shapeGroups.get(p.shape_id).push({ lat: Number(p.shape_pt_lat), lon: Number(p.shape_pt_lon), seq: Number(p.shape_pt_sequence) });
}
for (const pts of shapeGroups.values()) pts.sort((a,b) => a.seq-b.seq);

function serviceRunsToday(serviceId) {
  // Il calendario GTFS va valutato nel fuso locale del servizio (Venezia), non nel fuso UTC del server Render.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).formatToParts(new Date());
  const part = key => parts.find(p => p.type === key)?.value;
  const date = `${part('year')}${part('month')}${part('day')}`;
  const weekday = part('weekday').toLowerCase();
  const cal = gtfs.calendar.find(c => c.service_id === serviceId);
  return !cal || (date >= cal.start_date && date <= cal.end_date && cal[weekday] === '1');
}
function tripStops(tripId) {
  return gtfs.stopTimes.filter(s => s.trip_id === tripId).sort((a,b) => Number(a.stop_sequence)-Number(b.stop_sequence)).map(s => {
    const stop = stopById.get(s.stop_id) || {};
    return { stopId: s.stop_id, name: stop.stop_name || s.stop_id, lat: Number(stop.stop_lat), lon: Number(stop.stop_lon), sequence: Number(s.stop_sequence), arrival: s.arrival_time, departure: s.departure_time };
  });
}

// Posizioni condivise fra i dispositivi collegati alla stessa istanza del server.
// In memoria per il prototipo: per disponibilità persistente/multiistanza usare Redis o PostgreSQL.
const livePositions = new Map();
const STALE_AFTER_MS = 120_000;
app.post('/api/positions', (req, res) => {
  const b = req.body || {};
  const required = ['deviceId','tripId','routeId','boatId','lat','lon'];
  if (required.some(k => b[k] === undefined || b[k] === null || b[k] === '') || !Number.isFinite(Number(b.lat)) || !Number.isFinite(Number(b.lon))) {
    return res.status(400).json({ error: 'Campi obbligatori mancanti o coordinate non valide.' });
  }
  if (Math.abs(Number(b.lat)) > 90 || Math.abs(Number(b.lon)) > 180) return res.status(400).json({ error: 'Coordinate fuori intervallo.' });
  const now = Date.now();
  const prev = livePositions.get(String(b.deviceId));
  const item = {
    deviceId: String(b.deviceId).slice(0,100), tripId: String(b.tripId), routeId: String(b.routeId), boatId: String(b.boatId),
    boatName: String(b.boatName || b.boatId).slice(0,100), routeName: String(b.routeName || b.routeId).slice(0,100),
    lat: Number(b.lat), lon: Number(b.lon), accuracy: Number.isFinite(Number(b.accuracy)) ? Number(b.accuracy) : null,
    speedMps: Number.isFinite(Number(b.speedMps)) && Number(b.speedMps) >= 0 ? Number(b.speedMps) : null,
    bearing: Number.isFinite(Number(b.bearing)) ? Number(b.bearing) : null,
    progress: Number.isFinite(Number(b.progress)) ? Math.max(0,Math.min(1,Number(b.progress))) : null,
    delaySeconds: Number.isFinite(Number(b.delaySeconds)) ? Math.round(Number(b.delaySeconds)) : null,
    nextStopId: b.nextStopId ? String(b.nextStopId) : null, nextStopName: b.nextStopName ? String(b.nextStopName).slice(0,160) : null,
    timestamp: Number.isFinite(Number(b.timestamp)) ? Number(b.timestamp) : now, receivedAt: now
  };
  // Scarta update più vecchi rispetto alla posizione già memorizzata.
  if (prev && item.timestamp < prev.timestamp) return res.status(409).json({ error: 'Aggiornamento GPS più vecchio di quello già ricevuto.' });
  livePositions.set(item.deviceId, item);
  res.json({ ok: true, activeDevices: [...livePositions.values()].filter(x => now - x.receivedAt <= STALE_AFTER_MS).length });
});
app.get('/api/positions', (_req,res) => {
  const now = Date.now();
  res.json([...livePositions.values()].map(p => ({ ...p, stale: now-p.receivedAt > STALE_AFTER_MS })).sort((a,b)=>b.receivedAt-a.receivedAt));
});
app.get('/api/gtfs-rt/vehicle-positions.pb', (_req,res) => {
  const now = Date.now();
  const entities = [...livePositions.values()].filter(p => now-p.receivedAt <= STALE_AFTER_MS).map(p => ({
    id: p.deviceId,
    vehicle: {
      trip: { tripId: p.tripId, routeId: p.routeId },
      vehicle: { id: p.deviceId, label: p.boatName },
      position: { latitude: p.lat, longitude: p.lon, ...(p.bearing !== null ? { bearing: p.bearing } : {}), ...(p.speedMps !== null ? { speed: p.speedMps } : {}) },
      timestamp: Math.floor(p.timestamp/1000), currentStatus: 2,
      ...(p.nextStopId ? { stopId: p.nextStopId } : {})
    }
  }));
  const feed = { header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: Math.floor(now/1000) }, entity: entities };
  const bytes = GtfsRealtimeBindings.transit_realtime.FeedMessage.encode(feed).finish();
  res.set('Content-Type','application/x-protobuf');
  res.set('Cache-Control','no-store');
  res.send(Buffer.from(bytes));
});
app.get('/api/gtfs-rt/vehicle-positions.json', (_req,res) => {
  const now = Date.now();
  res.json({ header:{gtfsRealtimeVersion:'2.0',timestamp:Math.floor(now/1000)}, vehicles:[...livePositions.values()].filter(p=>now-p.receivedAt<=STALE_AFTER_MS) });
});

app.get('/api/health', (_req,res) => res.json({ ok: true, app: 'alilaguna-pilot', gtfsLoaded: gtfs.trips.length > 0 }));
app.get('/api/boats', (_req,res) => res.json(BOATS));
app.get('/api/routes', (_req,res) => res.json(gtfs.routes.map(r => ({ id:r.route_id, shortName:r.route_short_name, name:r.route_long_name, description:r.route_desc, color:r.route_color, textColor:r.route_text_color }))));
app.get('/api/trips', (req,res) => {
  const routeId = req.query.routeId;
  const trips = gtfs.trips.filter(t => (!routeId || t.route_id === routeId) && serviceRunsToday(t.service_id));
  res.json(trips.map(t => ({ id:t.trip_id, routeId:t.route_id, routeName:routeById.get(t.route_id)?.route_short_name || t.route_id, headsign:t.trip_headsign, directionId:t.direction_id, shapeId:t.shape_id, stops:tripStops(t.trip_id), shape:shapeGroups.get(t.shape_id) || [] })));
});
app.get('/api/gtfs-summary', (_req,res) => res.json({ feedInfo:gtfs.feedInfo[0] || {}, routes:gtfs.routes.length, trips:gtfs.trips.length, stops:gtfs.stops.length, shapes:shapeGroups.size }));

function parseNumber(s) {
  if (typeof s === 'number') return s;
  if (s == null) return NaN;
  const match = String(s).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}
function findStationRow(data) {
  const rows = Array.isArray(data) ? data : (data?.data && Array.isArray(data.data) ? data.data : data?.records && Array.isArray(data.records) ? data.records : []);
  return rows.find(r => /punta salute canal grande/i.test(String(r.stazione || r.station || r.nome || r.name || '')) || String(r.ID_stazione || r.id) === '1025');
}
async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'LagunaPilot/0.1 (Comune Venezia open data integration)' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Fonte marea HTTP ${response.status}`);
  return response.json();
}
// Il Comune pubblica l'orario come ora solare fissa UTC+1 tutto l'anno.
// Convertiamo quel wall-clock in un istante assoluto, poi il frontend lo visualizza in Europe/Rome (CET/CEST).
function comuneTimestampToIso(value) {
  if (!value) return null;
  const raw = String(value).trim();
  // ISO con Z/offset: è già un istante assoluto.
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const d = new Date(raw); return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Formati comuni: YYYY-MM-DD HH:mm[:ss] o YYYY-MM-DDTHH:mm[:ss]
  let m = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, day, h, mi, sec='0'] = m;
    // Sottrae l'offset fisso +01:00 della fonte.
    const d = new Date(Date.UTC(+y, +mo-1, +day, +h-1, +mi, +sec));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Formato italiano: DD/MM/YYYY HH:mm[:ss]
  m = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, day, mo, y, h, mi, sec='0'] = m;
    const d = new Date(Date.UTC(+y, +mo-1, +day, +h-1, +mi, +sec));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

app.get('/api/tide', async (_req,res) => {
  try {
    const data = await fetchJson(TIDE_URLS.observed);
    const row = findStationRow(data);
    if (!row) throw new Error('Stazione Punta Salute Canal Grande non trovata nel JSON ufficiale');
    const valueRaw = row.valore ?? row.value ?? row.livello;
    const meters = parseNumber(valueRaw);
    if (!Number.isFinite(meters) || meters <= -900) throw new Error('Valore di marea mancante/non valido');
    const observedAtRaw = row.data || row.timestamp || row.datetime || null;
    const observedAt = comuneTimestampToIso(observedAtRaw);
    res.json({ station: row.stazione || 'Punta Salute Canal Grande', levelMeters: meters, levelCm: Math.round(meters*100), observedAt, observedAtRaw, retrievedAt: new Date().toISOString(), source: TIDE_URLS.observed, units: 'm', reference: 'ZMPS', disclaimer: 'Dato automatico grezzo del Comune; non validato. Verificare sempre la fonte ufficiale.' });
  } catch (e) {
    res.status(502).json({ error: 'Impossibile leggere la marea ufficiale in questo momento.', detail: e.message, source: TIDE_URLS.observed });
  }
});
app.get('/api/tide-forecast', async (_req,res) => {
  try {
    const data = await fetchJson(TIDE_URLS.forecast);
    res.json({ source: TIDE_URLS.forecast, retrievedAt: new Date().toISOString(), raw: data, note: 'Formato previsione restituito dalla fonte ufficiale. Verificare la struttura del JSON prima di usarlo per decisioni operative.' });
  } catch (e) { res.status(502).json({ error:'Previsione marea non disponibile.', detail:e.message, source:TIDE_URLS.forecast }); }
});
app.get('/api/checkpoints', (_req,res) => res.json(TIDE_CHECKPOINTS));

const dist = path.join(root, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req,res,next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req,res) => res.type('text').send('Alilaguna Pilot API attiva. Avvia il frontend con npm run dev oppure esegui npm run build.'));
}
app.listen(port, () => console.log(`Alilaguna Pilot in ascolto sulla porta ${port}`));
