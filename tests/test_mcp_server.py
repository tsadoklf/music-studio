#!/usr/bin/env python3
"""Tests for mcp_server.py.

The MCP front door reuses serve.py's validator, so the containment rules are
already covered by test_serve.py and are not re-tested here. What IS worth
testing is the part that only exists in this file: the tool schemas an agent
reads, and the confirm gate that stands between an exploring agent and a
command that overwrites audio.
"""

from __future__ import annotations

import unittest

from music_studio.serve import mcp as mcp_server
from music_studio.serve.http import COMMANDS


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


if __name__ == "__main__":
    unittest.main()
