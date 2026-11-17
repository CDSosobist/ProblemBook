#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Тесты серверной части ProblemBook (API, права, CSRF, TLS, статика).

    python3 tests/server_test.py

Поднимает сервер на свободном порту с временной базой, прогоняет проверки и
останавливает процесс. Ничего в рабочей базе не меняет.
"""
import http.cookiejar
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, 'server', 'problembook.py')
PY = sys.executable

PASS, FAIL = [], []


def check(name, cond, extra=''):
    if cond:
        PASS.append(name)
        print('  PASS  %s' % name)
    else:
        FAIL.append(name)
        print('  FAIL  %s  %s' % (name, extra))


def free_port():
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class Client:
    def __init__(self, base, verify=True):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        handlers = [urllib.request.HTTPCookieProcessor(self.jar)]
        if base.startswith('https') and not verify:
            handlers.append(urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
        self.opener = urllib.request.build_opener(*handlers)
        self.csrf = None

    def call(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header('Content-Type', 'application/json')
        req.add_header('Accept', 'application/json')
        if self.csrf:
            req.add_header('X-CSRF-Token', self.csrf)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with self.opener.open(req, timeout=20) as resp:
                raw = resp.read()
                return resp.status, raw, dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), dict(exc.headers)

    def json(self, method, path, body=None, headers=None):
        status, raw, heads = self.call(method, path, body, headers)
        try:
            payload = json.loads(raw.decode('utf-8'))
        except Exception:
            payload = None
        return status, payload, heads

    def login(self, name, password):
        status, payload, _ = self.json('POST', '/api/login', {'name': name, 'password': password})
        if status == 200 and payload and payload.get('csrf'):
            self.csrf = payload['csrf']
        return status, payload


def wait_ready(url, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url + '/api/health', timeout=2,
                                        context=ssl._create_unverified_context()) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def start_server(db, port, extra_args):
    command = [PY, SERVER, '--host', '127.0.0.1', '--port', str(port), '--db', db] + extra_args
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, cwd=ROOT)
    return proc


def stop(proc):
    proc.terminate()
    try:
        proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()


def make_db(db, users):
    sys.path.insert(0, os.path.join(ROOT, 'server'))
    import pb_core
    pb_core.init_db(db)
    for name, password, role in users:
        pb_core.create_user(db, name, password, role)
    return pb_core


def sample_items(n=3):
    items = []
    for i in range(1, n + 1):
        items.append({
            'id': 'PB-%d' % i, 'title': 'Проблема номер %d' % i, 'category': 'Доступы и ИБ',
            'priority': 'P1' if i == 1 else 'P2', 'status': 'new', 'owner': 'Инфраструктура',
            'assets': 'TITAN', 'risk': 'риск %d' % i,
            'actions': ['шаг 1', 'шаг 2'], 'done': [0],
            'implRisks': 'риск реализации', 'notes': 'примечание',
            'due': '2026-12-01', 'effort': 2,
            'createdAt': '2026-11-17T10:00:00', 'updatedAt': '2026-11-17T10:00:00',
            'history': [{'ts': '2026-11-17T10:00:00', 'text': 'создана'}],
        })
    return items


def main():
    workdir = tempfile.mkdtemp(prefix='pb-test-')
    db = os.path.join(workdir, 'problems.db')
    certs = os.path.join(workdir, 'certs')
    pb_core = make_db(db, [('admin', 'adminpassword1', 'admin'),
                           ('editor', 'editorpassword1', 'editor'),
                           ('viewer', 'viewerpassword1', 'viewer')])

    # --- CLI пользователей
    cli_db = os.path.join(workdir, 'cli.db')
    out = subprocess.run([PY, os.path.join(ROOT, 'server', 'manage.py'), '--db', cli_db, 'adduser', 'petrov',
                          '--role', 'viewer', '--password-stdin'],
                         input='petrovpassword1\n', capture_output=True, text=True, cwd=ROOT)
    check('CLI создаёт пользователя', out.returncode == 0 and 'petrov' in out.stdout, out.stdout + out.stderr)
    out = subprocess.run([PY, os.path.join(ROOT, 'server', 'manage.py'), '--db', cli_db, 'list'],
                         capture_output=True, text=True, cwd=ROOT)
    check('CLI показывает пользователей', 'petrov' in out.stdout and 'viewer' in out.stdout, out.stdout)
    out = subprocess.run([PY, os.path.join(ROOT, 'server', 'manage.py'), '--db', cli_db, 'adduser', 'anna',
                          '--role', 'editor', '--password-stdin'],
                         input='short\n', capture_output=True, text=True, cwd=ROOT)
    check('CLI не даёт короткий пароль', out.returncode != 0 and 'пароль' in (out.stdout + out.stderr),
          out.stdout + out.stderr)

    port = free_port()
    proc = start_server(db, port, ['--no-tls', '--allow-tests'])
    base = 'http://127.0.0.1:%d' % port
    try:
        if not wait_ready(base):
            print('сервер не поднялся')
            print(proc.communicate(timeout=5)[0] if proc.poll() is None else '')
            return 1

        anon = Client(base)

        # --- health и статика
        status, payload, _ = anon.json('GET', '/api/health')
        check('health без авторизации', status == 200 and payload['ok'] is True, str(status))
        status, raw, heads = anon.call('GET', '/')
        check('главная страница раздаётся', status == 200 and 'ЭКРОСХИМ'.encode('utf-8') in raw,
              str(status))
        check('в разметке подключён логотип', b'branding/logo.svg' in raw)
        check('в разметке корпоративная иконка', b'branding/favicon' in raw)
        check('content-type html', 'text/html' in heads.get('Content-Type', ''), heads.get('Content-Type', ''))
        status, raw, _ = anon.call('GET', '/assets/app.js')
        check('assets/app.js раздаётся', status == 200 and b'ProblemBook' in raw, str(status))
        for asset, marker in (('/assets/fonts/rubik-cyrillic.woff2', b'wOF2'),
                              ('/assets/fonts/rubik-latin.woff2', b'wOF2'),
                              ('/assets/fonts/OFL.txt', b'Copyright'),
                              ('/assets/branding/logo-dark.svg', b'#35D19B')):
            code, payload_bytes, _ = anon.call('GET', asset)
            check('отдаётся %s' % asset, code == 200 and marker in payload_bytes, str(code))
        status, _, _ = anon.call('GET', '/etc/passwd')
        check('выход за пределы каталога закрыт', status == 404, str(status))
        status, _, _ = anon.call('GET', '/assets/../index.html')
        check('обход через .. закрыт из неизвестного пути', status == 404, str(status))

        # --- сессия и защита данных
        status, payload, _ = anon.json('GET', '/api/session')
        check('сессия: не авторизован', status == 200 and payload['authenticated'] is False, str(payload))
        status, _, _ = anon.json('GET', '/api/state')
        check('реестр без входа закрыт', status == 401, str(status))
        status, _, _ = anon.json('PUT', '/api/state', {'items': []})
        check('запись без входа закрыта', status == 401, str(status))

        # --- вход
        status, payload = anon.login('admin', 'wrongpassword')
        check('неверный пароль отклонён', status == 401 and 'error' in payload, str(payload))
        for _ in range(5):
            anon.login('admin', 'wrongpassword')
        status, payload, _ = anon.json('POST', '/api/login', {'name': 'admin', 'password': 'wrongpassword'})
        check('антибрутфорс: блокировка после 6 попыток', status == 429, str(status))

        admin = Client(base)
        status, payload = admin.login('admin', 'adminpassword1')
        check('вход администратора', status == 200 and payload['user']['role'] == 'admin', str(payload))
        status, payload, _ = admin.json('GET', '/api/session')
        check('сессия подтверждена', status == 200 and payload['authenticated'] is True, str(status))

        # --- реестр
        status, payload, _ = admin.json('GET', '/api/state')
        check('пустой реестр', status == 200 and payload['revision'] == 0 and payload['items'] == [], str(payload)[:120])

        status, payload, _ = admin.json('PUT', '/api/state', {'revision': 0, 'items': sample_items(2)})
        check('сохранение реестра', status == 200 and payload['revision'] == 1, str(payload))

        status, payload, _ = admin.json('PUT', '/api/state', {'revision': 0, 'items': sample_items(1)})
        check('устаревшая версия отклоняется (409)', status == 409 and payload['revision'] == 1, str(payload))

        status, payload, _ = admin.json('PUT', '/api/state', {'revision': 0, 'items': sample_items(1), 'force': True})
        check('перезапись поверх (force) проходит', status == 200 and payload['revision'] == 2, str(payload))

        status, payload, _ = admin.json('GET', '/api/state')
        check('в реестре одна проблема после перезаписи', len(payload['items']) == 1, str(len(payload['items'])))
        check('автор последнего сохранения зафиксирован', payload['updatedBy'] == 'admin', payload['updatedBy'])

        # --- импорт
        status, payload, _ = admin.json('POST', '/api/import', {'items': sample_items(26)})
        check('импорт 26 проблем', status == 200 and payload['count'] == 26, str(payload))
        status, payload, _ = admin.json('GET', '/api/state')
        check('импорт заменил реестр', len(payload['items']) == 26, str(len(payload['items'])))
        backup_dir = os.path.join(os.path.dirname(db), 'backups')
        files = sorted(os.listdir(backup_dir)) if os.path.isdir(backup_dir) else []
        check('перед импортом сохранён снимок', len(files) >= 1, str(files))
        if files:
            saved = json.load(open(os.path.join(backup_dir, files[-1]), encoding='utf-8'))
            check('снимок содержит прежний реестр', len(saved.get('items', [])) == 1, str(len(saved.get('items', []))))

        # --- валидация
        status, payload, _ = admin.json('POST', '/api/import', {'items': 'не список'})
        check('некорректный импорт отклонён', status == 400, str(status))
        bad = sample_items(1)
        bad[0]['title'] = 'З' * 900
        status, payload, _ = admin.json('POST', '/api/import', {'items': bad})
        check('слишком длинное поле обрезается', status == 200, str(status))
        status, payload, _ = admin.json('GET', '/api/state')
        check('длина заголовка ограничена сервером', len(payload['items'][0]['title']) <= 400, str(len(payload['items'][0]['title'])))

        # --- экспорт
        status, live, _ = admin.json('GET', '/api/state')
        status, raw, heads = admin.call('GET', '/api/export')
        exported = json.loads(raw.decode('utf-8'))
        check('экспорт отдаёт файл', status == 200 and 'attachment' in heads.get('Content-Disposition', ''),
              heads.get('Content-Disposition', ''))
        check('экспорт совпадает с реестром',
              len(exported.get('items', [])) == len(live['items']) and len(exported.get('items', [])) > 0,
              '%s vs %s' % (len(exported.get('items', [])), len(live['items'])))

        # --- права ролей
        editor = Client(base)
        status, _ = editor.login('editor', 'editorpassword1')
        check('вход редактора', status == 200, str(status))
        _, current, _ = editor.json('GET', '/api/state')
        status, payload, _ = editor.json('PUT', '/api/state', {'revision': current['revision'], 'items': sample_items(1)})
        check('редактор может сохранять', status == 200, str(payload))
        status, _, _ = editor.json('GET', '/api/audit')
        check('редактору закрыт журнал аудита', status == 403, str(status))

        viewer = Client(base)
        status, _ = viewer.login('viewer', 'viewerpassword1')
        check('вход наблюдателя', status == 200, str(status))
        status, payload, _ = viewer.json('GET', '/api/state')
        check('наблюдатель читает реестр', status == 200, str(status))
        status, payload, _ = viewer.json('PUT', '/api/state', {'revision': 0, 'items': sample_items(1)})
        check('наблюдателю запрещена запись', status == 403, str(status))
        status, payload, _ = viewer.json('POST', '/api/import', {'items': sample_items(1)})
        check('наблюдателю запрещён импорт', status == 403, str(status))

        # --- CSRF
        no_csrf = Client(base)
        no_csrf.login('admin', 'adminpassword1')
        no_csrf.csrf = None
        _, current, _ = no_csrf.json('GET', '/api/state')
        status, payload, _ = no_csrf.json('PUT', '/api/state', {'revision': current['revision'], 'items': sample_items(1)})
        check('запись без CSRF-токена отклонена', status == 403, str(status))

        # --- аудит и пользователи
        status, payload, _ = admin.json('GET', '/api/audit')
        actions = [entry['action'] for entry in payload['entries']]
        check('журнал аудита доступен администратору', status == 200 and len(actions) >= 3, str(actions[:6]))
        check('в аудите есть импорт и вход', 'import' in actions and 'login' in actions, str(sorted(set(actions))))
        status, payload, _ = admin.json('GET', '/api/users')
        names = [u['name'] for u in payload['users']]
        check('список пользователей без хешей', status == 200 and 'admin' in names and 'pwd' not in payload['users'][0],
              str(names))

        # --- выход
        status, payload, _ = admin.json('POST', '/api/logout')
        check('выход', status == 200, str(status))
        status, _, _ = admin.json('GET', '/api/state')
        check('после выхода реестр закрыт', status == 401, str(status))

        # --- TLS
        tls_port = free_port()
        tls_proc = start_server(db, tls_port, ['--cert-dir', certs])
        tls_base = 'https://127.0.0.1:%d' % tls_port
        try:
            if not wait_ready(tls_base):
                check('сервер с TLS поднялся', False, 'нет ответа')
            else:
                status, payload, _ = Client(tls_base, verify=False).json('GET', '/api/session')
                check('HTTPS отвечает', status == 200, str(status))

                cafile = os.path.join(certs, 'cert.pem')
                trusted = ssl.create_default_context(cafile=cafile)
                with socket.create_connection(('127.0.0.1', tls_port), timeout=10) as sock:
                    with trusted.wrap_socket(sock, server_hostname='127.0.0.1') as tls:
                        cert = tls.getpeercert()
                        sans = [value for kind, value in cert.get('subjectAltName', ())]
                        check('сертификат доверенный и с SAN',
                              '127.0.0.1' in sans and 'localhost' in sans, str(sans))
                        check('TLS-версия 1.2+', tls.version() in ('TLSv1.2', 'TLSv1.3'), tls.version())

                wrong = ssl.create_default_context(cafile=cafile)
                try:
                    with socket.create_connection(('127.0.0.1', tls_port), timeout=10) as sock:
                        with wrong.wrap_socket(sock, server_hostname='example.com'):
                            check('сертификат не принимает чужое имя', False, 'соединение прошло')
                except ssl.SSLCertVerificationError:
                    check('сертификат не принимает чужое имя', True)

                tls_client = Client(tls_base, verify=False)
                status, payload = tls_client.login('admin', 'adminpassword1')
                check('вход по HTTPS', status == 200, str(payload))
                _, _, login_headers = tls_client.call('POST', '/api/login',
                                                      {'name': 'admin', 'password': 'adminpassword1'})
                cookie_header = login_headers.get('Set-Cookie', '')
                check('cookie: HttpOnly и Secure', 'HttpOnly' in cookie_header and 'Secure' in cookie_header,
                      cookie_header or 'нет заголовка')
                check('cookie: SameSite=Strict', 'SameSite=Strict' in cookie_header, cookie_header)
        finally:
            stop(tls_proc)
    finally:
        stop(proc)

    print('\n=== ИТОГ: %d PASS, %d FAIL ===' % (len(PASS), len(FAIL)))
    if FAIL:
        for name in FAIL:
            print('  провал:', name)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
