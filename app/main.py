from pathlib import Path

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

from app.auth import authenticate, require_user
from app.store import (
    article_queue,
    get_article_segments,
    get_en,
    get_lang,
    save_segment,
)
from app.sync import run_sync

SECRET_KEY = "change-me-in-production-use-env-var"

app = FastAPI(title="Translation Manager")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, https_only=False)

STATIC_DIR = Path(__file__).parent / "static"


# --------------------------------------------------------------------------- #
# Auth routes
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
    return {"email": user["email"], "name": user["name"], "languages": user["languages"]}


@app.post("/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/me")
async def me(request: Request):
    user = require_user(request)
    return {"email": user["email"], "name": user["name"], "languages": user["languages"]}


# --------------------------------------------------------------------------- #
# Queue
# --------------------------------------------------------------------------- #

@app.get("/articles")
async def get_articles(request: Request, language: str | None = None):
    user = require_user(request)
    langs = user["languages"]
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
    if language not in user["languages"]:
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
    if language not in user["languages"]:
        raise HTTPException(status_code=403, detail="Language not assigned to you")

    try:
        seg = await save_segment(article_id, language, key, body.target, body.verify, user)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    return seg


# --------------------------------------------------------------------------- #
# Sync
# --------------------------------------------------------------------------- #

@app.post("/sync")
async def sync(request: Request):
    require_user(request)
    try:
        summary = await run_sync()
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return summary


# --------------------------------------------------------------------------- #
# Static files — must come last so API routes take precedence
# --------------------------------------------------------------------------- #

app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
