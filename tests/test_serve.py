#!/usr/bin/env python3
"""Tests for serve.py.

This is the one file that turns a browser click into a process, so
the tests are mostly about what it refuses. Each case below corresponds to a way
the page could otherwise reach something it should not: a path outside the root,
a flag the command table does not list, a write without a confirmation, a
confirmation reused or swapped onto a different command.

No test starts a listening socket except the one that checks binding is refused.
"""

from __future__ import annotations

import unittest
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


if __name__ == "__main__":
    unittest.main()
