# footprintjs-ml

**Status: Beta — APIs may change.** This repository currently presents the interactive story and saved evidence. An installable SDK has not been published yet.

[**Open the interactive ML story →**](https://footprintjs.github.io/footprintjs-ml/#1)

A visual exploration of how FootPrint can coordinate ML workflows and explain model-release mistakes using saved execution evidence. The twelve-chapter story builds a growing map of model references, evaluation receipts, trainer adapters, release guards and investigation tools.

This initial repository publishes the story and its supporting evidence. The experimental library described in the examples is a private v0.5.0 prototype; this repository does not yet provide an installable SDK or an npm release.

## Explore

- [Visual story](https://footprintjs.github.io/footprintjs-ml/#1)
- [Full technical story](https://footprintjs.github.io/footprintjs-ml/technical-story.html#1)
- [Evidence ledger](docs/EVIDENCE.md)
- [Public file integrity manifest](docs/publication-manifest.json)
- [FootPrint](https://github.com/footprintjs/footPrint)

Use Next and Back to move through the story. The graph supports dragging, revisiting earlier chapters, and pausing motion. More detail opens the technical explanation and recorded evidence.

## Hosting and updates

GitHub Pages serves `docs/` from `main`. The HTML views embed their scripts, styles and diagrams; viewing them does not run training or call a backend. Keep the evidence files beside the HTML views.

To update the story, replace `docs/` with a fresh verified public export, check the files against `docs/publication-manifest.json`, then push the update. The published-copy checksums cover the public bytes. Original retained-source checksums are labeled separately because personal local paths were removed from nine evidence JSON copies.

## Scope

Numerical tools perform training and determine accuracy. These local examples explore evidence identity, data use, model selection, release checks and saved investigation. They do not establish distributed release guarantees, production readiness, or a measured human debugging advantage over complete structured logs.

The project is MIT licensed. The embedded StoryDeck runtime has its [MIT notice](docs/STORYDECK-LICENSE.txt).
