"""SPEC-0033 Y05: mypy --strict accepts the typed example and reports each marked mistake.

Usage: python scripts/check-python-types.py   (mypy must be installed; CI pins it)
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / "python"
EXAMPLES = PYTHON / "tests" / "typing"


def mypy(path: Path) -> subprocess.CompletedProcess[str]:
    # The SDK's own modules are read for their types but not reported on (follow-imports=silent).
    return subprocess.run(
        [sys.executable, "-m", "mypy", "--strict", "--follow-imports=silent", "--no-incremental",
         "--python-version", f"{sys.version_info.major}.{sys.version_info.minor}", str(path.relative_to(PYTHON))],
        cwd=PYTHON, env={**os.environ, "PYTHONPATH": str(PYTHON / "src")}, capture_output=True, text=True, timeout=300)


def main() -> None:
    version = subprocess.run([sys.executable, "-m", "mypy", "--version"], capture_output=True, text=True)
    if version.returncode != 0:
        sys.exit("mypy is not installed; CI installs the pinned version")
    good = mypy(EXAMPLES / "good_usage.py")
    if good.returncode != 0:
        sys.exit(f"the typed example must pass:\n{good.stdout}{good.stderr}")
    bad_path = EXAMPLES / "bad_usage.py"
    expected = {(number, match.group(1))
                for number, line in enumerate(bad_path.read_text().splitlines(), 1)
                if (match := re.search(r"# expect: ([\w-]+)", line))}
    bad = mypy(bad_path)
    found = {(int(match.group(1)), match.group(2))
             for match in re.finditer(r"bad_usage\.py:(\d+): error: .*\[([\w-]+)\]$", bad.stdout, re.M)}
    if bad.returncode == 0 or found != expected:
        sys.exit(f"expected {sorted(expected)}, mypy reported {sorted(found)}:\n{bad.stdout}")
    print(json.dumps({"mypy": version.stdout.strip(), "typedExample": "passed", "mistakesReported": len(found)}))


if __name__ == "__main__":
    main()
