#!/usr/bin/env python3
"""SatIdentifier desktop shell.

Runs the local backend on a daemon thread and hosts the UI in a native
macOS window (pywebview / WKWebView). Closing the window quits the app.
"""

import webview

import server


def main():
    port = server.start_in_thread()
    webview.create_window(
        "SatIdentifier",
        f"http://127.0.0.1:{port}",
        width=1500,
        height=950,
        min_size=(1050, 680),
        text_select=True,
    )
    webview.start()


if __name__ == "__main__":
    main()
