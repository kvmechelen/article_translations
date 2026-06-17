import json
from pathlib import Path

import bcrypt
from starlette.requests import Request

USERS_FILE = Path(__file__).parent.parent / "users.json"


def _load_users() -> list[dict]:
    if not USERS_FILE.exists():
        return []
    with open(USERS_FILE, encoding="utf-8") as f:
        return json.load(f).get("users", [])


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


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
