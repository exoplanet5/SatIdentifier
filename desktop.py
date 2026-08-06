#!/usr/bin/env python3
"""SatIdentifier desktop shell.

Runs the local backend on a daemon thread and hosts the UI in a native
macOS window (pywebview / WKWebView). Closing the window quits the app.
"""

import importlib.util
import os
import pathlib
import sys


if importlib.util.find_spec("webview") is None:
    local_python = pathlib.Path(__file__).resolve().parent / ".venv" / "bin" / "python"
    if (__name__ == "__main__" and local_python.is_file()
            and pathlib.Path(sys.executable).resolve() != local_python.resolve()):
        os.execv(str(local_python), [str(local_python), __file__, *sys.argv[1:]])
    raise SystemExit(
        "pywebview is not installed. Run: "
        f"{local_python} -m pip install pywebview"
    )

import webview

import server
from desktop_occultation import OccultationBridge


def main():
    port = server.start_in_thread()
    api = OccultationBridge()
    webview.create_window(
        "SatIdentifier",
        f"http://127.0.0.1:{port}",
        width=1500,
        height=950,
        min_size=(1050, 680),
        text_select=True,
        js_api=api,
    )
    try:
        webview.start()
    finally:
        api.shutdown()


if __name__ == "__main__":
    main()
