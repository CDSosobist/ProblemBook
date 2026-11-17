#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ProblemBook — локальный сервер для внутренней сети.

Раздаёт интерфейс проблембука, хранит общий реестр в SQLite, требует вход
по внутренней учётке. Внешних зависимостей нет: только стандартная
библиотека Python 3 и openssl (для самоподписанного сертификата).

    python3 server/problembook.py --host 0.0.0.0 --port 8443

Пользователи создаются через server/manage.py.
"""
import argparse
import datetime
import hmac
import json
import mimetypes
import os
import socket
import ssl
import subprocess
import sys
import threading
import time
import http.cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pb_core  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(ROOT, "data", "problems.db")
DEFAULT_CERTS = os.path.join(ROOT, "certs")

COOKIE_NAME = "pb_sid"
MAX_BODY = 32 * 1024 * 1024
LOGIN_WINDOW = 300
LOGIN_MAX_FAILS = 6
STATIC_DIRS = ("assets/", "docs/")

# простой антибрутфорс: (ip, имя) → список меток времени неудачных попыток
LOGIN_FAILS = {}
LOGIN_LOCK = threading.Lock()
WRITE_LOCK = threading.Lock()

ALLOW_TESTS = False
DB_PATH = DEFAULT_DB


# --------------------------------------------------------------- утилиты TLS

def local_addresses():
    names = {"localhost", "127.0.0.1"}
    try:
        host = socket.gethostname()
        names.add(host)
        resolved = socket.gethostbyname_ex(host)
        for addrs in resolved[2:]:
            names.update(addrs)
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("10.255.255.255", 1))
        names.add(probe.getsockname()[0])
        probe.close()
    except OSError:
        pass
    return sorted(names)


def ensure_certificate(cert_dir, common_name="problembook"):
    os.makedirs(cert_dir, exist_ok=True)
    cert_path = os.path.join(cert_dir, "cert.pem")
    key_path = os.path.join(cert_dir, "key.pem")
    if os.path.isfile(cert_path) and os.path.isfile(key_path):
        return cert_path, key_path

    names = local_addresses()
    san = []
    for name in names:
        try:
            socket.inet_aton(name)
            san.append("IP:" + name)
        except OSError:
            san.append("DNS:" + name)

    command = [
        "openssl", "req", "-x509", "-nodes", "-newkey", "rsa:4096", "-sha256",
        "-days", "825",
        "-keyout", key_path, "-out", cert_path,
        "-subj", "/CN=%s" % common_name,
        "-addext", "subjectAltName=" + ",".join(san),
        "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
        "-addext", "extendedKeyUsage=serverAuth",
        "-addext", "basicConstraints=critical,CA:FALSE",
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit("не удалось выпустить сертификат: %s" % (result.stderr or result.stdout))
    os.chmod(key_path, 0o600)
    return cert_path, key_path


# ------------------------------------------------------------------ обработчик

class Handler(BaseHTTPRequestHandler):
    server_version = "ProblemBook"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------ служебное

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s %s\n" % (
            datetime.datetime.now().strftime("%d.%m %H:%M:%S"),
            self.address_string(),
            fmt % args,
        ))

    def _send(self, status, body, content_type="application/json; charset=utf-8", headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, payload, headers=None):
        self._send(status, json.dumps(payload, ensure_ascii=False), headers=headers)

    def _error(self, status, message, **extra):
        payload = {"ok": False, "error": message}
        payload.update(extra)
        self._json(status, payload)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise pb_core.ValidationError("некорректный Content-Length")
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise pb_core.ValidationError("тело запроса больше %d МБ" % (MAX_BODY // (1024 * 1024)))
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise pb_core.ValidationError("тело запроса — не корректный JSON")
        if not isinstance(data, dict):
            raise pb_core.ValidationError("ожидался JSON-объект")
        return data

    # -------------------------------------------------------------- сессия

    def _cookie_token(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(raw)
        except http.cookies.CookieError:
            return None
        morsel = jar.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def _session(self):
        return pb_core.read_session(DB_PATH, self._cookie_token())

    def _session_cookie(self, token, expires):
        attrs = ["%s=%s" % (COOKIE_NAME, token), "Path=/", "HttpOnly", "SameSite=Strict",
                 "Max-Age=%d" % int(expires - time.time())]
        if self.server.tls:
            attrs.append("Secure")
        return "; ".join(attrs)

    def _clear_cookie(self):
        return "%s=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0%s" % (
            COOKIE_NAME, "; Secure" if self.server.tls else "")

    def _require(self, role=None, csrf=False):
        session = self._session()
        if not session:
            self._json(401, {"ok": False, "error": "требуется вход"})
            return None
        if csrf:
            header = self.headers.get("X-CSRF-Token") or ""
            if not header or not hmac.compare_digest(header, session["csrf"]):
                self._json(403, {"ok": False, "error": "некорректный CSRF-токен"})
                return None
        if role == "write" and session["role"] not in ("admin", "editor"):
            self._json(403, {"ok": False, "error": "роль «%s» не может изменять реестр" % session["roleTitle"]})
            return None
        if role == "admin" and session["role"] != "admin":
            self._json(403, {"ok": False, "error": "нужны права администратора"})
            return None
        return session

    # --------------------------------------------------------------- роутинг

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def _dispatch(self, method):
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/"):
                self._api(method, path)
            elif method == "GET":
                self._static(path)
            else:
                self._error(405, "метод не поддерживается")
        except pb_core.ValidationError as exc:
            self._error(400, str(exc))
        except pb_core.ConflictError as exc:
            self._json(409, {"ok": False, "error": "реестр изменён другим пользователем",
                             "revision": exc.revision, "updatedAt": exc.updated_at,
                             "updatedBy": exc.updated_by})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # pragma: no cover — диагностика
            self.log_message("ошибка обработки %s: %r", path, exc)
            self._error(500, "внутренняя ошибка сервера")

    def _api(self, method, path):
        if path == "/api/health":
            return self._json(200, {"ok": True, "app": "problembook", "version": 1,
                                    "time": pb_core.now_iso(), "tls": bool(self.server.tls)})

        if path == "/api/session" and method == "GET":
            session = self._session()
            if not session:
                return self._json(200, {"ok": True, "authenticated": False})
            return self._json(200, {"ok": True, "authenticated": True,
                                    "user": {"name": session["name"], "role": session["role"],
                                             "roleTitle": session["roleTitle"]},
                                    "csrf": session["csrf"]})

        if path == "/api/login" and method == "POST":
            return self._login()

        if path == "/api/logout" and method == "POST":
            session = self._session()
            if session:
                pb_core.drop_session(DB_PATH, self._cookie_token())
            return self._json(200, {"ok": True}, headers={"Set-Cookie": self._clear_cookie()})

        if path == "/api/state" and method == "GET":
            if not self._require():
                return
            data = pb_core.get_register(DB_PATH)
            return self._json(200, {"ok": True, **data})

        if path == "/api/state" and method == "PUT":
            session = self._require(role="write", csrf=True)
            if not session:
                return
            body = self._read_json()
            with WRITE_LOCK:
                revision = pb_core.save_register(
                    DB_PATH, body.get("items") or [], session["name"],
                    expected_revision=body.get("revision"),
                    force=bool(body.get("force")),
                    action="save",
                )
            return self._json(200, {"ok": True, "revision": revision})

        if path == "/api/import" and method == "POST":
            session = self._require(role="write", csrf=True)
            if not session:
                return
            body = self._read_json()
            items = body.get("items")
            backup_dir = os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), "backups")
            with WRITE_LOCK:
                snapshot = pb_core.snapshot(DB_PATH, backup_dir)
                revision = pb_core.save_register(DB_PATH, items or [], session["name"],
                                                 force=True, action="import")
                with pb_core.connect(DB_PATH) as conn:
                    pb_core.audit(conn, session["name"], "import-backup", os.path.basename(snapshot))
            return self._json(200, {"ok": True, "revision": revision, "count": len(items or [])})

        if path == "/api/export" and method == "GET":
            if not self._require():
                return
            data = pb_core.get_register(DB_PATH)
            payload = {"app": "problembook", "version": 1,
                       "exportedAt": pb_core.now_iso(), "items": data["items"]}
            stamp = datetime.date.today().isoformat()
            return self._send(
                200, json.dumps(payload, ensure_ascii=False, indent=2),
                headers={"Content-Disposition": 'attachment; filename="problembook-%s.json"' % stamp})

        if path == "/api/audit" and method == "GET":
            if not self._require(role="admin"):
                return
            return self._json(200, {"ok": True, "entries": pb_core.audit_log(DB_PATH, 200)})

        if path == "/api/users" and method == "GET":
            if not self._require(role="admin"):
                return
            return self._json(200, {"ok": True, "users": pb_core.list_users(DB_PATH)})

        return self._error(404, "неизвестный метод API")

    # ------------------------------------------------------------------ вход

    def _login(self):
        body = self._read_json()
        name = str(body.get("name") or "").strip()
        password = str(body.get("password") or "")
        if not name or not password:
            return self._error(400, "укажите логин и пароль")

        key = (self.client_address[0], name)
        now = time.time()
        limited = False
        retry = 0
        with LOGIN_LOCK:
            attempts = [ts for ts in LOGIN_FAILS.get(key, []) if now - ts < LOGIN_WINDOW]
            if len(attempts) >= LOGIN_MAX_FAILS:
                limited = True
                retry = int(LOGIN_WINDOW - (now - attempts[0])) + 1
            LOGIN_FAILS[key] = attempts

        user = pb_core.check_credentials(DB_PATH, name, password)
        if not user and limited:
            # слишком много неудач: отвечаем 429, не подсказывая, верный ли пароль
            return self._error(429, "слишком много попыток, повторите через %d с" % retry,
                               retryAfter=retry)
        if not user:
            with LOGIN_LOCK:
                attempts = [ts for ts in LOGIN_FAILS.get(key, []) if now - ts < LOGIN_WINDOW]
                attempts.append(now)
                LOGIN_FAILS[key] = attempts
            with pb_core.connect(DB_PATH) as conn:
                pb_core.audit(conn, name or "?", "login-failed", "неверный логин или пароль")
            return self._error(401, "неверный логин или пароль")

        with LOGIN_LOCK:
            LOGIN_FAILS.pop(key, None)
        token, csrf, expires = pb_core.create_session(DB_PATH, user["name"])
        with pb_core.connect(DB_PATH) as conn:
            pb_core.audit(conn, user["name"], "login", "успешный вход")
        return self._json(200, {"ok": True, "user": user, "csrf": csrf},
                          headers={"Set-Cookie": self._session_cookie(token, expires)})

    # ----------------------------------------------------------- статика

    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/")
        if ".." in rel.split("/"):
            return self._error(404, "файл не найден")
        allowed = rel == "index.html" or rel.startswith(STATIC_DIRS)
        if ALLOW_TESTS and rel.startswith("tests/"):
            allowed = True
        if not allowed:
            return self._error(404, "файл не найден")

        full = os.path.realpath(os.path.join(ROOT, rel))
        if not (full == os.path.join(ROOT, "index.html") or full.startswith(ROOT + os.sep)):
            return self._error(404, "файл не найден")
        if not os.path.isfile(full):
            return self._error(404, "файл не найден")

        mime, _ = mimetypes.guess_type(full)
        if rel.endswith(".js"):
            mime = "text/javascript"
        mime = (mime or "application/octet-stream") + ("; charset=utf-8" if mime and mime.startswith(("text/", "application/json", "text/javascript")) else "")
        with open(full, "rb") as handle:
            body = handle.read()
        self._send(200, body, content_type=mime)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    tls = False


def build_server(args):
    global DB_PATH, ALLOW_TESTS
    DB_PATH = args.db
    ALLOW_TESTS = args.allow_tests
    pb_core.init_db(DB_PATH)

    httpd = Server((args.host, args.port), Handler)
    if not args.no_tls:
        cert, key = ensure_certificate(args.cert_dir)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(certfile=cert, keyfile=key)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
        httpd.tls = True
    return httpd


def main(argv=None):
    parser = argparse.ArgumentParser(description="ProblemBook — локальный сервер")
    parser.add_argument("--host", default="0.0.0.0", help="адрес прослушивания (по умолчанию 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--cert-dir", default=DEFAULT_CERTS)
    parser.add_argument("--no-tls", action="store_true", help="без HTTPS (только для тестов)")
    parser.add_argument("--allow-tests", action="store_true", help="раздавать /tests/ (только для отладки)")
    args = parser.parse_args(argv)

    httpd = build_server(args)
    scheme = "https" if httpd.tls else "http"
    port = httpd.server_address[1]
    users = pb_core.list_users(DB_PATH)
    print("ProblemBook: %s://%s:%d/  (TLS: %s)" % (scheme, "127.0.0.1" if args.host == "0.0.0.0" else args.host, port,
                                                   "да" if httpd.tls else "нет"))
    for name in local_addresses():
        if name != "127.0.0.1":
            print("  из сети: %s://%s:%d/" % (scheme, name, port))
    print("Пользователей: %d%s" % (len(users), "" if users else " — создайте первого: python3 server/manage.py adduser <имя> --role admin"))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nостановлено")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
