#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Управление пользователями проблембука (локальные учётные записи).

    python3 server/manage.py adduser ivanov --role editor
    python3 server/manage.py passwd  ivanov
    python3 server/manage.py role    ivanov --role viewer
    python3 server/manage.py deluser ivanov
    python3 server/manage.py list
    python3 server/manage.py audit --limit 30

Пароль вводится скрытно; также можно передать --password-stdin, чтобы
сгенерировать/передать пароль из скрипта. Роли: admin (всё + аудит),
editor (чтение и правка), viewer (только чтение).
"""
import argparse
import datetime
import getpass
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pb_core  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(ROOT, "data", "problems.db")


def read_password(args, confirm=True):
    if args.password_stdin:
        password = sys.stdin.readline().rstrip("\n")
        if not password:
            raise SystemExit("пустой пароль во входе")
        return password
    password = getpass.getpass("пароль (минимум 10 символов): ")
    if confirm:
        again = getpass.getpass("повторите пароль: ")
        if password != again:
            raise SystemExit("пароли не совпадают")
    return password


def main(argv=None):
    parser = argparse.ArgumentParser(description="Пользователи ProblemBook")
    parser.add_argument("--db", default=DEFAULT_DB)
    sub = parser.add_subparsers(dest="command", required=True)

    add = sub.add_parser("adduser", help="создать пользователя")
    add.add_argument("name")
    add.add_argument("--role", default="editor", choices=list(pb_core.ROLES))
    add.add_argument("--password-stdin", action="store_true")

    pwd = sub.add_parser("passwd", help="сменить пароль")
    pwd.add_argument("name")
    pwd.add_argument("--password-stdin", action="store_true")

    role = sub.add_parser("role", help="сменить роль")
    role.add_argument("name")
    role.add_argument("--role", required=True, choices=list(pb_core.ROLES))

    sub.add_parser("list", help="список пользователей")

    delete = sub.add_parser("deluser", help="удалить пользователя")
    delete.add_argument("name")

    audit = sub.add_parser("audit", help="журнал изменений")
    audit.add_argument("--limit", type=int, default=20)

    status = sub.add_parser("status", help="состояние реестра")
    status.add_argument("--json", action="store_true", help="вывести машинно-читаемо")

    export = sub.add_parser("export", help="выгрузить реестр в файл")
    export.add_argument("path")

    import_file = sub.add_parser("import-file", help="загрузить реестр из JSON-файла")
    import_file.add_argument("path")
    import_file.add_argument("--dry-run", action="store_true", help="только проверить файл")
    import_file.add_argument("--merge", action="store_true", help="добавить к текущим проблемам")

    args = parser.parse_args(argv)
    pb_core.init_db(args.db)

    try:
        if args.command == "adduser":
            password = read_password(args)
            pb_core.create_user(args.db, args.name, password, args.role)
            print("создан %s (роль: %s)" % (args.name, pb_core.ROLE_TITLES[args.role]))
        elif args.command == "passwd":
            password = read_password(args)
            pb_core.set_password(args.db, args.name, password)
            print("пароль обновлён: %s" % args.name)
        elif args.command == "role":
            pb_core.set_role(args.db, args.name, args.role)
            print("роль %s → %s" % (args.name, pb_core.ROLE_TITLES[args.role]))
        elif args.command == "deluser":
            pb_core.delete_user(args.db, args.name)
            print("удалён: %s" % args.name)
        elif args.command == "list":
            users = pb_core.list_users(args.db)
            if not users:
                print("пользователей нет — создайте: manage.py adduser <имя> --role admin")
            for user in users:
                print("%-16s %-9s создан %-19s последний вход %s" % (
                    user["name"], user["role"], user["created"] or "—", user["last_login"] or "—"))
        elif args.command == "audit":
            for entry in pb_core.audit_log(args.db, args.limit):
                print("%-19s %-12s %-14s %s" % (entry["ts"], entry["actor"], entry["action"], entry["details"]))
        elif args.command == "status":
            data = pb_core.get_register(args.db)
            items = data["items"]
            by_prio = {}
            by_status = {}
            overdue = 0
            today = datetime.date.today().isoformat()
            for item in items:
                by_prio[item.get("priority", "?")] = by_prio.get(item.get("priority", "?"), 0) + 1
                by_status[item.get("status", "?")] = by_status.get(item.get("status", "?"), 0) + 1
                if item.get("due") and item.get("due") < today and item.get("status") not in ("done", "rejected"):
                    overdue += 1
            summary = {
                "revision": data["revision"],
                "items": len(items),
                "byPriority": by_prio,
                "byStatus": by_status,
                "overdue": overdue,
                "updatedAt": data["updatedAt"],
                "updatedBy": data["updatedBy"],
                "users": len(pb_core.list_users(args.db)),
                "backups": len(pb_core.backups(os.path.join(os.path.dirname(os.path.abspath(args.db)), "backups"))),
            }
            if args.json:
                print(json.dumps(summary, ensure_ascii=False, indent=2))
            else:
                print("проблем: %d (версия реестра %d)" % (summary["items"], summary["revision"]))
                print("приоритеты: %s" % ", ".join("%s=%d" % kv for kv in sorted(summary["byPriority"].items())))
                print("статусы: %s" % ", ".join("%s=%d" % kv for kv in sorted(summary["byStatus"].items())))
                print("просрочено: %d" % summary["overdue"])
                print("последнее изменение: %s (%s)" % (summary["updatedAt"], summary["updatedBy"]))
                print("пользователей: %d, снимков: %d" % (summary["users"], summary["backups"]))
        elif args.command == "export":
            data = pb_core.get_register(args.db)
            payload = {"app": "problembook", "version": 1, "exportedAt": pb_core.now_iso(),
                       "items": data["items"]}
            with open(args.path, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
            print("выгружено %d проблем в %s" % (len(data["items"]), args.path))
        elif args.command == "import-file":
            with open(args.path, encoding="utf-8") as handle:
                payload = json.load(handle)
            incoming = payload.get("items") if isinstance(payload, dict) else payload
            if not isinstance(incoming, list) or not incoming:
                raise SystemExit("в файле нет записей: ожидался JSON с полем items")
            incoming = pb_core.validate_items(incoming)

            current = pb_core.get_register(args.db)["items"]
            if args.merge and current:
                start = len(current)
                used = set()
                for item in current:
                    used.add(item.get("id"))
                for index, item in enumerate(incoming):
                    candidate = "PB-%d" % (start + index + 1)
                    if candidate in used:
                        candidate = "PB-%d-%s" % (start + index + 1, datetime.datetime.now().strftime("%H%M%S"))
                    item["id"] = candidate
                incoming = current + incoming

            by_prio = {}
            for item in incoming:
                by_prio[item["priority"]] = by_prio.get(item["priority"], 0) + 1
            summary = ", ".join("%s=%d" % kv for kv in sorted(by_prio.items()))
            if args.dry_run:
                print("проверка пройдена: %d проблем (%s), запись не выполнялась" % (len(incoming), summary))
                return 0

            backup_dir = os.path.join(os.path.dirname(os.path.abspath(args.db)), "backups")
            snapshot = pb_core.snapshot(args.db, backup_dir)
            revision = pb_core.save_register(args.db, incoming, "cli", force=True, action="cli-import")
            with pb_core.connect(args.db) as conn:
                pb_core.audit(conn, "cli", "cli-import-backup", os.path.basename(snapshot))
            print("загружено %d проблем (%s), реестр стал версией %d" % (len(incoming), summary, revision))
            print("снимок предыдущего состояния: %s" % snapshot)
    except pb_core.ValidationError as exc:
        raise SystemExit("ошибка: %s" % exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
