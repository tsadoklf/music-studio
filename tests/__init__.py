"""Test package for the song-shop tooling.

Puts the parent directory on sys.path so `import analyze` resolves when tests
are run with `python -m unittest discover -s tests` from _tooling/.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
