#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Гоняет tests/ui_tests.js в headless Firefox против собранной страницы.

Как это работает: скрипт делает копию index.html (.selftest.html в корне проекта),
подключает к ней тестовый скрипт, запускает Firefox в headless-режиме с включённым
выводом консоли в stdout, собирает строки [T] PASS/FAIL и удаляет копию.

Требуется только Firefox (без selenium/geckodriver/pip).

    python3 tests/run_ui_tests.py
    python3 tests/run_ui_tests.py --url http://127.0.0.1:8000/index.html
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARNESS_NAME = '.selftest.html'
LINE_RE = re.compile(r'\[T\] (PASS|FAIL) (.+)')
PRE_SCRIPT = """<script>
(function () {
  var phase = 1;
  try {
    var raw = localStorage.getItem('pb.selftest');
    if (raw && JSON.parse(raw).phase === 2) { phase = 2; }
    if (phase !== 2) { localStorage.clear(); }
  } catch (e) { phase = 1; }
  window.__PB_PHASE__ = phase;
})();
</script>
"""


def find_firefox():
    candidates = [
        os.environ.get('FIREFOX_BIN'),
        '/snap/firefox/current/usr/lib/firefox/firefox',
        '/usr/lib/firefox/firefox',
        '/usr/lib/firefox-esr/firefox-esr',
        shutil.which('firefox'),
    ]
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def build_harness():
    index_path = os.path.join(ROOT, 'index.html')
    with open(index_path, encoding='utf-8') as handle:
        html = handle.read()

    marker = '<script src="assets/app.js"></script>'
    if marker not in html:
        raise SystemExit('в index.html не найден %s — обновите тестовый запуск' % marker)

    html = html.replace(marker, PRE_SCRIPT + marker + '\n<script src="tests/ui_tests.js"></script>')

    harness = os.path.join(ROOT, HARNESS_NAME)
    with open(harness, 'w', encoding='utf-8') as handle:
        handle.write(html)
    return harness


def run_firefox(firefox, target, timeout, size=None):
    profile = tempfile.mkdtemp(prefix='pb-firefox-profile-')
    home = tempfile.mkdtemp(prefix='pb-firefox-home-')
    with open(os.path.join(profile, 'user.js'), 'w', encoding='utf-8') as handle:
        handle.write('user_pref("browser.dom.window.dump.enabled", true);\n')
        handle.write('user_pref("devtools.console.stdout.content", true);\n')
        handle.write('user_pref("devtools.console.stdout", true);\n')
        handle.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        handle.write('user_pref("browser.startup.homepage_override.mstone", "ignore");\n')
        handle.write('user_pref("datareporting.policy.dataSubmissionEnabled", false);\n')
        handle.write('user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);\n')
        handle.write('user_pref("security.fileuri.strict_origin_policy", false);\n')

    env = dict(os.environ)
    env.update({
        'HOME': home,
        'MOZ_HEADLESS': '1',
        'MOZ_DISABLE_ACCESSIBILITY': '1',
        'MOZ_CRASHREPORTER_DISABLE': '1',
    })

    command = [firefox, '--headless', '--no-remote', '--new-instance',
               '--profile', profile]
    if size:
        command.append('--window-size=%s' % size)
    command.append(target)

    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, env=env, errors='replace')
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        output, _ = process.communicate()
        output += '\n[runner] Firefox остановлен по таймауту (%s c)\n' % timeout
    finally:
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(home, ignore_errors=True)

    return output


def main():
    parser = argparse.ArgumentParser(description='Смоук-тесты ProblemBook')
    parser.add_argument('--timeout', type=int, default=90, help='таймаут прогона, секунды')
    parser.add_argument('--verbose', action='store_true', help='печатать весь вывод Firefox')
    parser.add_argument('--size', default='', help='размер окна, например 1600,1100 или 390,844')
    args = parser.parse_args()

    firefox = find_firefox()
    if not firefox:
        print('Firefox не найден. Укажите путь через FIREFOX_BIN=/путь/к/firefox')
        return 2

    harness = build_harness()
    target = 'file://' + harness
    print('Firefox : %s' % firefox)
    print('Цель    : %s' % target)

    try:
        output = run_firefox(firefox, target, args.timeout, args.size or None)
    finally:
        try:
            os.remove(harness)
        except OSError:
            pass

    if args.verbose:
        print(output)

    passed, failed = [], []
    for line in output.splitlines():
        match = LINE_RE.search(line)
        if not match:
            continue
        status, name = match.group(1), match.group(2).strip()
        (passed if status == 'PASS' else failed).append(name)
        print('  %s  %s' % ('PASS' if status == 'PASS' else 'FAIL', name))

    if 'PHASE1' not in output:
        print('\nТесты даже не начались — смотрите вывод Firefox (--verbose).')
        print(output[-2500:])
        return 2

    print('\n=== ИТОГ: %d PASS, %d FAIL ===' % (len(passed), len(failed)))
    if failed:
        for name in failed:
            print('  провал: %s' % name)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
