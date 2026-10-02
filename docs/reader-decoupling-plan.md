# Reader decoupling plan

## Obiettivo

Ridurre `Reader.bub.js` a composition root TinyBubble e rendere indipendenti layout, camera, analisi, playback, reveal e debug.

`autoskip` diventa **playback**: Play/Pause è uno stato runtime, non un'opzione persistente.

## Concetti

- **Reading mode:** `vertical`, `paged-ltr`, `paged-rtl`, `panels`.
- **Camera strategy:** `classic` o `director`; funziona anche senza playback. Default: `director`.
- **Reading order:** direzione `rtl` o `ltr` usata per ordinare soggetti e movimenti.
- **Text policy:** solo dialoghi, esclusione parole singole e testo colorato.
- **Timing policy:** tempo basato su testo o area del pannello.
- **Effects:** reveal e barra di avanzamento.
- **Playback state:** `stopped`, `preparing`, `playing`, `paused`.

## Pipeline

```text
PageAnalysis
  -> ReadingSubjectSelection
  -> CameraPlan
  -> PlaybackSchedule
  -> Viewport + Reveal + Progress
```

Classic e Director devono produrre lo stesso contratto di location. La camera decide geometria e soggetti; lo scheduler assegna durate e avanzamento.

## Dipendenze

| Modifica | Ricalcolo |
|---|---|
| Camera o reading order | soggetti ordinati, camera plan, schedule |
| Filtri testo | soggetti, camera plan, schedule, reveal |
| Timing o velocità | schedule |
| Reveal mode | reveal units |
| Progress o debug | solo UI |
| Play/Pause | solo runtime |

Nessun timer deve avanzare se il playback non è `playing`.

## Confini

- `Reader.bub.js`: route, capitolo, chrome, modalità e coordinamento.
- `panel-page-analysis.js`: panel detection, OCR, balloon e cache grezza.
- `panel-reader-controller.js`: navigazione per location e composizione della pipeline.
- `panel-frame-planner.js`: strategia Classic pura.
- `panel-director.js`: strategia Director pura.
- `reader-playback-controller.js`: stato runtime, clock e progress.
- Estrazioni successive: scheduler, reveal controller e debug layer.

## Migrazione

1. Aggiungere una regressione: `overviewDuration` non avanza con playback fermo.
2. Rimuovere il legame tra `autoSkipEnabled` e camera Director.
3. Estrarre l'analisi grezza senza cambiare gli algoritmi.
4. Uniformare Classic e Director sul contratto comune.
5. Spostare timing e tutti i timer nel playback controller.
6. Aggiungere Play/Pause al chrome e rimuovere il toggle Autoskip.
7. Estrarre reveal e debug; eliminare i nomi `autoSkip*` residui.

## Decisioni

- Pause conserva tempo residuo, progress bar, stato del reveal e location corrente.
- `autoSkipEnabled` viene eliminato: il playback parte soltanto con Play e si ferma con Pause.
- Senza OCR, Director usa i pannelli rilevati e produce una sequenza geometrica di coverage, senza beat testuali né reveal.
