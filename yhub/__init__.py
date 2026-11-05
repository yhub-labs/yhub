"""The Y-Hub Python package (PyPI distribution ``yhub``).

Single namespace: every module lives under ``yhub.*`` so installing into
site-packages never adds top-level ``cli/`` / ``server/`` / ``web/``
directories that other distributions are likely to collide with.

``__version__`` below is the single source of truth: ``pyproject.toml`` reads it
via ``[tool.hatch.version] path = "yhub/__init__.py"``, runtime uses
``yhub.__version__``. Bump the version here only.
"""

__version__ = "0.1.8"

__all__ = ["__version__"]
