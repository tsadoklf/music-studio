#!/usr/bin/env python3
"""Expose the music CLI to an agent over MCP.

    mcp_server.py --root ../camille-marceau

Speaks the Model Context Protocol on stdin/stdout, so an agent that supports
MCP can measure, analyse, advise and master without being told the commands.

WHY THIS EXISTS ALONGSIDE THE OTHER TWO FRONT DOORS

There are now three ways in, and they are not alternatives:

  SKILL.md      teaches an agent the WORKFLOW — when to master, why publishing
                before mastering is unrecoverable, what the invariants are. It
                is prose, loaded into context, and it cannot execute anything.
  serve.py      serves the browser page and runs commands for it. HTTP,
                loopback, for a human at a keyboard.
  this file     lets an agent call the same commands as typed tools, with
                schemas it can read, no shell string to compose, and no risk of
                inventing a flag that does not exist.

An agent using only the skill must write `music master <track> --lufs -14` as
text and hope the shell agrees. Over MCP it calls `master(track=..., lufs=-14)`
against a declared schema, and a wrong argument is a validation error rather
than a mangled command. That is the whole gain: the skill supplies judgement,
MCP supplies hands.

ONE SOURCE OF TRUTH

The tool list is generated from serve.py's COMMANDS table. Adding a command
there exposes it here automatically, and the safety rules — argv only, never a
shell string; every path resolved inside --root; `master` marked as writing —
are the same code, not a second implementation that can drift.

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path


from music_studio.serve.http import COMMANDS, ServeError, _display, _run, build_argv   # noqa: E402

log = logging.getLogger("mcp")

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "music-studio"
SERVER_VERSION = "1.0.0"

# A tool that writes audio needs the caller to mean it. MCP has no confirmation
# step of its own, so the intent is carried in the arguments: the caller must
# pass confirm=true, which an agent cannot do by accident while exploring.
WRITE_CONFIRM = "confirm"

JSON_TYPE = {"path": "string", "text": "string", "number": "number",
             "flag": "boolean"}


def tool_name(cmd: str) -> str:
    return cmd.replace("-", "_")


def arg_name(flag: str) -> str:
    """`--sample-rate` becomes `sample_rate`: agents pass keywords, not flags."""
    return flag.lstrip("-").replace("-", "_")


def schema_for(name: str) -> dict:
    """A JSON Schema an agent can read, built from the command table."""
    cmd = COMMANDS[name]
    props: dict[str, dict] = {}
    for flag, kind in cmd.options.items():
        props[arg_name(flag)] = {
            "type": JSON_TYPE.get(kind, "string"),
            "description": _describe(name, flag, kind),
        }
    if cmd.writes:
        props[WRITE_CONFIRM] = {
            "type": "boolean",
            "description": ("Must be true. This tool writes audio to disk; the "
                            "flag exists so it cannot happen by accident."),
        }
    return {
        "type": "object",
        "properties": props,
        "required": [WRITE_CONFIRM] if cmd.writes else [],
        "additionalProperties": False,
    }


def _describe(name: str, flag: str, kind: str) -> str:
    """Per-argument help, because a bare type tells an agent nothing."""
    known = {
        "--in": "Audio file to read, relative to the server root.",
        "--out": "Where to write the result, relative to the server root.",
        "--analysis": "An analysis.json produced by `scope` or `studio`.",
        "--ask": "A question, in plain language.",
        "--lufs": "Integrated loudness target, e.g. -14 for streaming.",
        "--tp": "True-peak ceiling in dBTP, e.g. -1.0.",
        "--eq": ("A tone preset (flat, warm, air, clean-lows, narrow-bass) or "
                 "a raw ffmpeg filter chain. Runs before the loudness stage."),
        "--a": "First file to compare, usually the take.",
        "--b": "Second file to compare, usually the master.",
        "--null": "Write the difference signal here, to listen to.",
        "--bands-json": "Current equaliser bands as inline JSON.",
        "--no-advice": "Skip the model call and only measure.",
        "--measure": "Report the numbers without writing anything.",
    }
    return known.get(flag, f"{kind} argument {flag}")


def tools() -> list[dict]:
    out = []
    for name, cmd in COMMANDS.items():
        summary = cmd.summary
        if cmd.writes:
            summary += " Requires confirm=true."
        out.append({
            "name": tool_name(name),
            "description": summary,
            "inputSchema": schema_for(name),
        })
    return out


def call_tool(name: str, args: dict, root: Path, read_only: bool) -> dict:
    """Run one tool and return its MCP content blocks."""
    cmd_name = next((c for c in COMMANDS if tool_name(c) == name), None)
    if cmd_name is None:
        raise ServeError(f"unknown tool: {name}")
    cmd = COMMANDS[cmd_name]

    args = dict(args or {})
    confirmed = bool(args.pop(WRITE_CONFIRM, False))
    if cmd.writes:
        if read_only:
            raise ServeError(f"{name} writes audio and this server is read-only")
        if not confirmed:
            raise ServeError(
                f"{name} writes audio to disk. Pass confirm=true when you mean it.")

    # Back to flags, then through serve.py's own validator — so path
    # containment, the option whitelist and the type checks are the same code
    # the browser goes through, not a second implementation.
    options = {}
    for key, value in args.items():
        flag = next((f for f in cmd.options if arg_name(f) == key), None)
        if flag is None:
            raise ServeError(f"{name} does not accept '{key}'")
        options[flag] = value

    argv = build_argv(cmd_name, options, root)
    result = _run(argv, root)

    text = (result.get("stdout") or "").strip()
    err = (result.get("stderr") or "").strip()
    ok = result.get("returncode") == 0

    body = text or err or "(no output)"
    if err and text:
        body = f"{text}\n\n--- log ---\n{err}"

    return {
        "content": [{"type": "text",
                     "text": f"$ {_display(argv, root)}\n\n{body}"}],
        "isError": not ok,
    }


# --------------------------------------------------------------------------
# the JSON-RPC loop
# --------------------------------------------------------------------------

def handle(msg: dict, root: Path, read_only: bool) -> dict | None:
    method = msg.get("method")
    mid = msg.get("id")

    if method == "initialize":
        return _ok(mid, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })

    if method == "notifications/initialized":
        return None                      # a notification takes no reply

    if method == "tools/list":
        return _ok(mid, {"tools": tools()})

    if method == "tools/call":
        params = msg.get("params") or {}
        try:
            return _ok(mid, call_tool(params.get("name", ""),
                                      params.get("arguments") or {},
                                      root, read_only))
        except ServeError as exc:
            # A refusal is a result the agent can read and correct, not a
            # transport failure.
            return _ok(mid, {"content": [{"type": "text", "text": str(exc)}],
                             "isError": True})

    if method == "ping":
        return _ok(mid, {})

    return _err(mid, -32601, f"method not found: {method}")


def _ok(mid, result) -> dict:
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def _err(mid, code, message) -> dict:
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def serve_stdio(root: Path, read_only: bool) -> int:
    """Read one JSON-RPC message per line, answer on stdout.

    Logging goes to stderr: stdout is the protocol channel, and a stray print
    there corrupts the stream.
    """
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            sys.stdout.write(json.dumps(_err(None, -32700, "parse error")) + "\n")
            sys.stdout.flush()
            continue

        try:
            reply = handle(msg, root, read_only)
        except Exception as exc:                       # noqa: BLE001
            log.exception("unhandled")
            reply = _err(msg.get("id"), -32603, f"{type(exc).__name__}: {exc}")

        if reply is not None:
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Expose the music CLI to an agent over MCP.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--root", type=Path, default=Path("."),
                   help="Directory the tools may touch. Nothing outside it is reachable.")
    p.add_argument("--read-only", action="store_true",
                   help="Refuse every tool that writes audio.")
    p.add_argument("--list-tools", action="store_true",
                   help="Print the tool schemas and exit, for inspection.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        stream=sys.stderr,
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s")

    root = args.root.resolve()
    if args.list_tools:
        print(json.dumps(tools(), indent=1))
        return 0
    if not root.is_dir():
        log.error("--root is not a directory: %s", root)
        return 1

    log.info("music-studio MCP on stdio; root %s%s",
             root, " (read-only)" if args.read_only else "")
    return serve_stdio(root, args.read_only)


if __name__ == "__main__":
    sys.exit(main())
