# Review di `Reader.bub.js`

## Scopo e metodo

Review del mega-rewrite che introduce automazione pannelli, Director, OCR/reveal,
playback e preloading.

Sono stati riletti direttamente:

- `client/src/views/Reader.bub.js`
- `panel-reader-controller.js`, `panel-page-analysis.js`
- `panel-director.js`, `panel-frame-planner.js`, `panel-camera-plan.js`
- `panel-playback-scheduler.js`, `panel-reveal-controller.js`
- `reader-playback-controller.js`, `reader-image-preloader.js`

La review iniziale è stata poi sottoposta a una seconda verifica diretta. Questo
documento contiene solo i finding corretti dopo tale verifica.

## Risultato live aggiuntivo

Il 2026-07-21 è stato usato il dev server su `http://localhost:8910` con un
capitolo reale MangaDex di 20 pagine.

- Tutte le 20 pagine sono state preparate in modalità `director`.
- Il campione non ha prodotto pagine a zero location né beat `reading-pan-*`.
  I finding relativi restano validi per il flusso statico, ma non sono stati
  riprodotti in questo capitolo.
- È stato invece riprodotto il difetto di interazione/autoplay:
  1. durante un timer attivo, `zoomIn()` lascia `playback=playing` e il timer
     schedulato vivo;
  2. interrompere una transizione con `zoomIn()` lascia il reader in
     `playback=preparing`, senza timer schedulato e senza camera pending.
     L'autoplay resta fermo finché l'utente non interviene di nuovo.

## Priorità

| Priorità | Finding |
| --- | --- |
| P0 | 1, 2, 3 |
| P1 | 4, 5, 6 |
| P2 | 7, 8, 9 |
| P3 | 10–15 |

---

## Finding 1 — Director può produrre zero location e bloccare l'autoplay

**Priorità:** P0  
**File:** `client/src/panel-director.js:93-98`, `client/src/views/Reader.bub.js:929-936`, `1280-1284`

Un pannello che entra nella composizione e non ha balloon ritorna una shot ma
`beats: []`. Per una pagina d'azione senza dialoghi, o dopo filtri come
`dialogueOnly`, il Director può quindi produrre `locations: []` pur avendo
pannelli rilevati correttamente.

In modalità manuale il fallback attuale è tollerabile: la pagina resta intera
e il tap successivo avanza. In autoplay no: `_prepareCurrentPagePanels()` tenta
`_framePanel(0)`, ma `_framePanel()` ritorna perché non esiste una location;
il playback resta in `preparing`, senza timer e senza una transizione verso la
pagina successiva.

**Proposta:** rendere esplicito il contratto: ogni pagina con pannelli deve
produrre almeno una location navigabile. Il Director dovrebbe creare un beat di
coverage/overview anche per pannelli senza balloon. Come ulteriore safety net,
`_prepareCurrentPagePanels()` deve gestire `locations.length === 0` e decidere
esplicitamente se mostrare pagina intera, avanzare durante il playback, o
fermare il playback con stato e UI coerenti.

**Nota di verifica:** il caso è confermato dal codice; non è comparso nel
capitolo live analizzato.

## Finding 2 — Il reveal viene cancellato all'inizio di una `reading-pan`

**Priorità:** P0  
**File:** `client/src/views/Reader.bub.js:1305`, `209-214`; `client/src/reader-playback-controller.js:94-98`, `172-185`; `client/src/panel-reveal-controller.js:192-202`; `client/src/panel-playback-scheduler.js:92-96`

Una location `reading-pan-lead` arma un reveal lungo quanto l'intera durata di
lettura, ma mantiene la camera soltanto 600–1000ms. All'avvio della location
`reading-pan-travel`, `_framePanel()` chiama `enterLocation()`, che invoca
`_playback.enterLocation()`. Il controller resetta il clock e chiama
`onCancel("reset")`; Reader risponde con `_panelReveal.cancelSchedule()`.

