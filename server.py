#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Engram Panel - a tiny local web UI for Engram.

The panel serves a static UI and proxies /api/* to Engram's local HTTP API.
Normal edits and deletes go through Engram.  The recycle-bin restore is the one
exception: Engram has no restore API, so the panel clears deleted_at directly
in SQLite (after a full database backup when backups are enabled) and lets
Engram's FTS triggers rebuild the search index.
"""

import atexit
import glob
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("PANEL_HOST", "127.0.0.1")
PORT = int(os.environ.get("PANEL_PORT", "8787"))
ENGRAM_URL = os.environ.get("ENGRAM_URL", "http://127.0.0.1:7437").rstrip("/")
ENGRAM_TOKEN = os.environ.get("ENGRAM_HTTP_TOKEN", "")
ENGRAM_DATA_DIR = os.environ.get("ENGRAM_DATA_DIR") or str(Path.home() / ".engram")
ENGRAM_DB_PATH = Path(os.environ.get("ENGRAM_DB_PATH") or (Path(ENGRAM_DATA_DIR) / "engram.db"))
ENGRAM_IS_LOCAL = urllib.parse.urlparse(ENGRAM_URL).hostname in ("127.0.0.1", "localhost")
LOG_DIR = ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
BACKUP_DIR = ROOT / "backups"
BACKUP_DIR.mkdir(parents=True, exist_ok=True)
BACKUP_KEEP = max(1, int(os.environ.get("PANEL_BACKUP_KEEP", "20")))
BACKUP_ENABLED = os.environ.get("PANEL_BACKUP", "1") != "0" and ENGRAM_IS_LOCAL

CHILD = None
HTTPD = None
SHUTTING_DOWN = False


def find_engram():
    candidates = []
    env_bin = os.environ.get("ENGRAM_BIN", "").strip()
    if env_bin:
        candidates.append(Path(env_bin))
    which = shutil.which("engram")
    if which:
        candidates.append(Path(which))
    candidates.append(Path.home() / "bin" / "engram.exe")
    candidates.append(Path.home() / "bin" / "engram")
    for candidate in candidates:
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            pass
    return None


def request_engram(method, path, body=None, timeout=3):
    headers = {"Accept": "application/json"}
    if ENGRAM_TOKEN:
        headers["Authorization"] = "Bearer " + ENGRAM_TOKEN
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(ENGRAM_URL + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def engram_alive():
    try:
        status, _ = request_engram("GET", "/health", timeout=1.2)
        return status == 200
    except Exception:
        return False


def prune_backups():
    try:
        files = sorted(
            BACKUP_DIR.glob("engram-*.db"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return
    for old in files[BACKUP_KEEP:]:
        try:
            old.unlink()
        except OSError:
            pass


def create_backup(reason="manual"):
    """Create a consistent SQLite snapshot using the online backup API."""
    if not BACKUP_ENABLED:
        return None
    if not ENGRAM_DB_PATH.is_file():
        raise FileNotFoundError("找不到 Engram 数据库：%s" % ENGRAM_DB_PATH)

    safe_reason = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(reason or "manual")).strip("-") or "manual"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = BACKUP_DIR / ("engram-%s-%s.db" % (stamp, safe_reason))
    counter = 2
    while dest.exists():
        dest = BACKUP_DIR / ("engram-%s-%s-%d.db" % (stamp, safe_reason, counter))
        counter += 1

    source = None
    target = None
    try:
        source = sqlite3.connect(str(ENGRAM_DB_PATH), timeout=30)
        target = sqlite3.connect(str(dest), timeout=30)
        source.backup(target)
        target.commit()
        if not dest.is_file() or dest.stat().st_size <= 0:
            raise OSError("备份文件为空")
    except Exception:
        try:
            if target is not None:
                target.close()
        except Exception:
            pass
        target = None
        try:
            if dest.exists():
                dest.unlink()
        except OSError:
            pass
        raise
    finally:
        try:
            if target is not None:
                target.close()
        except Exception:
            pass
        try:
            if source is not None:
                source.close()
        except Exception:
            pass

    prune_backups()
    return {
        "name": dest.name,
        "path": str(dest),
        "bytes": dest.stat().st_size,
    }


def list_backups():
    result = []
    try:
        files = sorted(
            BACKUP_DIR.glob("engram-*.db"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return result
    for path in files:
        try:
            stat = path.stat()
            result.append({
                "name": path.name,
                "path": str(path),
                "bytes": stat.st_size,
                "modified": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)),
            })
        except OSError:
            pass
    return result


TRASH_COLUMNS = """
    id, sync_id, session_id, type, title, content, tool_name, project, scope,
    topic_key, revision_count, duplicate_count, last_seen_at, review_after,
    superseded_by_sync_id, created_at, updated_at, deleted_at
"""


def open_engram_db(readonly=False):
    if not ENGRAM_DB_PATH.is_file():
        raise FileNotFoundError("找不到 Engram 数据库：%s" % ENGRAM_DB_PATH)
    con = sqlite3.connect(str(ENGRAM_DB_PATH), timeout=30)
    con.row_factory = sqlite3.Row
    if readonly:
        con.execute("PRAGMA query_only=ON")
    return con


def list_trash(project="", obs_type="", scope="", query="", limit=50):
    limit = max(1, min(200, int(limit or 50)))
    where = ["deleted_at IS NOT NULL"]
    args = []
    if project:
        where.append("ifnull(project, '') = ?")
        args.append(project)
    if obs_type:
        where.append("type = ?")
        args.append(obs_type)
    if scope:
        where.append("scope = ?")
        args.append(scope)
    if query:
        where.append("(title LIKE ? OR content LIKE ?)")
        like = "%" + query + "%"
        args.extend([like, like])
    where_sql = " AND ".join(where)

    con = open_engram_db(readonly=True)
    try:
        total = con.execute(
            "SELECT COUNT(*) FROM observations WHERE " + where_sql, args
        ).fetchone()[0]
        rows = con.execute(
            "SELECT " + TRASH_COLUMNS + " FROM observations WHERE " + where_sql +
            " ORDER BY deleted_at DESC, id DESC LIMIT ?",
            args + [limit],
        ).fetchall()
        return {"count": total, "items": [dict(row) for row in rows]}
    finally:
        con.close()


def get_trash(observation_id):
    con = open_engram_db(readonly=True)
    try:
        row = con.execute(
            "SELECT " + TRASH_COLUMNS + " FROM observations WHERE id = ? AND deleted_at IS NOT NULL",
            (observation_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        con.close()


_SQLITE_TRIGRAM = None
_MODERN_PYTHON = None
_MODERN_PYTHON_SEARCHED = False


def sqlite_supports_trigram():
    """Return True when this Python's SQLite can write Engram's FTS5 index."""
    global _SQLITE_TRIGRAM
    if _SQLITE_TRIGRAM is not None:
        return _SQLITE_TRIGRAM
    try:
        con = sqlite3.connect(":memory:")
        try:
            con.execute("CREATE VIRTUAL TABLE _trigram_probe USING fts5(x, tokenize='trigram')")
        finally:
            con.close()
        _SQLITE_TRIGRAM = True
    except Exception:
        _SQLITE_TRIGRAM = False
    return _SQLITE_TRIGRAM


def find_modern_python():
    """Find a Python whose bundled SQLite supports the FTS5 trigram tokenizer."""
    global _MODERN_PYTHON, _MODERN_PYTHON_SEARCHED
    if _MODERN_PYTHON_SEARCHED:
        return _MODERN_PYTHON
    _MODERN_PYTHON_SEARCHED = True

    candidates = []
    env_python = os.environ.get("PANEL_SQLITE_PYTHON", "").strip()
    if env_python:
        candidates.append([env_python])
    candidates.append([sys.executable])
    for version in ("3.15", "3.14", "3.13", "3.12", "3.11", "3.10"):
        candidates.append(["py", "-" + version])
    for name in ("python3", "python"):
        path = shutil.which(name)
        if path:
            candidates.append([path])

    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        patterns = [
            os.path.join(local_app_data, "Python", "pythoncore-*", "python.exe"),
            os.path.join(local_app_data, "Programs", "Python", "Python*", "python.exe"),
        ]
        for pattern in patterns:
            for path in sorted(glob.glob(pattern), reverse=True):
                candidates.append([path])

    probe = (
        "import sqlite3\n"
        "try:\n"
        "    c = sqlite3.connect(':memory:')\n"
        "    c.execute(\"CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')\")\n"
        "    c.close()\n"
        "    print('ok')\n"
        "except Exception:\n"
        "    pass\n"
    )
    seen = set()
    for command in candidates:
        key = tuple(command)
        if key in seen:
            continue
        seen.add(key)
        try:
            proc = subprocess.run(
                command + ["-c", probe],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            continue
        if proc.returncode == 0 and b"ok" in (proc.stdout or b""):
            _MODERN_PYTHON = command
            return _MODERN_PYTHON
    return None


def cloud_sync_warning(project, enrolled):
    if not enrolled:
        return None
    return (
        "该项目已启用云同步。直接恢复只改本地库，不保证自动上传；"
        "建议之后用 engram sync --cloud 检查，或重新保存一条同 topic_key 的记忆。"
    )


def restore_trash_direct(observation_id, expected_project):
    con = sqlite3.connect(str(ENGRAM_DB_PATH), timeout=30, isolation_level=None)
    con.row_factory = sqlite3.Row
    try:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute(
            "SELECT id, project, deleted_at, sync_id FROM observations WHERE id = ?",
            (observation_id,),
        ).fetchone()
        if row is None:
            con.execute("ROLLBACK")
            raise LookupError("observation not found")
        if row["deleted_at"] is None:
            con.execute("ROLLBACK")
            raise ValueError("observation is not in trash")
        if (row["project"] or "") != expected_project:
            con.execute("ROLLBACK")
            raise PermissionError("project mismatch")
        con.execute(
            "UPDATE observations SET deleted_at = NULL, updated_at = datetime('now') "
            "WHERE id = ? AND deleted_at IS NOT NULL",
            (observation_id,),
        )
        con.execute("COMMIT")

        enrolled = False
        try:
            enrolled = con.execute(
                "SELECT 1 FROM sync_enrolled_projects WHERE project = ? LIMIT 1",
                (expected_project,),
            ).fetchone() is not None
        except sqlite3.Error:
            pass
        return {
            "id": observation_id,
            "project": expected_project,
            "sync_id": row["sync_id"],
            "enrolled": enrolled,
        }
    except Exception:
        try:
            con.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        con.close()


def restore_trash_via_helper(observation_id, expected_project):
    python = find_modern_python()
    if not python:
        raise RuntimeError(
            "当前 Python 的 SQLite 不支持 trigram，恢复需要 Python 3.10+（SQLite 3.34+）。"
            "请安装新版 Python，或设置 PANEL_SQLITE_PYTHON 指向新版 python.exe。"
        )
    payload = json.dumps({
        "db": str(ENGRAM_DB_PATH),
        "id": observation_id,
        "expected_project": expected_project,
    }).encode("utf-8")
    try:
        proc = subprocess.run(
            python + [str(ROOT / "restore_worker.py")],
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as exc:
        raise RuntimeError("启动恢复助手失败：%s" % exc)
    raw = (proc.stdout or b"").decode("utf-8", "replace").strip()
    try:
        result = json.loads(raw) if raw else {}
    except Exception:
        result = {}
    if proc.returncode != 0 or not result.get("ok"):
        error_type = result.get("error_type") or ""
        message = result.get("error") or (proc.stderr or b"").decode("utf-8", "replace").strip()
        if error_type == "LookupError":
            raise LookupError(message or "observation not found")
        if error_type == "PermissionError":
            raise PermissionError(message or "project mismatch")
        if error_type == "ValueError":
            raise ValueError(message or "observation is not in trash")
        raise RuntimeError(message or "恢复助手执行失败")
    return result


def restore_trash(observation_id, expected_project):
    if not ENGRAM_IS_LOCAL:
        raise RuntimeError("回收站恢复只支持本地 Engram 数据库")
    if expected_project is None:
        raise ValueError("expected_project is required")
    if not ENGRAM_DB_PATH.is_file():
        raise FileNotFoundError("找不到 Engram 数据库：%s" % ENGRAM_DB_PATH)

    if sqlite_supports_trigram():
        result = restore_trash_direct(observation_id, expected_project)
    else:
        result = restore_trash_via_helper(observation_id, expected_project)
    result["cloud_warning"] = cloud_sync_warning(
        expected_project, bool(result.get("enrolled"))
    )
    return result


def stop_child():
    global CHILD
    if CHILD is None:
        return
    proc = CHILD
    CHILD = None
    try:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
    except Exception:
        pass


atexit.register(stop_child)


def ensure_engram():
    """Start Engram's local HTTP server if it is not already running."""
    global CHILD
    if engram_alive():
        print("[panel] Engram HTTP API already running at %s" % ENGRAM_URL)
        return
    binary = find_engram()
    if not binary:
        print("[panel] WARNING: engram binary not found; start it manually.", file=sys.stderr)
        return

    parsed = urllib.parse.urlparse(ENGRAM_URL)
    if parsed.hostname not in ("127.0.0.1", "localhost"):
        print("[panel] WARNING: ENGRAM_URL is not local; not auto-starting Engram.", file=sys.stderr)
        return
    serve_port = parsed.port or 7437
    log_path = LOG_DIR / "engram-serve.log"
    log_file = open(str(log_path), "ab", buffering=0)
    env = os.environ.copy()
    env["ENGRAM_DATA_DIR"] = ENGRAM_DATA_DIR
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    print("[panel] Starting Engram: %s serve %s" % (binary, serve_port))
    CHILD = subprocess.Popen(
        [binary, "serve", str(serve_port)],
        cwd=str(ROOT),
        env=env,
        stdout=log_file,
        stderr=log_file,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    for _ in range(40):
        if engram_alive():
            print("[panel] Engram HTTP API is ready.")
            return
        if CHILD.poll() is not None:
            print("[panel] Engram exited with code %s; see %s" % (CHILD.returncode, log_path), file=sys.stderr)
            return
        time.sleep(0.3)
    print("[panel] WARNING: Engram did not become ready in time.", file=sys.stderr)


def panel_alive():
    try:
        req = urllib.request.Request("http://127.0.0.1:%d/" % PORT)
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            return resp.status == 200
    except Exception:
        return False


def open_panel():
    webbrowser.open("http://127.0.0.1:%d/" % PORT)


def shutdown_panel():
    global SHUTTING_DOWN
    if SHUTTING_DOWN:
        return
    SHUTTING_DOWN = True
    time.sleep(0.25)
    if HTTPD is not None:
        try:
            HTTPD.shutdown()
        except Exception:
            pass
    stop_child()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "EngramPanel/1.0"

    def log_message(self, fmt, *args):
        # Keep the console quiet for normal requests.
        if len(args) >= 2 and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("[panel] %s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status, body, content_type="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _send_json(self, status, payload):
        self._send(status, json.dumps(payload, ensure_ascii=False), "application/json; charset=utf-8")

    def _serve_file(self, filename, content_type):
        path = ROOT / filename
        if not path.is_file():
            self._send_json(404, {"error": "not found"})
            return
        try:
            body = path.read_bytes()
        except OSError as exc:
            self._send_json(500, {"error": str(exc)})
            return
        self._send(200, body, content_type)

    def _proxy(self):
        if not self.path.startswith("/api/"):
            self._send_json(404, {"error": "not found"})
            return

        upstream_path = self.path[4:] or "/"
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else None

        backup = None
        if (
            self.command == "DELETE"
            and self.path.startswith(("/api/observations/", "/api/sessions/", "/api/prompts/"))
            and "/pin" not in self.path
        ):
            try:
                backup = create_backup("before-delete")
            except Exception as exc:
                self._send_json(500, {
                    "error": "删除前备份失败，已取消删除",
                    "detail": str(exc),
                    "hint": "确认 Engram 数据库可读，或设置 PANEL_BACKUP=0 关闭删除前备份",
                })
                return

        headers = {"Accept": self.headers.get("Accept", "application/json")}
        content_type = self.headers.get("Content-Type")
        if content_type:
            headers["Content-Type"] = content_type
        if ENGRAM_TOKEN:
            headers["Authorization"] = "Bearer " + ENGRAM_TOKEN

        req = urllib.request.Request(
            ENGRAM_URL + upstream_path,
            data=body,
            headers=headers,
            method=self.command,
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
                resp_type = resp.headers.get("Content-Type", "application/json; charset=utf-8")
                extra = {}
                if resp.headers.get("Content-Encoding"):
                    extra["Content-Encoding"] = resp.headers["Content-Encoding"]
                if backup:
                    extra["X-Engram-Panel-Backup"] = backup["name"]
                self._send(resp.status, data, resp_type, extra)
        except urllib.error.HTTPError as exc:
            data = exc.read()
            resp_type = exc.headers.get("Content-Type", "application/json; charset=utf-8")
            self._send(exc.code, data, resp_type)
        except socket.timeout:
            self._send_json(504, {"error": "Engram 请求超时"})
        except urllib.error.URLError as exc:
            self._send_json(502, {
                "error": "Engram HTTP API 不可用",
                "detail": str(exc.reason),
                "hint": "确认 engram serve 7437 正在运行",
            })
        except Exception as exc:
            self._send_json(500, {"error": "代理请求失败", "detail": str(exc)})

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._serve_file("index.html", "text/html; charset=utf-8")
        elif self.path == "/app.css":
            self._serve_file("app.css", "text/css; charset=utf-8")
        elif self.path == "/app.js":
            self._serve_file("app.js", "application/javascript; charset=utf-8")
        elif self.path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
        elif self.path == "/api/panel/backups":
            self._send_json(200, {
                "enabled": BACKUP_ENABLED,
                "dir": str(BACKUP_DIR),
                "keep": BACKUP_KEEP,
                "backups": list_backups(),
            })
        elif self.path == "/api/panel/info":
            self._send_json(200, {
                "engram_url": ENGRAM_URL,
                "data_dir": ENGRAM_DATA_DIR,
                "db_path": str(ENGRAM_DB_PATH),
                "backup_dir": str(BACKUP_DIR),
                "backup_enabled": BACKUP_ENABLED,
                "backup_keep": BACKUP_KEEP,
            })
        elif urllib.parse.urlparse(self.path).path == "/api/panel/trash":
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            try:
                limit = int(params.get("limit", ["50"])[0] or "50")
                payload = list_trash(
                    project=params.get("project", [""])[0],
                    obs_type=params.get("type", [""])[0],
                    scope=params.get("scope", [""])[0],
                    query=params.get("q", [""])[0],
                    limit=limit,
                )
                self._send_json(200, payload)
            except Exception as exc:
                self._send_json(500, {"error": "读取回收站失败", "detail": str(exc)})
        else:
            trash_match = re.match(r"^/api/panel/trash/(\d+)$", urllib.parse.urlparse(self.path).path)
            if trash_match:
                try:
                    obs = get_trash(int(trash_match.group(1)))
                    if obs is None:
                        self._send_json(404, {"error": "回收站里没有这条记录"})
                    else:
                        self._send_json(200, obs)
                except Exception as exc:
                    self._send_json(500, {"error": "读取回收站记录失败", "detail": str(exc)})
            elif self.path.startswith("/api/"):
                self._proxy()
            else:
                self._send_json(404, {"error": "not found"})

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if self.path == "/api/panel/shutdown":
            self._send_json(200, {"ok": True, "message": "面板正在关闭"})
            threading.Thread(target=shutdown_panel, daemon=True).start()
            return
        if self.path == "/api/panel/backup":
            if not BACKUP_ENABLED:
                self._send_json(400, {
                    "error": "备份未启用",
                    "hint": "只有本地 Engram 且 PANEL_BACKUP 不为 0 时才启用",
                })
                return
            try:
                backup = create_backup("manual")
                self._send_json(200, {
                    "ok": True,
                    "backup": backup,
                    "dir": str(BACKUP_DIR),
                })
            except Exception as exc:
                self._send_json(500, {
                    "error": "备份失败",
                    "detail": str(exc),
                    "hint": "确认 Engram 数据库可读，或检查磁盘空间",
                })
            return

        restore_match = re.match(r"^/api/panel/trash/(\d+)/restore$", urllib.parse.urlparse(self.path).path)
        if restore_match:
            observation_id = int(restore_match.group(1))
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length else b""
            try:
                payload = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                self._send_json(400, {"error": "请求 JSON 无效"})
                return
            expected_project = payload.get("expected_project")
            if expected_project is None:
                self._send_json(400, {"error": "expected_project is required"})
                return

            backup = None
            if BACKUP_ENABLED:
                try:
                    backup = create_backup("before-restore")
                except Exception as exc:
                    self._send_json(500, {
                        "error": "恢复前备份失败，已取消恢复",
                        "detail": str(exc),
                    })
                    return
            try:
                result = restore_trash(observation_id, expected_project)
                self._send_json(200, {
                    "ok": True,
                    "restore": result,
                    "backup": backup,
                })
            except LookupError:
                self._send_json(404, {"error": "回收站里没有这条记录"})
            except PermissionError:
                self._send_json(409, {"error": "项目不匹配，已取消恢复"})
            except ValueError as exc:
                self._send_json(409, {"error": str(exc)})
            except Exception as exc:
                self._send_json(500, {"error": "恢复失败", "detail": str(exc)})
            return

        if self.path.startswith("/api/"):
            self._proxy()
        else:
            self._send_json(404, {"error": "not found"})

    def do_PATCH(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            self._send_json(404, {"error": "not found"})

    def do_PUT(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            self._send_json(404, {"error": "not found"})

    def do_DELETE(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            self._send_json(404, {"error": "not found"})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()


def main():
    global HTTPD
    if panel_alive():
        print("[panel] Panel is already running at http://127.0.0.1:%d/" % PORT)
        if os.environ.get("PANEL_NO_BROWSER") != "1":
            open_panel()
        return

    ensure_engram()

    try:
        HTTPD = ThreadingHTTPServer((HOST, PORT), Handler)
        HTTPD.daemon_threads = True
    except OSError as exc:
        print("[panel] Cannot bind %s:%d: %s" % (HOST, PORT, exc), file=sys.stderr)
        stop_child()
        sys.exit(1)

    url = "http://127.0.0.1:%d/" % PORT
    print("[panel] Engram Panel: %s" % url)
    print("[panel] Engram API:   %s" % ENGRAM_URL)
    print("[panel] Data dir:     %s" % ENGRAM_DATA_DIR)
    print("[panel] Backup dir:   %s" % BACKUP_DIR)
    print("[panel] Press Ctrl+C to stop.")

    if os.environ.get("PANEL_NO_BROWSER") != "1":
        threading.Timer(0.7, open_panel).start()

    try:
        HTTPD.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            HTTPD.server_close()
        except Exception:
            pass
        stop_child()
        print("[panel] Stopped.")


if __name__ == "__main__":
    main()
