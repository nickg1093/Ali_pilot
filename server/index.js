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
// API dinamiche: non consentire cache intermedie/browser, soprattutto per la marea.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
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

// Archivio realtime su file JSON: leggibile anche fuori dal processo server.
// Su Render il filesystem è persistente solo se REALTIME_DATA_DIR punta a un disco persistente.
const realtimeDir = path.resolve(process.env.REALTIME_DATA_DIR || path.join(root, 'data', 'realtime'));
const vehiclePositionsFile = path.join(realtimeDir, 'vehicle-positions.json');
const tripUpdatesFile = path.join(realtimeDir, 'trip-updates.json');
const vehiclePositionsPbFile = path.join(realtimeDir, 'vehicle-positions.pb');
const tripUpdatesPbFile = path.join(realtimeDir, 'trip-updates.pb');
const livePositions = new Map();
const STALE_AFTER_MS = 120_000;
let persistQueue = Promise.resolve();
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}
function persistRealtimeFiles() {
  persistQueue = persistQueue.then(() => {
    fs.mkdirSync(realtimeDir, { recursive: true });
    const now = Date.now();
    const vehicles = [...livePositions.values()].sort((a,b) => b.receivedAt-a.receivedAt);
    const header = { generatedAt: new Date(now).toISOString(), format: 'Alilaguna Pilot GTFS-RT JSON mirror', staleAfterSeconds: STALE_AFTER_MS/1000 };
    writeJsonAtomic(vehiclePositionsFile, { header, vehicles });
    const tripUpdates = vehicles.filter(p => now-p.receivedAt <= STALE_AFTER_MS).map(p => ({
      tripId:p.tripId, routeId:p.routeId, vehicleId:p.deviceId,
      timestamp:Math.floor((p.timestamp || p.receivedAt || now)/1000),
      delaySeconds:p.delaySeconds, stopId:p.nextStopId || null, stopName:p.nextStopName || null, source:'phone-gps'
    }));
    writeJsonAtomic(tripUpdatesFile, { header, tripUpdates });
    const protobuf = GtfsRealtimeBindings.transit_realtime;
    const feedHeader = { gtfsRealtimeVersion:'2.0', incrementality:0, timestamp:Math.floor(now/1000) };
    const vehicleEntities = vehicles.filter(p => now-p.receivedAt <= STALE_AFTER_MS).map(p => ({
      id:p.deviceId, vehicle:{ trip:{tripId:p.tripId,routeId:p.routeId}, vehicle:{id:p.deviceId,label:p.boatName},
        position:{latitude:p.lat,longitude:p.lon,...(p.bearing!==null?{bearing:p.bearing}:{}),...(p.speedMps!==null?{speed:p.speedMps}:{})},
        timestamp:Math.floor((p.timestamp||now)/1000), currentStatus:2, ...(p.nextStopId?{stopId:p.nextStopId}:{}) }
    }));
    const vpBytes = protobuf.FeedMessage.encode({header:feedHeader,entity:vehicleEntities}).finish();
    const tuEntities = vehicles.filter(p => now-p.receivedAt <= STALE_AFTER_MS).map(p => ({
      id:`trip:${p.tripId}:${p.deviceId}`, tripUpdate:{trip:{tripId:p.tripId,routeId:p.routeId},timestamp:Math.floor((p.timestamp||now)/1000),
        ...(p.nextStopId?{stopTimeUpdate:[{stopId:p.nextStopId,arrival:p.delaySeconds!==null&&p.delaySeconds!==undefined?{delay:p.delaySeconds}:{},departure:p.delaySeconds!==null&&p.delaySeconds!==undefined?{delay:p.delaySeconds}:{}}]}:{})}
    }));
    const tuBytes = protobuf.FeedMessage.encode({header:feedHeader,entity:tuEntities}).finish();
    const writeBufferAtomic = (file, buffer) => { const tmp=`${file}.${process.pid}.tmp`; fs.writeFileSync(tmp,Buffer.from(buffer)); fs.renameSync(tmp,file); };
    writeBufferAtomic(vehiclePositionsPbFile, vpBytes);
    writeBufferAtomic(tripUpdatesPbFile, tuBytes);
  }).catch(error => console.error('Salvataggio realtime fallito:', error.message));
  return persistQueue;
}
try {
  const stored = JSON.parse(fs.readFileSync(vehiclePositionsFile, 'utf8'));
  for (const p of (Array.isArray(stored.vehicles) ? stored.vehicles : [])) {
    if (p?.deviceId && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon))) livePositions.set(String(p.deviceId), p);
  }
} catch (error) { if (error.code !== 'ENOENT') console.warn('Archivio realtime non leggibile:', error.message); }
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
  persistRealtimeFiles();
  res.json({ ok: true, activeDevices: [...livePositions.values()].filter(x => now - x.receivedAt <= STALE_AFTER_MS).length });
});
app.get('/api/positions', (_req,res) => {
  const now = Date.now();
  // Arricchisce le posizioni con il percorso GTFS e gli orari della corsa,
  // così la flotta live può mostrare tracciato e rail senza richieste extra.
  res.json([...livePositions.values()].map(p => {
    const gtfsTrip = gtfs.trips.find(t => t.trip_id === p.tripId);
    const route = routeById.get(p.routeId) || {};
    return {
      ...p,
      stale: now-p.receivedAt > STALE_AFTER_MS,
      completed: (() => { const ss=tripStops(p.tripId); const last=ss.at(-1); const lm=gtfsMinutesServer(last?.arrival)||gtfsMinutesServer(last?.departure); if(lm==null)return false; const pp=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()); const vv=k=>Number(pp.find(x=>x.type===k)?.value||0); let nm=vv('hour')*60+vv('minute')+vv('second')/60; let end=lm; while(nm-end>720)nm-=1440; while(end-nm>720)end-=1440; return nm>end+15; })(),
      routeColor: route.route_color || null,
      stops: tripStops(p.tripId),
      shape: gtfsTrip ? (shapeGroups.get(gtfsTrip.shape_id) || []) : []
    };
  }).sort((a,b)=>b.receivedAt-a.receivedAt));
});
// Posizioni simulate delle corse GTFS attualmente in servizio. Sono stime animate,
// non posizioni reali: il client le sopprime quando esiste un GPS recente per la stessa corsa.
app.get('/api/scheduled-vehicles', (_req,res) => {
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const val = k => Number(parts.find(p=>p.type===k)?.value||0);
  const nowMin = val('hour')*60+val('minute')+val('second')/60;
  const active=[];
  for (const t of gtfs.trips) {
    if (!serviceRunsToday(t.service_id)) continue;
    const stops=tripStops(t.trip_id); if(stops.length<2) continue;
    const timed=stops.map(s=>({...s,minute:gtfsMinutesServer(s.departure)||gtfsMinutesServer(s.arrival)}));
    const first=timed[0].minute,last=timed[timed.length-1].minute;
    if(first==null||last==null) continue;
    let n=nowMin; while(n<first-720)n+=1440; while(n>last+720)n-=1440;
    if(n<first||n>last) continue;
    let i=0; while(i<timed.length-2 && timed[i+1].minute<n)i++;
    const a=timed[i],b=timed[i+1]; if(a.minute==null||b.minute==null||b.minute<=a.minute)continue;
    const shape=(shapeGroups.get(t.shape_id)||[]).map(p=>({lat:p.lat,lon:p.lon})); if(shape.length<2)continue;
    const nearestIndex=stop=>{let best=0,dmin=Infinity;shape.forEach((p,j)=>{const d=(p.lat-stop.lat)**2+(p.lon-stop.lon)**2;if(d<dmin){dmin=d;best=j;}});return best;};
    const ia=nearestIndex(a),ib=Math.max(ia+1,nearestIndex(b));
    const f=Math.max(0,Math.min(1,(n-a.minute)/(b.minute-a.minute)));
    const pointAt=(idx)=>shape[Math.min(shape.length-1,Math.max(0,idx))];
    const raw=ia+(ib-ia)*f,lo=Math.floor(raw),hi=Math.min(shape.length-1,lo+1),q=raw-lo,p0=pointAt(lo),p1=pointAt(hi);
    const route=routeById.get(t.route_id)||{};
    active.push({deviceId:`scheduled:${t.trip_id}`,simulated:true,stale:false,tripId:t.trip_id,routeId:t.route_id,boatId:null,boatName:`Corsa ${t.trip_id}`,routeName:route.route_short_name||t.route_id,lat:p0.lat+(p1.lat-p0.lat)*q,lon:p0.lon+(p1.lon-p0.lon)*q,speedMps:null,delaySeconds:null,nextStopId:b.stopId,nextStopName:b.name,timestamp:Date.now(),routeColor:route.route_color||null,stops,shape});
  }
  res.set('Cache-Control','no-store');res.json(active);
});
function gtfsMinutesServer(s){if(!s||!/^\d{1,3}:\d{2}:\d{2}$/.test(s))return null;const [h,m,sec]=s.split(':').map(Number);return h*60+m+sec/60;}

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
app.get('/api/gtfs-rt/trip-updates.json', (_req,res) => {
  res.set('Cache-Control','no-store');
  try { res.type('json').send(fs.readFileSync(tripUpdatesFile, 'utf8')); }
  catch { res.json({ header:{generatedAt:null}, tripUpdates:[] }); }
});
app.get('/api/gtfs-rt/trip-updates.pb', (_req,res) => {
  res.set('Content-Type','application/x-protobuf'); res.set('Cache-Control','no-store');
  try { res.send(fs.readFileSync(tripUpdatesPbFile)); } catch { const feed=GtfsRealtimeBindings.transit_realtime.FeedMessage.encode({header:{gtfsRealtimeVersion:'2.0',incrementality:0,timestamp:Math.floor(Date.now()/1000)},entity:[]}).finish(); res.send(Buffer.from(feed)); }
});
app.get('/api/gtfs-rt/files', (_req,res) => res.json({
  directory:path.relative(root, realtimeDir),
  files:[
    {name:'vehicle-positions.json',url:'/api/gtfs-rt/vehicle-positions.json',path:path.relative(root,vehiclePositionsFile)},
    {name:'trip-updates.json',url:'/api/gtfs-rt/trip-updates.json',path:path.relative(root,tripUpdatesFile)},
    {name:'vehicle-positions.pb',url:'/api/gtfs-rt/vehicle-positions.pb',path:path.relative(root,vehiclePositionsPbFile)},
    {name:'trip-updates.pb',url:'/api/gtfs-rt/trip-updates.pb',path:path.relative(root,tripUpdatesPbFile)}
  ],
  persistence:process.env.REALTIME_DATA_DIR ? 'REALTIME_DATA_DIR configurata; verificare che punti a disco persistente' : 'filesystem locale del progetto; su Render free i file possono essere persi ai riavvii'
}));

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
  // Bypass anche eventuali cache CDN/proxy a monte: cache:'no-store' da sola
  // riguarda il client Node, ma non obbliga il server remoto a servire il JSON nuovo.
  const liveUrl = new URL(url);
  liveUrl.searchParams.set('_ts', String(Date.now()));
  const response = await fetch(liveUrl, {
    cache: 'no-store',
    headers: {
      'User-Agent': 'Mozilla/5.0 AlilagunaPilot/1.0 (live tide data)',
      'Cache-Control': 'no-cache, no-store, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    },
    signal: AbortSignal.timeout(12000)
  });
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

async function fetchText(url) {
  const liveUrl = new URL(url);
  liveUrl.searchParams.set('_ts', String(Date.now()));
  const response = await fetch(liveUrl, {
    cache: 'no-store',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AlilagunaPilot/1.0; live tide check)',
      'Cache-Control': 'no-cache, no-store, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Centro Maree HTTP ${response.status}`);
  return response.text();
}
function parseBetaObserved(html) {
  // Preferisce il campo osservata esposto dal backend della pagina BETA;
  // il livello principale della pagina può essere un valore sintetico/previsto.
  const patterns = [
    /\[osservata\]\s*=>\s*([+-]?\s*\d+(?:[.,]\d+)?)/i,
    /\bosservata\s*['"]?\s*[:=]\s*['"]?([+-]?\s*\d+(?:[.,]\d+)?)/i,
    /Livello attuale\s*:\s*(?:<[^>]*>\s*)*([+-]?\s*\d+(?:[.,]\d+)?)\s*cm/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const cm = parseNumber(m[1]);
      if (Number.isFinite(cm) && cm > -900) return { cm, matched: re.source };
    }
  }
  return null;
}
app.get('/api/tide', async (_req,res) => {
  try {
    const page = await fetchText(TIDE_URLS.observed);
    const observed = parseBetaObserved(page);
    if (observed) {
      const retrievedAt = new Date();
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      return res.json({
        station: 'Punta Salute (Centro Maree BETA)', levelMeters: observed.cm / 100,
        levelCm: Math.round(observed.cm), observedAt: null, observedAtRaw: null,
        retrievedAt: retrievedAt.toISOString(), ageMinutes: null, stale: false,
        freshness: 'unknown',
        warning: 'Valore corrente letto dalla pagina ufficiale BETA. La pagina non espone qui l’orario della singola misurazione.',
        source: TIDE_URLS.observed, units: 'cm', reference: 'ZMPS',
        disclaimer: 'Dato pubblicato dal Centro Maree; verificare l’orario della rilevazione nella fonte ufficiale.'
      });
    }
    // Se il markup BETA cambia, usa il feed grezzo delle stazioni solo se contiene
    // una misurazione recente. Non presenta mai un valore vecchio come attuale.
    const data = await fetchJson(TIDE_URLS.observedFallback);
    const row = findStationRow(data);
    if (!row) throw new Error('La pagina BETA non espone il valore osservato e la stazione non è presente nel feed di fallback');
    const meters = parseNumber(row.valore ?? row.value ?? row.livello);
    if (!Number.isFinite(meters) || meters <= -900) throw new Error('Valore di marea mancante/non valido');
    const observedAtRaw = row.data || row.timestamp || row.datetime || null;
    const observedAt = comuneTimestampToIso(observedAtRaw);
    const retrievedAt = new Date();
    const ageMinutes = observedAt ? Math.round((retrievedAt.getTime() - new Date(observedAt).getTime()) / 60000) : null;
    const stale = ageMinutes == null || ageMinutes < -5 || ageMinutes > 20;
    if (stale) throw new Error(`Il feed stazioni è fermo o obsoleto (ultima misura: ${observedAtRaw || 'orario assente'}); la pagina BETA non ha restituito un valore osservato riconoscibile.`);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    return res.json({ station: row.stazione || 'Punta Salute Canal Grande', levelMeters: meters, levelCm: Math.round(meters*100), observedAt, observedAtRaw, retrievedAt: retrievedAt.toISOString(), ageMinutes, stale: false, freshness:'measured', warning:null, source: TIDE_URLS.observedFallback, units: 'm', reference: 'ZMPS', disclaimer: 'Dato automatico grezzo del Comune; non validato.' });
  } catch (e) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.status(502).json({ error: 'Impossibile leggere il livello osservato dal Centro Maree.', detail: e.message, source: TIDE_URLS.observed });
  }
});
app.get('/api/tide-forecast', async (_req,res) => {
  const source = TIDE_URLS.forecast;
  try {
    const data = await fetchJson(source);
    if (!Array.isArray(data)) throw new Error('Il JSON previsione non contiene un array');
    const now = Date.now();
    const peaks = data.map(row => {
      const rawAt = row.DATA_ESTREMALE ?? row.data_estremale ?? row.at;
      const at = comuneTimestampToIso(rawAt);
      const typeRaw = String(row.TIPO_ESTREMALE ?? row.tipo_estremale ?? row.type ?? '').toLowerCase();
      const level = parseNumber(row.VALORE ?? row.valore ?? row.levelCm);
      if (!at || !Number.isFinite(level)) return null;
      const type = typeRaw.startsWith('max') ? 'Massimo' : typeRaw.startsWith('min') ? 'Minimo' : typeRaw;
      return { at, time: new Intl.DateTimeFormat('it-IT',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at)), type, levelCm: Math.round(level), issuedAt: comuneTimestampToIso(row.DATA_PREVISIONE ?? row.data_previsione) };
    }).filter(p => p && new Date(p.at).getTime() > now).sort((a,b)=>new Date(a.at)-new Date(b.at));
    const unique = peaks.filter((p,i,a)=>a.findIndex(q=>q.at===p.at&&q.type===p.type)===i).slice(0,4);
    if (!unique.length) throw new Error('Il JSON ufficiale non contiene picchi futuri riconoscibili');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({ source, retrievedAt:new Date().toISOString(), issuedAt:unique[0].issuedAt || null, peaks:unique, nextPeak:unique[0], method:'Estremali estratti dal JSON ufficiale previsione.json; orari della fonte interpretati in ora solare UTC+1.' });
  } catch (e) {
    res.status(502).json({ error:'Previsione marea non disponibile.', detail:e.message, source });
  }
});
app.get('/api/checkpoints', (_req,res) => res.json(TIDE_CHECKPOINTS));

const dist = path.join(root, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req,res,next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req,res) => res.type('text').send('Alilaguna Pilot API attiva. Avvia il frontend con npm run dev oppure esegui npm run build.'));
}
const server = app.listen(port, () => console.log(`Alilaguna Pilot in ascolto sulla porta ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(async () => { await persistRealtimeFiles(); process.exit(0); }); });
