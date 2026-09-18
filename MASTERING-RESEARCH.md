# Mastering and EQ — research notes, and what they imply for the CLI

Written 2026-09-15. Every ffmpeg claim below was measured on this machine
(ffmpeg 8.1.1) against real program material, not taken from documentation.
Where a measurement contradicts the common advice, the measurement wins and the
command is recorded so you can repeat it.

---

## 1. Delivery targets

Streaming platforms normalise playback to a fixed loudness. Mastering louder than
the target does not make you louder — the platform simply turns you down, and you
have spent dynamic range for nothing.

| Platform | Integrated | Ceiling |
|---|---|---|
| Spotify, YouTube, Tidal, Amazon | −14 LUFS | −1 dBTP |
| Apple Music | −16 LUFS | −1 dBTP |
| Deezer | −15 LUFS | −1 dBTP |
| Amazon (alt) | −14 LUFS | −2 dBTP |

One master at **−14 LUFS / −1 dBTP** serves all of them. The current default in
`master.py` is already correct; nothing to change there.

### Why −1 dBTP and not 0

True peak measures the reconstructed analogue waveform *between* samples. A file
whose samples never exceed −0.1 dBFS can still reconstruct above 0 dBFS. Lossy
encoders then add their own overshoot, so a master measuring +0.3 dBTP can land
near +1.0 dBTP after AAC — audible distortion the encoder never intended.

Measured here, on a 5 s tone whose samples peak at −0.1 dBFS:

```
input_tp = +0.65 dBTP        # 0.75 dB of intersample peak, from sample-legal audio
```

Both files in `ce-qui-reste-du-feu/masters/` violate this: the extended version
reads **+0.2 dBTP**, the "mastered" version **+0.5 dBTP**. Both will distort on
YouTube.

---

## 2. Finding: `alimiter` is not a true-peak limiter

This is the most important practical result, because the obvious way to build a
mastering chain is "EQ → compress → limit" with `alimiter` at the end. That does
not work for streaming delivery.

`alimiter` limits **sample** peaks. It has no oversampling option (`level_out`,
`limit`, `asc`, `asc_level` — that is the whole list). So it cannot see, and
cannot control, intersample peaks.

Measured on 60 s of real program material (source: −0.46 dBTP):

| Chain | Result |
|---|---|
| `alimiter=limit=0.891` (−1.00 dBFS) | **+0.13 dBTP** |
| `alimiter=limit=0.841` (−1.50 dBFS) | **+0.13 dBTP** |
| `alimiter=limit=0.794` (−2.00 dBFS) | **+0.17 dBTP** |
| `loudnorm=I=-14:TP=-1:LRA=11` | **−1.00 dBTP** |

Two things to notice. Tightening the limit by a full decibel does not move the
true peak at all — the overshoot is reconstruction, not gain. And `alimiter` took
a source that was *already legal* at −0.46 dBTP and pushed it over zero.

**Rule: never end a chain with `alimiter` and call the result delivery-ready.**
`loudnorm`'s TP stage is the only true-peak-accurate ceiling in stock ffmpeg. If
a brickwall is wanted for colour, it belongs *before* the loudnorm stage, never
after.

Oversampling `alimiter` by hand helps but does not fix it:

```
aresample=192000,alimiter=limit=0.891,aresample=48000   ->  +0.05 dBTP
```

Better than +0.32, still over zero, and four times the work for a worse result
than `loudnorm` gives for free.

---

## 3. Finding: `linear=true` silently falls back to dynamic

`master.py`'s docstring makes a specific promise:

> The second pass is given the first pass's measurements, which is what makes
> loudnorm linear rather than dynamic — it applies a fixed gain and limits peaks,
> instead of riding the level through the track.

That promise does not always hold, and the code never checks. Asking for
linear normalisation on the extended version:

```
loudnorm=I=-14:TP=-1:LRA=11:measured_I=-14.0:measured_TP=0.2:...:linear=true
  -> "normalization_type" : "dynamic"
     "target_offset"      : "-0.62"
```

When the gain needed to hit the loudness target would push true peak past the
ceiling, loudnorm **abandons linear mode and rides the level instead** — the exact
behaviour the docstring says it avoids, applied without warning. On a track with a
quiet opening and a loud climax, that is a musical change, not a technical one.

