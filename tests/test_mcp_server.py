#!/usr/bin/env python3
"""Tests for mcp_server.py.

The MCP front door reuses serve.py's validator, so the containment rules are
already covered by test_serve.py and are not re-tested here. What IS worth
testing is the part that only exists in this file: the tool schemas an agent
reads, the confirm gate that stands between an exploring agent and a command
that overwrites audio, and the JSON-RPC envelope — an agent that cannot parse
a reply cannot read the refusal in it either.

`subprocess.run` is patched wherever a tool is allowed to reach it. No test
runs ffmpeg.
"""

from __future__ import annotations

import io
import json
import subprocess
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

from music_studio.serve import mcp as mcp_server
from music_studio.serve.http import COMMANDS

ROOT = Path(__file__).resolve().parent.parent


class TestToolList(unittest.TestCase):
    def test_every_command_becomes_a_tool(self):
        names = {t["name"] for t in mcp_server.tools()}
        self.assertEqual(names, {mcp_server.tool_name(c) for c in COMMANDS})

    def test_tool_names_are_identifier_safe(self):
        """`clean-lows` style names would be awkward to call; hyphens go."""
        for t in mcp_server.tools():
            self.assertNotIn("-", t["name"])
            self.assertTrue(t["name"].isidentifier(), t["name"])

    def test_every_tool_has_a_description(self):
        for t in mcp_server.tools():
            self.assertTrue(t["description"].strip(), t["name"])

    def test_every_argument_is_described(self):
        """A bare type tells an agent nothing about what to pass."""
        for t in mcp_server.tools():
            for name, spec in t["inputSchema"]["properties"].items():
                self.assertTrue(spec.get("description", "").strip(),
                                f"{t['name']}.{name} has no description")

    def test_arguments_drop_the_leading_dashes(self):
        scope = next(t for t in mcp_server.tools() if t["name"] == "scope")
        self.assertIn("in", scope["inputSchema"]["properties"])
        self.assertNotIn("--in", scope["inputSchema"]["properties"])

    def test_hyphenated_flags_become_underscores(self):
        master = next(t for t in mcp_server.tools() if t["name"] == "master")
        self.assertIn("sample_rate", master["inputSchema"]["properties"])

    def test_no_extra_arguments_accepted(self):
        for t in mcp_server.tools():
            self.assertFalse(t["inputSchema"]["additionalProperties"])


class TestWriteGate(unittest.TestCase):
    """A tool that writes audio must be impossible to trigger by accident."""

    def test_every_writing_tool_requires_confirm(self):
        writers = [n for n, c in COMMANDS.items() if c.writes]
        self.assertTrue(writers, "no writing tools — the gate is untested")
        for name in writers:
            tool = next(t for t in mcp_server.tools()
                        if t["name"] == mcp_server.tool_name(name))
            self.assertIn("confirm", tool["inputSchema"]["required"], name)

    def test_read_tools_require_nothing(self):
        """Derived from the command table, not a hardcoded name: a second
        writing tool was added and a list of one silently went stale."""
        writers = {mcp_server.tool_name(n) for n, c in COMMANDS.items() if c.writes}
        for t in mcp_server.tools():
            if t["name"] in writers:
                continue
            self.assertEqual(t["inputSchema"].get("required", []), [],
                             f"{t['name']} should not demand an argument")

    def test_write_description_says_so(self):
        for name, cmd in COMMANDS.items():
            if not cmd.writes:
                continue
            tool = next(t for t in mcp_server.tools()
                        if t["name"] == mcp_server.tool_name(name))
            self.assertIn("confirm=true", tool["description"], name)


class TestProtocol(unittest.TestCase):
    ROOT = __import__("pathlib").Path(__file__).resolve().parent.parent

    def test_initialize_reports_a_protocol_version(self):
        r = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                              self.ROOT, False)
        self.assertEqual(r["result"]["protocolVersion"], mcp_server.PROTOCOL_VERSION)
        self.assertIn("tools", r["result"]["capabilities"])

    def test_notification_gets_no_reply(self):
        """A JSON-RPC notification has no id and must not be answered."""
        self.assertIsNone(mcp_server.handle(
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            self.ROOT, False))

    def test_unknown_method_is_an_error(self):
        r = mcp_server.handle({"jsonrpc": "2.0", "id": 9, "method": "nope"},
                              self.ROOT, False)
        self.assertEqual(r["error"]["code"], -32601)

    def test_tools_list_round_trips(self):
        r = mcp_server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                              self.ROOT, False)
        self.assertEqual(len(r["result"]["tools"]), len(COMMANDS))


