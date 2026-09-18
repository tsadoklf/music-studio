"""The two front doors.

`http` serves the browser page and turns a click into a subprocess. `mcp`
exposes the same commands to an agent as typed tools, GENERATED from `http`'s
COMMANDS table — so path containment, the option whitelist and argv-not-shell
are one implementation rather than two that can drift.
"""
