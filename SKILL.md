---
name: song-shop
description: Produce and publish music tracks for Tsadok's channels (Le Bal Musette, Camille Marceau). Use when working on a song — writing its spec, generating in Suno, mastering, rendering video, or publishing to YouTube. Triggers include mentions of a track slug, song.md, the music CLI, Suno prompts, mastering, or uploading a track. Do not use for general music theory questions or listening recommendations.
---

# Song shop

> **Working on the tooling itself?** Read `STATUS.md` first — it is the
> whole-system view: what exists, what is proven, what is known-broken, and the
> invariants that will bite you. This file covers the song workflow; that one
> covers the machine.


Tsadok produces music with Suno and publishes it to two YouTube channels. Each song
is a folder with a `song.md` holding everything about it: the Suno inputs, the musical
spec, the background research, and the publishing metadata. A CLI handles the
deterministic parts of the pipeline.

**Your job is the parts that need judgment** — writing lyrics and style blocks,
diagnosing why a render came out wrong, deciding whether a take is good. **The CLI's
job is everything mechanical.** Never do by hand what `music` does.

## Layout

```
<audio-root>/                 whatever you point --root at
  <artist>/
    tracks/<slug>/
      song.md
      masters/master.wav, masters/takes/take-NN.wav
      artwork/, video/
```

The tooling does not care what the artists are called or how many there are;
`--root` and the file arguments are the whole interface to the audio.

Slugs are kebab-case. Display titles with accents and feat. credits live inside
`song.md`, never in paths.

## The CLI

```
music doctor                          check dependencies
music new <slug> --channel <channel>  scaffold a track folder
music check <track>                   validate publishing metadata
music measure <audio>                 loudness, true peak, range
music studio <file> [--open|--serve]  one step: analyse, report, advise
music scope <track> [--open] [--advise]  analysis JSON only
music advise <track> [--ask "..."]    what the numbers mean, and what to run
music serve <root> [--read-only]      the music studio, wired to the CLI
music master <track> [--eq <preset>]  take -> masters/master.wav
music maximize <track> --preset loud  compressor, imager, maximizer, soft clip
music compare <track> --null diff.wav numeric diff + a residue you can listen to
music video <track>                   render MP4 + thumbnail
music publish <track> [--update]      YouTube upload or metadata edit
```

Commands accept a track directory or the `song.md` inside it.

## Pipeline order

Mastering must happen **before** upload. YouTube cannot replace a video file on an
existing upload — fixing audio later means deleting and re-uploading, losing the URL,
views and comments. Never let a song reach `publish` with `status` below `mastered`.

```
music new <slug> --channel <channel>
  → write the Score and Style into song.md
  → Tsadok generates in Suno, drops takes into masters/takes/
music master <track>
music compare <track> --null /tmp/diff.wav      # confirm mastering did something
music scope <track> --open --advise             # look at it, and ask what to do
music video <track> --pad-colour '#F5EBDC'      # cream, if artwork is square
music check <track>
music publish <track> --dry-run
music publish <track>                            # lands private
music publish <track> --update --privacy public  # after listening
```

The upload writes `video_id` back into the frontmatter, so later edits are just
`music publish <track> --update`.

## Suno field mapping

Create → Advanced. Three fields, filled from `song.md`:

| Suno field | Section of song.md |
|---|---|
| Song Title (Optional) | the title block — always set it, never let Suno invent one |
| **Lyrics** | the **Score** block — section tags and sung text |
| Style | the Style block, verbatim, under 1000 characters |
| Save to… | the workspace named in Settings |

Plus More Options → Max Mode, Vocal Gender, Duration, Weirdness, Style Influence,
Exclude styles — all recorded per song in the Settings table.

## Ask before the first generation of a session

1. Which tracks this session?
2. Max Mode on or off? Default On; it changes the credit cost.
3. How many takes per track? Default 2.
4. New generations, or Extend/Cover of an existing take?
5. Does the target Suno workspace exist yet?

## Rules

- **Paste specs verbatim.** Never silently reword a style block. Propose changes and
  write them into `song.md` instead.
- **Never name a film, composer, artist or recording in a prompt.** Describe the idiom —
  instrumentation, tempo, meter, rhythm feel, recording character. Terms-of-service
  matter, and it produces better results anyway.
- **Never upload third-party audio as a Suno reference.** Only Tsadok's own material.
- **Takes are append-only.** Raw Suno exports go in `masters/takes/` and are never
  edited. Anything assembled or processed is a master.
- **Record why.** When a take is chosen or a master assembled, write the reason in
  song.md. Timings are recoverable; reasoning is not.
- **Don't invent tracks or titles** to fill out a set.

## Diagnosing bad renders

| Symptom | First move |
|---|---|
| Voice missing entirely | Vocal Gender may be overriding the prompt — unset it |
| Two voices collapse to one | Split into two generations and join in the DAW |
| Meter flattens to 4/4 | Name the palo or dance form, not the beat count |
| Free-time intro truncated | Generate the intro separately and splice |
| Modal colour lost | Push the interval (augmented second, raised fourth), not the mode name |
| Muddy | Subtract. Name one instrument as the only low voice; remove competing ones |
| Harsh | Check on WAV, not the web player — the codec may be the culprit |
| Sections compressed | Too many bracketed sections; collapse, or split the generation |

A bad render is usually a prompt problem, not a compute problem. Don't spend Max Mode
credits re-rolling the same spec.

## Mastering

`music master` runs two-pass EBU R128 with `linear=true`, which applies fixed gain
rather than riding the level — so a quiet opening stays quiet relative to a climax.
Default target −14 LUFS integrated, −1 dBTP. That one master serves Spotify, YouTube,
Tidal and Amazon; Apple Music normalises to −16 but the same file is fine.

