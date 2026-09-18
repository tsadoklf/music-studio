"""Make the tooling modules importable from inside tests/.

The tests import their subjects directly (`import analyze`), which worked while
they sat beside those modules. From a subdirectory the parent has to be put on
the path explicitly — done here so no individual test file carries the boilerplate.

pytest picks this up automatically; `unittest` does not, which is why the same
insertion also lives in tests/__init__.py.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
