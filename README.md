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

Il dato osservato primario viene letto dalla pagina ufficiale [Centro Maree BETA](https://www.comune.venezia.it/it/content/centro-previsioni-e-segnalazioni-maree-beta), cercando il campo di marea osservata/livello attuale; la pagina non sempre espone l'ora della singola misura, quindi l'interfaccia mostra l'ora di consultazione e non la spaccia per ora di rilevazione. Se il campo non è riconoscibile, il backend prova il dataset delle stazioni `livello.json`, ma lo accetta soltanto se la misurazione è recente (massimo 20 minuti). Le previsioni usano `http://dati.venezia.it/sites/default/files/dataset/opendata/previsione.json`; i timestamp della fonte sono interpretati come ora solare fissa UTC+1 e visualizzati in `Europe/Rome`. I dati automatici possono essere grezzi/non validati: verificare sempre la fonte ufficiale.

## Stima ritardo

Il ritardo è una stima ottenuta interpolando gli orari statici GTFS lungo la forma del percorso e confrontandoli con l'ora locale. Non è un'informazione ufficiale di esercizio; dipende dalla qualità del GPS e dall'associazione corretta della corsa.

## Aggiornamenti interfaccia flotta e rail

- La velocità è mostrata in km/h (conversione da m/s restituiti dal GPS).
- La rail mostra l'orario programmato e una stima aggiornata tramite il ritardo stimato corrente; quando il GPS registra una sosta ravvicinata al pontile a velocità molto bassa, memorizza l'ora di rilevamento per la sessione corrente.
- La prossima fermata considera il punto GTFS più vicino e la velocità GPS per segnalare una fermata quando il dispositivo è entro circa 35 m e sotto 3,2 km/h. I parametri sono euristiche da calibrare sul campo.
- La pagina Flotta live include una mappa Leaflet con simboli selezionabili e una scheda dettagliata per ciascun dispositivo.
- Le ore visualizzate nella rail sono orari locali Europe/Rome. Le stime non sostituiscono dati ufficiali di esercizio.

## Aggiornamenti interfaccia flotta

- Layout più compatto, ottimizzato per schermi mobili.
- Nella flotta live non vengono mostrate coordinate, accuratezza GPS o percentuale di avanzamento.
- La mappa disegna anche il tracciato GTFS associato a ogni dispositivo; cliccando sul mezzo o sul tracciato si apre il dettaglio.
- Il dettaglio include la corsa e la successione delle fermate con orario programmato, orario stimato e anticipo/ritardo.
- Le differenze di puntualità sono mostrate anche quando valgono un solo minuto.
- Gli orari stimati del dettaglio flotta applicano la differenza attuale rispetto al GTFS a tutte le fermate della corsa: sono quindi stime indicative, non previsioni dinamiche validate per ogni singola fermata.


## Installare su smartphone (PWA)

Alilaguna Pilot è una web app installabile, non un APK Android o un pacchetto IPA per iOS. Non serve uno store: dopo il deploy su un indirizzo HTTPS, aprire il sito sul dispositivo.

- **Android (Chrome):** usare il pulsante `Installa app` nell'intestazione se disponibile, oppure menu ⋮ → `Installa app` / `Aggiungi a schermata Home`.
- **iPhone/iPad (Safari):** aprire l'indirizzo in Safari → `Condividi` → `Aggiungi alla schermata Home` → `Aggiungi`. Su iOS il pulsante di installazione del browser non è esposto come su Android, quindi sono mostrate istruzioni manuali.
- **Desktop compatibili:** il browser può offrire l'icona di installazione nella barra degli indirizzi.

Il progetto include manifest PWA, service worker generato da `vite-plugin-pwa`, icone PNG 192/512 e `apple-touch-icon`. La geolocalizzazione richiede HTTPS e permesso esplicito. Alcune funzioni, in particolare GPS continuo e trasmissione alla flotta, richiedono che l'app resti aperta e che il sistema operativo non sospenda il browser.

## Archivio GTFS-Realtime

Il backend salva automaticamente le posizioni GPS ricevute e gli aggiornamenti corsa in `data/realtime/` (o nella directory indicata da `REALTIME_DATA_DIR`):

- `vehicle-positions.json`: posizioni leggibili in JSON;
- `trip-updates.json`: aggiornamenti leggibili in JSON;
- `vehicle-positions.pb`: feed GTFS-Realtime protobuf VehiclePositions;
- `trip-updates.pb`: feed GTFS-Realtime protobuf TripUpdates.

Endpoint HTTP: `/api/gtfs-rt/vehicle-positions.json`, `/api/gtfs-rt/trip-updates.json`, `/api/gtfs-rt/vehicle-positions.pb`, `/api/gtfs-rt/trip-updates.pb` e `/api/gtfs-rt/files`.

**Persistenza Render:** sul piano gratuito il filesystem del servizio può essere effimero e i file possono sparire al riavvio o al nuovo deploy. Per conservarli nel tempo, configurare `REALTIME_DATA_DIR` verso un disco persistente montato sul servizio (se disponibile nel piano Render) oppure migrare l'archivio a un database/oggetto storage persistente. I file contengono posizioni GPS: non renderli pubblici se non autorizzato.
