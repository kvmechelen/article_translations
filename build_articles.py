#!/usr/bin/env python3
"""
build_articles.py

Turn the paginated Intercom dumps in ./article_files/page_*.json into a
per-article, per-language, segment-level translation structure:

    ./articles/<article_id>/en.json   <- source master (+ body skeleton)
    ./articles/<article_id>/de.json   <- bilingual: source + target + status
    ./articles/<article_id>/da.json   <- one file per TARGET_LANGS, ALWAYS created
    ...

WHAT THIS DOES
--------------
- English is the source of truth and comes from Intercom.
- For every article, a file is created for every language in TARGET_LANGS,
  even when Intercom has no translation for it yet (new articles). This system
  is the source of truth for the non-English versions.

STATUS MODEL (binary: 'verified' | 'unverified')
-------------------------------------------------
- This builder reads ENGLISH ONLY from Intercom and NEVER writes 'verified'.
  Verification is a human action performed in the app; the app stamps
  'verified' (origin 'human') onto a segment.
- For each target language, per segment, the builder does one of two things:
    * English unchanged -> leave the segment completely untouched, so a
      'verified' translation written by the app survives the sync; or
    * English new or changed -> (re)machine-translate and mark 'unverified',
      pushing it back into the review queue.
- Each segment stores the hash of the English it was built from
  (translated_from_hash). A hash only says *whether* English changed, not how
  much, so any change triggers a fresh MT (previous text stays in git history).

NOTE: bootstrapping existing production translations as 'verified' is a separate
one-off migration, intentionally out of scope here. A fresh build is entirely
'unverified' until humans verify in the app.

REVERSIBILITY
-------------
The body is stored as block segments plus a 'body_skeleton' (the original HTML
with each block's text replaced by an @@key@@ placeholder). Reassemble a
translated body with reassemble_body() when pushing back to Intercom.

DEPENDENCIES
------------
    pip install beautifulsoup4 requests
Machine translation is pluggable (DeepL wired up below). Set DEEPL_API_KEY to
enable it; without a key the pipeline still runs and leaves placeholders.
"""

import os
import re
import json
import glob
import hashlib
from collections import defaultdict

from bs4 import BeautifulSoup, NavigableString

INPUT_DIR = "./article_files"
OUTPUT_DIR = "./articles"

# Languages your translators own. A file is created for EACH of these, for every
# article, whether or not Intercom has a translation yet.
TARGET_LANGS = ["de", "da", "es", "fr", "it", "nl"]

# Block-level tags whose text is one translatable unit.
BLOCK_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6",
              "li", "blockquote", "td", "th", "figcaption", "caption", "dt", "dd"]

# Run summary counters.
STATS = defaultdict(int)


# --------------------------------------------------------------------------- #
# Hashing & HTML segmentation
# --------------------------------------------------------------------------- #
def text_hash(s):
    """Whitespace-normalised hash, so reformatting alone never flags a change."""
    norm = re.sub(r"\s+", " ", s or "").strip()
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:12]


def _leaf_blocks(soup):
    """Block elements that directly contain text (no nested block children)."""
    leaves = []
    for el in soup.find_all(BLOCK_TAGS):
        if el.find(BLOCK_TAGS):
            continue  # a container; its text lives in the nested blocks
        if el.decode_contents().strip():
            leaves.append(el)
    return leaves


def split_body_blocks(html):
    """HTML body -> ordered list of translatable inner-HTML blocks."""
    if not html or not html.strip():
        return []
    soup = BeautifulSoup(html, "html.parser")
    blocks = [el.decode_contents().strip() for el in _leaf_blocks(soup)]
    if not blocks:
        blocks = [html.strip()]   # no block markup -> whole body is one segment
    return blocks


