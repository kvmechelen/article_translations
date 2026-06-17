from pathlib import Path

from fastapi import FastAPI, Request, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

from app.auth import (
    authenticate, require_user, require_admin,
    list_users, create_user, update_user, delete_user,
    verify_password, get_user,
)
from app.store import (
    article_queue,
    get_article_segments,
    get_en,
    save_segment,
)
from app.sync import run_sync

SECRET_KEY = "change-me-in-production-use-env-var"

app = FastAPI(title="Translation Manager")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, https_only=False)

STATIC_DIR = Path(__file__).parent / "static"


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #

class LoginBody(BaseModel):
    email: str
    password: str


@app.post("/login")
async def login(body: LoginBody, request: Request):
    user = authenticate(body.email, body.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    request.session["email"] = user["email"]
    return {
        "email": user["email"],
        "name": user["name"],
        "languages": user.get("languages", []),
        "role": user.get("role", "proofreader"),
    }


@app.post("/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/me")
async def me(request: Request):
    user = require_user(request)
    return {
        "email": user["email"],
        "name": user["name"],
        "languages": user.get("languages", []),
        "role": user.get("role", "proofreader"),
    }


# --------------------------------------------------------------------------- #
# Self-service profile
# --------------------------------------------------------------------------- #

class ProfileBody(BaseModel):
    name: str | None = None
    email: str | None = None


class PasswordBody(BaseModel):
    current_password: str
    new_password: str


@app.put("/me")
async def update_me(body: ProfileBody, request: Request):
    user = require_user(request)
    updates = {}
    if body.name is not None:
        updates["name"] = body.name
    if body.email is not None:
        updates["email"] = body.email
    updated = update_user(user["email"], updates, user)
    # Keep session in sync if email changed
    request.session["email"] = updated["email"]
    return updated


@app.put("/me/password")
async def change_password(body: PasswordBody, request: Request):
    user = require_user(request)
    if not verify_password(body.current_password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    if len(body.new_password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    update_user(user["email"], {"password": body.new_password}, user)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# User management (admin only)
# --------------------------------------------------------------------------- #

class CreateUserBody(BaseModel):
    email: str
    name: str
    password: str
    languages: list[str]
    role: str = "proofreader"


class UpdateUserBody(BaseModel):
    name: str | None = None
    email: str | None = None
    languages: list[str] | None = None
    role: str | None = None
    password: str | None = None


@app.get("/users")
async def get_users(request: Request):
    require_admin(request)
    return list_users()


@app.post("/users")
async def post_user(body: CreateUserBody, request: Request):
    require_admin(request)
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    return create_user(body.email, body.name, body.password, body.languages, body.role)


@app.put("/users/{email:path}")
async def put_user(email: str, body: UpdateUserBody, request: Request):
    acting = require_admin(request)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if "password" in updates and len(updates["password"]) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    return update_user(email, updates, acting)


@app.delete("/users/{email:path}")
async def del_user(email: str, request: Request):
    acting = require_admin(request)
    if email.lower() == acting["email"].lower():
        raise HTTPException(status_code=409, detail="You cannot delete your own account")
    delete_user(email)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Queue
# --------------------------------------------------------------------------- #

@app.get("/articles")
async def get_articles(request: Request, language: str | None = None):
    user = require_user(request)
    langs = user.get("languages", [])
    if language:
        if language not in langs:
            raise HTTPException(status_code=403, detail="Language not assigned to you")
        langs = [language]
    return article_queue(langs)


# --------------------------------------------------------------------------- #
# Article editor
# --------------------------------------------------------------------------- #

@app.get("/articles/{article_id}")
async def get_article(article_id: str, request: Request, language: str):
    user = require_user(request)
    if language not in user.get("languages", []):
        raise HTTPException(status_code=403, detail="Language not assigned to you")
    en = get_en(article_id)
    if not en:
        raise HTTPException(status_code=404, detail="Article not found")
    segments = get_article_segments(article_id, language)
    return {
        "article_id": article_id,
        "language": language,
        "title": en.get("segments", {}).get("title", {}).get("text", article_id),
        "body_skeleton": en.get("body_skeleton", ""),
        "segments": segments,
    }


# --------------------------------------------------------------------------- #
# Segment save
# --------------------------------------------------------------------------- #

class SegmentBody(BaseModel):
    target: str
    verify: bool = False


@app.put("/articles/{article_id}/segments/{key}")
async def put_segment(
    article_id: str,
    key: str,
    body: SegmentBody,
    request: Request,
    language: str,
):
    user = require_user(request)
    if language not in user.get("languages", []):
        raise HTTPException(status_code=403, detail="Language not assigned to you")
    try:
        seg = await save_segment(article_id, language, key, body.target, body.verify, user)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return seg


# --------------------------------------------------------------------------- #
# Sync (admin only)
# --------------------------------------------------------------------------- #

@app.post("/sync")
async def sync(request: Request):
    require_admin(request)
    try:
        summary = await run_sync()
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return summary


# --------------------------------------------------------------------------- #
# Static files — must come last
# --------------------------------------------------------------------------- #

app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
