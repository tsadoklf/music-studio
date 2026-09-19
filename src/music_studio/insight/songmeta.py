#!/usr/bin/env python3
"""Read a song.md, and say whether it is ready to publish.

    python -m music_studio.insight.songmeta --song tracks/<slug>/song.md

A song.md is a working document a person writes: frontmatter, then prose, then
a Publishing section holding the title, description and tags a video will carry.
This reads that section and checks it against what YouTube will actually accept,
BEFORE an upload makes any of it permanent.

WHY CHECKING IS WORTH ITS OWN MODULE

YouTube cannot replace the video file on an existing upload. Fixing audio, or a
title typo caught after the fact, means deleting and re-uploading — losing the
URL, the views and the comments. Every mistake this catches is one that would
otherwise be expensive, so validation is not a preliminary to publishing; it is
most of the value.

Nothing here touches the network, and nothing here needs a credential. That is
deliberate: the check must run for anyone with a checkout, long before OAuth
enters the picture.

THE LIMITS ARE YOUTUBE'S, NOT OURS

Title 100 characters, description 5000, each tag 500 with 500 total across all
tags. They are checked in UTF-16 code units, because that is how the API counts
and a title of accented French can be well under 100 characters and still be
refused. Angle-bracket placeholders left over from the template are treated as
unfilled fields rather than content.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("songmeta")

# YouTube's documented limits. Counted in UTF-16 code units — see _length.
TITLE_MAX = 100
DESCRIPTION_MAX = 5000
TAG_MAX = 500
TAGS_TOTAL_MAX = 500

# Characters YouTube refuses in a title outright.
TITLE_FORBIDDEN = ("<", ">")

# A status below this has not been mastered, and mastering after upload is the
# one mistake this pipeline cannot undo.
READY_STATUS = "mastered"
STATUS_ORDER = ["sketch", "generated", "chosen", "mastered", "published"]

# An unfilled template field: <like this>. Distinguished from a legitimate
# angle bracket by having no line break inside it.
PLACEHOLDER = re.compile(r"<[^<>\n]{2,}>")


class SongError(RuntimeError):
    """Anything that should stop the run with a readable message."""


def _length(text: str) -> int:
    """Length as YouTube counts it: UTF-16 code units.

    A character outside the basic plane — an emoji, say — costs two. Counting
    Python characters instead would pass a title the API then refuses, which
    is the worst place to discover a limit.
    """
    return len(text.encode("utf-16-le")) // 2


@dataclass
class SongMeta:
    """What a song.md says about publishing one video."""

    path: Path
    slug: str = ""
    title: str = ""
    channel: str = ""
    status: str = ""
    video_id: str = ""
    description: str = ""
    tags: list[str] = field(default_factory=list)
    thumbnail: str = ""
    category: str = ""
    disclosure: str = ""
    visibility: str = ""

    # ---- validation ------------------------------------------------------

    def validate(self, strict: bool = False) -> list[str]:
        """Everything wrong with this file, worst first.

        Returns a list rather than raising: a person fixing a song.md wants to
        see all of it at once, not one problem per run.

        `strict` also requires the assets on disk — the video and thumbnail.
        Off by default because `check` is useful while a track is still being
        written, long before anything has been rendered.
        """
        out: list[str] = []
        out += self._check_frontmatter()
        out += self._check_title()
        out += self._check_description()
        out += self._check_tags()
        out += self._check_settings()
        if strict:
            out += self._check_assets()
        return out

    def _check_frontmatter(self) -> list[str]:
        out = []
        if not self.slug:
            out.append("no slug in the frontmatter")
        elif self.slug != self.slug.lower() or " " in self.slug:
            out.append(f"slug {self.slug!r} should be kebab-case")
        if not self.channel:
            out.append("no channel in the frontmatter")
        if self.status and self.status not in STATUS_ORDER:
            out.append(f"status {self.status!r} is not one of: "
                       + ", ".join(STATUS_ORDER))
        return out

    def _check_title(self) -> list[str]:
        out = []
        if not self.title.strip():
            out.append("no title")
            return out
        if PLACEHOLDER.search(self.title):
            out.append(f"title still holds a template placeholder: {self.title}")
        n = _length(self.title)
        if n > TITLE_MAX:
            out.append(f"title is {n} characters; YouTube allows {TITLE_MAX}")
        for ch in TITLE_FORBIDDEN:
            if ch in self.title:
                out.append(f"title contains {ch!r}, which YouTube refuses")
        return out

    def _check_description(self) -> list[str]:
        out = []
        if not self.description.strip():
            out.append("no description")
            return out
        if PLACEHOLDER.search(self.description):
            found = PLACEHOLDER.search(self.description).group(0)
            out.append(f"description still holds a template placeholder: {found}")
        n = _length(self.description)
        if n > DESCRIPTION_MAX:
            out.append(f"description is {n} characters; YouTube allows {DESCRIPTION_MAX}")
        return out

    def _check_tags(self) -> list[str]:
        out = []
        if not self.tags:
            out.append("no tags")
            return out
        for tag in self.tags:
            if PLACEHOLDER.search(tag):
                out.append(f"tag still holds a template placeholder: {tag}")
            if _length(tag) > TAG_MAX:
                out.append(f"tag {tag!r} is longer than {TAG_MAX} characters")
        # YouTube counts the total across all tags, including the separators
        # it adds between them. Quoted tags cost more; this is the plain sum,
        # which is the lower bound and the one worth warning on.
        total = sum(_length(t) for t in self.tags) + len(self.tags) - 1
        if total > TAGS_TOTAL_MAX:
            out.append(f"tags total {total} characters; YouTube allows {TAGS_TOTAL_MAX}")
        return out

    def _check_settings(self) -> list[str]:
        out = []
        if self.category and self.category.lower() != "music":
            out.append(f"category is {self.category!r}, expected Music")
        if self.disclosure and self.disclosure.strip().lower() not in ("yes", "no"):
            out.append(f"AI disclosure is {self.disclosure!r}; expected Yes or No")
        return out

    def _check_assets(self) -> list[str]:
        """The files an upload needs. Only asked for under --strict."""
        out = []
        track = self.path.parent
        video = _find_asset(track / "video", ("-1080p.mp4", ".mp4"))
        if video is None:
            out.append(f"no video in {track / 'video'} — run `music video` first")
        thumb = _find_asset(track / "video", ("-thumb.jpg", "-thumb.png", ".jpg"))
        if thumb is None:
            out.append(f"no thumbnail in {track / 'video'}")
        elif thumb.stat().st_size > 2 * 1024 * 1024:
            mb = thumb.stat().st_size / 1024 / 1024
            out.append(f"thumbnail is {mb:.1f} MB; YouTube refuses over 2 MB")
        if self.status and self.status != READY_STATUS and not self.video_id:
            out.append(f"status is {self.status!r}, not {READY_STATUS!r} — "
                       "mastering after upload means deleting and re-uploading")
        return out

    def as_dict(self) -> dict:
        return {
            "slug": self.slug, "title": self.title, "channel": self.channel,
            "status": self.status, "video_id": self.video_id,
            "description_chars": _length(self.description),
            "tags": self.tags, "thumbnail": self.thumbnail,
            "category": self.category, "disclosure": self.disclosure,
        }


def _find_asset(folder: Path, suffixes: tuple[str, ...]) -> Path | None:
    """The first file matching any suffix, preferring the earlier ones.

    Renders carry the take name — `<Take 1>-1080p.mp4`, not `video-1080p.mp4` —
    so the asset is found by suffix rather than by an exact name nobody uses.
    """
    if not folder.is_dir():
        return None
    for suffix in suffixes:
        for candidate in sorted(folder.iterdir()):
            if candidate.is_file() and candidate.name.endswith(suffix):
                return candidate
    return None


# --------------------------------------------------------------------------
# parsing
# --------------------------------------------------------------------------

def _frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    out = {}
    for line in text[3:end].splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            out[key.strip()] = value.strip()
    return out


def _fenced_after(text: str, heading: str) -> str:
    """The first fenced block following a bold heading like **Title**.

    The song.md format puts each publishable field in a code fence so that
    markdown does not reflow it — a description's line breaks are meaningful
    on YouTube.
    """
    m = re.search(rf"^\*\*{re.escape(heading)}\*\*.*?^```[^\n]*\n(.*?)^```",
                  text, re.S | re.M)
    return m.group(1).rstrip("\n") if m else ""


def _table_value(text: str, field_name: str) -> str:
    """A value from the Upload settings table, by its row label."""
    m = re.search(rf"^\|\s*{re.escape(field_name)}\s*\|\s*([^|]*?)\s*\|",
                  text, re.M | re.I)
    return m.group(1).strip().strip("`") if m else ""


def parse_song(path: Path) -> SongMeta:
    """Read a song.md into a SongMeta. Raises SongError if it cannot."""
    if not path.is_file():
        raise SongError(f"No song file at {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise SongError(f"{path} is not UTF-8: {exc}") from exc

    fm = _frontmatter(text)
    if not fm:
        raise SongError(f"{path} has no frontmatter — is it a song.md?")

    tags_block = _fenced_after(text, "Tags")
    tags = [t.strip() for t in tags_block.replace("\n", ",").split(",") if t.strip()]

    video_id = fm.get("video_id", "")
    if video_id in ("—", "-", "none", "None"):
        video_id = ""

    return SongMeta(
        path=path,
        slug=fm.get("slug", ""),
        title=_fenced_after(text, "Title").strip() or fm.get("title", ""),
        channel=fm.get("channel", ""),
        status=fm.get("status", ""),
        video_id=video_id,
        description=_fenced_after(text, "Description"),
        tags=tags,
        thumbnail=_table_value(text, "Thumbnail"),
        category=_table_value(text, "Category"),
        disclosure=_table_value(text, "Altered/synthetic content disclosure"),
        visibility=_table_value(text, "Visibility"),
    )


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Validate a song.md's publishing metadata. No network.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--song", type=Path, required=True, help="Path to song.md.")
    p.add_argument("--strict", action="store_true",
                   help="Also require the rendered video and thumbnail.")
    p.add_argument("--json", action="store_true", help="Emit the result as JSON.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(stream=sys.stderr,
                        level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(levelname)s: %(message)s")
    try:
        meta = parse_song(args.song)
    except SongError as exc:
        log.error("%s", exc)
        return 1

    problems = meta.validate(strict=args.strict)
    if args.json:
        print(json.dumps({"ok": not problems, "problems": problems,
                          **meta.as_dict()}, indent=1))
    else:
        for key, value in meta.as_dict().items():
            if key not in ("description_chars", "tags"):
                print(f"{key:<12} {value or '—'}")
        print(f"{'tags':<12} {len(meta.tags)}")
        for issue in problems:
            print(f"  x {issue}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
