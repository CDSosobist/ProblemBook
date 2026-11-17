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
import getpass
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
    except pb_core.ValidationError as exc:
        raise SystemExit("ошибка: %s" % exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
