"""
Run get_articles.py then build_articles.py under the write lock.
Returns a summary dict.
"""
import re
import subprocess
import sys
from pathlib import Path

from app.store import WRITE_LOCK

REPO_ROOT = Path(__file__).parent.parent
GET_ARTICLES = REPO_ROOT / "get_articles.py"
BUILD_ARTICLES = REPO_ROOT / "build_articles.py"


async def run_sync() -> dict:
    async with WRITE_LOCK:
        return _run_sync_locked()


def _run_sync_locked() -> dict:
    python = sys.executable

    # Step 1: ingest
    r1 = subprocess.run(
        [python, str(GET_ARTICLES)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if r1.returncode != 0:
        raise RuntimeError(f"get_articles.py failed:\n{r1.stderr or r1.stdout}")

    # Step 2: build
    r2 = subprocess.run(
        [python, str(BUILD_ARTICLES)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if r2.returncode != 0:
        raise RuntimeError(f"build_articles.py failed:\n{r2.stderr or r2.stdout}")

    return _parse_summary(r1.stdout + "\n" + r2.stdout)


def _parse_summary(output: str) -> dict:
    summary = {
        "articles_processed": 0,
        "machine_translated": 0,
        "preserved": 0,
        "raw_output": output.strip(),
    }

    m = re.search(r"Processed (\d+) published", output)
    if m:
        summary["articles_processed"] = int(m.group(1))

    m = re.search(r"machine-translated.*?:\s*(\d+)", output)
    if m:
        summary["machine_translated"] = int(m.group(1))

    m = re.search(r"preserved.*?:\s*(\d+)", output)
    if m:
        summary["preserved"] = int(m.group(1))

    return summary
