# Review consolidata — `Reader.bub.js`

**Data:** 2026-07-21  
**Stato:** review read-only; nessun file di produzione è stato modificato.  
**Scopo:** unifica le review di `Reader.bub.js` sull’automazione pannelli, Director, OCR/reveal, autoplay, preload, gesture e conformità alle regole favourite-coworker.

## Ambito verificato

- `client/src/views/Reader.bub.js`
- `panel-reader-controller.js`, `panel-page-analysis.js`
- `panel-camera-executor.js`, `panel-reveal-controller.js`
- `reader-playback-controller.js`, `reader-image-preloader.js`
- Director, scheduler e stage TinyBubble correlati
- fullfill e typecheck disponibili

## Sintesi

La direzione della rewrite è buona:

- responsabilità rilevanti sono già estratte in controller dedicati;
- `_pagePreparationGeneration` evita che analisi stale pubblichino UI della pagina sbagliata;
- `destroy()` libera listener, timer e controller;
- un errore OCR degrada alla geometria dei pannelli invece di rendere inutilizzabile Panels mode;
- l’uso TinyBubble è coerente: template con root unica, props/emits e child component già separati.

Il rischio principale è però l’orchestrazione. Camera, clock playback, reveal e input utente cancellano lavoro con contratti differenti. Prima di ulteriori split, deve esistere un lifecycle esplicito del beat: `framing`, `holding`, `completed`, `interrupted`, con token condiviso e una sola policy per l’input manuale.

## Priorità

| Priorità | Finding |
| --- | --- |
| P0 | 1–6 |
| P1 | 7–15 |
| P2 | 16–21 |
| P3 | 22–28 |

---

## P0 — blocchi di correttezza

### 1. Cancellare la camera può bloccare autoplay in `preparing`

**Evidenza:** `Reader.bub.js:472-477, 490-496, 1258-1325, 1428-1452, 1489-1517`; `panel-camera-executor.js:27-71`; `reader-playback-controller.js:94-98`.

**Scenario:** un autoplay entra in `preparing` e avvia il tween camera. Wheel, pointer/pinch, zoom o reset zoom chiamano `PanelCameraExecutor.cancel()`. Il cancel rimuove il rAF senza chiamare `complete()`: `_continueAfterPanelFrame()` non pianifica l’hold, mentre playback resta `preparing` e Screen Awake rimane attivo.

Il resize ha una variante precisa dello stesso difetto: `_onReaderResize()` sostituisce il tween con `PanelCameraExecutor.execute()` istantaneo, ma non passa `complete`. L’esecuzione nuova cancella il rAF precedente e termina nel callback no-op di default; non viene quindi schedulato né l’hold né il pannello successivo.

**Fix minimo:** un solo percorso Reader per l’interruzione manuale: mettere in pausa o fermare playback *prima* di cancellare la camera. Se il resize deve preservare autoplay, l’esecuzione istantanea deve chiamare `_continueAfterPanelFrame(location, index)` solo quando sta sostituendo una transizione ancora in `preparing`; non deve duplicare un dwell già in `playing`.

**Regressione richiesta:** interrompere una transizione autoplay, incluso un resize durante il tween, e verificare che `preparing` implichi sempre una camera o un timer pendente.

### 2. Il reveal si annulla nel passaggio `reading-pan-lead` → `reading-pan-travel`

**Evidenza:** `Reader.bub.js:1202-1238, 1258-1325`; `reader-playback-controller.js:94-98, 172-185`; `panel-reveal-controller.js:84-100, 192-202`; `panel-playback-scheduler.js:45-65`.

**Scenario:** il lead riceve un reveal lungo quanto il beat di lettura; il travel seguente chiama `_framePanel()`, resetta il clock e quindi `cancelSchedule()` sul reveal. Timer e WAAPI animation attive vengono cancellati, mentre travel non possiede reveal unit da continuare.

**Fix minimo:** lead e travel devono essere un unico beat logico per clock/reveal, oppure il reset deve preservare il reveal quando la location successiva continua lo stesso balloon/reveal unit.

**Regressione richiesta:** balloon orizzontale lungo con reveal attivo dall’inizio del lead alla fine del travel.

### 3. Il Director può produrre zero location e bloccare autoplay

**Evidenza:** `panel-director.js:93-98`; `Reader.bub.js:929-936, 1280-1284`.

**Scenario:** un pannello senza balloon, oppure l’uso di filtri come `dialogueOnly`, può produrre shot ma `beats: []`, quindi `locations: []`. In manuale si torna alla pagina intera; in autoplay `_framePanel(0)` ritorna senza schedulare nulla e playback può restare `preparing`.

**Fix minimo:** ogni pagina con pannelli deve produrre almeno una location navigabile, anche solo coverage/overview. In parallelo `_prepareCurrentPagePanels()` deve trattare esplicitamente `locations.length === 0`: pagina intera, stop coerente o avanzamento deterministicamente definito.

