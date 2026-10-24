# Alilaguna Pilot

Dashboard PWA per il personale in servizio: turno/corsa, fermate e orari GTFS, marea osservata e previsione ufficiale, più visualizzazione live della flotta.

## Avvio

- `npm install`
- `npm run dev` per sviluppo
- `npm run build` e `npm start` per esecuzione server con frontend compilato

## Fonti marea — solo Open Data ufficiali

Configurate in `server/config.js`:
- Osservata: `https://dati.venezia.it/sites/default/files/dataset/opendata/livello.json`
- Previsione: `https://dati.venezia.it/sites/default/files/dataset/opendata/previsione.json`

Il backend non cerca fonti alternative. Se il JSON ufficiale non è disponibile o non contiene campi riconoscibili, l'API segnala l'errore senza ripiegare su altre pagine o endpoint.

## Flotta live

Il dispositivo in servizio invia la posizione a `POST /api/positions`; la dashboard legge `GET /api/positions`. Le posizioni sono mantenute soltanto nella memoria del processo server e si perdono al riavvio. Non vengono creati file per le posizioni live e nessun file aggiuntivo. I file GTFS statici in `data/gtfs/` restano usati per orari, fermate, percorsi e simulazione visuale delle corse quando non è disponibile un GPS reale.

## API principali

- `GET /api/tide`
- `GET /api/tide-forecast`
- `GET /api/positions`
- `POST /api/positions`
- `GET /api/scheduled-vehicles`
- `GET /api/routes`, `GET /api/trips`, `GET /api/boats`