It also explains the miss on the real run: asking for −14.0 produced −13.6 LUFS.

**Implication:** `master_loudnorm` must parse `normalization_type` from the second
pass and warn loudly when it reads `dynamic`. The fix when it happens is to lower
the target or raise the ceiling, not to ignore it. This is a bug fix, not a
feature.

---

## 4. Finding: detecting a lossy generation

Covered in detail by the `ce-qui-reste-du-feu` investigation, but it generalises
and belongs in the tool. A file that has been through MP3/AAC shows a brick wall:
energy falls off a cliff at the codec's cutoff and stays 40+ dB down.

Measured, 20 s from the middle of each file:

```
                   14-15k   15-16k   16-17k   17-18k   19-20k
original 48k        -54.5    -55.4    -55.5    -56.0    -57.0   (flat to 20k)
"mastered" 44.1k    -51.9    -56.1   -100.9   -100.6    -98.1   (cliff at 16k)
```

A 44 dB step between adjacent kHz bands is not an EQ curve — no equaliser does
that. It is a codec. Cutoff frequency roughly indicates the bitrate: 16 kHz ≈
128 kbps MP3, 19–20 kHz ≈ 320 kbps or AAC.

This is worth a first-class check because the failure is invisible in every
loudness number. The "mastered" file measured plausibly on LUFS, peak and LRA
while having had its entire top octave destroyed.

`analyze.py` now does this check. Verified against these files and against real
LAME/AAC round-trips:

| File | Cutoff | Confidence | Verdict |
|---|---|---|---|
| extended version, mastered (44.1k) | 15084 Hz | 0.87 | lossy |
| extended version (48k) | 19998 Hz | 0.00 | harmless |
| MP3 128k / 192k / AAC 128k | 16597 / 18658 / 17227 Hz | flagged | lossy |

### Audibility, not fingerprints

Both 48 kHz files turn out to have a genuine cliff too — measured by hand on the
"original":

```
  19500 Hz   -43.2 dB
  20000 Hz   -49.4 dB
  20500 Hz   -87.4 dB      <- a real ~38 dB wall
```

So that file has been through an encoder at some point as well. It is reported,
but with confidence forced to zero, because 20 kHz is above adult hearing and a
detector that flags every 320 kbps source cries wolf. **Confidence means "this
damages the audio", not "a filter exists."** The cutoff frequency is always
reported so provenance is never hidden; only the alarm is suppressed. The
threshold is one constant (`CUTOFF_BENIGN`) if that judgement ever needs revising.

---

## 5. EQ approaches worth having as presets

The research on mastering EQ is consistent on a few points, and they map onto
filters this ffmpeg build actually has (all verified present: `firequalizer`,
`anequalizer`, `equalizer`, `acrossover`, `acompressor`, `deesser`,
`stereotools`, `asubboost`, `aexciter`).

**Tilt.** The single most useful mastering move: a gentle broadband slope, darker
or brighter, without touching the middle. A shelf pair does it — low shelf down
and high shelf up by the same amount, pivoting near 650–1000 Hz. Small amounts:
±0.5 to ±1.5 dB is a mastering decision, ±3 dB is a mix problem you should fix
upstream.

**Subtractive first.** Cutting a resonance restores headroom and makes any
downstream compressor behave. Sweep a narrow bell to find the ring, then cut it
narrowly — do not boost around it.

**Dynamic EQ over static EQ for intermittent problems.** If a vocal is harsh only
on the loud notes, a static cut at 3 kHz dulls the whole track. ffmpeg has no
dynamic EQ filter, but `acrossover` + per-band `acompressor` + remix is a real
multiband compressor and can be built.

**High-pass with care.** Below ~30 Hz there is usually nothing but rumble eating
headroom. But a steep high-pass shifts phase and can *raise* peak level; measure
true peak after, not before.

Sensible preset shapes to ship, each a named, documented, reversible starting
point rather than a magic button:

| Preset | What it does | When |
|---|---|---|
| `flat` | loudness + TP only, no tone change | default; trust the mix |
| `warm` | −0.75 dB tilt toward the lows, pivot 800 Hz | thin, brittle digital sources |
| `air` | +1 dB shelf above 10 kHz | dull source with real top end present |
| `clean-lows` | high-pass 28 Hz, 12 dB/oct | rumble, room noise, DC |
| `deharsh` | dynamic-style cut 2.5–5 kHz via multiband | harsh Suno vocal renders |
| `narrow-bass` | bass below 120 Hz to mono | wide synth bass that eats headroom |

