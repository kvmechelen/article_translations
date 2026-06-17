import requests
import os
import json
from dotenv import load_dotenv

load_dotenv()
api_key = os.getenv("API_KEY")

BASE_URL = "https://api.intercom.io/articles"
OUTPUT_DIR = "./article_files"

headers = {
    "Intercom-Version": "2.15",
    "Authorization": f"Bearer {api_key}"
}

os.makedirs(OUTPUT_DIR, exist_ok=True)

url = BASE_URL
params = {}
page_num = 1

while True:
    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    data = response.json()

    out_path = os.path.join(OUTPUT_DIR, f"page_{page_num}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"Saved {out_path} ({len(data.get('data', []))} articles)")

    pages = data.get("pages") or {}
    next_page = pages.get("next")
    if not next_page:
        break

    if isinstance(next_page, str):
        # standard pagination: 'next' is a full URL to the next page
        url = next_page
        params = {}
    else:
        # cursor pagination: 'next' is an object with a starting_after cursor
        url = BASE_URL
        params = {"starting_after": next_page["starting_after"]}

    page_num += 1

print(f"Done — {page_num} page(s) saved to {OUTPUT_DIR}")