La cancellazione non avviene dunque alla nuova chiamata di `reveal()` come
ipotizzato nella review iniziale: avviene prima, all'inizio della pan. Le
animazioni con `fill: forwards` vengono cancellate, i cover tornano opachi, e
il reveal viene eventualmente riprogrammato solo alla fine, compresso nel
`finalPauseMs`.

**Proposta:** modellare `reading-pan-lead` e `reading-pan-travel` come un unico
beat di playback/reveal, oppure distinguere un cambio camera interno dalla
cancellazione del beat corrente. `enterLocation()` non deve resettare il reveal
quando la nuova location continua lo stesso `revealUnitId`/lo stesso balloon.

**Nota di verifica:** il meccanismo è confermato; il campione live non aveva
beat `reading-pan-*`.

## Finding 3 — Un'interazione manuale non ferma il playback e può congelarlo

**Priorità:** P0  
**File:** `client/src/views/Reader.bub.js:472-487`, `490-496`, `1489-1517`, `1258-1271`; `client/src/panel-camera-executor.js:68-71`; `client/src/reader-playback-controller.js:124-151`

Wheel, pointerdown, pinch, zoom in/out e reset zoom chiamano
`_panelCamera.cancel()`, ma non fermano né mettono in pausa il playback.

Ci sono due effetti:

1. durante un hold già schedulato, il timer continua e la camera salta al beat
   successivo mentre l'utente sta facendo zoom;
2. durante una transizione camera, l'interazione cancella il `requestAnimationFrame`
   della camera. Il callback `complete`, che chiama `_continueAfterPanelFrame()`,
   non parte; non viene quindi creato alcun timer. Il playback rimane in
   `preparing` senza clock.

**Riproduzione live:** confermata sul dev server. Dopo l'interruzione: stato
`preparing`, `hasScheduledLocation() === false`, camera non pending.

**Proposta:** definire una sola policy di interazione manuale. La soluzione più
semplice è una funzione del Reader, ad esempio `_interruptPlaybackForUserInput`,
che mette in pausa/stop il playback prima di cancellare la camera. Se il
prodotto richiede di continuare automaticamente, `PanelCameraExecutor.cancel()`
deve distinguere cancellazione utente e cancellazione tecnica e notificare il
coordinatore, che deve schedulare un fallback deterministico.

## Finding 4 — La cache `reveal-unavailable` viene cancellata a ogni pagina

**Priorità:** P1  
**File:** `client/src/views/Reader.bub.js:750-759`, `1034-1040`; `client/src/panel-page-analysis.js:127-133`

`_goToPage()` svuota tutto `_revealUnavailablePages`, non soltanto lo stato
della pagina precedente. I fallimenti OCR non restano nella cache di analisi:
`analyze()` rimuove la request fallita. Tornando a una pagina che ha già fallito
il reveal, l'app ritenta OCR e torna a bloccare `_panelsPending()` dietro un
lavoro spesso destinato a rifallire.

**Proposta:** non svuotare il Set durante la navigazione. Invalidarlo solo su
un'azione che cambia l'input dell'analisi (`retryReveal`, filtri OCR, cambio
sorgente/pagina reale) o introdurre una cache con asset id e policy di retry.

## Finding 5 — Le preferenze camera/timing possono non applicarsi alla pagina corrente

**Priorità:** P1  
**File:** `client/src/views/Reader.bub.js:1152-1162`; `client/src/panel-reader-controller.js:79-93`

Per camera strategy e timing, `onPreferenceChange()` chiama solo
`_rescheduleCurrentPagePanels()`. `reschedulePage()` restituisce `null` se
`pageData` o pannelli non sono ancora in cache. In quel caso la modifica cade
nel vuoto e la preparazione in corso completa usando le preferenze vecchie.

**Proposta:** far ritornare un esito esplicito da `_rescheduleCurrentPagePanels`;
se non può reschedulare, chiamare `_restartCurrentPagePreparation()`. In
alternativa, rendere la preparation generation dipendente da una versione delle
preferenze, per invalidare automaticamente lavori in volo.

## Finding 6 — Il preloader conserva download ormai inutili ancora in volo

**Priorità:** P1  
**File:** `client/src/reader-image-preloader.js:15-17`, `30-36`, `55-60`

