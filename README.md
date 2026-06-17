# Article Translator — Translation Management UI

Internal tool for verifying machine-translated Intercom help-center articles into DE, DA, ES, FR, IT, NL.

## Run

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000. Sign in with the credentials in `users.json`.

## Adding a user

Generate a bcrypt password hash:

```bash
python3 -c "import bcrypt; print(bcrypt.hashpw(b'yourpassword', bcrypt.gensalt()).decode())"
```

Add an entry to `users.json`:

```json
{
  "users": [
    {
      "email": "translator@example.com",
      "name": "Jane Doe",
      "password_hash": "<paste hash here>",
      "languages": ["de", "fr"]
    }
  ]
}
```

`languages` limits which language files the user can see and edit. Valid values: `de da es fr it nl`.

## Sync

The **Sync** button on the queue page runs `get_articles.py` (Intercom ingest) then `build_articles.py` (segment build) under a write lock. Requires `API_KEY` in `.env`.

## Data files

| Path | Description |
|------|-------------|
| `articles/<id>/en.json` | English source — never modified by this app |
| `articles/<id>/<lang>.json` | Bilingual file the app edits |
| `users.json` | User accounts (bcrypt-hashed passwords) |
| `article_files/` | Raw Intercom dumps written by `get_articles.py` |

## Out of scope (next steps)

- Write-back to Intercom (body reassembly + PUT /articles/{id}) — stub is in `build_articles.py:reassemble_body()`
- Scheduled sync (currently manual via UI button)
- Migrating existing translations to `verified` (separate one-off job)
