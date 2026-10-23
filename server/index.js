import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
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
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  const weekday = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][now.getDay()];
  const cal = gtfs.calendar.find(c => c.service_id === serviceId);
  return !cal || (date >= cal.start_date && date <= cal.end_date && cal[weekday] === '1');
}
function tripStops(tripId) {
  return gtfs.stopTimes.filter(s => s.trip_id === tripId).sort((a,b) => Number(a.stop_sequence)-Number(b.stop_sequence)).map(s => {
    const stop = stopById.get(s.stop_id) || {};
    return { stopId: s.stop_id, name: stop.stop_name || s.stop_id, lat: Number(stop.stop_lat), lon: Number(stop.stop_lon), sequence: Number(s.stop_sequence), arrival: s.arrival_time, departure: s.departure_time };
  });
}
app.get('/api/health', (_req,res) => res.json({ ok: true, app: 'laguna-pilot', gtfsLoaded: gtfs.trips.length > 0 }));
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
app.get('/api/tide', async (_req,res) => {
  try {
    const data = await fetchJson(TIDE_URLS.observed);
    const row = findStationRow(data);
    if (!row) throw new Error('Stazione Punta Salute Canal Grande non trovata nel JSON ufficiale');
    const valueRaw = row.valore ?? row.value ?? row.livello;
    const meters = parseNumber(valueRaw);
    if (!Number.isFinite(meters) || meters <= -900) throw new Error('Valore di marea mancante/non valido');
    const observedAt = row.data || row.timestamp || row.datetime || null;
    res.json({ station: row.stazione || 'Punta Salute Canal Grande', levelMeters: meters, levelCm: Math.round(meters*100), observedAt, retrievedAt: new Date().toISOString(), source: TIDE_URLS.observed, units: 'm', reference: 'ZMPS', disclaimer: 'Dato automatico grezzo del Comune; non validato. Verificare sempre la fonte ufficiale.' });
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
  app.get('/', (_req,res) => res.type('text').send('Laguna Pilot API attiva. Avvia il frontend con npm run dev oppure esegui npm run build.'));
}
app.listen(port, () => console.log(`Laguna Pilot in ascolto sulla porta ${port}`));
