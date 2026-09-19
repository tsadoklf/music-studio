# web/ — the studio page

The bench as the browser sees it: one `index.html`, two stylesheets, the five
`studio-*.js` files that are the application, and `widgets/`, the meter bank.

These were one 5,591-line `studio.js`. Same code, same behaviour, split so each
part is a file you can open on its own. **Splitting it failed three times before
this; the reasons are below and they are the point of the arrangement.**

## The files, in load order

`index.html` loads them in exactly this order. Order matters: each file uses what
the ones above it defined.

| # | File | Lines | What it is |
|---|---|---|---|
| 1 | `studio-core.js` | 312 | Colour maps and small maths (`clamp`, `lerp`, `dbfs`, `inferno`, the number and time formatters), the VU ballistics (`VuMovement`, a second-order damped response), and loudness to ITU-R BS.1770-4 — `LoudnessMeter`, the K-weighting filters, gated integration, and `truePeakOf` at 4× oversampling. Depends on nothing. |
| 2 | `studio-draw.js` | 633 | The instrument faces: the VU dial, the dBFS bar meters, correlation, the spectrum on a log axis, and the `Spectrogram`. Plus the canvas helpers `hasArea` and `fitCanvas`. Uses 1. |
| 3 | `studio-engine.js` | 930 | The WebAudio `Engine`: decode and transport, the two EQ chains, the rack router, the soft-clip and hard-ceiling curves, and the adapter that lets a precomputed `analyze.py` JSON drive the same meters as live audio. Uses 1. |
| 4 | `studio-verdicts.js` | 142 | The delivery targets and the four whole-file verdicts — loudness, clipping, codec cutoff, phase. Uses 1. |
| 5 | `studio.js` | 3,676 | The wiring: the frame loop, file loading, transport, the musical readouts, the splitter, the timed findings, reset, collapse, the chat, the layout and drag-and-drop, workspaces, and `boot()`. Uses 1–4. |

Then `widgets/` — see `widgets/README.md`, which has its own load order and its
own namespace.

### Why `studio.js` keeps its name, and stays last of the five

Two reasons, both load-bearing:

- `cli.py` injects the preloaded analysis by finding the literal string
  `<script src="studio.js"` and writing a `<script>` block immediately before
  it (`music_studio/cli.py`, `_write_scope_page`). The marker has to still be
  there, and it has to sit after the other four, because the injected globals
  must be set before `boot()` reads them.
- It is the file that boots the page, so on the dependency order alone it comes
  last anyway.

## How the files see each other

Each file is its own IIFE over one shared namespace object, published at the foot:

```js
(function (__S) {
'use strict';
  /* ... */
Object.assign(__S, { drawVu, drawBars });   // publish what this file defines
})(window.__studio || (window.__studio = {}));
```

A file reaches another file's symbols through `__S`: `__S.clamp(...)`,
`__S.drawVu(...)`, `new __S.Engine()`.

**The namespace is `window.__studio`, deliberately NOT `widgets/`'s
`window.__studioWidgets`.** They are two separate transports for two separate
sets of files, and several names exist in both with different definitions
(`clamp`, `lerp`, `hasArea`, `fitCanvas`, `fToT`, `fmtHz`, `fmtLu`, `fmtTime`,
`INFERNO`, `SPEC_LABELS`). Merging the namespaces would recreate, one level
down, exactly the collision the IIFEs exist to prevent.

`__S` is short for studio and appears nowhere in the original source, so it
cannot be shadowed by a local. (`widgets/` uses `__W` for the same reason: its
code uses `S` and `W` as ordinary local names.)

**References go through `__S` at the point of use, never destructured at the top
of a file.** This is not a style preference, it is the thing that makes the split
work: `__S` fills up progressively as the scripts load, so

```js
const { drawVu } = __S;     // WRONG at the top of a file
```

captures `undefined` for anything a later file defines, and breaks the moment the
load order changes. Writing `__S.drawVu` at call time reads the property when the
call happens, by which point every file has run.

### The one mutable binding

`TARGET_LUFS` and `TP_CEILING` are the delivery targets. They are declared in
`studio-verdicts.js`, **reassigned** by `applyTargets()` when an analysis JSON
carries its own targets, and read from `studio.js`. A `let` cannot be shared
across files by value — publishing it onto the namespace would copy the number
once and the copy would never change — so these two live on the namespace as
properties:

```js
__S.TARGET_LUFS = -14;                       // studio-verdicts.js
__S.TARGET_LUFS = t.integrated_lufs;         // applyTargets() writes through
const d = itg - __S.TARGET_LUFS;             // studio.js reads through
```

Every read and every write goes through `__S`, so there is exactly one storage
location. Anything else that becomes reassignable across a file boundary must be
handled the same way.

`TARGET_SOURCE` is written but never read outside its file, so it stays an
ordinary `let`.