Every preset must be a *named recipe printed before it runs*, so the filter chain
is visible and can be copied, edited, or rejected. A mastering tool that hides
what it did is not usable.

---

## 6. What the numbers cannot tell you

Worth stating plainly in the tool's own docs, because the CLI is about to grow a
lot of numbers.

- LUFS says nothing about whether it sounds good.
- LRA below ~4 LU usually means over-compression, but a sparse solo piano can
  legitimately read low, and a loud dense mix can legitimately read 5.
- Band energy tables compare a file to *itself over time*, not to a genre norm.
  There is no correct spectrum.
- The null test is the one measurement that is genuinely objective: it shows
  exactly what processing changed, and nothing else. Keep it central.

---

## Sources

- [LUFS targets per platform in 2026](https://www.forasoft.com/learn/audio-for-video/articles-audio/lufs-targets-per-platform-2026)
- [LUFS Targets for Spotify, Apple Music & YouTube (2026)](https://process.audio/blog/lufs-targets-streaming-platforms-loudness-metering)
- [True Peak, dBTP and the Inter-Sample Peak Problem](https://www.forasoft.com/learn/audio-for-video/articles-audio/true-peak-dbtp-inter-sample)
- [Is –1 dBTP Necessary? True Peak Explained](https://www.vicmalvolti-mastering.com/blog/true-peak-is-1-dbtp-really-important)
- [Pro Mastering: Dynamic EQ and Multiband Compression](https://www.sonarworks.com/blog/learn/pro-mastering-dynamic-eq-and-multiband-compression)
- [How to EQ Your Master — iZotope](https://izotope.com/en/learn/advanced-eq-mastering-tips)
- [FFmpeg Filters Documentation](https://ffmpeg.org/ffmpeg-filters.html)

---

## 7. The browser EQ clips on boost; the CLI does not

Measured 2026-09-15, using the studio page's own filter code in an
OfflineAudioContext, on a -1 dBFS two-tone source — where a finished master sits.

| Monitor chain | Output peak | Samples over full scale |
|---|---|---|
| no EQ | -1.01 dBFS | 0 |
| +12 dB low shelf | **+4.61 dBFS** | 11,949 |
| +18 dB peak at 110 Hz | **+13.25 dBFS** | 40,587 |

The audition path is `source -> gain(1.0) -> [biquads] -> destination`. Nothing
sits after the filters, so a boost adds level with nothing to catch it and the
browser hard-clips. The distortion is the monitor's, not the track's — which is
the dangerous part, because a tone decision then gets judged through clipping
that is not in the file.

This does **not** reach disk. The EQ is an audition; only `music master` writes
audio, and there the EQ runs *before* loudnorm's true-peak stage, so the ceiling
is enforced after the boost. The browser simply has no equivalent stage.

The fix is gain compensation on the monitor path: trim by the EQ's maximum boost
before the filters, so the audition never clips and an A/B compares tone rather
than loudness. It is monitor-only and must never appear in the emitted ffmpeg
chain — `master.py` would otherwise attenuate a second time.

---

## 8. A maximizer, and what MClass gets that we cannot

Researched Reason's MClass suite (Equalizer, Compressor, Stereo Imager,
Maximizer) and built the equivalent as `maximize.py`. Every device maps onto a
stock ffmpeg filter:

| MClass | ffmpeg |
|---|---|
| Compressor | `acompressor` — threshold, ratio, attack, release, knee, RMS detection |
| Stereo Imager | `acrossover` split + per-band `stereotools` |
| Maximizer | `alimiter`, with `latency=1` as the 4 ms look-ahead |
| Soft Clip | `asoftclip` — 8 curves, `param` is MClass's "Amount" |

### It earns its place

At the shop's −14 LUFS target, on 45 s of real material:

| Chain | Result | Mode |
|---|---|---|
| loudnorm alone | −13.1 LUFS, −1.0 dBTP, LRA 6.9 | misses the target |
| `--preset loud` then loudnorm | **−14.0 LUFS, −1.7 dBTP, LRA 6.5** | **linear** |

The maximizer reaches a target loudnorm alone cannot, under the ceiling, in
linear mode. That is the whole argument for having one.

### Two rules the measurements forced

**The limiter cannot be last.** MClass puts the Maximizer at the end of the
chain. Here `alimiter` overshoots — measured, asked for −1.0 dBFS it let
+0.4 dBTP through — so loudnorm keeps the final word on true peak and the
limiter aims 0.8 dB below the stated ceiling.

**The maximizer must leave headroom.** Handed a signal already at the ceiling,
loudnorm cannot reach any target linearly and silently rides the level instead.
Measured: `gentle` handed it −0.0 dBTP and it fell back to dynamic mode. The
chain now ends with a 2 dB trim so the last stage can work as a fixed gain.

**`asoftclip` is not a peak guard.** Tried as one, and measured: on real music
it drops the level about 14 dB regardless of its threshold. It is an effect,
not a safety net.

---

## 9. The suite in the browser: three nodes that had to be built

`maximize.py` renders the suite. The studio panel previews it live, which meant
building in WebAudio what ffmpeg gives us as filters. Measured in headless
Chromium against the engine's own `buildRack()`.

### What WebAudio supplies, and what it does not

| Device | Browser | Verdict |
|---|---|---|
| Compressor | `DynamicsCompressorNode` | threshold, ratio, knee, attack exact |
| Soft clip | `WaveShaper`, `oversample='4x'` | curve is ours to define |
| Stereo imager | — | hand-built: splitter → mid/side → merger |
| Maximizer | — | hand-built: delay → compressor → hard ceiling |
| Makeup gain | — | a `GainNode`; the browser compressor has none |

### `DynamicsCompressorNode` is not a limiter

The first build used a hard-kneed 20:1 compressor as the limiter, on the
assumption that a high ratio approximates a wall. It does not. Driving a
−1.0 dBFS threshold:

| Input drive | Output peak | Over the ceiling by |
|---|---|---|
| +6 dB | +0.38 dBFS | 1.38 dB |
| +12 dB | +1.195 dBFS | 2.20 dB |

It overshoots *more* the harder it is pushed, because a ratio is a slope and
not a wall — the same failure `alimiter` has in §2, arrived at independently.

A hard-clipping `WaveShaper` behind it fixes this completely:

| Chain | +6 dB drive | +12 dB drive |
|---|---|---|
| compressor alone | +0.38 dBFS | +1.195 dBFS |
| compressor + ceiling | **−0.986 dBFS** | **−0.991 dBFS** |

The ceiling holds regardless of drive. The compressor does the musical gain
riding so the clipper rarely has audible work to do; the clipper guarantees the
number. Both are needed — neither alone is correct.

### Mid/side algebra is easy to get subtly wrong

The imager's first version folded gains into shared nodes, and width 1 — which
must be bit-transparent — came out at L=0.525/R=0.075 from a 0.5/0.1 input.
Audibly wider when it should have been *nothing at all*, and invisible without
a numeric check. Every gain is now its own node:

| Width | L | R | Meaning |
|---|---|---|---|
| 0 | 0.3 | 0.3 | mono, correct |
| 1 | **0.5** | **0.1** | transparent, correct |
| 2 | 0.7 | −0.1 | side doubled, correct |

### Three divergences the panel must not hide

The browser cannot match the CLI exactly. These are reported by
`engine.rackApprox()` and shown on the affected knob rather than clamped
silently — a knob reading 2.4 s while previewing 1.0 s is a lie the ear cannot
catch:

1. **Compressor release.** ffmpeg allows 9 s; `DynamicsCompressorNode` caps at
   1 s. Previewed at 1 s.
2. **Adaptive release.** No browser equivalent. The render has it, the preview
   does not.
3. **Imager crossover.** `acrossover` splits the band; the preview applies
   width full-range.

`limit_release: auto` is deliberately *not* flagged: `alimiter`'s `asc` adapts
to the material and previews at a middling 100 ms, an audibly small difference
that would bury the three above if listed beside them.

### The rack is a router, not a fixed chain

Each device is an `{input, output}` block and the engine chains only the
patched ones, exactly as `buildEq()` already worked. An unpatched suite is
absent from the graph rather than a bypassed device sitting in it — which is
what makes Reason-style back-panel cabling a change to the router later rather
than a rewrite of every device.