**`linear=true` is a request, not a promise.** When the gain needed to reach the target
would push true peak past the ceiling, loudnorm switches to dynamic mode and rides the
level instead — silently, until now. `master.py` reads the second pass's own report
back and warns. If you see that warning, the master is no longer a fixed gain, and the
fix is usually upstream: a source already peaking over the ceiling cannot be normalised
linearly at any target.

`--eq <preset>` applies a tone preset *before* the loudness stage. `--list-eq` prints
them with the exact filter chain each one runs, and any raw ffmpeg chain is accepted in
place of a name. Keep moves small: ±0.5 to ±1.5 dB is a mastering decision, ±3 dB means
the mix wants fixing instead.

`--reference <file>` matches a recording's loudness and tonal balance instead. Feed it
a raw export, not something already limited.

**Never end a chain with `alimiter`.** Measured on real material here: asking it for
−2.0 dBFS still produced +0.17 dBTP, and it pushed an already-legal −0.46 dBTP source
over zero. It limits sample peaks and has no oversampling, so it cannot see intersample
peaks at all. `loudnorm`'s TP stage is the only true-peak-accurate ceiling in stock
ffmpeg, and it has to have the last word.

Always run `music compare` afterwards. If the null residue is below −40 dB, the master
changed level and almost nothing else — which is fine, but worth knowing.

## The maximizer

`music maximize` is an MClass-style suite — compressor, stereo imager,
maximizer, soft clip — for when loudnorm alone cannot reach a target. Measured
on real material at the shop's −14 LUFS: loudnorm alone stalls at −13.1 and
falls back to dynamic mode; `--preset loud` then loudnorm hits **−14.0 LUFS at
−1.7 dBTP in linear mode, with more range left (LRA 6.5 vs 6.9 → 5.8)**.

```
music maximize <track> --preset loud       # writes <name>-max.wav
music master <track>                       # then this, always
```

Five presets, each a starting point rather than a mode: `gentle`, `loud`,
`broadcast`, `wide`, `glue`. Every knob overrides the preset it came from —
`--preset loud --comp-ratio 6 --limit-attack slow` is valid, and a test asserts
no preset holds a value unreachable by hand.

**It is never the last stage.** ffmpeg's `alimiter` limits sample peaks with no
oversampling: measured, asked for −1.0 dBFS it let +0.4 dBTP through. So the
maximizer buys loudness and `master.py`'s loudnorm applies the true-peak
ceiling afterwards. This inverts MClass's own rule, where the Maximizer is the
final device — Reason's limiter controls its own output; ours cannot.

The chain also ends with a 2 dB trim, because a signal handed to loudnorm
already at the ceiling makes every loudness target unreachable linearly, and
loudnorm then silently rides the level instead.

See `MASTERING-RESEARCH.md` for the measurements behind all of this.

## The music studio

`music studio <file>` is the whole thing in one step. It writes three files beside the
audio and prints the verdict:

```
analysis.json   the full measurement data, for the page and for tools
REPORT.md       verdicts and next actions, for a person
report.ai.md    the same facts plus the rules that bound them, for an agent
```

The two reports exist because the readers need opposite things. A person wants a
verdict and a next action. An agent wants every number flat, plus the constraints that
stop it reaching a wrong conclusion — that a codec cutoff cannot be EQ'd back, that the
band table is relative and not a tonal verdict. Those are the two mistakes a model
actually makes on this data, so they are written down rather than left to inference.

`--open` renders it in `studio/` — VU meters with real 300 ms ballistics, true-peak and
LUFS readouts, a spectrum and spectrogram with the codec cutoff marked. Every card on
the page collapses, and the arrangement is remembered.

`music scope` remains the narrower command: analysis JSON, no reports.

`music advise` asks a model what the measurements mean. It reads the analysis, never
the audio, so every claim it makes rests on a number you can check on the same page,
and it recommends commands rather than running them. `--ask` takes a question:

```
music advise <track> --ask "why does this sound dull?"
```

The delivery targets travel inside the analysis, read from `master.py`, so changing
`DEFAULT_LUFS` reaches the player and the model instead of leaving them showing a
number nobody targets any more.

Opened from `file://` the page has no way to run anything, so the Ask panel composes
commands for you to paste. `scope --advise --open` puts an answer straight on the page.

`music serve <root>` closes the loop: the panel then asks and runs commands itself, and
any `music …` line in an answer grows a Run button.

```
music serve <audio-dir>                 # http://127.0.0.1:8770
music serve <audio-dir> --read-only
```

Four rules hold it in place, and each is tested:

- **Loopback only.** Binding anything else is refused outright. A process that can
  rewrite your masters must not be reachable from the network.
- **Reads run, writes ask.** `scope`, `measure`, `compare` and `advise` run on request.
  `master` writes audio, so the server issues a single-use token, the page shows the
  exact command, and nothing runs until you agree. The token is bound to that command:
  it cannot be reused or moved onto another one.
- **No shell, ever.** A request names a command from a fixed table and supplies typed
  options; the server builds an argv list and runs it with `shell=False`. Text from the
  page never becomes a shell token, so `--eq "highpass=f=28; rm -rf ~"` arrives at
  `master.py` as one inert string.
- **Nothing outside the root.** Every path argument is resolved and must still be inside
  `--root` afterwards.

A Run button appears only when the server exposes that command *and* every flag in the
line. A placeholder like `music master <track>` gets no button — it names no real file.

Every card on the right collapses, and the arrangement is remembered.

## Publishing

- Category: Music
- Set the altered/synthetic content disclosure in Studio — the CLI does not set it
- Uploads from an unaudited API project are forced private; that is expected
- Two channels means two token files: `--token token-camille.json`, `--token token-balmusette.json`
