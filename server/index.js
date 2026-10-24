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

// Le posizioni live restano soltanto nella memoria del server: nessun archivio
// locale e nessun file di output generato per i dati realtime.
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

app.get('/api/health', (_req,res) => res.json({ ok: true, app: 'alilaguna-pilot', gtfsLoaded: gtfs.trips.length > 0, liveFleet: true }));
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
  return rows.find(r => /punta salute canal grande/i.test(String(r.stazione || r.STAZIONE || r.station || r.nome || r.NOME || r.name || '')) || String(r.ID_stazione || r.ID_STAZIONE || r.id || r.station_id) === '1025');
}
async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'LagunaPilot/0.1 (Comune Venezia open data integration)' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Fonte marea HTTP ${response.status}`);
  return response.json();
}

// La pagina ufficiale di Punta Salute espone le misure osservate in una tabella HTML.
// Il vecchio endpoint Open Data /livello.json restituisce soltanto l'anagrafica delle stazioni.
function htmlText(value) {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '\"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}
function parseObservedTideHtml(html) {
  const source = String(html);
  const rows = [];
  const addRow = (date, levelRaw, tempRaw) => {
    const level = parseNumber(levelRaw);
    if (!date || !Number.isFinite(level) || level <= -900) return;
    const temp = parseNumber(tempRaw);
    rows.push({ observedAtRaw: date.trim(), levelMeters: level, temperatureC: Number.isFinite(temp) ? temp : null });
  };

  // Primo tentativo: tabella HTML tradizionale.
  for (const match of source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => htmlText(m[1]));
    if (cells.length < 2) continue;
    const date = cells.find(v => /^(?:\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\s+\d{2}:\d{2}(?::\d{2})?$/.test(v));
    if (!date) continue;
    const idx = cells.indexOf(date);
    addRow(date, cells[idx + 1], cells[idx + 2]);
  }

  // Il server del Comune può servire le righe come testo tabellare delimitato da |,
  // non come elementi <tr>. Supporta anche le righe con tag HTML inline.
  if (!rows.length) {
    const text = htmlText(source.replace(/<\/(?:tr|p|div|li|br|pre|td|th)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n'));
    const datePattern = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?|\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?::\d{2})?)/g;
    for (const line of text.split(/\n|(?<=\d{2})\s{2,}/)) {
      const m = line.match(datePattern);
      if (!m) continue;
      const date = m[0];
      const idx = line.indexOf(date) + date.length;
      const tail = line.slice(idx).split('|').map(v => v.trim()).filter(Boolean);
      if (tail.length >= 1) addRow(date, tail[0], tail[1]);
    }
    // Ultimo parser: righe complete data | livello | temperatura anche se HTML minificato.
    if (!rows.length) {
      const flat = source.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
      const re = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s*(?:\|\s*|\t+| {1,})(-?\d+(?:[.,]\d+)?)\s*(?:\|\s*|\t+| {1,})(-?\d+(?:[.,]\d+)?)/g;
      for (const m of flat.matchAll(re)) addRow(m[1], m[2], m[3]);
    }
  }

  // Rimuove eventuali duplicati creati da markup che espone sia testo sia tabella.
  const unique = [...new Map(rows.map(r => [`${r.observedAtRaw}|${r.levelMeters}`, r])).values()];
  unique.sort((a,b) => String(a.observedAtRaw).localeCompare(String(b.observedAtRaw)));
  if (!unique.length) {
    const preview = htmlText(source).slice(0, 350);
    throw new Error(`La pagina ufficiale non contiene righe di marea riconoscibili. Anteprima: ${preview}`);
  }
  return { latest: unique[unique.length - 1], rows: unique, rowCount: unique.length };
}
async function fetchObservedTide() {
  const response = await fetch(TIDE_URLS.observed, {
    headers: { 'User-Agent': 'AlilagunaPilot/1.0 (integrazione dati ufficiali Comune di Venezia)', 'Accept': 'text/html' },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Fonte ufficiale marea HTTP ${response.status}`);
  const html = await response.text();
  if (!/<html|<table|<tr/i.test(html)) throw new Error('La fonte ufficiale non ha restituito una pagina HTML leggibile.');
  return { ...parseObservedTideHtml(html), httpStatus: response.status, contentType: response.headers.get('content-type') };
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

