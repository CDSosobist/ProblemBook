#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ProblemBook — хранилище, пользователи и сессии.

Только стандартная библиотека Python 3: sqlite3, hashlib.scrypt, secrets.
"""
import datetime
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time

ROLES = ("admin", "editor", "viewer")
ROLE_TITLES = {"admin": "администратор", "editor": "инженер", "viewer": "только чтение"}
NAME_RE = re.compile(r"^[a-zA-Z0-9._-]{2,32}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    name       TEXT PRIMARY KEY,
    role       TEXT NOT NULL,
    pwd        TEXT NOT NULL,
    created    TEXT NOT NULL,
    last_login TEXT
);
CREATE TABLE IF NOT EXISTS register (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    revision   INTEGER NOT NULL,
    items      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL,
    actor   TEXT NOT NULL,
    action  TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    csrf       TEXT NOT NULL,
    created    REAL NOT NULL,
    expires    REAL NOT NULL
);
"""

MAX_ITEMS = 5000
MAX_ACTIONS = 100
LIMITS = {
    "title": 400, "category": 120, "owner": 120, "assets": 300,
    "risk": 20000, "implRisks": 20000, "notes": 20000,
    "action": 2000, "id": 40, "history_text": 500,
}


class ConflictError(Exception):
    def __init__(self, revision, updated_at, updated_by):
        super().__init__("revision conflict")
        self.revision = revision
        self.updated_at = updated_at
        self.updated_by = updated_by


class ValidationError(Exception):
    pass


def now_iso():
    return datetime.datetime.now().astimezone().replace(microsecond=0).isoformat()


def connect(db_path):
    conn = sqlite3.connect(db_path, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def init_db(db_path):
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    with connect(db_path) as conn:
        conn.executescript(SCHEMA)
        row = conn.execute("SELECT revision FROM register WHERE id = 1").fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO register (id, revision, items, updated_at, updated_by) VALUES (1, 0, '[]', ?, ?)",
                (now_iso(), "system"),
            )
            audit(conn, "system", "init", "создана база проблембука")


# ------------------------------------------------------------------ секреты

def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$16384$8$1$%s$%s" % (
        __import__("base64").b64encode(salt).decode(),
        __import__("base64").b64encode(digest).decode(),
    )


def verify_password(stored, password):
    try:
        algo, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        import base64
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        digest = hashlib.scrypt(password.encode("utf-8"), salt=salt,
                                n=int(n), r=int(r), p=int(p), dklen=len(expected))
        return hmac.compare_digest(digest, expected)
    except Exception:
        return False


# ------------------------------------------------------------------ аудит

def audit(conn, actor, action, details=""):
    conn.execute("INSERT INTO audit (ts, actor, action, details) VALUES (?, ?, ?, ?)",
                 (now_iso(), actor, action, details[:2000]))


def audit_log(db_path, limit=200):
    with connect(db_path) as conn:
        rows = conn.execute("SELECT ts, actor, action, details FROM audit ORDER BY id DESC LIMIT ?",
                            (int(limit),)).fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------- пользователи

def create_user(db_path, name, password, role="editor"):
    if not NAME_RE.match(name or ""):
        raise ValidationError("имя: 2-32 символа, латиница, цифры, точка, дефис, подчёркивание")
    if role not in ROLES:
        raise ValidationError("роль одна из: %s" % ", ".join(ROLES))
    if len(password or "") < 10:
        raise ValidationError("пароль короче 10 символов")
    with connect(db_path) as conn:
        exists = conn.execute("SELECT 1 FROM users WHERE name = ?", (name,)).fetchone()
        if exists:
            raise ValidationError("пользователь %s уже есть" % name)
        conn.execute("INSERT INTO users (name, role, pwd, created) VALUES (?, ?, ?, ?)",
                     (name, role, hash_password(password), now_iso()))
        audit(conn, "cli", "user-create", "%s (%s)" % (name, ROLE_TITLES[role]))