class TestCallRefusals(unittest.TestCase):
    """A refusal is returned as a readable result, not a transport error — the
    agent has to be able to read it and correct itself."""

    ROOT = __import__("pathlib").Path(__file__).resolve().parent.parent

    def _call(self, name, args, read_only=False):
        return mcp_server.handle(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": name, "arguments": args}},
            self.ROOT, read_only)["result"]

    def test_write_without_confirm_refuses(self):
        r = self._call("master", {"in": "a.wav", "out": "b.wav"})
        self.assertTrue(r["isError"])
        self.assertIn("confirm=true", r["content"][0]["text"])

    def test_read_only_server_refuses_writes(self):
        r = self._call("master", {"in": "a.wav", "out": "b.wav", "confirm": True},
                       read_only=True)
        self.assertTrue(r["isError"])
        self.assertIn("read-only", r["content"][0]["text"])

    def test_unknown_tool_refuses(self):
        r = self._call("definitely_not_a_tool", {})
        self.assertTrue(r["isError"])

    def test_unknown_argument_refuses(self):
        r = self._call("measure", {"exec": "rm -rf /"})
        self.assertTrue(r["isError"])
        self.assertIn("does not accept", r["content"][0]["text"])

    def test_path_escape_refuses(self):
        r = self._call("measure", {"in": "../../../../etc/passwd", "measure": True})
        self.assertTrue(r["isError"])
        self.assertIn("escapes the root", r["content"][0]["text"])


class TestSuccessfulCalls(unittest.TestCase):
    """The allowed path. subprocess.run is patched: what is under test is the
    argv built and the content blocks returned, never ffmpeg."""

    def setUp(self):
        self.calls = []

        def fake_run(argv, **kw):
            self.calls.append((argv, kw))
            return subprocess.CompletedProcess(argv, 0, "-14.0 LUFS integrated\n", "")

        patcher = unittest.mock.patch("subprocess.run", side_effect=fake_run)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _call(self, name, args, read_only=False):
        return mcp_server.call_tool(name, args, ROOT, read_only)

    def test_a_read_tool_returns_its_output_as_a_text_block(self):
        r = self._call("measure", {"in": "README.md", "measure": True})
        self.assertFalse(r["isError"])
        self.assertIn("-14.0 LUFS", r["content"][0]["text"])

    def test_the_command_that_ran_is_echoed_back(self):
        """An agent that can see the argv can correct itself; one that gets
        only the output has to guess what its arguments became."""
        r = self._call("measure", {"in": "README.md", "measure": True})
        self.assertIn("$ master", r["content"][0]["text"])

    def test_keyword_arguments_become_the_right_flags(self):
        self._call("master", {"in": "a.wav", "out": "b.wav",
                              "sample_rate": 48000, "confirm": True})
        argv = self.calls[0][0]
        self.assertIn("--sample-rate", argv)
        self.assertIn("48000", argv)
        self.assertNotIn("sample_rate", argv)

    def test_confirm_is_consumed_and_never_passed_to_the_script(self):
        """It is an MCP-level gate, not a flag master.py knows about — passing
        it through would make every write fail with an unknown-argument error."""
        self._call("master", {"in": "a.wav", "out": "b.wav", "confirm": True})
        self.assertNotIn("--confirm", self.calls[0][0])
        self.assertNotIn("confirm", self.calls[0][0])

    def test_never_a_shell(self):
        """The same claim serve.py makes, through the same code — asserted here
        because this is the door an agent comes through."""
        self._call("measure", {"in": "README.md", "measure": True})
        argv, kw = self.calls[0]
        self.assertIs(kw["shell"], False)
        self.assertIsInstance(argv, list)

    def test_paths_are_resolved_inside_the_root(self):
        self._call("measure", {"in": "README.md", "measure": True})
        self.assertIn(str(ROOT / "README.md"), self.calls[0][0])

    def test_a_nonzero_exit_is_reported_as_an_error_with_its_stderr(self):
        """An agent must be able to tell a failed master from a silent one."""
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess([], 1, "", "no such file")):
            r = self._call("measure", {"in": "README.md", "measure": True})
        self.assertTrue(r["isError"])
        self.assertIn("no such file", r["content"][0]["text"])

    def test_stdout_and_stderr_are_both_kept_when_both_are_present(self):
        """ffmpeg narrates on stderr while the answer goes to stdout; dropping
        either loses half the story."""
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, "the answer",
                                                         "a warning")):
            r = self._call("measure", {"in": "README.md", "measure": True})
        text = r["content"][0]["text"]
        self.assertIn("the answer", text)
        self.assertIn("a warning", text)

    def test_silence_is_said_rather_than_returned_empty(self):
        """An empty content block reads to an agent as a broken tool."""
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, "", "")):
            r = self._call("measure", {"in": "README.md", "measure": True})
        self.assertIn("(no output)", r["content"][0]["text"])

    def test_a_read_tool_is_unaffected_by_read_only(self):
        r = self._call("measure", {"in": "README.md", "measure": True},
                       read_only=True)
        self.assertFalse(r["isError"])

    def test_a_write_runs_once_confirmed(self):
        r = self._call("master", {"in": "a.wav", "out": "b.wav", "confirm": True})
        self.assertFalse(r["isError"])
        self.assertEqual(len(self.calls), 1)

    def test_confirm_false_is_refused_like_no_confirm_at_all(self):
        """`confirm=False` is what an agent filling in a schema sends by
        default. Treating a present-but-false flag as consent would make the
        gate decorative."""
        with self.assertRaises(mcp_server.ServeError):
            self._call("master", {"in": "a.wav", "out": "b.wav", "confirm": False})
        self.assertEqual(self.calls, [])