**Nota:** il caso non è apparso nel capitolo live controllato, ma è confermato dal flusso statico.

### 4. Una navigazione capitolo stale può sovrascrivere l’ultima scelta dell’utente

**Evidenza:** `Reader.bub.js:1525-1555`.

**Scenario:** Next Chapter, poi Back o Previous Chapter in rapida sequenza. Ogni `_jumpChapter()` attende `manga.chapters()` senza token e senza guardia `_destroyed` post-await. Una richiesta vecchia risolta per ultima può eseguire `router.navigate()` dopo una scelta più recente o dopo destroy.

**Fix minimo:** token monotono di chapter navigation, invalidato in `destroy()`, da verificare dopo `await` prima di navigare.

### 5. Il second pass detection ha una race con la propria invalidazione

**Evidenza:** trigger `Reader.bub.js:1152-1156`; cache `panel-page-analysis.js:53-83, 159-165`; composizione `panel-reader-controller.js:42-70`.

**Scenario:** cambiare `panelSecondPass` mentre il primo rilevamento è in volo fa `clearPage()`, ma non invalida la Promise vecchia. La richiesta vecchia può poi scrivere `_panels` o cancellare la request map di una richiesta nuova; la pagina attiva può essere composta con opzioni obsolete.

**Fix minimo:** request version per pagina, oppure chiave cache formata da asset e opzioni detection normalizzate. `then` e `finally` devono mutare la cache solo se possiedono ancora la versione corrente.

### 6. `panelSecondPass` non si applica alle pagine già precaricate

**Evidenza:** preload `Reader.bub.js:182-185, 1013-1019`; invalidazione solo corrente `1152-1156`; cache option-insensitive `panel-page-analysis.js:53-55`.

**Scenario:** N+1 viene calcolata con l’opzione precedente. Modificare la preferenza invalida solo la pagina visibile; su N+1 `getPanels()` restituisce la cache vecchia prima di leggere le nuove opzioni.

**Fix minimo:** cache key con detection options normalizzate, oppure invalidazione globale delle pagine preparate quando cambia il second pass.

---

## P1 — stabilità e performance rilevanti

### 7. Stato OCR-unavailable dimenticato a ogni cambio pagina

**Evidenza:** `Reader.bub.js:750-759, 892-900, 1034-1040, 1117-1137`; `panel-page-analysis.js:127-133`.

`_revealUnavailablePages.clear()` elimina il fallback noto. Tornando a una pagina OCR-failed viene ritentato OCR e il Reader può tornare in attesa.

**Fix:** mantenere lo stato per asset/pagina fino a Retry esplicito o a una modifica che renda davvero sensato ritentare.

### 8. Cambi preferenze persi mentre la preparation è pending

**Evidenza:** `Reader.bub.js:1000-1011, 1152-1162`; `panel-reader-controller.js:79-93`.

`reschedulePage()` può restituire `null` prima che pageData/pannelli siano cacheati; Reader ignora l’esito e la preparation in corso completa con vecchie preferenze, mentre la UI mostra quelle nuove.

**Fix:** far restituire un esito a `_rescheduleCurrentPagePanels()` e riavviare preparation quando non può reschedulare. Una preference version nel token rende l’invariante esplicita.

### 9. Il preload genera OCR speculative non cancellabile

**Evidenza:** `Reader.bub.js:182-185, 1013-1019`; `paddle-tiny-ocr.js`; `panel-page-analysis.js`.

Il preload avvia analisi completa inclusa OCR. Le guardie Reader evitano la pubblicazione di risultati stale ma i job restano nella coda seriale OCR e consumano CPU dopo navigazione rapida o uscita dal Reader.

**Fix:** session generation o `AbortSignal` fino allo scheduler OCR; eliminare i job non correnti prima dell’inferenza e mantenere solo current page più look-ahead limitato.

### 10. Download immagini stale in flight non vengono rilasciati né limitati

**Evidenza:** `Reader.bub.js:781-782, 866-868`; `reader-image-preloader.js:15-17, 30-36, 55-60`.

`clear()` cancella solo il timer; `_prune()` elimina solo immagini già completate. Paginando più rapidamente della rete, ogni vecchia pagina look-ahead resta nella Map e continua il download: la coda nominale di due pagine può quindi aprire un numero non limitato di richieste. Anche `clear(true)` svuota la Map senza rimuovere handler o sorgente dell’immagine, quindi le richieste pendenti possono trattenere il Reader distrutto fino al completamento e invocare ancora `onLoad`.

**Fix:** al prune/release, rimuovere `onload`/`onerror`, impostare `image.src = ""` per le richieste pendenti e rimuoverle dalla Map. Conservare solo current/next/after-next; la cache browser può restare utile senza permettere download e analisi stale.