def build_skeleton(html, ordered_keys):
    """Original body HTML with each block's content replaced by @@key@@.

    ordered_keys must line up, in document order, with split_body_blocks(html).
    """
    if not html or not html.strip():
        return ""
    soup = BeautifulSoup(html, "html.parser")
    leaves = _leaf_blocks(soup)
    if not leaves:
        return f"@@{ordered_keys[0]}@@" if ordered_keys else html.strip()
    for el, key in zip(leaves, ordered_keys):
        el.clear()
        el.append(NavigableString(f"@@{key}@@"))
    return str(soup)


def reassemble_body(skeleton, body_segments):
    """Rebuild an HTML body from a skeleton + {body_key: text} for one language.

    Use this when pushing a translation back to Intercom.
    """
    html = skeleton or ""
    for key, text in body_segments.items():
        html = html.replace(f"@@{key}@@", text or "")
    return html


# --------------------------------------------------------------------------- #
# Machine translation (PLUGGABLE)
# --------------------------------------------------------------------------- #
# Swap in whichever engine you choose. DeepL is wired up because it handles
# inline HTML natively (tag_handling=html) and is strong for European languages.
# To switch to Azure / LibreTranslate / an LLM, replace the body of
# machine_translate() — everything else stays the same.
DEEPL_ENDPOINT = "https://api-free.deepl.com/v2/translate"   # api.deepl.com for Pro


