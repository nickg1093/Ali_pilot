// ================================================================
// CONFIGURAZIONE PRINCIPALE — PERSONALIZZARE QUI
// Tutte le soglie sono ESEMPI FITTIZI: sostituirle con dati verificati.
// Non sono un'autorizzazione alla navigazione né un calcolo strutturale.
// ================================================================
export const BOATS = [
  { id: 'barca-alfa', name: 'Barca Alfa (PROVVISORIA)', maxTideCm: 70, note: 'Soglia di esempio da verificare' },
  { id: 'barca-beta', name: 'Barca Beta (PROVVISORIA)', maxTideCm: 85, note: 'Soglia di esempio da verificare' },
  { id: 'barca-gamma', name: 'Barca Gamma (PROVVISORIA)', maxTideCm: 100, note: 'Soglia di esempio da verificare' }
];

// ================================================================
// SOGLIE PER TRATTO/PONTE — DA SOSTITUIRE CON VALORI AUTORIZZATI.
// Nessuna altezza di ponte viene usata. Il sistema confronta la marea
// osservata con una soglia operativa configurata per ciascun punto.
// Se la soglia dipende dalla barca, aggiungere maxTideByBoatCm.
// Coordinate e soglie sotto sono solo segnaposto, non dati reali.
// ================================================================
export const TIDE_CHECKPOINTS = [
  { id: 'checkpoint-demo-1', name: 'Punto controllo demo 1 (PROVVISORIO)', lat: 45.4340, lon: 12.3350, maxTideCm: 70 },
  { id: 'checkpoint-demo-2', name: 'Punto controllo demo 2 (PROVVISORIO)', lat: 45.4380, lon: 12.3320, maxTideCm: 80 }
];

// Fonte ufficiale Comune di Venezia / Open Data CPSM.
export const TIDE_URLS = {
  observed: 'https://dati.venezia.it/sites/default/files/dataset/opendata/livello.json',
  forecast: 'https://dati.venezia.it/sites/default/files/dataset/opendata/previsione.json'
};