// Pagina diagnostica accessibile direttamente da browser, indipendente dalla UI React.
app.get('/debug-marea', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Debug marea · Alilaguna Pilot</title><style>body{font:16px system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#18212f}h1{font-size:1.6rem}button{padding:10px 14px;border:0;border-radius:8px;background:#075985;color:white;font-size:1rem;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f9;border:1px solid #cbd5e1;padding:14px;border-radius:8px} .ok{color:#087443}.bad{color:#b42318}</style></head><body><h1>Diagnostica marea · Punta Salute</h1><p>Questa pagina interroga solo gli Open Data ufficiali configurati nel server. Non usa fonti alternative.</p><p><button onclick="run()">Riprova test</button></p><h2>1. Fonte ufficiale e parsing</h2><p id="status">Test in corso…</p><pre id="debug">Caricamento…</pre><h2>2. Risposta consumata dalla dashboard</h2><p id="status2">Test in corso…</p><pre id="tide">Caricamento…</pre><script>async function get(url){const r=await fetch(url,{cache:'no-store'});const t=await r.text();let d;try{d=JSON.parse(t)}catch{d={raw:t}}return {httpStatus:r.status,ok:r.ok,data:d}}async function run(){document.querySelector('#status').textContent='Test in corso…';document.querySelector('#status2').textContent='Test in corso…';try{const d=await get('/api/tide/debug');document.querySelector('#debug').textContent=JSON.stringify(d,null,2);document.querySelector('#status').textContent='HTTP '+d.httpStatus+' · '+(d.data.ok?'lettura riconosciuta':'problema rilevato');document.querySelector('#status').className=d.data.ok?'ok':'bad'}catch(e){document.querySelector('#debug').textContent=String(e);document.querySelector('#status').textContent='Errore chiamando la diagnostica';document.querySelector('#status').className='bad'}try{const d=await get('/api/tide');document.querySelector('#tide').textContent=JSON.stringify(d,null,2);document.querySelector('#status2').textContent='HTTP '+d.httpStatus+' · '+(d.ok?'marea disponibile':'marea non disponibile');document.querySelector('#status2').className=d.ok?'ok':'bad'}catch(e){document.querySelector('#tide').textContent=String(e);document.querySelector('#status2').textContent='Errore chiamando /api/tide';document.querySelector('#status2').className='bad'}}run();</script></body></html>`);
});

// Diagnostica esplicita della fonte osservata: mostra struttura e campi utili,
// senza tentare fonti alternative né modificare i dati visualizzati.
app.get('/api/tide/debug', async (_req,res) => {
  const checkedAt = new Date().toISOString();
  try {
    const result = await fetchObservedTide();
    return res.json({ ok:true, checkedAt, source:TIDE_URLS.observed, httpStatus:result.httpStatus, contentType:result.contentType,
      station:'Punta Salute Canal Grande', rowCount:result.rowCount, latest:result.latest,
      parsedMeters:result.latest.levelMeters, parsedObservedAt:comuneTimestampToIso(result.latest.observedAtRaw),
      sampleRows:result.rows.slice(-3), note:'Dato osservato grezzo del Comune; non validato.' });
  } catch (e) {
    return res.status(502).json({ ok:false, checkedAt, source:TIDE_URLS.observed, error:e.message,
      hint:'La fonte ufficiale potrebbe essere temporaneamente non disponibile o aver cambiato formato.' });
  }
});

app.get('/api/tide', async (_req,res) => {
  try {
    const result = await fetchObservedTide();
    const latest = result.latest;
    const observedAt = comuneTimestampToIso(latest.observedAtRaw);
    res.set('Cache-Control', 'no-store');
    res.json({ station:'Punta Salute Canal Grande', levelMeters:latest.levelMeters, levelCm:Math.round(latest.levelMeters*100),
      observedAt, observedAtRaw:latest.observedAtRaw, temperatureC:latest.temperatureC,
      retrievedAt:new Date().toISOString(), source:TIDE_URLS.observed, units:'m', reference:'ZMPS',
      disclaimer:'Dato automatico grezzo del Comune; non validato. L’orario pubblicato dal Comune è in ora solare UTC+1.' });
  } catch (e) {
    res.status(502).json({ error:'Impossibile leggere la marea ufficiale in questo momento.', detail:e.message, source:TIDE_URLS.observed });
  }
});
app.get('/api/tide-forecast', async (_req,res) => {
  try {
    const data = await fetchJson(TIDE_URLS.forecast);
    const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.records) ? data.records : [];
    const now = Date.now();
    const peaks = rows.map(row => {
      const rawAt = row.DATA_ESTREMALE ?? row.data_estremale ?? row.DATA ?? row.data ?? row.timestamp ?? row.datetime;
      const at = comuneTimestampToIso(rawAt);
      const rawLevel = row.VALORE ?? row.valore ?? row.value ?? row.livello;
      const levelCm = parseNumber(rawLevel);
      const typeRaw = String(row.TIPO_ESTREMALE ?? row.tipo_estremale ?? row.tipo ?? row.type ?? '').trim();
      if (!at || !Number.isFinite(levelCm) || !typeRaw) return null;
      const type = /max|mass/i.test(typeRaw) ? 'Massimo' : /min/i.test(typeRaw) ? 'Minimo' : typeRaw;
      return { at, time: new Intl.DateTimeFormat('it-IT',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit'}).format(new Date(at)), type, levelCm: Math.round(levelCm) };
    }).filter(p => p && new Date(p.at).getTime() > now).sort((a,b)=>new Date(a.at)-new Date(b.at)).slice(0,4);
    if (!peaks.length) throw new Error('Il JSON ufficiale non contiene estremi futuri riconoscibili.');
    res.json({ source:TIDE_URLS.forecast, retrievedAt:new Date().toISOString(), peaks, nextPeak:peaks[0], method:'Estremi futuri letti dagli Open Data ufficiali del Comune di Venezia.' });
  } catch (e) {
    res.status(502).json({ error:'Previsione marea non disponibile dagli Open Data ufficiali.', detail:e.message, source:TIDE_URLS.forecast });
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

