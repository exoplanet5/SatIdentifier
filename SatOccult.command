#!/bin/zsh
# SatOccult launcher — double-click in Finder to start.
cd "$(dirname "$0")"
if [ -x ".venv/bin/python" ]; then
  PY=.venv/bin/python
elif [ -x "$HOME/.venvs/astro313/bin/python" ]; then
  PY="$HOME/.venvs/astro313/bin/python"
else
  PY=python3
fi
# Prefer the packaged-style native window when pywebview is installed. The
# server-only fallback remains useful on machines without a GUI dependency.
if "$PY" -c 'import webview' >/dev/null 2>&1; then
  exec "$PY" desktop.py
fi
exec "$PY" server.py
