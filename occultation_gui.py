#!/usr/bin/env python3
"""Small Tk GUI for the browser-independent occultation runner.

The GUI owns no astronomy. It starts ``tools/run_occultation_headless.js`` in a
separate process, forwards progress records, and leaves the JSON/CSV result on
disk. A failed or cancelled calculation therefore cannot take down the GUI.
"""

from __future__ import annotations

import datetime as dt
import json
import queue
import shutil
import subprocess
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk


ROOT = Path(__file__).resolve().parent
RUNNER = ROOT / "tools" / "run_occultation_headless.js"
STATE = ROOT / "data" / "state.json"
CATALOGUE = ROOT / "data" / "cache" / "catalog_full.json"


def read_defaults():
    saved = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    locations = saved.get("locations") or []
    site = next((row for row in locations if row.get("active")), locations[0] if locations else {})
    try:
        timezone = dt.datetime.now().astimezone().tzinfo
        zone_name = getattr(timezone, "key", None) or "UTC"
    except Exception:
        zone_name = "UTC"
    return {
        "date": dt.date.today().isoformat(),
        "timezone": zone_name,
        "lat": str(site.get("latDeg", "")),
        "lon": str(site.get("lonDeg", "")),
        "alt": str(site.get("altM", 0)),
        "mag": "6", "corridor": "10", "radius": "1",
    }


class OccultationGui:
    def __init__(self, root):
        self.root = root
        self.root.title("SatIdentifier — Complete Occultation Search")
        self.root.geometry("780x600")
        self.process = None
        self.messages = queue.Queue()
        self.defaults = read_defaults()
        self.fields = {}
        self.contacts_only = tk.BooleanVar(value=True)
        self.status = tk.StringVar(value="Ready")
        self.progress = tk.DoubleVar(value=0)
        self._build()
        self.root.after(100, self._poll_messages)

    def _build(self):
        frame = ttk.Frame(self.root, padding=12)
        frame.pack(fill="both", expand=True)
        form = ttk.LabelFrame(frame, text="Complete search parameters", padding=10)
        form.pack(fill="x")
        specs = [
            ("date", "Local date"), ("timezone", "IANA timezone"),
            ("lat", "Latitude"), ("lon", "Longitude"), ("alt", "Altitude m"),
            ("mag", "Star V limit"), ("corridor", "Corridor arcsec"),
            ("radius", "Effective radius m"),
        ]
        for index, (key, label) in enumerate(specs):
            row, column = divmod(index, 4)
            ttk.Label(form, text=label).grid(row=row * 2, column=column, sticky="w", padx=4, pady=(2, 0))
            value = tk.StringVar(value=self.defaults[key])
            self.fields[key] = value
            ttk.Entry(form, textvariable=value, width=18).grid(
                row=row * 2 + 1, column=column, sticky="ew", padx=4, pady=(0, 6))
        for column in range(4):
            form.columnconfigure(column, weight=1)
        ttk.Checkbutton(form, text="Contacts only (recommended)", variable=self.contacts_only).grid(
            row=4, column=0, columnspan=2, sticky="w", padx=4, pady=4)
        ttk.Label(form, text="Full mode: no 5,000-candidate cap; results are written to disk").grid(
            row=4, column=2, columnspan=2, sticky="e", padx=4, pady=4)

        buttons = ttk.Frame(frame)
        buttons.pack(fill="x", pady=(10, 6))
        self.run_button = ttk.Button(buttons, text="Run complete search", command=self.run)
        self.run_button.pack(side="left")
        self.stop_button = ttk.Button(buttons, text="Stop", command=self.stop, state="disabled")
        self.stop_button.pack(side="left", padx=8)
        ttk.Label(buttons, textvariable=self.status).pack(side="right")
        ttk.Progressbar(frame, variable=self.progress, maximum=100).pack(fill="x", pady=(0, 8))

        log_frame = ttk.LabelFrame(frame, text="Calculation log", padding=6)
        log_frame.pack(fill="both", expand=True)
        self.log = tk.Text(log_frame, height=20, wrap="none", state="disabled")
        self.log.pack(side="left", fill="both", expand=True)
        scrollbar = ttk.Scrollbar(log_frame, orient="vertical", command=self.log.yview)
        scrollbar.pack(side="right", fill="y")
        self.log.configure(yscrollcommand=scrollbar.set)

    def _append(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _command(self):
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js was not found on PATH")
        args = [node, "--max-old-space-size=8192", str(RUNNER),
                "--state", str(STATE), "--catalogue", str(CATALOGUE)]
        mapping = {
            "date": "date", "timezone": "timezone", "lat": "lat", "lon": "lon",
            "alt": "alt", "mag": "mag-limit", "corridor": "corridor", "radius": "radius",
        }
        for key, option in mapping.items():
            value = self.fields[key].get().strip()
            if not value:
                raise ValueError(f"{key} is required")
            args.extend([f"--{option}", value])
        if not self.contacts_only.get():
            args.append("--all-candidates")
        return args

    def run(self):
        if self.process is not None:
            return
        try:
            command = self._command()
        except (RuntimeError, ValueError) as error:
            messagebox.showerror("Cannot start search", str(error))
            return
        self._append("$ " + " ".join(command))
        self.status.set("Running")
        self.progress.set(0)
        self.run_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.process = subprocess.Popen(
            command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
        threading.Thread(target=self._reader, args=(self.process,), daemon=True).start()

    def _reader(self, process):
        for line in process.stdout:
            self.messages.put(("line", line.rstrip()))
        self.messages.put(("exit", process.wait()))

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.status.set("Stopping")
            self.process.terminate()

    def _poll_messages(self):
        try:
            while True:
                kind, value = self.messages.get_nowait()
                if kind == "line":
                    self._handle_line(value)
                else:
                    self._finished(value)
        except queue.Empty:
            pass
        self.root.after(100, self._poll_messages)

    def _handle_line(self, line):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            self._append(line)
            return
        if payload.get("type") == "progress":
            progress = payload.get("progress") or {}
            done, total = progress.get("done", 0), progress.get("total", 0)
            phase = progress.get("phase", "running")
            stage = progress.get("stage") or phase
            if stage == "pass-scan" or phase in ("coarse", "fine"):
                start, width = 0, 40
                label = "pass scan / " + phase
            elif stage == "star-search" or phase == "star-search":
                start, width = 40, 30
                label = "star search"
            elif stage == "event-refinement" or phase == "event-refinement":
                start, width = 70, 30
                label = "exact contact refinement"
            else:
                start, width = 0, 100
                label = str(stage)
            self.progress.set(start + width * done / total if total else start)
            self.status.set(f"{label} · {done}/{total}")
        elif payload.get("type") == "finished":
            self._append(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            self._append(json.dumps(payload, ensure_ascii=False))

    def _finished(self, return_code):
        self._append(f"Process exited with code {return_code}")
        self.status.set("Finished" if return_code == 0 else "Failed / stopped")
        self.progress.set(100 if return_code == 0 else self.progress.get())
        self.process = None
        self.run_button.configure(state="normal")
        self.stop_button.configure(state="disabled")


def main():
    window = tk.Tk()
    OccultationGui(window)
    window.mainloop()


if __name__ == "__main__":
    main()
