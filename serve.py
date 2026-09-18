#!/usr/bin/env python3
"""Serve the music studio, and run `music` commands for it.

    serve.py --root ../camille-marceau
    serve.py --root ../camille-marceau --port 8770
    serve.py --root ../camille-marceau --read-only

The page is a browser UI for a command line tool, so the two need a channel
between them. This is that channel, and it is deliberately small.

What keeps it safe is not a filter on a shell string — it is that no shell
string ever exists. A request names a command from a fixed table and supplies
typed arguments; this builds an argv list and runs it with shell=False. There
is no path by which text from the page becomes a token in a command.

Three rules, all enforced here rather than trusted to the caller:

  * Loopback only. Binding anything else is refused outright, not warned about.
    A process that can rewrite your masters must not be reachable from the
    network.
  * Reads run on request; writes need a token. `scope`, `measure`, `compare`
    and `advise` only read. `master` writes audio, so the page must first ask
    for a confirmation token, show the exact argv to a human, and send that
    token back. The token is single-use and expires.
  * Everything under --root, nothing above it. Every path argument is resolved
    and must still be inside the root afterwards, which is what stops `../`.

Stdlib only, like the rest of the shop.
"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

log = logging.getLogger("serve")

HERE = Path(__file__).resolve().parent
STUDIO = HERE / "studio"
PYTHON = sys.executable or "python3"

TOKEN_TTL = 120.0          # seconds a confirmation stays valid
MAX_BODY = 1 << 20         # 1 MiB of JSON is far more than any request needs
RUN_TIMEOUT = 900          # a long master on a long track still finishes


class ServeError(RuntimeError):
    """Anything that should stop the run with a readable message."""


# --------------------------------------------------------------------------
# the command table
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Command:
    """One runnable command.

    `script` is the module beside this file. `writes` marks a command that
    changes audio on disk, which is what makes confirmation mandatory.
    """
    script: str
    writes: bool
    summary: str
    # option name -> ("path" | "number" | "text" | "flag"); anything absent is rejected
    options: dict = field(default_factory=dict)


COMMANDS: dict[str, Command] = {
    "scope": Command(
        "analyze.py", False, "Measure a file and write analysis JSON.",
        {"--in": "path", "--out": "path"},
    ),
    "measure": Command(
        "master.py", False, "Report loudness, true peak and range.",
        {"--in": "path", "--measure": "flag"},
    ),
    "compare": Command(
        "compare.py", False, "Null-test two files against each other.",
        {"--a": "path", "--b": "path", "--null": "path", "--amplify": "number"},
    ),
    "advise": Command(
        "advise.py", False, "Ask a model what the measurements mean.",
        {"--analysis": "path", "--ask": "text"},
    ),
    "eq": Command(
        "eqchat.py", False,
        "Turn a plain-language tone request into equaliser bands.",
        # --bands-json carries the panel's current bands inline. The page holds
        # them in memory, not on disk, and without them every request starts
        # from flat — so "more" could not mean "more of what you just did".
        {"--ask": "text", "--bands": "path", "--bands-json": "text",
         "--analysis": "path"},
    ),
    "studio": Command(
        "studio_run.py", False,
        "Analyse a file and write analysis.json, REPORT.md and report.ai.md.",
        {"--in": "path", "--out-dir": "path", "--no-advice": "flag"},
    ),
    "maximize": Command(
        "maximize.py", True,
        "Compressor, imager, maximizer, soft clip. WRITES AUDIO.",
        {"--in": "path", "--out": "path", "--preset": "text",
         "--comp-ratio": "number", "--comp-threshold": "number",
         "--input-gain": "number", "--limit": "number",
         "--soft-clip": "text", "--print-chain": "flag"},
    ),
    "master": Command(
        "master.py", True, "Master a take. WRITES AUDIO.",
        {"--in": "path", "--out": "path", "--lufs": "number", "--tp": "number",
         "--eq": "text", "--sample-rate": "number", "--bit-depth": "number"},
    ),
}

# --eq takes a preset name or a raw ffmpeg chain. The chain is passed to
# master.py as one argv element and never reaches a shell, so it needs no
# escaping — but an absurd length is still refused.
MAX_TEXT = 2000


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------

def _inside(root: Path, candidate: str) -> str:
    """Resolve a path argument and refuse anything outside the root."""
    p = (root / candidate).resolve() if not Path(candidate).is_absolute() \
        else Path(candidate).resolve()
    try:
        p.relative_to(root)
    except ValueError:
        raise ServeError(f"path escapes the root: {candidate}")
    return str(p)


def build_argv(name: str, options: dict, root: Path) -> list[str]:
    """Turn a named command and typed options into an argv list.

    Every option must appear in the command's own table. An unknown flag is an
    error rather than something passed through, so the page cannot reach a
    switch this file did not intend to expose.
    """
    cmd = COMMANDS.get(name)
    if cmd is None:
        raise ServeError(f"unknown command: {name}")

    argv = [PYTHON, str(HERE / cmd.script)]
    for key, value in (options or {}).items():
        kind = cmd.options.get(key)
        if kind is None:
            raise ServeError(f"{name} does not accept {key}")
        if kind == "flag":
            if value:
                argv.append(key)
            continue
        if value is None or value == "":
            continue
        if kind == "path":
            argv += [key, _inside(root, str(value))]
        elif kind == "number":
            try:
                argv += [key, str(float(value)) if "." in str(value) else str(int(value))]
            except (TypeError, ValueError):
                raise ServeError(f"{key} expects a number, got {value!r}")
        else:  # text
            text = str(value)
            if len(text) > MAX_TEXT:
                raise ServeError(f"{key} is too long")
            argv += [key, text]
    return argv


# --------------------------------------------------------------------------
# confirmation tokens
# --------------------------------------------------------------------------

class Confirmations:
    """Single-use tokens for commands that write.

    The page asks for a token, shows the argv it describes to a person, and
    sends the token back only when that person clicks Run. A token is bound to
    the exact argv it was issued for, so nothing can be swapped between the
    showing and the running.
    """

    def __init__(self) -> None:
        self._items: dict[str, tuple[float, tuple[str, ...]]] = {}
        self._lock = threading.Lock()

    def issue(self, argv: list[str]) -> str:
        token = secrets.token_urlsafe(18)
        with self._lock:
            self._sweep()
            self._items[token] = (time.monotonic(), tuple(argv))
        return token

    def redeem(self, token: str, argv: list[str]) -> None:
        with self._lock:
            self._sweep()
            found = self._items.pop(token, None)
        if found is None:
            raise ServeError("confirmation missing or expired; ask again")
        _, wanted = found
        if tuple(argv) != wanted:
            raise ServeError("confirmation does not match this command")

    def _sweep(self) -> None:
        now = time.monotonic()
        for k in [k for k, (t, _) in self._items.items() if now - t > TOKEN_TTL]:
            self._items.pop(k, None)


# --------------------------------------------------------------------------
# the server
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "music-studio"

    # injected by serve()
    root: Path
    read_only: bool
    confirmations: Confirmations

    def log_message(self, fmt, *args):       # quieter than the default
        log.debug("%s %s", self.address_string(), fmt % args)

    # ---- helpers --------------------------------------------------------

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # The page talks only to this origin; say so rather than allowing any.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            raise ServeError("empty or oversized request")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _guard_origin(self) -> None:
        """Refuse cross-site requests.

        A page on another origin cannot read our responses, but it can still
        cause a POST. Since a POST here can run a command, require that any
        Origin header present is our own.
        """
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
            raise ServeError("cross-origin request refused")

    # ---- GET: the studio page itself ----------------------------------------

    def do_GET(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path == "/":
            path = "/index.html"
        if path == "/api/health":
            return self._json(200, {
                "ok": True,
                "root": str(self.root),
                "read_only": self.read_only,
                "commands": {k: {"writes": v.writes, "summary": v.summary,
                                 "options": v.options}
                             for k, v in COMMANDS.items()},
            })

        if path == "/api/analysis":
            # Hand back an analysis.json the page just produced. Same
            # containment rule as every path argument: inside the root or not
            # at all, so this cannot become a way to read the disk.
            wanted = urllib.parse.parse_qs(
                urllib.parse.urlparse(self.path).query).get("path", [""])[0]
            try:
                resolved = Path(_inside(self.root, wanted))
            except ServeError as exc:
                return self._json(403, {"error": str(exc)})
            if resolved.name != "analysis.json" or not resolved.is_file():
                return self._json(404, {"error": "no analysis there"})
            data = resolved.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return

        target = (STUDIO / path.lstrip("/")).resolve()
        try:
            target.relative_to(STUDIO)
        except ValueError:
            return self._json(403, {"error": "outside the studio directory"})
        if not target.is_file():
            return self._json(404, {"error": "not found"})

        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---- POST: prepare and run -----------------------------------------

    def do_POST(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        try:
            self._guard_origin()
            body = self._read_json()
            name = str(body.get("command", ""))
            options = body.get("options") or {}
            argv = build_argv(name, options, self.root)
            cmd = COMMANDS[name]

            if path == "/api/prepare":
                # What would run, and whether a human has to agree first.
                token = None
                if cmd.writes:
                    if self.read_only:
                        raise ServeError("this server is read-only; "
                                         "restart without --read-only to master")
                    token = self.confirmations.issue(argv)
                return self._json(200, {
                    "command": name,
                    "writes": cmd.writes,
                    "summary": cmd.summary,
                    "display": _display(argv, self.root),
                    "confirm": token,
                })

            if path == "/api/run":
                if cmd.writes:
                    if self.read_only:
                        raise ServeError("this server is read-only")
                    self.confirmations.redeem(str(body.get("confirm", "")), argv)
                return self._json(200, _run(argv, self.root))

            return self._json(404, {"error": "no such endpoint"})

        except ServeError as exc:
            return self._json(400, {"error": str(exc)})
        except json.JSONDecodeError:
            return self._json(400, {"error": "body is not JSON"})
        except Exception as exc:                       # noqa: BLE001
            log.exception("unhandled")
            return self._json(500, {"error": f"{type(exc).__name__}: {exc}"})


def _display(argv: list[str], root: Path) -> str:
    """The command as a person should read it: short paths, `music` up front."""
    parts = []
    for a in argv[2:]:
        try:
            p = Path(a)
            if p.is_absolute():
                a = str(p.relative_to(root)) if str(p).startswith(str(root)) else p.name
        except ValueError:
            pass
        parts.append(a if " " not in a else f'"{a}"')
    script = Path(argv[1]).stem
    return " ".join([script] + parts)


def _run(argv: list[str], cwd: Path) -> dict:
    """Run one command. No shell, ever."""
    started = time.monotonic()
    try:
        proc = subprocess.run(
            argv, cwd=str(cwd), capture_output=True, text=True,
            timeout=RUN_TIMEOUT, shell=False,
        )
    except subprocess.TimeoutExpired:
        raise ServeError(f"timed out after {RUN_TIMEOUT}s")
    return {
        "argv": argv[1:],
        "returncode": proc.returncode,
        "stdout": proc.stdout[-40000:],
        "stderr": proc.stderr[-40000:],
        "seconds": round(time.monotonic() - started, 2),
    }


def serve(root: Path, port: int, read_only: bool, host: str = "127.0.0.1") -> None:
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise ServeError(
            f"refusing to bind {host}. This server runs commands that write "
            "audio; it listens on loopback only."
        )
    if not root.is_dir():
        raise ServeError(f"--root is not a directory: {root}")
    if not STUDIO.is_dir():
        raise ServeError(f"no studio page at {STUDIO}")

    Handler.root = root.resolve()
    Handler.read_only = read_only
    Handler.confirmations = Confirmations()

    httpd = ThreadingHTTPServer((host, port), Handler)
    log.info("music studio on http://%s:%d", host, port)
    log.info("root    %s", Handler.root)
    log.info("actions %s", "read-only" if read_only else "enabled (writes confirm first)")
    log.info("^C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("stopped")
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Serve the music studio and run music commands for it.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--root", type=Path, default=Path("."),
                   help="Directory commands may touch. Nothing outside it is reachable.")
    p.add_argument("--port", type=int, default=8770)
    p.add_argument("--host", default="127.0.0.1", help="Loopback only; anything else is refused.")
    p.add_argument("--read-only", action="store_true",
                   help="Refuse every command that writes audio.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )
    try:
        serve(args.root.resolve(), args.port, args.read_only, args.host)
    except ServeError as exc:
        log.error("%s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
