#!/usr/bin/env python3
"""Reading a song.md, and refusing to publish a bad one.

Every check here guards a mistake that would otherwise be expensive. YouTube
cannot replace the video file on an existing upload, so a title typo or
unmastered audio found after the fact means deleting and re-uploading — losing
the URL, the views and the comments. That asymmetry is why validation is worth
its own module and its own tests, rather than being a preliminary inside the
upload it protects.

Nothing here touches the network or needs a credential, which is also true of
the code under test, and deliberately so.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from music_studio.insight import songmeta as sm

MINIMAL = """---
slug: a-track
title: A Track
channel: a-channel
status: mastered
video_id: —
---

# A Track

## 7. Publishing

### YouTube

**Title**
```
A Track — An Artist
```

**Description**
```
What the song is.

A second paragraph.
```

**Tags**
```
one, two, three
```

**Upload settings**
| Field | Value |
|---|---|
| Category | Music |
| Altered/synthetic content disclosure | Yes |
| Visibility | Private → Public |
| Thumbnail | `video/thumb-720.jpg` |
"""


class _Song(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def write(self, text=MINIMAL, name="song.md") -> Path:
        p = self.tmp / name
        p.write_text(text, encoding="utf-8")
        return p

    def meta(self, text=MINIMAL):
        return sm.parse_song(self.write(text))


class TestParsing(_Song):
    def test_frontmatter_is_read(self):
        m = self.meta()
        self.assertEqual(m.slug, "a-track")
        self.assertEqual(m.channel, "a-channel")
        self.assertEqual(m.status, "mastered")

    def test_the_title_comes_from_the_fenced_block_not_the_frontmatter(self):
        """The frontmatter title is the song's name; the fenced one is what
        the video is called, and they legitimately differ — the video usually
        carries the artist too."""
        m = self.meta()
        self.assertEqual(m.title, "A Track — An Artist")

    def test_the_description_keeps_its_line_breaks(self):
        """They are meaningful on YouTube, which is why the format fences
        them rather than letting markdown reflow them."""
        self.assertIn("\n\n", self.meta().description)

    def test_tags_are_split_and_stripped(self):
        self.assertEqual(self.meta().tags, ["one", "two", "three"])

    def test_the_upload_settings_table_is_read(self):
        m = self.meta()
        self.assertEqual(m.category, "Music")
        self.assertEqual(m.disclosure, "Yes")
        self.assertEqual(m.thumbnail, "video/thumb-720.jpg")

    def test_an_em_dash_video_id_means_not_uploaded(self):
        """The template writes `—` for "no value yet". Treating that as an id
        would make every fresh track look already published."""
        self.assertEqual(self.meta().video_id, "")

    def test_a_real_video_id_survives(self):
        m = self.meta(MINIMAL.replace("video_id: —", "video_id: dQw4w9WgXcQ"))
        self.assertEqual(m.video_id, "dQw4w9WgXcQ")

    def test_a_missing_file_is_a_readable_error(self):
        with self.assertRaises(sm.SongError) as caught:
            sm.parse_song(self.tmp / "nope.md")
        self.assertIn("No song file", str(caught.exception))

    def test_a_file_without_frontmatter_is_refused(self):
        with self.assertRaises(sm.SongError) as caught:
            sm.parse_song(self.write("just some prose\n"))
        self.assertIn("frontmatter", str(caught.exception))

    def test_a_song_with_no_publishing_section_parses_but_is_empty(self):
        """Half-written files are the normal state early on. Parsing must not
        raise; validate() is what says it is not ready."""
        m = self.meta("---\nslug: x\nchannel: y\n---\n\n# X\n")
        self.assertEqual(m.title, "")
        self.assertTrue(m.validate())


class TestUtf16Counting(unittest.TestCase):
    """YouTube counts UTF-16 code units, not Python characters.

    A title of emoji passes a len() check and is then refused by the API,
    which is the worst place to find a limit.
    """

    def test_an_emoji_costs_two(self):
        self.assertEqual(sm._length("🎵"), 2)

    def test_accented_latin_costs_one(self):
        self.assertEqual(sm._length("Ce Qui Reste du Feu"), 19)

    def test_a_title_of_emoji_is_caught_before_the_api_sees_it(self):
        m = sm.SongMeta(path=Path("x"), slug="s", channel="c",
                        title="🎵" * 51, description="d", tags=["a"])
        self.assertTrue(any("title is" in p for p in m.validate()),
                        "51 emoji is 102 UTF-16 units and must be refused")


class TestLimits(unittest.TestCase):
    def meta(self, **kw):
        base = dict(path=Path("x"), slug="s", channel="c", title="T",
                    description="d", tags=["a"])
        base.update(kw)
        return sm.SongMeta(**base)

    def test_a_title_at_the_limit_passes(self):
        self.assertEqual(
            [p for p in self.meta(title="T" * 100).validate() if "title is" in p], [])

    def test_a_title_over_the_limit_fails(self):
        self.assertTrue(
            [p for p in self.meta(title="T" * 101).validate() if "title is" in p])

    def test_a_description_over_the_limit_fails(self):
        self.assertTrue([p for p in self.meta(description="d" * 5001).validate()
                         if "description is" in p])

    def test_tags_over_the_shared_total_fail(self):
        """Each tag is short enough; together they are not. The total is the
        limit people actually hit."""
        m = self.meta(tags=["x" * 60] * 12)
        self.assertTrue([p for p in m.validate() if "total" in p])

    def test_angle_brackets_in_a_title_are_refused(self):
        self.assertTrue([p for p in self.meta(title="A <Track>").validate()
                         if "refuses" in p])


class TestPlaceholders(unittest.TestCase):
    """An unfilled template field is not content.

    A fresh song.md is entirely placeholders; publishing one would put
    `<Song Title — Artist Name>` on a channel.
    """

    def meta(self, **kw):
        base = dict(path=Path("x"), slug="s", channel="c", title="T",
                    description="d", tags=["a"])
        base.update(kw)
        return sm.SongMeta(**base)

    def test_a_placeholder_title_is_caught(self):
        self.assertTrue([p for p in self.meta(title="<Song Title>").validate()
                         if "placeholder" in p])

    def test_a_placeholder_in_the_description_is_caught(self):
        m = self.meta(description="Real text.\n\n<AI disclosure line.>")
        self.assertTrue([p for p in m.validate() if "placeholder" in p])

    def test_a_placeholder_tag_is_caught(self):
        self.assertTrue([p for p in self.meta(tags=["<comma-separated>"]).validate()
                         if "placeholder" in p])

    def test_a_legitimate_comparison_is_not_a_placeholder(self):
        """`a < b` in a description must not read as an unfilled field. The
        pattern requires a closing bracket on the same line with no break."""
        m = self.meta(description="The verse sits lower < the chorus.")
        self.assertEqual([p for p in m.validate() if "placeholder" in p], [])


class TestStrictAssets(_Song):
    """--strict asks for the files an upload needs.

    Off by default: `check` is useful while a track is still being written,
    long before anything has been rendered.
    """

    def _track(self, status="mastered", video=True, thumb=True, thumb_bytes=1000):
        song = self.write(MINIMAL.replace("status: mastered", f"status: {status}"))
        vdir = self.tmp / "video"
        vdir.mkdir(exist_ok=True)
        if video:
            (vdir / "A Track (Take 1)-1080p.mp4").write_bytes(b"\0" * 10)
        if thumb:
            (vdir / "A Track (Take 1)-thumb.jpg").write_bytes(b"\0" * thumb_bytes)
        return sm.parse_song(song)

    def test_a_complete_track_passes_strict(self):
        self.assertEqual(self._track().validate(strict=True), [])

    def test_assets_are_found_by_suffix_not_by_an_exact_name(self):
        """Renders carry the take name — `<Take 1>-1080p.mp4`, never
        `video-1080p.mp4` — so matching an exact name would find nothing."""
        self.assertEqual(
            [p for p in self._track().validate(strict=True) if "video" in p], [])

    def test_a_missing_video_is_reported(self):
        problems = self._track(video=False).validate(strict=True)
        self.assertTrue([p for p in problems if "no video" in p])

    def test_a_missing_thumbnail_is_reported(self):
        problems = self._track(thumb=False).validate(strict=True)
        self.assertTrue([p for p in problems if "thumbnail" in p])

    def test_an_oversized_thumbnail_is_reported(self):
        """YouTube refuses over 2 MB, and does so after the upload of the
        video has already happened."""
        problems = self._track(thumb_bytes=3 * 1024 * 1024).validate(strict=True)
        self.assertTrue([p for p in problems if "2 MB" in p])

    def test_an_unmastered_track_is_refused(self):
        """The one mistake this pipeline cannot undo: YouTube will not replace
        a video file, so publishing before mastering costs the URL."""
        problems = self._track(status="generated").validate(strict=True)
        self.assertTrue([p for p in problems if "mastered" in p])

    def test_assets_are_not_required_without_strict(self):
        self.assertEqual(self._track(video=False, thumb=False).validate(), [])


class TestCli(_Song):
    def test_a_valid_song_exits_zero(self):
        self.assertEqual(sm.main(["--song", str(self.write())]), 0)

    def test_an_invalid_song_exits_one(self):
        bad = self.write(MINIMAL.replace("A Track — An Artist", "<Song Title>"))
        self.assertEqual(sm.main(["--song", str(bad)]), 1)

    def test_a_missing_file_exits_one_rather_than_raising(self):
        self.assertEqual(sm.main(["--song", str(self.tmp / "no.md")]), 1)

    def test_json_output_is_valid_json(self):
        import contextlib
        import io
        import json
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            sm.main(["--song", str(self.write()), "--json"])
        self.assertTrue(json.loads(buf.getvalue())["ok"])


if __name__ == "__main__":
    unittest.main()