def machine_translate(text, target_lang, source_lang="en"):
    """Machine-translate `text` (may contain inline HTML) into target_lang.

    With DEEPL_API_KEY set, calls DeepL with HTML tag handling. Without a key,
    the pipeline still runs end to end: it returns the English text as a
    placeholder, and the caller leaves the segment 'unverified' for a translator.
    """
    if not text or not text.strip():
        return text
    key = os.getenv("DEEPL_API_KEY")
    if not key:
        if not machine_translate._warned:
            print("  ! DEEPL_API_KEY not set — using English as a placeholder "
                  "(segments stay 'unverified').")
            machine_translate._warned = True
        return text

    import requests
    resp = requests.post(
        DEEPL_ENDPOINT,
        headers={"Authorization": f"DeepL-Auth-Key {key}"},
        data={
            "text": text,
            "source_lang": source_lang.upper(),
            "target_lang": target_lang.upper(),
            "tag_handling": "html",      # keep inline <a>, <strong>, ... intact
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["translations"][0]["text"]


machine_translate._warned = False


# --------------------------------------------------------------------------- #
# Stable-key reconciliation (source language only)
# --------------------------------------------------------------------------- #
def reconcile_body_keys(new_sources, prev_body_segments):
    """Assign stable keys to current English body blocks.

    Reuses a previous key on exact source match, then by position; anything left
    over is genuinely new and gets a fresh key. Returns [(key, source_text), ...].
    """
    prev_items = [(k, v.get("source", v.get("text", ""))) for k, v in prev_body_segments.items()]
    used = set()
    assigned = [None] * len(new_sources)

    src_to_keys = defaultdict(list)
    for k, txt in prev_items:
        src_to_keys[txt].append(k)
    for i, src in enumerate(new_sources):
        candidates = [k for k in src_to_keys.get(src, []) if k not in used]
        if candidates:
            assigned[i] = candidates[0]
            used.add(candidates[0])

    remaining = [k for k, _ in prev_items if k not in used]
    ri = 0
    for i in range(len(new_sources)):
        if assigned[i] is None and ri < len(remaining):
            assigned[i] = remaining[ri]
            used.add(remaining[ri])
            ri += 1

    existing_nums = [int(k.split(":")[1]) for k in prev_body_segments
                     if k.startswith("body:") and k.split(":")[1].isdigit()]
    next_id = max(existing_nums, default=0) + 1
    result = []
    for i, src in enumerate(new_sources):
        if assigned[i] is None:
            assigned[i] = f"body:{next_id:04d}"
            next_id += 1
        result.append((assigned[i], src))
    return result


# --------------------------------------------------------------------------- #
# Per-article processing
# --------------------------------------------------------------------------- #
def load_json(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return None


def process_article(article):
    art_id = str(article.get("id"))
    tc = article.get("translated_content") or {}
    source_locale = article.get("default_locale") or "en"

    source = tc.get(source_locale) or tc.get("en")
    if source is None:
        source = {"title": article.get("title"),
                  "description": article.get("description"),
                  "body": article.get("body")}

    art_dir = os.path.join(OUTPUT_DIR, art_id)
    os.makedirs(art_dir, exist_ok=True)

    # ---- Build canonical source segments with stable keys ----
    prev_en = load_json(os.path.join(art_dir, f"{source_locale}.json")) or {}
    prev_body_segs = {k: v for k, v in prev_en.get("segments", {}).items()
                      if k.startswith("body:")}

    src_title = source.get("title") or ""
    src_desc = source.get("description") or ""
    src_body_html = source.get("body") or ""

    body_keyed = reconcile_body_keys(split_body_blocks(src_body_html), prev_body_segs)
    skeleton = build_skeleton(src_body_html, [k for k, _ in body_keyed])

    canonical = [("title", "title", src_title),
                 ("description", "description", src_desc)]
    canonical += [(k, "body", txt) for k, txt in body_keyed]

    # ---- Write source master (en.json) ----
    en_out = {
        "article_id": art_id,
        "language": source_locale,
        "is_source": True,
        "body_skeleton": skeleton,
        "segments": {k: {"field": f, "text": txt, "hash": text_hash(txt)}
                     for k, f, txt in canonical},
    }
    with open(os.path.join(art_dir, f"{source_locale}.json"), "w", encoding="utf-8") as fh:
        json.dump(en_out, fh, ensure_ascii=False, indent=2)

    # ---- One file per target language (always) ----
    for lang in TARGET_LANGS:
        if lang == source_locale:
            continue

        path = os.path.join(art_dir, f"{lang}.json")
        prev_segs = (load_json(path) or {}).get("segments", {})

        out_segs = {}
        for k, field, src in canonical:
            src_h = text_hash(src)

            prev = prev_segs.get(k)
            if prev and prev.get("translated_from_hash") == src_h:
                # English unchanged -> preserve OUR managed translation as-is,
                # including a 'verified' status the app set. The builder never
                # touches a translation whose English hasn't moved.
                target = prev.get("target", "")
                status = prev.get("status", "unverified")
                origin = prev.get("origin", "machine")
                STATS["preserved"] += 1
            else:
                # New segment OR English changed -> (re)machine-translate.
                # The builder ONLY writes 'unverified'. 'verified' is set
                # exclusively by a human in the app and preserved by the branch
                # above; a machine process can never assert human approval.
                target = machine_translate(src, lang, source_locale)
                status, origin = "unverified", "machine"
                STATS["machine"] += 1

            out_segs[k] = {
                "field": field,
                "source": src,
                "source_hash": src_h,
                "target": target,
                "translated_from_hash": src_h,
                "origin": origin,           # 'machine' (builder) | 'human' (app)
                "status": status,           # builder writes only 'unverified'
            }

        lang_out = {
            "article_id": art_id,
            "language": lang,
            "source_language": source_locale,
            "segments": out_segs,
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(lang_out, fh, ensure_ascii=False, indent=2)


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    pages = sorted(glob.glob(os.path.join(INPUT_DIR, "*.json")))
    if not pages:
        print(f"No JSON files found in {INPUT_DIR}/")
        return

    count = 0
    skipped = 0
    for page_path in pages:
        with open(page_path, encoding="utf-8") as f:
            payload = json.load(f)
        for article in payload.get("data", []):
            if article.get("state") == "draft":   # skip unpublished articles
                skipped += 1
                continue
            process_article(article)
            count += 1

    print(f"Processed {count} published article(s) into {OUTPUT_DIR}/  (skipped {skipped} draft)")
    print(f"  machine-translated (new/changed) : {STATS['machine']}")
    print(f"  preserved (unchanged)            : {STATS['preserved']}")


if __name__ == "__main__":
    main()