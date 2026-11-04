"""`python -m yhub` is equivalent to the `yhub` command."""

from __future__ import annotations

from yhub.cli.main import main

if __name__ == "__main__":
    raise SystemExit(main())