class TestSchemaTypes(unittest.TestCase):
    """The schema is the only thing telling an agent what to pass. A wrong
    type there produces arguments this file then refuses, with the agent
    having done exactly what it was told."""

    def test_a_number_option_is_declared_as_a_number(self):
        master = mcp_server.schema_for("master")
        self.assertEqual(master["properties"]["lufs"]["type"], "number")

    def test_a_flag_is_declared_as_a_boolean(self):
        self.assertEqual(
            mcp_server.schema_for("measure")["properties"]["measure"]["type"],
            "boolean")

    def test_a_path_is_declared_as_a_string(self):
        self.assertEqual(
            mcp_server.schema_for("scope")["properties"]["in"]["type"], "string")

    def test_every_declared_type_is_a_real_json_schema_type(self):
        allowed = {"string", "number", "boolean", "integer", "object", "array"}
        for name in COMMANDS:
            for arg, spec in mcp_server.schema_for(name)["properties"].items():
                self.assertIn(spec["type"], allowed, f"{name}.{arg}")

    def test_the_schema_covers_every_option_the_command_accepts(self):
        """An option missing from the schema is unreachable over MCP even
        though serve.py would accept it."""
        for name, cmd in COMMANDS.items():
            props = set(mcp_server.schema_for(name)["properties"])
            for flag in cmd.options:
                self.assertIn(mcp_server.arg_name(flag), props, f"{name} {flag}")

    def test_an_undocumented_flag_still_gets_a_description(self):
        """_describe falls back rather than returning empty, so a newly added
        flag is never presented to an agent with a blank explanation."""
        self.assertTrue(mcp_server._describe("master", "--brand-new", "text").strip())


class TestEnvelope(unittest.TestCase):
    """JSON-RPC framing. An agent parses these before it can read anything
    inside them."""

    def test_ping_is_answered(self):
        r = mcp_server.handle({"jsonrpc": "2.0", "id": 7, "method": "ping"},
                              ROOT, False)
        self.assertEqual(r["result"], {})
        self.assertEqual(r["id"], 7)

    def test_the_id_is_echoed_on_every_reply(self):
        """It is how a caller matches a reply to its request; a dropped id
        stalls a pipelined client forever."""
        for method in ("initialize", "tools/list", "ping"):
            r = mcp_server.handle({"jsonrpc": "2.0", "id": 42, "method": method},
                                  ROOT, False)
            self.assertEqual(r["id"], 42, method)

    def test_every_reply_declares_the_protocol_version(self):
        for method in ("initialize", "tools/list", "ping"):
            r = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": method},
                                  ROOT, False)
            self.assertEqual(r["jsonrpc"], "2.0", method)

    def test_an_error_reply_carries_no_result(self):
        """JSON-RPC forbids both; a client checking for "result" first would
        read an error as a success."""
        r = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "nope"},
                              ROOT, False)
        self.assertNotIn("result", r)
        self.assertIn("message", r["error"])

    def test_a_refused_call_is_a_result_not_an_error_envelope(self):
        """The distinction is deliberate: a refusal is something the agent can
        read and correct, while an error envelope reads as a broken transport."""
        r = mcp_server.handle(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": "master", "arguments": {"in": "a.wav"}}},
            ROOT, False)
        self.assertIn("result", r)
        self.assertNotIn("error", r)
        self.assertTrue(r["result"]["isError"])

    def test_a_call_with_no_params_does_not_crash(self):
        r = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call"},
                              ROOT, False)
        self.assertTrue(r["result"]["isError"])


