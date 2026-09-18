"""Samples in, numbers out.

Measurement and processing: loudness and true peak, mastering, the MClass-style
maximizer suite, tempo and key, the null test, and video rendering. Everything
here takes a file path and returns numbers or writes a file.

Nothing in this package calls a model or decides what a measurement MEANS —
that is `music_studio.insight`, and the dependency runs one way.
"""
