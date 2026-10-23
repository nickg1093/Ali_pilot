# Laguna Pilot — PWA starter

Prototipo installabile per dashboard di navigazione, basato sul GTFS statico Alilaguna e sui dati Open Data CPSM del Comune di Venezia.

## Avvio locale

```bash
npm install
npm run dev
```

Vite mostra l'indirizzo del frontend (normalmente `http://localhost:5173`). L'API viene avviata sulla porta `10000` in sviluppo; per comodità configura un proxy Vite aggiungendo `server.proxy` se necessario, oppure avvia il build e usa `npm start`.

Per testare la versione completa in locale:

```bash
npm install
npm run build
npm start
```

Apri `http://localhost:10000`.

## Deploy su GitHub + Render

1. Carica tutti i file di questa cartella in un repository GitHub.
2. In Render scegli **New + → Web Service** e collega il repository.
3. Render può usare `render.yaml`; altrimenti imposta Build Command `npm install && npm run build` e Start Command `npm start`.
4. Dopo il deploy apri l'URL HTTPS da smartphone. Per installare la PWA usa il menu del browser; la geolocalizzazione richiede HTTPS e consenso.

## Dati GTFS

Il GTFS caricato è incluso in `data/gtfs/`. Aggiornare questi file quando si riceve un nuovo feed. L'API filtra i servizi in base a `calendar.txt`; il feed allegato non contiene `calendar_dates.txt`, quindi le eccezioni speciali di calendario non sono gestite.

## Marea

L'API legge il JSON ufficiale `livello.json`, filtra `Punta Salute Canal Grande` e restituisce il valore in cm. Fonte: [Comune di Venezia — stazione Punta Salute](https://www.comune.venezia.it/it/content/1-punta-salute-canal-grande) e [Open Data CPSM](https://dati.venezia.it/?q=content/cpsm-dati-meteomarini-laguna-e-litorale-veneziano). Il dato osservato è grezzo, riferito a ZMPS e indicato in ora solare UTC+1 dalla fonte; l'app mostra l'orario così come pubblicato. Il route `/api/tide-forecast` espone per ora il JSON grezzo della previsione: la sua struttura va normalizzata prima di presentarla come previsione utilizzabile.

## Personalizzazione — MODIFICARE `server/config.js`

- `BOATS`: nomi delle barche e soglia massima di marea in cm.
- `TIDE_CHECKPOINTS`: punti di controllo e soglie di marea in cm. Coordinate e soglie attuali sono segnaposto fittizi.
- Non vengono inserite quote dei ponti: il prototipo confronta il livello misurato con soglie operative predefinite. Soglie reali devono provenire da fonti tecniche/autorizzate. Non usare le soglie dimostrative per prendere decisioni di navigazione.

## Note importanti

- Il GPS segue la posizione, ma in questa versione non fa ancora map-matching del GPS sul tracciato e non stima l'orario d'arrivo al punto di controllo.
- Gli orari GTFS sono orari pianificati, non dati live.
- La marea osservata a Punta Salute può non rappresentare perfettamente il livello locale di ogni canale. Il sistema è informativo e non sostituisce le prescrizioni del gestore o le valutazioni del comandante.
- Dati CPSM pubblicati con licenza CC-BY: riportare la fonte e la licenza nelle versioni distribuite.
