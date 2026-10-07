# Samples

Two Walk Editions made with this repository on one laptop (Apple M5 Max, 64 GB), `gemma4:e4b` through Ollama and Kokoro-82M on the CPU. Each folder holds the MP3, the script the voice reads (with times) and the run's `meta.json`. You can hear both on the [project page](https://nazboyko.github.io/tabs-to-trails/).

| Sample | Source | Asked for | Measured | Halfway cue | Words in source / script | Sections | Model | Voice |
|---|---|---|---|---|---|---|---|---|
| [`dev-post/`](dev-post/) | The author's own DEV post | 10:00 | 10:15 | 5:11 | 1,726 / 1,531 | 2 in full, 2 condensed | 4.1 s | Heart, 63.5 s |
| [`thoreau-walking/`](thoreau-walking/) | Henry David Thoreau, "Walking" (1862), part one | 20:00 | 19:39 | 9:45 | 3,160 / 3,160 | 3 in full | 0.7 s | George, 159.2 s |

The DEV post was condensed to fit ten minutes; its challenge submission line and Prize Categories section are left out. Thoreau's part one fits twenty minutes, so it is read as written.

## The Thoreau text

`thoreau-walking/source.md` is the first 24 paragraphs of "Walking", which is in the public domain, from Project Gutenberg's plain-text edition (eBook #1022) with the distributor's header, footer and license removed. It ends at "Let us improve our opportunities, then, before the evil days come." The rest of the essay is left out because it uses 1862 language about race and peoples that does not belong on this page.

## Making them again

```
npm run walk -- https://dev.to/nazar-boyko/my-six-year-old-cant-do-five-things-at-once-so-his-screen-shows-one-o1m --minutes 10
npm run walk -- samples/thoreau-walking/source.md --minutes 20 --voice george
npx tsx scripts/save-sample.ts <walk-id> <folder>
npm run docs
```

A small model does not give the same text twice, so a new run gives a slightly different script and length.