`preload()` richiama `clear()` senza `releaseImages`, quindi la Map resta viva.
`_prune()` rimuove solo richieste già completate (`request.image === null`), non
quelle in flight. Sfogliando rapidamente, immagini non più utili finiscono il
download e attivano comunque `onLoad` e `_precalculatePanels()`.

**Proposta:** introdurre una richiesta cancellabile/abortibile, oppure rimuovere
le richieste non retained dalla Map e invalidare i rispettivi callback con un
token. Il preloading può conservare la cache del browser senza eseguire
precalcoli per pagine stale.

## Finding 7 — Fetch dei capitoli inutilmente sequenziale

**Priorità:** P2  
**File:** `client/src/views/Reader.bub.js:286-319`

`source` e `mangaId` sono già impostati a inizio `init()`, ma
`manga.chapters(source, mangaId)` parte solo dopo `detail` e `pages`. Non ha
dipendenze dai loro risultati, quindi ogni apertura paga un round-trip extra.

**Proposta:** avviare `chapters` nello stesso gruppo di promise, mantenendo il
suo fallimento non bloccante con una gestione per-promise (`allSettled` o catch
localizzato).

## Finding 8 — Query DOM ripetute nel pinch zoom

**Priorità:** P2  
**File:** `client/src/views/Reader.bub.js:165`, `524-541`, `1139-1141`, `1372-1396`

`_surface()` e `_getPagedImage()` fanno query DOM a ogni chiamata. In un tick di
pointermove con pinch, la catena `_setZoom()` → `_applyZoomLayout()` → refresh
di spotlight/reveal/debug può interrogare la surface circa otto volte.

**Proposta:** cachare la surface in `init()`; mantenere/invalidare un riferimento
all'immagine paged quando il ReaderPageStage cambia pagina o modalità. Evitare
cache globale dell'immagine se il child component può rimontarla senza segnale.

## Finding 9 — Tracking verticale O(N) a ogni evento scroll

**Priorità:** P2  
**File:** `client/src/views/Reader.bub.js:1341-1350`

Ogni evento scroll legge il rect della surface e quello di ogni pagina montata,
senza batching `requestAnimationFrame`. Il costo cresce col numero di immagini
montate e viene pagato alla frequenza nativa di scroll.

**Proposta:** usare una sola callback rAF pendente per frame; valutare
`IntersectionObserver` per tracciare la pagina corrente, evitando la scansione
completa.

## Finding 10 — Tre copie divergenti della guardia “immagine pronta”

**Priorità:** P3  
**File:** `client/src/views/Reader.bub.js:874`, `1000-1003`, `1021-1025`

Due call site richiedono `image.complete && image.naturalWidth`; il reschedule
controlla solo `naturalWidth`. Durante uno swap di `src`, la copia debole può
agire mentre le altre attendono.

**Proposta:** estrarre un helper `_readyPagedImage()` che restituisca immagine o
`null` e usarlo in tutti e tre i percorsi.

## Finding 11 — Wrapper vuoti e parametro morto

**Priorità:** P3  
**File:** `client/src/views/Reader.bub.js:862-864`, `1179-1181`, `621`, `682`

`_pausePlayback()` inoltra solo `this._playback.pause()`, ma altri call site
usano direttamente il controller. `_clearPreload(releaseImages = false)` ha un
solo call site, `destroy()`, che passa sempre `true`: il default non è usato.

**Proposta:** eliminare i wrapper o renderli il solo punto di ingresso con
semantica aggiunta. Qui è più semplice inlineare entrambe le chiamate e togliere
il parametro morto. Attinenza diretta alla regola favourite-coworker 10.

## Finding 12 — Duplicazioni con semantiche poco leggibili

**Priorità:** P3  
**File:** `client/src/views/Reader.bub.js:680-735`, `1314-1325`, `1441-1451`, `1489-1507`

- `zoomIn()` e `zoomOut()` sono identici salvo delta e log;
- l'oggetto per `PanelCameraExecutor.execute()` è duplicato quasi identico;
- `prevPage`/`nextPage` sono panel-aware, mentre `goToPreviousPage`/
  `goToNextPage` saltano deliberatamente quella logica, ma i nomi non lo
  dichiarano.

