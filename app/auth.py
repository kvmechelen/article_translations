import json
import os
from pathlib import Path

import bcrypt
from starlette.requests import Request

USERS_FILE = Path(__file__).parent.parent / "users.json"
TARGET_LANGS = ["de", "da", "es", "fr", "it", "nl"]


# --------------------------------------------------------------------------- #
# Internal load / save
# --------------------------------------------------------------------------- #

def _load_users() -> list[dict]:
    if not USERS_FILE.exists():
        return []
    with open(USERS_FILE, encoding="utf-8") as f:
        return json.load(f).get("users", [])


def _save_users(users: list[dict]) -> None:
    tmp = USERS_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"users": users}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, USERS_FILE)


def _public(user: dict) -> dict:
    return {
        "email": user["email"],
        "name": user["name"],
        "languages": user.get("languages", []),
        "role": user.get("role", "proofreader"),
    }


# --------------------------------------------------------------------------- #
# Password helpers
# --------------------------------------------------------------------------- #

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


# --------------------------------------------------------------------------- #
# Auth helpers
# --------------------------------------------------------------------------- #

def authenticate(email: str, password: str) -> dict | None:
    for user in _load_users():
        if user["email"].lower() == email.lower():
            if verify_password(password, user["password_hash"]):
                return user
    return None


def get_current_user(request: Request) -> dict | None:
    email = request.session.get("email")
    if not email:
        return None
    for user in _load_users():
        if user["email"].lower() == email.lower():
            return user
    return None


def require_user(request: Request) -> dict:
    user = get_current_user(request)
    if not user:
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_admin(request: Request) -> dict:
    user = require_user(request)
    if user.get("role") != "admin":
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


# --------------------------------------------------------------------------- #
# User CRUD
# --------------------------------------------------------------------------- #

def list_users() -> list[dict]:
    return [_public(u) for u in _load_users()]


def get_user(email: str) -> dict | None:
    for u in _load_users():
        if u["email"].lower() == email.lower():
            return u
    return None


def create_user(email: str, name: str, password: str, languages: list[str], role: str) -> dict:
    from fastapi import HTTPException
    users = _load_users()
    if any(u["email"].lower() == email.lower() for u in users):
        raise HTTPException(status_code=409, detail="Email already in use")
    if role not in ("admin", "proofreader"):
        raise HTTPException(status_code=422, detail="role must be admin or proofreader")
    for lang in languages:
        if lang not in TARGET_LANGS:
            raise HTTPException(status_code=422, detail=f"Unknown language: {lang}")
    new_user = {
        "email": email.lower().strip(),
        "name": name.strip(),
        "password_hash": hash_password(password),
        "languages": languages,
        "role": role,
    }
    users.append(new_user)
    _save_users(users)
    return _public(new_user)


def update_user(email: str, updates: dict, acting_user: dict) -> dict:
    from fastapi import HTTPException
    users = _load_users()
    idx = next((i for i, u in enumerate(users) if u["email"].lower() == email.lower()), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="User not found")

    u = dict(users[idx])

    # Prevent removing the last admin
    if "role" in updates and updates["role"] != "admin" and u.get("role") == "admin":
        admin_count = sum(1 for x in users if x.get("role") == "admin")
        if admin_count <= 1:
            raise HTTPException(status_code=409, detail="Cannot remove the last admin")

    if "name" in updates:
        u["name"] = updates["name"].strip()
    if "email" in updates:
        new_email = updates["email"].lower().strip()
        if new_email != u["email"] and any(x["email"].lower() == new_email for x in users):
            raise HTTPException(status_code=409, detail="Email already in use")
        u["email"] = new_email
    if "languages" in updates:
        for lang in updates["languages"]:
            if lang not in TARGET_LANGS:
                raise HTTPException(status_code=422, detail=f"Unknown language: {lang}")
        u["languages"] = updates["languages"]
    if "role" in updates:
        if updates["role"] not in ("admin", "proofreader"):
            raise HTTPException(status_code=422, detail="role must be admin or proofreader")
        u["role"] = updates["role"]
    if "password" in updates:
        u["password_hash"] = hash_password(updates["password"])

    users[idx] = u
    _save_users(users)
    return _public(u)


def delete_user(email: str) -> None:
    from fastapi import HTTPException
    users = _load_users()
    target = next((u for u in users if u["email"].lower() == email.lower()), None)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.get("role") == "admin":
        admin_count = sum(1 for u in users if u.get("role") == "admin")
        if admin_count <= 1:
            raise HTTPException(status_code=409, detail="Cannot delete the last admin")
    _save_users([u for u in users if u["email"].lower() != email.lower()])
