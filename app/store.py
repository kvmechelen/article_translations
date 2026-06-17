"""
Read/write article segment files with a single write-lock.
All mutations go through save_segment(); sync.py also acquires the lock.
"""
import asyncio
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ARTICLES_DIR = Path(__file__).parent.parent / "articles"
WRITE_LOCK = asyncio.Lock()

TARGET_LANGS = ["de", "da", "es", "fr", "it", "nl"]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _art_dir(article_id: str) -> Path:
    return ARTICLES_DIR / str(article_id)


def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _atomic_write(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _git_commit_async(path: Path, author_name: str, author_email: str, message: str) -> None:
    """Stage the file and commit; push in a daemon thread so the UI never waits."""
    repo_root = Path(__file__).parent.parent
    subprocess.run(
        ["git", "add", str(path)],
        cwd=repo_root, check=False, capture_output=True,
    )
    subprocess.run(
        ["git", "commit",
         "--author", f"{author_name} <{author_email}>",
         "-m", message],
        cwd=repo_root, check=False, capture_output=True,
    )

    import threading
    def _push():
        subprocess.run(
            ["git", "push"],
            cwd=repo_root, check=False, capture_output=True,
        )

    t = threading.Thread(target=_push, daemon=True)
    t.start()


# --------------------------------------------------------------------------- #
# Public readers
# --------------------------------------------------------------------------- #

def list_articles() -> list[str]:
    """Return article IDs that have an en.json."""
    if not ARTICLES_DIR.exists():
        return []
    return [
        d.name for d in sorted(ARTICLES_DIR.iterdir())
        if d.is_dir() and (d / "en.json").exists()
    ]


def get_en(article_id: str) -> dict:
    return _load(_art_dir(article_id) / "en.json")


def get_lang(article_id: str, lang: str) -> dict:
    return _load(_art_dir(article_id) / f"{lang}.json")


def article_queue(languages: list[str]) -> list[dict]:
    """
    Return ALL articles with per-language stats. Articles are always included so
    a fully-verified article stays visible (shown as done) rather than disappearing.
    """
    result = []
    for art_id in list_articles():
        en = get_en(art_id)
        if not en:
            continue
        title = en.get("segments", {}).get("title", {}).get("text", art_id)
        total_segs = len(en.get("segments", {}))

        lang_stats: dict[str, dict] = {}
        verified_total = 0

        for lang in languages:
            lang_data = get_lang(art_id, lang)
            segs = lang_data.get("segments", {})
            verified = sum(1 for s in segs.values() if s.get("status") == "verified")
            lang_stats[lang] = {"verified": verified, "total": total_segs}
            verified_total += verified

        result.append({
            "article_id": art_id,
            "title": title,
            "total_segments": total_segs,
            "total_segments_all_langs": total_segs * len(languages),
            "verified_segments": verified_total,
            "lang_stats": lang_stats,
        })
    return result


def get_article_segments(article_id: str, lang: str) -> dict:
    """Return segments in document order with source + target info."""
    en = get_en(article_id)
    if not en:
        return {}
    lang_data = get_lang(article_id, lang)
    lang_segs = lang_data.get("segments", {})

    segments = {}
    for key, en_seg in en.get("segments", {}).items():
        tgt = lang_segs.get(key, {})
        segments[key] = {
            "field": en_seg.get("field"),
            "source": en_seg.get("text", ""),
            "source_hash": en_seg.get("hash", ""),
            "target": tgt.get("target", ""),
            "translated_from_hash": tgt.get("translated_from_hash", ""),
            "origin": tgt.get("origin", "machine"),
            "status": tgt.get("status", "unverified"),
            "updated_by": tgt.get("updated_by"),
            "updated_at": tgt.get("updated_at"),
        }
    return segments


# --------------------------------------------------------------------------- #
# Public writer — must be called with WRITE_LOCK held
# --------------------------------------------------------------------------- #

async def save_segment(
    article_id: str,
    lang: str,
    key: str,
    target: str,
    verify: bool,
    user: dict,
) -> dict:
    async with WRITE_LOCK:
        return _save_segment_locked(article_id, lang, key, target, verify, user)


def _save_segment_locked(
    article_id: str,
    lang: str,
    key: str,
    target: str,
    verify: bool,
    user: dict,
) -> dict:
    en = get_en(article_id)
    if not en:
        raise ValueError(f"Article {article_id} not found")

    en_seg = en.get("segments", {}).get(key)
    if not en_seg:
        raise ValueError(f"Segment {key} not found in en.json for {article_id}")

    path = _art_dir(article_id) / f"{lang}.json"
    lang_data = _load(path)
    segs = lang_data.get("segments", {})

    seg = dict(segs.get(key, {}))
    seg["field"] = en_seg.get("field")
    seg["source"] = en_seg.get("text", "")
    seg["source_hash"] = en_seg.get("hash", "")
    seg["target"] = target
    seg["translated_from_hash"] = en_seg.get("hash", "")
    seg["updated_by"] = user["email"]
    seg["updated_at"] = datetime.now(timezone.utc).isoformat()

    if verify:
        seg["origin"] = "human"
        seg["status"] = "verified"
    else:
        # Save draft: keep existing origin/status or default to machine/unverified
        seg.setdefault("origin", "machine")
        seg.setdefault("status", "unverified")

    segs[key] = seg
    lang_data["segments"] = segs
    _atomic_write(path, lang_data)

    action = "verify" if verify else "draft"
    _git_commit_async(
        path,
        author_name=user.get("name", user["email"]),
        author_email=user["email"],
        message=f"[{lang}] {action} {article_id}/{key}",
    )

    return seg