def set_password(db_path, name, password):
    if len(password or "") < 10:
        raise ValidationError("пароль короче 10 символов")
    with connect(db_path) as conn:
        changed = conn.execute("UPDATE users SET pwd = ? WHERE name = ?",
                               (hash_password(password), name)).rowcount
        if not changed:
            raise ValidationError("пользователь %s не найден" % name)
        conn.execute("DELETE FROM sessions WHERE name = ?", (name,))
        audit(conn, "cli", "user-password", name)


def set_role(db_path, name, role):
    if role not in ROLES:
        raise ValidationError("роль одна из: %s" % ", ".join(ROLES))
    with connect(db_path) as conn:
        changed = conn.execute("UPDATE users SET role = ? WHERE name = ?", (role, name)).rowcount
        if not changed:
            raise ValidationError("пользователь %s не найден" % name)
        audit(conn, "cli", "user-role", "%s → %s" % (name, ROLE_TITLES[role]))


def delete_user(db_path, name):
    with connect(db_path) as conn:
        changed = conn.execute("DELETE FROM users WHERE name = ?", (name,)).rowcount
        if not changed:
            raise ValidationError("пользователь %s не найден" % name)
        conn.execute("DELETE FROM sessions WHERE name = ?", (name,))
        audit(conn, "cli", "user-delete", name)


def list_users(db_path):
    with connect(db_path) as conn:
        rows = conn.execute("SELECT name, role, created, last_login FROM users ORDER BY name").fetchall()
    return [dict(r) for r in rows]


def get_user(db_path, name):
    with connect(db_path) as conn:
        row = conn.execute("SELECT name, role, pwd FROM users WHERE name = ?", (name,)).fetchone()
    return dict(row) if row else None


def check_credentials(db_path, name, password):
    user = get_user(db_path, name)
    if not user or not verify_password(user["pwd"], password):
        return None
    with connect(db_path) as conn:
        conn.execute("UPDATE users SET last_login = ? WHERE name = ?", (now_iso(), name))
    return {"name": user["name"], "role": user["role"], "roleTitle": ROLE_TITLES[user["role"]]}


# ------------------------------------------------------------------- сессии

SESSION_TTL = 8 * 3600


def _token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(db_path, name):
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    expires = time.time() + SESSION_TTL
    with connect(db_path) as conn:
        conn.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
        conn.execute("INSERT INTO sessions (token_hash, name, csrf, created, expires) VALUES (?, ?, ?, ?, ?)",
                     (_token_hash(token), name, csrf, time.time(), expires))
    return token, csrf, expires


def read_session(db_path, token):
    if not token:
        return None
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT s.token_hash, s.name, s.csrf, s.expires, u.role FROM sessions s "
            "JOIN users u ON u.name = s.name WHERE s.token_hash = ?",
            (_token_hash(token),),
        ).fetchone()
        if not row:
            return None
        if row["expires"] < time.time():
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (row["token_hash"],))
            return None
    return {"name": row["name"], "role": row["role"], "csrf": row["csrf"],
            "roleTitle": ROLE_TITLES[row["role"]]}


def drop_session(db_path, token):
    if token:
        with connect(db_path) as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))


# ------------------------------------------------------------------ реестр

def _clip(value, limit, field):
    if not isinstance(value, str):
        raise ValidationError("поле %s должно быть строкой" % field)
    text = value.strip()
    if len(text) > limit:
        text = text[:limit]
    return text


