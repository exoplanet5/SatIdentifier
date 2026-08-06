#!/usr/bin/env python3
"""Run SatIdentifier's JavaScript regression tests as offline child processes.

The runner owns test discovery and process reporting. Individual JavaScript
harnesses remain responsible for their scientific assertions, while this file
deliberately performs no catalogue download, browser launch, or result parsing.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Iterable, Sequence


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"


def discovered_tests() -> list[Path]:
    """Return the repository's JavaScript test harnesses in stable order."""

    return sorted(TOOLS.glob("test_*.js"))


def resolve_test(raw: str) -> Path:
    """Resolve a test argument accepted as a name, repository path, or absolute path."""

    supplied = Path(raw).expanduser()
    candidates = [supplied, ROOT / supplied, TOOLS / supplied]
    for candidate in candidates:
        if candidate.is_file() and candidate.suffix == ".js":
            return candidate.resolve()
    raise FileNotFoundError(f"JavaScript test not found: {raw}")


def command_label(node: str, test: Path) -> str:
    """Render a concise command label without hiding the child process output."""

    try:
        label = test.relative_to(ROOT)
    except ValueError:
        label = test
    return f"{node} {label}"


def display_test(test: Path) -> str:
    """Return a repository-relative test name when possible."""

    try:
        return str(test.relative_to(ROOT))
    except ValueError:
        return str(test)


def run_tests(tests: Iterable[Path], node: str, fail_fast: bool) -> int:
    """Run tests from the repository root and return a shell-compatible status."""

    test_list = list(tests)
    failures: list[tuple[Path, int]] = []
    environment = os.environ.copy()
    environment["SATIDENTIFIER_REGRESSION_OFFLINE"] = "1"

    for test in test_list:
        print(f"\n==> {command_label(node, test)}", flush=True)
        try:
            result = subprocess.run(
                [node, str(test)],
                cwd=ROOT,
                env=environment,
                check=False,
            )
        except OSError as exc:
            print(f"runner error: cannot execute {node}: {exc}", file=sys.stderr)
            return 2

        if result.returncode == 0:
            print(f"<== PASS {display_test(test)}", flush=True)
            continue

        failures.append((test, result.returncode))
        print(
            f"<== FAIL {display_test(test)} (exit {result.returncode})",
            flush=True,
        )
        if fail_fast:
            break

    if failures:
        print("\nRegression suite failed:", file=sys.stderr)
        for test, status in failures:
            print(f"  {display_test(test)}: exit {status}", file=sys.stderr)
        return 1

    print(f"\nAll {len(test_list)} regression test(s) passed.", flush=True)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Parse runner options, select tests, and return the process exit status."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "tests",
        nargs="*",
        metavar="TEST",
        help="optional test name/path(s); default: every tools/test_*.js",
    )
    parser.add_argument(
        "--node",
        default=os.environ.get("SATIDENTIFIER_NODE") or shutil.which("node") or "node",
        help="Node.js executable (default: SATIDENTIFIER_NODE, PATH, or node)",
    )
    parser.add_argument("--fail-fast", action="store_true", help="stop after the first failure")
    parser.add_argument("--list", action="store_true", help="list selected tests and exit")
    args = parser.parse_args(argv)

    try:
        tests = [resolve_test(raw) for raw in args.tests] if args.tests else discovered_tests()
    except FileNotFoundError as exc:
        print(f"runner error: {exc}", file=sys.stderr)
        return 2

    if not tests:
        print("runner error: no JavaScript tests found", file=sys.stderr)
        return 2

    if args.list:
        for test in tests:
            print(display_test(test))
        return 0

    return run_tests(tests, args.node, args.fail_fast)


if __name__ == "__main__":
    raise SystemExit(main())
