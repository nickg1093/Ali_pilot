# Alilaguna Pilot

PWA sperimentale per selezione corsa, navigazione GPS, rail delle fermate, marea di Punta Salute e condivisione delle posizioni GPS fra dispositivi collegati alla stessa istanza server.

## Avvio locale

- Node.js 20 o successivo consigliato.
- `npm install`
- `npm run dev` per sviluppo
- `npm run build` e `npm start` per avvio produzione

## Render

Il repository include `render.yaml`. Come alternativa, configurare Build Command `npm install && npm run build` e Start Command `npm start`. Il GPS richiede HTTPS e il consenso del browser.

## GTFS Realtime

- `GET /api/gtfs-rt/vehicle-positions.pb`: feed GTFS Realtime protobuf VehiclePositions.
- `GET /api/gtfs-rt/vehicle-positions.json`: rappresentazione JSON di debug.
- `GET /api/positions`: posizioni recenti per la dashboard flotta.
- `POST /api/positions`: riceve aggiornamenti GPS da ogni dispositivo.

Il feed protobuf è generato al volo dal backend e non va committato come file statico. Il dispositivo invia aggiornamenti ogni circa 4 secondi mentre il GPS è attivo. Le posizioni più vecchie di 2 minuti sono escluse dal feed GTFS-RT.

## Limite del prototipo multi-dispositivo

Le posizioni sono conservate in memoria nel processo Node. Sono quindi condivise dai dispositivi che raggiungono la stessa istanza, ma si perdono al riavvio e non sono condivise tra più istanze Render. Per uso continuativo occorre collegare Redis o PostgreSQL e proteggere gli endpoint con autenticazione/token per dispositivo.

## Personalizzare barche e soglie

Modificare `server/config.js`. I dati dimostrativi sono segnaposto e non devono essere usati per decisioni di navigazione reali.

## Marea

Il backend recupera il dataset del Comune di Venezia. L'orario della fonte, pubblicato in ora solare fissa UTC+1, viene convertito in un istante e mostrato in `Europe/Rome`, con gestione automatica CET/CEST. Il dato può essere grezzo/non validato: verificare sempre la fonte ufficiale.

## Stima ritardo

Il ritardo è una stima ottenuta interpolando gli orari statici GTFS lungo la forma del percorso e confrontandoli con l'ora locale. Non è un'informazione ufficiale di esercizio; dipende dalla qualità del GPS e dall'associazione corretta della corsa.

## Aggiornamenti interfaccia flotta e rail

- La velocità è mostrata in km/h (conversione da m/s restituiti dal GPS).
- La rail mostra l'orario programmato e una stima aggiornata tramite il ritardo stimato corrente; quando il GPS registra una sosta ravvicinata al pontile a velocità molto bassa, memorizza l'ora di rilevamento per la sessione corrente.
- La prossima fermata considera il punto GTFS più vicino e la velocità GPS per segnalare una fermata quando il dispositivo è entro circa 35 m e sotto 3,2 km/h. I parametri sono euristiche da calibrare sul campo.
- La pagina Flotta live include una mappa Leaflet con simboli selezionabili e una scheda dettagliata per ciascun dispositivo.
- Le ore visualizzate nella rail sono orari locali Europe/Rome. Le stime non sostituiscono dati ufficiali di esercizio.
