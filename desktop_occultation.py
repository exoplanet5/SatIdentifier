#!/usr/bin/env python3
"""Bridge the original pywebview UI to the complete occultation runner.

The HTML interface remains responsible for controls, tables, and charts.  This
small bridge only starts the browser-independent Node process and exposes its
JSON-line progress stream to JavaScript through the pywebview API.
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import threading
import uuid

import server


class OccultationBridge:
    """Run at most one complete search and expose cursor-based polling."""

    def __init__(self, project_root: pathlib.Path | None = None):
        default_root = server.BASE_DIR if server.IS_BUNDLED else server.SCRIPT_DIR
        self.project_root = pathlib.Path(project_root or default_root).resolve()
        self.runner = self.project_root / "tools" / "run_occultation_headless.js"
        self._lock = threading.RLock()
        self._jobs: dict[str, dict] = {}

    @staticmethod
    def _number(config: dict, key: str, label: str) -> float:
        try:
            value = float(config[key])
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"{label} must be finite") from None
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError(f"{label} must be finite")
        return value

    @staticmethod
    def _nested(config: dict, parent: str, key: str, label: str) -> float:
        values = config.get(parent) or {}
        return OccultationBridge._number(values, key, label)

    @staticmethod
    def _node_binary() -> str | None:
        """Find Node both from a terminal PATH and from Finder's short PATH."""
        candidates = [shutil.which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        for candidate in candidates:
            if candidate and pathlib.Path(candidate).is_file():
                return candidate
        return None

    @staticmethod
    def _list(config: dict, parent: str, key: str, label: str) -> list[str] | None:
        values = (config.get(parent) or {}).get(key)
        if values is None:
            return None
        if not isinstance(values, (list, tuple)):
            raise ValueError(f"{label} must be a list")
        cleaned = [str(value).strip() for value in values if str(value).strip()]
        if not cleaned:
            raise ValueError(f"at least one {label} is required")
        return cleaned

    def _catalogue_for_job(self, config: dict, job_id: str) -> pathlib.Path:
        """Use the same merged catalogue as the ordinary SatIdentifier scan."""
        full_path = pathlib.Path(server.CACHE_DIR) / "catalog_full.json"
        if not full_path.is_file():
            raise FileNotFoundError(
                "the full catalogue is not cached yet; load it in Catalogue first")
        return full_path

    def _command(self, config: dict, job_id: str, output: pathlib.Path) -> list[str]:
        node = self._node_binary()
        if not node:
            raise RuntimeError("Node.js was not found; install it or add its bin directory to PATH")
        if not self.runner.is_file():
            raise RuntimeError(f"complete runner is missing: {self.runner}")

        site = config.get("site") or {}
        if not isinstance(site, dict):
            raise ValueError("an active ground site is required")
        if site.get("kind") == "orbit":
            raise ValueError("the complete desktop occultation runner currently requires a ground site")

        try:
            local_date = str(config["localDate"]).strip()
            time_zone = str(config["timeZone"]).strip()
        except KeyError:
            raise ValueError("local date and IANA time zone are required") from None
        if not local_date or not time_zone:
            raise ValueError("local date and IANA time zone are required")

        state_path = pathlib.Path(server.STATE_PATH)
        catalogue_path = self._catalogue_for_job(config, job_id)

        command = [node, "--max-old-space-size=8192", str(self.runner),
                   "--state", str(state_path), "--catalogue", str(catalogue_path),
                   "--date", local_date, "--timezone", time_zone,
                   "--lat", str(self._number(site, "latDeg", "latitude")),
                   "--lon", str(self._number(site, "lonDeg", "longitude")),
                   "--alt", str(self._number(site, "altM", "altitude")),
                   "--twilight", str(self._number(config, "sunAltitudeLimitDeg", "twilight altitude")),
                   "--min-elevation", str(self._number(config, "minimumElevationDeg", "minimum elevation")),
                   "--coarse", str(self._number(config, "coarseStepS", "coarse step")),
                   "--fine", str(self._number(config, "fineStepS", "fine step")),
                   "--path-tolerance", str(self._number(config, "pathToleranceArcsec", "path tolerance")),
                   "--mag-limit", str(self._nested(config, "starOptions", "magLimit", "star magnitude limit")),
                   "--corridor", str(self._nested(config, "starOptions", "corridorArcsec", "search corridor")),
                   "--radius", str(self._nested(config, "eventOptions", "defaultRadiusM", "effective radius")),
                   "--output", str(output)]
        classes = self._list(config, "passOptions", "classes", "orbit-class tag")
        types = self._list(config, "passOptions", "types", "object type")
        if classes is not None:
            command.extend(["--classes", ",".join(classes)])
        if types is not None:
            command.extend(["--types", ",".join(types)])
        if not bool((config.get("eventOptions") or {}).get("contactsOnly", True)):
            command.append("--all-candidates")
        return command

    def start_occultation(self, config: dict | None = None) -> dict:
        """Start a complete search and return a job ID immediately."""
        config = dict(config or {})
        with self._lock:
            if any(not job["done"] for job in self._jobs.values()):
                return {"error": "an occultation search is already running"}
            job_id = uuid.uuid4().hex[:12]
            output = pathlib.Path(server.DATA_DIR) / "occultation-results" \
                / f"occultation-{config.get('localDate', 'unknown')}-{job_id}.json"
            command = self._command(config, job_id, output)
            process = subprocess.Popen(
                command,
                cwd=self.project_root,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            self._jobs[job_id] = {
                "process": process,
                "output": output,
                "messages": [],
                "done": False,
                "returnCode": None,
                "cancelRequested": False,
                "report": None,
            }
            threading.Thread(
                target=self._read_job, args=(job_id, process),
                name=f"occultation-{job_id}", daemon=True,
            ).start()
            return {"jobId": job_id, "mode": "headless-complete", "output": str(output)}

    @staticmethod
    def _decode_line(line: str) -> dict:
        try:
            payload = json.loads(line)
            return payload if isinstance(payload, dict) else {"type": "log", "text": line}
        except json.JSONDecodeError:
            return {"type": "log", "text": line}

    def _read_job(self, job_id: str, process: subprocess.Popen[str]) -> None:
        for line in process.stdout or ():
            message = self._decode_line(line.rstrip())
            with self._lock:
                job = self._jobs.get(job_id)
                if job is not None:
                    job["messages"].append(message)
        return_code = process.wait()
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                job["returnCode"] = return_code
                job["done"] = True

    def _report(self, job: dict) -> dict | None:
        if job["report"] is not None:
            return job["report"]
        output = pathlib.Path(job["output"])
        if output.is_file():
            try:
                job["report"] = json.loads(output.read_text(encoding="utf-8"))
                return job["report"]
            except (OSError, ValueError):
                pass
        if job["cancelRequested"]:
            return {"status": "cancelled", "complete": False,
                    "flags": ["desktop-process-terminated"], "stats": {}}
        if job["returnCode"] not in (None, 0):
            logs = [str(message.get("text", "")) for message in job["messages"]
                    if message.get("type") == "log" and message.get("text")]
            if len(logs) > 12:
                logs = logs[:3] + ["… (desktop process output truncated) …"] + logs[-8:]
            return {"status": "failed", "complete": False,
                    "error": "\n".join(logs) or "desktop process exited with code "
                    + str(job["returnCode"]),
                    "flags": ["desktop-process-failed"], "stats": {}}
        return None

    def poll_occultation(self, job_id: str, cursor: int = 0) -> dict:
        """Return new JSON-line messages and, when finished, the full report."""
        with self._lock:
            job = self._jobs.get(str(job_id))
            if job is None:
                return {"error": "unknown occultation job"}
            try:
                start = max(0, int(cursor))
            except (TypeError, ValueError):
                start = 0
            messages = job["messages"][start:]
            response = {
                "messages": messages,
                "nextCursor": len(job["messages"]),
                "done": bool(job["done"]),
                "returnCode": job["returnCode"],
            }
            if job["done"]:
                response["result"] = self._report(job)
            return response

    def cancel_occultation(self, job_id: str) -> dict:
        with self._lock:
            job = self._jobs.get(str(job_id))
            if job is None:
                return {"error": "unknown occultation job"}
            job["cancelRequested"] = True
            process = job["process"]
            if process.poll() is None:
                process.terminate()
            return {"ok": True}

    def save_export(self, name: str = "export.txt", mime: str = "text/plain",
                    text: str = "") -> dict:
        """Save a UI text export through the native desktop file dialog.

        Blob-URL downloads are reliable in a normal browser but are not a safe
        download path for macOS WKWebView: clicking an anchor backed by a Blob
        URL can be treated as a navigation and make the native page disappear.
        The pywebview window owns the save dialog, so the web page never has to
        navigate away from the application.
        """
        try:
            import webview
        except ImportError:
            return {"error": "pywebview is unavailable"}

        windows = list(getattr(webview, "windows", ()) or ())
        if not windows:
            return {"error": "the desktop window is unavailable"}

        requested_name = pathlib.Path(str(name or "export.txt")).name
        if not requested_name or requested_name in {".", ".."}:
            requested_name = "export.txt"
        suffix = pathlib.Path(requested_name).suffix.lower()
        if mime.startswith("text/csv") or suffix == ".csv":
            file_types = ("CSV files (*.csv)",)
        elif mime.startswith("application/json") or suffix == ".json":
            file_types = ("JSON files (*.json)",)
        else:
            file_types = ("Text files (*.txt)", "All files (*.*)")

        try:
            selected = windows[0].create_file_dialog(
                webview.FileDialog.SAVE,
                save_filename=requested_name,
                file_types=file_types,
            )
        except Exception as error:  # GUI backends report dialog failures here.
            return {"error": f"could not open the save dialog: {error}"}

        if not selected:
            return {"ok": False, "cancelled": True}
        target_name = selected[0] if isinstance(selected, (tuple, list)) else selected
        target = pathlib.Path(str(target_name)).expanduser()
        if not target.suffix and suffix:
            target = target.with_suffix(suffix)
        try:
            with target.open("w", encoding="utf-8", newline="") as handle:
                handle.write(str(text or ""))
        except OSError as error:
            return {"error": f"could not write export: {error}"}
        return {"ok": True, "path": str(target)}

    def shutdown(self) -> None:
        with self._lock:
            for job in self._jobs.values():
                if job["process"].poll() is None:
                    job["cancelRequested"] = True
                    job["process"].terminate()