## The public interface

Unchanged by the split, and checked in the tests:

| Global | Set by | What it is |
|---|---|---|
| `window.engine` | `studio.js` | The audio graph, so the Equalizer and rack panels can make a knob audible |
| `window.StudioAnalysis` | `studio.js` | The loaded analysis JSON, or null |
| `window.seekTo` | `studio.js` | Transport seek, for the timeline rows |
| `window.StudioEq`, `StudioEq2`, `StudioRack`, `StudioMeters` | `widgets/` | The meter bank's four panels |

`window.__studio` and `window.__studioWidgets` are the two transports. They are
not part of the public interface.

Nothing else is global. Before the split the page put **147** names on `window`;
it now puts **8** — the seven above plus `__studio`. A leaked internal is not
harmless: it is the collision surface that broke the three earlier attempts.

## Why classic scripts and not ES modules

The studio has to open by double-clicking `index.html` — straight from `file://`,
with no server and no build step. Under `file://` a browser treats every file as
a distinct opaque origin, so `import` is blocked by CORS and a
`<script type="module">` page loads nothing at all. Classic `<script>` tags have
no such restriction.

That constraint is the whole reason for the IIFE-plus-namespace arrangement: it
is what ES modules would have given for free, done with what `file://` allows.
`tests/test_web_assets.py` fails the build if a `type="module"` or a top-level
`import`/`export` appears.

## Why the IIFEs cannot be dropped

Classic scripts share **one** global scope, and a top-level `const` in one script
collides with the same name in another: `Identifier 'clamp' has already been
declared`, and the second script then never runs. The symptom is a blank panel
and one line in a console nobody is looking at.

The old `studio.js` was not wrapped, and declared 231 names at genuine top-level
script scope — `clamp`, `lerp`, `INFERNO`, `SPEC_LABELS`, `fmtTime`, `fmtLu`,
`hasArea`, `fitCanvas`, `fToT`, `fmtHz` and more. Several of those are also
declared, with different bodies, in `widgets/`. The single IIFE around the old
`meters.js` is what kept the two apart.

Now every file here has its own. Do not remove them, and do not add a top-level
declaration outside one.

## The three failures this arrangement is built to prevent

Recorded so the fourth attempt does not repeat them:

1. **An IIFE cannot span files.** Wrapping the whole thing in one IIFE and
   cutting it in half produces two syntactically invalid files. Each file gets
   its own complete IIFE.
2. **A namespace destructured at the top loses cross-file references.**
   `const { drawVu } = __S;` captures `undefined` for anything defined by a file
   that loads later. References are `__S.drawVu` at the point of use.
3. **Shared scope collides.** A top-level `const clamp` in two files throws and
   the second file silently never runs. Nothing is declared at top level any
   more; the IIFEs are what guarantee it.

## A trap for anyone editing these files with a script

**This code writes function bodies UNINDENTED.** In `studio.js`:

```js
function isToneRequest(text) {
const s = String(text || '').trim();        // <- a LOCAL, at column 0
```

`const s` at column 0 is a local inside `isToneRequest`, not a top-level
declaration. Any regex or `sed` tool that assumes indentation marks scope will
corrupt these files. A line-based count reports 228 top-level declarations where
a brace-depth scan finds 75 and a real parser finds 231 including the ones inside
template literals.

Verify scope with a parser or by brace depth, never by indentation.
`tests/test_web_assets.py` does the brace-depth version; the split itself was done
with the TypeScript parser's AST, which is what caught `VU_MAX` hiding inside a
template-literal interpolation that a regex scan had missed.

## Changing things

- **Adding a symbol another file needs:** declare it as usual, add it to that
  file's `Object.assign(__S, { ... })`, and reference it as `__S.name` from the
  other file — at the point of use.
- **Adding a file:** same pattern, and a `<script>` tag in `index.html` at the
  right point in the dependency order. Anything the wiring uses goes before
  `studio.js`.
- **A value that gets reassigned across files** goes on the namespace as a
  property, like `TARGET_LUFS` above. Publishing it by value will silently
  freeze it at its initial value.
- **Never** add a top-level declaration outside an IIFE, and never widen the
  global surface beyond the seven names in the table above.

## What checks this

`tests/test_web_assets.py`, in the ordinary Python suite:

- no two scripts declare the same top-level name (the failure that killed three
  attempts)
- every widget file is wrapped in its namespace IIFE
- every script and stylesheet `index.html` names actually exists
- `core.js` is the first widget and `tray.js` the last
- nothing is an ES module and no file uses `import`/`export`

`vu-sizes.html` is a scratch page that draws the VU bridge at several sizes using
these files' own `__studio.drawVu`, `drawBars` and `drawCorrelation`, so it is a
second consumer worth re-checking after a change here.