**Regressione richiesta:** con immagini fake non risolte, cambiare rapidamente `currentIndex` e poi distruggere il preloader; verificare che richieste e callback obsolete siano cancellate e che la coda resti limitata.

### 11. Overlay reveal ricostruito ogni frame camera

**Evidenza:** `Reader.bub.js:1314-1325, 1372-1404`; `panel-reveal-controller.js:260-299`.

Ogni `_setZoom()` aggiorna layout reveal e ricrea object/style per tutte le box OCR, poi pubblica una nuova array reattiva. Con molte box aumenta GC e reconciliation nel tratto che deve restare fluido.

**Fix:** cache dei dati per-box; durante camera/zoom aggiornare solo la geometria del container. Ricostruire box solo a cambiamento sources, reveal state o debug timing.

### 12. Tracking verticale O(N) a ogni scroll

**Evidenza:** `Reader.bub.js:1341-1350`; `ReaderPageStage.bub.js:20-23`.

Ogni scroll nativo interroga tutte le immagini e legge tutti i rect.

**Fix:** almeno un rAF pendente per frame; preferibilmente `IntersectionObserver` per aggiornare solo le pagine che cambiano visibilità.

### 13. Cache analysis senza limite sul capitolo e scritture post-destroy

`PanelPageAnalysisService` e `PanelReaderController` trattengono linee OCR, balloon, piani camera e schedule per tutte le pagine visitate/precaricate fino a destroy. Su un capitolo lungo, memoria e costo del preloading crescono quindi con ogni pagina letta.

Inoltre, `destroy()` pulisce le Map ma non invalida i job già in volo: dopo gli `await`, `preparePage()` e il servizio di analisi possono scrivere nuovamente cache nel controller ritirato. La UI ignora il risultato grazie alle guardie Reader, ma l’istanza resta trattenuta dal lavoro pendente fino al completamento.

**Fix:** LRU/window limitata a current, look-behind e look-ahead; non evictare pagine pending. Aggiungere anche una generation di disposal a controller e servizio: dopo ogni `await`, un job obsoleto deve terminare senza mutare cache.

**Regressione richiesta:** attraversare molte pagine e verificare una dimensione cache limitata; distruggere il Reader con OCR/detection deferred, risolverli poi e verificare che le cache restino vuote.

### 14. Resize non coalesced

**Evidenza:** `Reader.bub.js:1428-1453`.

Un resize esegue layout, projection reveal/debug, reschedule e camera execute a ogni evento nativo.

**Fix:** coalescing con singolo rAF o debounce trailing prima del reposition camera.

### 15. rAF Reader possono sopravvivere a destroy

**Evidenza:** `Reader.bub.js:439-449, 775-780, 1513-1516`.

Frame di setMode, navigazione e reset zoom non hanno guardia `_destroyed` né ID cancellato.

**Fix:** guardia all’inizio dei callback o helper per tracciare/cancellare i frame Reader-owned in destroy.

---

## P2 — miglioramenti concreti

### 16. Fetch chapter evitabilmente sequenziale

**Evidenza:** `Reader.bub.js:286-319`.

`manga.chapters(source, mangaId)` non dipende da detail/pages ma parte solo dopo di essi.

**Fix:** avviarlo nello stesso gruppo di Promise; il suo fallimento resta non bloccante con catch locale/allSettled.

### 17. Guardie “immagine pronta” divergenti

**Evidenza:** `Reader.bub.js:874, 1000-1003, 1021-1025`.

Alcuni percorsi richiedono `complete && naturalWidth`, il reschedule solo `naturalWidth`. Durante swap `src`, la guardia più debole può agire prima del caricamento completo.

**Fix:** `_readyPagedImage()` restituisce immagine o `null` e viene usato nei tre percorsi.

### 18. Errori pre-calc nascosti

**Evidenza:** `Reader.bub.js:1013-1019`; confronto `_preloadPanelOcr()`.

`_precalculatePanels()` usa `catch(() => {})`. Il prefetch è non fatale, ma il silenzio rende difficile capire quando non ha fornito valore.

**Fix:** warning deduplicato solo in DEV o quando `analysisDebug` è attivo.

### 19. Query DOM ripetute nei gesti e nel pinch

**Evidenza:** `_surface()` a `Reader.bub.js:165`, gesti `472-555, 598-613`, layout `1372-1396`.

**Fix:** cache della surface in `init()` o almeno una volta per handler. Non cacheare globalmente l’immagine paged senza un’invalidazione esplicita, perché il child può rimontarla.

### 20. Progress update per ogni pagina senza last-write-wins

**Evidenza:** `Reader.bub.js:750-783, 1358-1369`.