def validate_items(raw):
    if not isinstance(raw, list):
        raise ValidationError("items должен быть списком")
    if len(raw) > MAX_ITEMS:
        raise ValidationError("слишком много проблем: %d (максимум %d)" % (len(raw), MAX_ITEMS))

    clean = []
    for index, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise ValidationError("запись %d: ожидался объект" % index)
        actions = item.get("actions") or []
        if not isinstance(actions, list) or len(actions) > MAX_ACTIONS:
            raise ValidationError("запись %d: actions — список до %d строк" % (index, MAX_ACTIONS))
        actions = [_clip(str(a), LIMITS["action"], "actions") for a in actions if str(a).strip()]

        history = item.get("history") or []
        if not isinstance(history, list):
            raise ValidationError("запись %d: history — список" % index)

        done = item.get("done") or []
        if not isinstance(done, list):
            raise ValidationError("запись %d: done — список" % index)

        clean.append({
            "id": _clip(item.get("id") or ("PB-%d" % index), LIMITS["id"], "id"),
            "title": _clip(item.get("title") or "", LIMITS["title"], "title"),
            "category": _clip(item.get("category") or "", LIMITS["category"], "category"),
            "priority": _clip(item.get("priority") or "P3", 4, "priority"),
            "status": _clip(item.get("status") or "new", 20, "status"),
            "owner": _clip(item.get("owner") or "", LIMITS["owner"], "owner"),
            "assets": _clip(item.get("assets") or "", LIMITS["assets"], "assets"),
            "risk": _clip(item.get("risk") or "", LIMITS["risk"], "risk"),
            "actions": actions,
            "done": [int(d) for d in done if isinstance(d, (int, float))][:MAX_ACTIONS],
            "implRisks": _clip(item.get("implRisks") or "", LIMITS["implRisks"], "implRisks"),
            "notes": _clip(item.get("notes") or "", LIMITS["notes"], "notes"),
            "due": _clip(item.get("due") or "", 10, "due"),
            "effort": item.get("effort") if isinstance(item.get("effort"), (int, float)) else None,
            "order": float(item.get("order")) if isinstance(item.get("order"), (int, float)) else None,
            "createdAt": _clip(item.get("createdAt") or now_iso(), 40, "createdAt"),
            "updatedAt": _clip(item.get("updatedAt") or now_iso(), 40, "updatedAt"),
            "history": [
                {"ts": _clip(str(h.get("ts") or ""), 40, "history.ts"),
                 "text": _clip(str(h.get("text") or ""), LIMITS["history_text"], "history.text")}
                for h in history if isinstance(h, dict)
            ][-1000:],
        })
    return clean


def snapshot(db_path, directory, keep=30):
    """Сохраняет копию реестра в отдельный файл (перед импортом/перезаписью)."""
    data = get_register(db_path)
    os.makedirs(directory, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    path = os.path.join(directory, "register-%s.json" % stamp)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"app": "problembook", "version": 1, "exportedAt": now_iso(),
                   "revision": data["revision"], "items": data["items"]},
                  handle, ensure_ascii=False, indent=2)
    old = sorted(name for name in os.listdir(directory) if name.startswith("register-"))
    for name in old[:-keep]:
        try:
            os.remove(os.path.join(directory, name))
        except OSError:
            pass
    return path


def backups(directory, keep=30):
    if not os.path.isdir(directory):
        return []
    names = sorted((name for name in os.listdir(directory) if name.startswith("register-")), reverse=True)
    return names[:keep]


def get_register(db_path):
    with connect(db_path) as conn:
        row = conn.execute("SELECT revision, items, updated_at, updated_by FROM register WHERE id = 1").fetchone()
    return {
        "revision": row["revision"],
        "items": json.loads(row["items"]),
        "updatedAt": row["updated_at"],
        "updatedBy": row["updated_by"],
    }


def save_register(db_path, items, actor, expected_revision=None, force=False, action="save"):
    clean = validate_items(items)
    with connect(db_path) as conn:
        row = conn.execute("SELECT revision, updated_at, updated_by FROM register WHERE id = 1").fetchone()
        if not force and expected_revision is not None and int(expected_revision) != row["revision"]:
            raise ConflictError(row["revision"], row["updated_at"], row["updated_by"])
        revision = row["revision"] + 1
        conn.execute(
            "UPDATE register SET revision = ?, items = ?, updated_at = ?, updated_by = ? WHERE id = 1",
            (revision, json.dumps(clean, ensure_ascii=False), now_iso(), actor),
        )
        audit(conn, actor, action, "проблем в реестре: %d, версия %d" % (len(clean), revision))
    return revision
