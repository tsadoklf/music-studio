---
slug: <kebab-case-folder-name>
title: <Display title, accents and all>
subtitle: <feat. credit, alternate take, etc. — or omit>
channel: <channel-slug>
project: <series or album name, if any>
status: <sketch | generated | chosen | mastered | published>
created: <YYYY-MM-DD>
published: <YYYY-MM-DD or —>
---

# <Title>

> One line: what this song is. The thing you'd say if someone asked.

---

## 1. At a glance

| | |
|---|---|
| **Tempo** | <BPM> |
| **Meter** | <4/4 · 3/4 · 6/8 · 12-beat compás> |
| **Key / mode** | <D minor → Hijaz → D minor, up a key at the climax> |
| **Duration** | <target, e.g. 4:00> |
| **Languages** | <French, Arabic> |
| **Voices** | <Lead voice; stacked harmonies at the climax. No choir.> |
| **Structure** | <Template A–E, or "bespoke"> |

---

## 2. Background

*Why this song exists, and what a listener would be better off knowing. Historical
and musical context goes here — the research, not the marketing. This is the section
that keeps the catalog from being a folder of prompts.*

**The idea.**
<One paragraph. What the song is about and what device carries it.>

**Musical background.**
<The tradition, mode, rhythm or form being used, and what it actually is.
e.g. "Hijaz is a maqam whose augmented second gives it its characteristic colour."
e.g. "Musette is named for a small French bagpipe, displaced by the accordion in
the 1920s; the name outlived the instrument.">

**Why these choices.**
<Why this tempo, this meter, this instrumentation. The reasoning you'd otherwise
lose in three months.>

---

## 3. Suno inputs

Everything in this section is pasted verbatim into **Create → Advanced**.

### Song Title (Optional)

```
<Title>
```

### Score — goes in Suno's "Lyrics" field

> Note on naming: Suno calls this field "Lyrics", but for these songs it carries
> section directions as well as sung text. Calling it the **Score** internally
> avoids the confusion of "lyrics that aren't lyrics". When filling the form,
> it is the Lyrics field.

```
<bracketed section tags and sung text — paste-ready>
```

### Style

```
<style block — paste-ready, under 1000 characters>
```

### Settings

| Field | Value |
|---|---|
| **Save to…** | <workspace name> |
| **Model** | <v6 / v6-wild / v6-mini> |
| **Max Mode** | <On / Off> |
| **Vocal Gender** | <Female / Male / unset> |
| **Duration** | <Custom, 4:00 / Auto> |
| **Weirdness** | <%> |
| **Style Influence** | <%> |
| **Variety** | <Normal / value> |
| **Personalize** | <Off / On> |
| **Exclude styles** | `<comma-separated>` |

---

## 4. Lyrics and translation

*Only the sung text. Section directions stay in the Score above.*

### <Language 1>

| Original | English |
|---|---|
| <line> | <line> |

### <Language 2>

| Original | Transliteration | English |
|---|---|---|
| <line> | <line> | <line> |

---

## 5. Takes

| Take | Date | Model | Kept | Notes |
|---|---|---|---|---|
| 01 | | | ☐ | |
| 02 | | | ☐ | |

**Chosen take:** <number> — <one line on why>

---

## 6. Production notes

**What to check on every render:**
- <the fragile thing, e.g. "the modal shift actually happens rather than flattening to plain minor">
- <e.g. "the groove never breaks when the orchestra enters">
- <e.g. "feminine verb forms in the Hebrew">

**Known failure modes and fixes:**
| Symptom | Fix |
|---|---|
| <e.g. intro truncated> | <generate separately and splice, or edit the section in v6> |

**Post-processing:**
- Mix: <stems needed? level notes?>
- Master: <target, e.g. −14 LUFS integrated, −1 dBTP; gentle limiting>

---

## 7. Publishing

### YouTube

**Title**
```
<Song Title — Artist Name>
```

**Description**
```
<2–4 lines: what the song is, then the languages, then any context worth giving.>

<Lyrics + translation, or a link to them.>

<AI disclosure line.>
```

**Tags**
```
<comma-separated>
```

**Chapters** (only if the video warrants them)
```
00:00 <section>
```

**Upload settings**
| Field | Value |
|---|---|
| Category | Music |
| Altered/synthetic content disclosure | Yes |
| Visibility | <Private → Public> |
| Thumbnail | `video/thumb-720.jpg` |

### Distribution (if released)

| Field | Value |
|---|---|
| Distributor | |
| Artist name | <Artist Name> |
| Release date | |
| ISRC | |
| Artwork | `artwork/cover-3000.png` (3000×3000, JPEG under 10 MB) |
| AI disclosure | per distributor's current requirement |

---

## 8. Assets

```
<slug>/
  song.md                  ← this file
  masters/
    master.wav             ← chosen take
    master.mp3
    takes/
  artwork/
    cover-3000.png
  video/
    video-1080p.mp4
    thumb-720.jpg
```

---

## 9. Changelog

| Date | Change |
|---|---|
| | |