Autoplay e navigazione rapida emettono più update fire-and-forget, incluso un ulteriore save in destroy; possono creare lavoro rete/server inutile e completare fuori ordine.

**Fix:** sender serializzato/debounced che conserva solo l’ultimo payload e fa flush in destroy.

### 21. Copertura insufficiente dell’orchestrazione Reader

Esistono fullfill mirati dei controller, ma non un harness della view che verifichi cancellazione camera, race route chapter, preference pending e invalidazione detection.

**Fix:** fullfill Reader-level con fake camera/playback/router, oppure estrazione di un orchestratore piccolo e testabile.

---

## P3 — conformità favourite-coworker e cleanup

### 22. `Reader.bub.js` ha ancora troppe responsabilità

A 1.563 righe contiene bridge DEV, gesture pointer/wheel/pinch, matematica viewport/zoom, route/page orchestration e playback/reveal.

**Direzione:** non spezzare ulteriormente prima di P0. Dopo, estrarre prima `ReaderGestureController`, bridge DEV e poi un controller viewport/zoom.

### 23. Wrapper vuoti e alias inutili

- `_pausePlayback()` (`1179`) inoltra solo `this._playback.pause()` ed è usato in modo incoerente rispetto ai call site diretti.
- `_clearPreload(releaseImages = false)` (`862-864`) ha un solo call site che passa sempre `true`.
- `detectedPanel` seguito da `sourcePanel = detectedPanel` (`1287-1290`) non trasforma il dato.

**Fix:** inline, oppure rendere il wrapper il solo punto d’ingresso con una semantica reale.

### 24. Contratti JSDoc insufficienti

Solo `_framePanel()` documenta input complessi. Metodi come `_goToPage`, `_schedulePlayback`, `_panelPreparationInput` e `_prepareCurrentPagePanels` richiedono contratti JSDoc espliciti, come previsto dalle regole locali per `.js`.

### 25. Errori silenziosi con impatto prodotto

Le letture/scritture localStorage possono degradare tranquillamente ai default se tale fallback è spiegato. Invece il catch di `manga.chapters()` intorno a linea 319 può disabilitare la navigazione capitoli senza diagnosi.

**Fix:** almeno log DEV o stato osservabile per il fallimento di navigazione.

### 26. Duplicazioni minori

`zoomIn()` e `zoomOut()` sono quasi identici; anche l’input per `PanelCameraExecutor.execute()` è duplicato tra frame e resize.

**Nota:** non estrarre helper generici prima dei fix P0. Se la duplicazione resta dopo, `_zoomBy(delta, label)` e un builder dell’input camera possono meritare il nome.

### 27. Nomi della navigazione non esplicitano il salto pannelli

`prevPage`/`nextPage` sono panel-aware; `goToPreviousPage`/`goToNextPage` saltano intenzionalmente la logica panel. I nomi non chiariscono la differenza.

**Fix:** rinominare i comandi di skip puro o documentare l’intento ai call site UI.

### 28. Stile locale

- Mix `var`, `let` e `const` senza una ragione evidente.
- `_surface()` chiamata in `destroy()` assume che il DOM stage sia ancora presente; l’ordine attuale funziona, ma un riferimento cacheato rende il teardown meno fragile.

**Nota:** non ci sono `??` né optional chaining concatenato nel file.

---

## Validazione

- `node fullfill/panel-playback-scheduler.mjs` è stato riprodotto come fallimento: atteso `['entry', 'reading']`, ottenuto `['reading', 'reading-pan']`.
- I controller hanno fullfill dedicati utili, ma manca una prova funzionale diretta dell’orchestrazione della view.
- La review precedente ha verificato un capitolo MangaDex live di 20 pagine: il blocco autoplay da interazione manuale è stato riprodotto; zero-location e reading-pan non erano presenti in quel campione.

## Finding ritirati

Non implementare come bug i seguenti punti, già ricontrollati:

1. `panelSecondPass` non pulirebbe `_revealUnavailablePages`: falso; `_restartCurrentPagePreparation()` la elimina per la pagina corrente.
2. La guardia post-`await` non controllerebbe mode panels: non è una race pratica, perché `setMode()` incrementa `_pagePreparationGeneration` e invalida già il lavoro.
3. L’overwrite del bridge DEV non è un finding utile: destroy rimuove il bridge solo se ne è ancora owner.

## Ordine di implementazione consigliato

1. Lifecycle condiviso del playback beat e policy input/camera.
2. Reveal continuo attraverso `reading-pan`.
3. Fallback esplicito per zero location.
4. Token per chapter navigation e request version per panel detection.
5. Correggere/decidere il contratto del fullfill scheduler e aggiungere regressioni Reader-level.
6. Cache key/preload cancellabile/LRU e ottimizzazioni overlay/scroll/resize.
7. Split gesture/viewport e cleanup favourite-coworker.
