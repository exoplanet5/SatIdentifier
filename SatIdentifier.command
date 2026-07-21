#!/bin/zsh
# SatIdentifier launcher — double-click in Finder to start.
cd "$(dirname "$0")"
PY="$HOME/.venvs/astro313/bin/python"
[ -x "$PY" ] || PY=python3
exec "$PY" server.py