class TestStdioLoop(unittest.TestCase):
    """serve_stdio reads one message per line and writes one per line. stdout
    IS the protocol channel, so anything extra on it corrupts the stream."""

    def _pump(self, lines: str) -> list[str]:
        out = io.StringIO()
        with unittest.mock.patch.object(mcp_server.sys, "stdin",
                                        io.StringIO(lines)), \
                unittest.mock.patch.object(mcp_server.sys, "stdout", out):
            rc = mcp_server.serve_stdio(ROOT, False)
        self.rc = rc
        return [l for l in out.getvalue().splitlines() if l]

    def test_one_reply_per_request(self):
        lines = self._pump(
            '{"jsonrpc": "2.0", "id": 1, "method": "ping"}\n'
            '{"jsonrpc": "2.0", "id": 2, "method": "ping"}\n')
        self.assertEqual([json.loads(l)["id"] for l in lines], [1, 2])
        self.assertEqual(self.rc, 0)

    def test_every_line_is_one_complete_json_object(self):
        """Pretty-printing a reply across several lines would desynchronise a
        line-based reader for the rest of the session."""
        for line in self._pump('{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}\n'):
            json.loads(line)          # must not raise

    def test_blank_lines_are_ignored(self):
        lines = self._pump('\n\n{"jsonrpc": "2.0", "id": 1, "method": "ping"}\n\n')
        self.assertEqual(len(lines), 1)

    def test_a_notification_produces_no_line_at_all(self):
        """Answering a notification is a protocol violation and leaves the
        client an unmatched reply it will try to pair with the next request."""
        self.assertEqual(
            self._pump('{"jsonrpc": "2.0", "method": "notifications/initialized"}\n'),
            [])

    def test_unparseable_input_gets_a_parse_error_and_the_loop_continues(self):
        """A truncated write from the client must not kill the session."""
        lines = self._pump('{not json\n{"jsonrpc": "2.0", "id": 5, "method": "ping"}\n')
        self.assertEqual(json.loads(lines[0])["error"]["code"], -32700)
        self.assertEqual(json.loads(lines[1])["id"], 5)

    def test_an_unexpected_crash_is_reported_and_the_loop_continues(self):
        """Without this the whole session dies on one bad call, and the agent
        sees a closed pipe rather than a message it could act on."""
        with unittest.mock.patch.object(mcp_server, "handle",
                                        side_effect=[RuntimeError("boom"),
                                                     {"jsonrpc": "2.0", "id": 2,
                                                      "result": {}}]), \
                unittest.mock.patch.object(mcp_server.log, "exception"):
            lines = self._pump('{"jsonrpc": "2.0", "id": 1, "method": "ping"}\n'
                               '{"jsonrpc": "2.0", "id": 2, "method": "ping"}\n')
        self.assertEqual(json.loads(lines[0])["error"]["code"], -32603)
        self.assertIn("RuntimeError", json.loads(lines[0])["error"]["message"])
        self.assertEqual(json.loads(lines[1])["id"], 2)


class TestMain(unittest.TestCase):
    def setUp(self):
        quiet = unittest.mock.patch.object(mcp_server.log, "info")
        quiet.start()
        self.addCleanup(quiet.stop)

    def test_list_tools_prints_the_schemas_and_exits(self):
        """The inspection path: it must not start the stdio loop, or running it
        by hand in a terminal hangs."""
        buf = io.StringIO()
        with unittest.mock.patch.object(mcp_server, "serve_stdio") as loop, \
                redirect_stdout(buf):
            rc = mcp_server.main(["--list-tools"])
        self.assertEqual(rc, 0)
        loop.assert_not_called()
        self.assertEqual(len(json.loads(buf.getvalue())), len(COMMANDS))

    def test_the_root_is_resolved_before_the_loop_gets_it(self):
        """Containment compares resolved paths; an unresolved relative root
        would make every comparison fail open."""
        with unittest.mock.patch.object(mcp_server, "serve_stdio",
                                        return_value=0) as loop:
            mcp_server.main(["--root", str(ROOT / "tests" / "..")])
        self.assertEqual(loop.call_args[0][0], ROOT)

    def test_read_only_reaches_the_loop(self):
        with unittest.mock.patch.object(mcp_server, "serve_stdio",
                                        return_value=0) as loop:
            mcp_server.main(["--root", str(ROOT), "--read-only"])
        self.assertTrue(loop.call_args[0][1])

    def test_a_root_that_is_not_a_directory_is_an_exit_code(self):
        with unittest.mock.patch.object(mcp_server, "serve_stdio") as loop, \
                unittest.mock.patch.object(mcp_server.log, "error"):
            rc = mcp_server.main(["--root", str(ROOT / "README.md")])
        self.assertEqual(rc, 1)
        loop.assert_not_called()

    def test_logging_never_goes_to_stdout(self):
        """stdout is the protocol channel. A log line on it corrupts the
        stream for every message after it."""
        with unittest.mock.patch.object(mcp_server, "serve_stdio", return_value=0), \
                unittest.mock.patch.object(mcp_server.logging,
                                           "basicConfig") as configured:
            mcp_server.main(["--root", str(ROOT)])
        self.assertIs(configured.call_args[1]["stream"], mcp_server.sys.stderr)


if __name__ == "__main__":
    unittest.main()
