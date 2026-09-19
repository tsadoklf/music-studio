# benchmarks/

Records to measure your own against. One JSON per record, a few hundred bytes.

```sh
music benchmark --list
music benchmark <a record you trust>.wav --add aja --note "Steely Dan, 1977."
music scope <your take>.wav --against aja
```

## Why measurements and not audio

A benchmark is an `audio-benchmark/v1` digest — loudness, range, crest factor,
true peak, band energies, stereo. **The audio is not stored, referenced or
needed.** Commercial recordings cannot be committed to a repository, and even
one's own masters are binaries that have no business in git. Numbers travel;
the record stays on your disk.

That is also why these are worth committing: a library of ten references is a
few kilobytes and survives a fresh clone.

## Choosing references

This is a taste decision, not a technical one. What helps:

- **Something with the dynamics you want.** Well-recorded records of the
  seventies and eighties commonly read LRA 9–12; a modern pop master is often
  4–5. Knowing which end you are aiming at is most of the value.
- **Something modern and loud**, as the other pole. Not to imitate — to know
  what you are declining.
- **Something in your own genre.** A chanson record with real orchestration
  says more about an orchestral chanson take than either of the above.

Two or three is enough. A long list stops being a comparison.

## What compares, and what does not

Loudness, range, crest factor, true peak and correlation are absolute
measurements and compare directly between records.

**Band energies do not.** The table carries no reference level and every mix
reads progressively lower toward the top, so raw band dB between two records is
meaningless — see invariant 5 in `STATUS.md`. What compares is the *tilt*: each
band's distance from `mid` within its own file. A record whose air sits 40 dB
under its mid is darker than one where the gap is 30, whatever their absolute
levels. `benchmark.py` normalises before it says anything tonal.

## Thresholds

Differences below these are not reported, because they are not decisions:

| | |
|---|---|
| Loudness | 1.0 LU |
| Loudness range | 1.5 LU |
| Crest factor | 1.5 dB |
| True peak | 1.0 dB |
| Correlation | 0.15 |
| Band tilt | 3.0 dB |

Silence from a comparison means the two records agree, which is a result.
