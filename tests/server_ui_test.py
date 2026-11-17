#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Тест интерфейса ProblemBook в серверном режиме (headless Firefox).

    python3 tests/server_ui_test.py

Поднимает сервер на свободном порту с временной базой, создаёт пользователей
и прогоняет tests/server_ui.html: вход, загрузка реестра с сервера, отправка
правок, режим «только чтение». Требуется только Firefox.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'server'))
import pb_core  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, extra=''):
    if cond:
        PASS.append(name)
        print('  PASS  %s' % name)
    else:
        FAIL.append(name)
        print('  FAIL  %s  %s' % (name, extra))


def free_port():
    import socket
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def find_firefox():
    for path in (os.environ.get('FIREFOX_BIN'),
                 '/snap/firefox/current/usr/lib/firefox/firefox',
                 '/usr/lib/firefox/firefox',
                 shutil.which('firefox')):
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def seed(db):
    pb_core.init_db(db)
    for name, password, role in (('testadmin', 'adminpassword1', 'admin'),
                                 ('testviewer', 'viewerpassword1', 'viewer')):
        pb_core.create_user(db, name, password, role)
    items = [
        {'id': 'PB-%d' % i, 'title': 'Серверная проблема %d' % i, 'category': 'Доступы и ИБ',
         'priority': 'P1' if i == 1 else 'P2', 'status': 'new', 'owner': 'Инфраструктура',
         'assets': 'TITAN', 'risk': 'риск', 'actions': ['шаг'], 'done': [],
         'implRisks': 'риск реализации', 'notes': 'примечание', 'due': '2026-12-01', 'effort': 1,
         'createdAt': '2026-11-17T10:00:00', 'updatedAt': '2026-11-17T10:00:00',
         'history': [{'ts': '2026-11-17T10:00:00', 'text': 'создана'}]}
        for i in range(1, 4)
    ]
    pb_core.save_register(db, items, 'seed', force=True, action='seed')


def wait_ready(base, timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + '/api/health', timeout=2) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def main():
    firefox = find_firefox()
    if not firefox:
        print('Firefox не найден — укажите FIREFOX_BIN')
        return 2

    work = tempfile.mkdtemp(prefix='pb-ui-')
    db = os.path.join(work, 'problems.db')
    seed(db)

    port = free_port()
    base = 'http://127.0.0.1:%d' % port
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'server', 'problembook.py'),
                             '--host', '127.0.0.1', '--port', str(port), '--db', db,
                             '--no-tls', '--allow-tests'],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=ROOT)
    prof = tempfile.mkdtemp(prefix='ffp-')
    home = tempfile.mkdtemp(prefix='ffh-')
    try:
        if not wait_ready(base):
            print('сервер не поднялся'); return 1

        with open(os.path.join(prof, 'user.js'), 'w') as handle:
            handle.write('user_pref("devtools.console.stdout.content", true);\n')
            handle.write('user_pref("browser.dom.window.dump.enabled", true);\n')
            handle.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')

        env = dict(os.environ, MOZ_HEADLESS='1', HOME=home, MOZ_DISABLE_ACCESSIBILITY='1',
                   DBUS_SESSION_BUS_ADDRESS='/dev/null')
        run = subprocess.Popen([firefox, '--headless', '--no-remote', '--new-instance',
                                '--profile', prof, base + '/tests/server_ui.html'],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, env=env, errors='replace')
        try:
            output, _ = run.communicate(timeout=90)
        except subprocess.TimeoutExpired:
            run.kill()
            output, _ = run.communicate()
            output += '\n[runner] Firefox остановлен по таймауту\n'

        def unescape(text):
            return re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), text)

        lines = [unescape(line) for line in output.splitlines() if '[S]' in line]
        if not lines:
            print('нет вывода теста; хвост лога:')
            print(output[-2000:])
            return 2

        seen = set()
        for line in lines:
            text = line.split('[S]', 1)[1].strip().rstrip('"')
            if text.startswith('ИТОГ'):
                print('  ' + text)
                continue
            key = text.split(' :: ')[0]
            if key in seen:
                continue
            seen.add(key)
            status = text[:4]
            name = text[5:].split(' :: ')[0]
            extra = text.split(' :: ')[1] if ' :: ' in text else ''
            check(name, status == 'PASS', extra)

        created = 0
        with urllib.request.urlopen(base + '/api/health', timeout=5) as resp:
            created = json.loads(resp.read())['ok']
        check('сервер отвечает после прогона', created is True)
    finally:
        proc.terminate()
        try:
            proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(prof, ignore_errors=True)
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(work, ignore_errors=True)

    print('\n=== ИТОГ: %d PASS, %d FAIL ===' % (len(PASS), len(FAIL)))
    if FAIL:
        for name in FAIL:
            print('  провал:', name)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