**Proposta:** estrarre `_zoomBy(delta, label)` e un builder degli argomenti
camera; rinominare i metodi di navigazione pura, per esempio
`skipToPreviousPage`/`skipToNextPage`, o documentare l'intento nei call site UI.

## Finding 13 — Errori di pre-calc pannelli invisibili

**Priorità:** P3  
**File:** `client/src/views/Reader.bub.js:1013-1019`, `1028-1032`

`_precalculatePanels()` fa `.catch(() => {})`, mentre il preloading OCR gemello
logga un warning. Il prefetch è non fatale e il percorso di preparazione reale
ritenta; il difetto è quindi minore, ma la telemetria/debug risulta incoerente.

**Proposta:** loggare in DEV o dietro `analysisDebug`, con deduplicazione per
pagina/asset, senza trasformare il prefetch in un errore utente.

## Finding 14 — API playback troppo esposta al Reader

**Priorità:** P3  
**File:** `client/src/views/Reader.bub.js:1183-1239`; `client/src/reader-playback-controller.js`

Reader legge direttamente `generation`, `isCurrent`, `canSchedule` e
`hasScheduledLocation`. I call site odierni sono corretti, ma la sicurezza delle
continuazioni async dipende da ricordarsi manualmente le guardie.

**Proposta:** esporre nel controller primitive di più alto livello, ad esempio
`runIfCurrent(generation, callback)` o una schedule che consegni un token/Abort
Signal. Camera, reveal e clock dovrebbero osservare lo stesso token del beat.

## Finding 15 — `Reader.bub.js` continua a fare troppe cose

**Priorità:** P3  
**File:** `client/src/views/Reader.bub.js:1-1564`

Dopo le estrazioni già esistenti, il componente contiene ancora:

- bridge DEV/test (`381-420`);
- gesture raw pointer/wheel/pinch (`472-613`);
- zoom e viewport math (`1372-1458`);
- orchestration route/page/panel/playback/reveal.

A 1564 righe, questo è il caso esatto della regola favourite-coworker 16:
proporre lo split prima che un file responsabile di più cose cresca ancora.

**Proposta:** estrarre prima un `ReaderGestureController` (event binding,
pointer/pinch, zoom/pan intent) e il bridge DEV. La matematica zoom può seguire
in un controller viewport; non spostare l'orchestrazione di prodotto finché i
contratti camera/playback/reveal non sono chiariti dai finding P0.

---

## Finding ritirati dalla review iniziale

Questi punti non devono essere implementati come bug:

1. **`panelSecondPass` non pulisce `_revealUnavailablePages`: falso.**
   Chiama `_restartCurrentPagePreparation()`, che fa il delete come prima
   istruzione (`Reader.bub.js:1118`).
2. **Guardia post-`await` senza check `mode === "panels"`: non è una race.**
   `setMode()` incrementa `_pagePreparationGeneration` e la seconda guardia la
   controlla; il cambio modo invalida già quel lavoro. Il primo check di mode è
   semmai ridondante.
3. **Overwrite del dev bridge: non è un finding utile.** `destroy()` rimuove il
   bridge solo se l'owner è l'istanza corrente (`Reader.bub.js:378`); il rischio
   restante è DEV-only e non giustifica complessità aggiuntiva.

## Direzione architetturale consigliata

I tre P0 condividono la stessa causa: camera, reveal e clock sono proprietari
di cancellazioni differenti ma non hanno un proprietario unico del beat.

Prima di ulteriori split, definire un contratto di `PlaybackBeat` con:

- token/generation condiviso;
- lifecycle esplicito: `framing`, `holding`, `completed`, `interrupted`;
- una sola policy per input utente (`pause`, `stop`, oppure `resume`);
- reveal che continua fra sub-location dello stesso beat;
- fallback deterministico per una pagina senza location.

Questo riduce gli stati impliciti che oggi permettono `preparing` senza timer,
reveal cancellati e pagine non schedulabili.
