from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
import sqlite3, json, uuid, re
import queue as _queue
import threading as _threading
import time
from concurrent.futures import Future as _Future
from concurrent.futures import TimeoutError as _FutureTimeout
from path_helper import data_path

DATABASE = data_path('LedgerEditor.db')
LEDGER = data_path('Ledger.db')
ARCHIVE = data_path('Archive.db')
FILE_DB = data_path('file.db')
OFFLINE = data_path('Offline.db')

DEFAULT_FILE_TYPES = [
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'txt', 'csv', 'png', 'jpg', 'jpeg', 'zip', 'rar', '7z',
]
MAX_FILE_SIZE = 100 * 1024 * 1024
MAX_LEDGER_FILE_TOTAL = 2 * 1024 * 1024 * 1024
MAX_LEDGER_FILE_COUNT = 200

UUID_SENTINEL = '__uuid__'


def _now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _connect(path, timeout=10):
    conn = sqlite3.connect(path, timeout=timeout)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=10000")
        # ★ 性能调参
        conn.execute("PRAGMA cache_size=-64000")   # 64MB 页缓存
        conn.execute("PRAGMA temp_store=MEMORY")   # 临时表/索引用内存
        conn.execute("PRAGMA mmap_size=268435456") # 256MB mmap 只读
    except sqlite3.Error:
        pass
    return conn


def _safe_json(val, fallback):
    try:
        out = json.loads(val or 'null')
        if isinstance(out, type(fallback)):
            return out
    except (json.JSONDecodeError, TypeError):
        pass
    return fallback


def _valid_uuid(u):
    if not isinstance(u, str) or len(u) != 32:
        return False
    try:
        int(u, 16)
        return True
    except ValueError:
        return False


def _new_col_ids(n_user_cols):
    return [UUID_SENTINEL] + [uuid.uuid4().hex for _ in range(n_user_cols)]

# ==================== 台账成员权限（原子化） ====================

PERMISSION_KEYS = [
    'data.view', 'data.edit', 'data.delete',
    'file.upload', 'file.download', 'qr.generate', 'export',
    'member.manage', 'member.approve', 'log.view',
]

PERM_LABELS = {
    'data.view': '查看数据',
    'data.edit': '编辑数据',
    'data.delete': '删除数据',
    'file.upload': '上传附件',
    'file.download': '下载附件',
    'qr.generate': '生成二维码',
    'export': '导出',
    'member.manage': '成员管理',
    'member.approve': '审批申请',
    'log.view': '查看日志',
}

PERM_COL_MAP = {
    'data.view': 'perm_data_view',
    'data.edit': 'perm_data_edit',
    'data.delete': 'perm_data_delete',
    'file.upload': 'perm_file_upload',
    'file.download': 'perm_file_download',
    'qr.generate': 'perm_qr_generate',
    'export': 'perm_export',
    'member.manage': 'perm_member_manage',
    'member.approve': 'perm_member_approve',
    'log.view': 'perm_log_view',
}

ROLE_LABELS = {
    'owner': '所有者',
    'manager': '管理者',
    'member': '成员',
}

# ==================== 系统级用户角色 / 组织 ====================
# 系统角色（与台账级 owner/manager/member 是两套，互不干扰）
SYS_ROLES = ['super_admin', 'admin', 'user']
SYS_ROLE_LABELS = {
    'super_admin': '超级管理员',
    'admin': '管理员',
    'user': '普通用户',
}
# 系统功能开关：管理员可对本组织成员授予/回收（默认全部允许）
FEATURE_KEYS = ['export', 'observatory', 'scan', 'offline_scan', 'file_upload']
FEATURE_LABELS = {
    'export': '导出数据',
    'observatory': '访问观测台',
    'scan': '扫码终端',
    'offline_scan': '离线扫码',
    'file_upload': '上传附件',
}

# 预设权限包
PRESET_PACKS = {
    'owner': {
        'label': '所有者（全权限）',
        'role': 'owner',
        'perms': {
            'data.view': 1, 'data.edit': 1, 'data.delete': 1,
            'file.upload': 1, 'file.download': 1, 'qr.generate': 1, 'export': 1,
            'member.manage': 1, 'member.approve': 1, 'log.view': 1,
        },
    },
    'manager': {
        'label': '管理者（编辑 + 成员管理 + 审批）',
        'role': 'manager',
        'perms': {
            'data.view': 1, 'data.edit': 1, 'data.delete': 1,
            'file.upload': 1, 'file.download': 1, 'qr.generate': 1, 'export': 1,
            'member.manage': 1, 'member.approve': 1, 'log.view': 1,
        },
    },
    'member_edit': {
        'label': '成员·可编辑（含导出、下载）',
        'role': 'member',
        'perms': {
            'data.view': 1, 'data.edit': 1,
            'file.download': 1, 'export': 1,
        },
    },
    'member_view': {
        'label': '成员·只读',
        'role': 'member',
        'perms': {
            'data.view': 1,
        },
    },
    'member_audit': {
        'label': '成员·审计（只读 + 日志）',
        'role': 'member',
        'perms': {
            'data.view': 1, 'log.view': 1,
        },
    },
    'custom': {
        'label': '自定义（逐项勾选）',
        'role': 'member',
        'perms': {},
    },
}


def _perms_from_row(row):
    """从 sqlite Row 提取权限字典（只返回值为 1 的键）"""
    out = {}
    for k, col in PERM_COL_MAP.items():
        try:
            v = row[col]
        except (KeyError, IndexError):
            v = 0
        out[k] = 1 if v else 0
    return out


def _member_role_label(role):
    return ROLE_LABELS.get(role, role or '')

# ============================================================
# JSON1 扩展探测（json_extract / json_each）
# ============================================================

_JSON1_AVAILABLE = None


def _check_json1():
    global _JSON1_AVAILABLE
    if _JSON1_AVAILABLE is not None:
        return _JSON1_AVAILABLE
    try:
        conn = _connect(LEDGER)
        try:
            conn.execute("SELECT json_extract('[]', '$[0]')").fetchone()
            _JSON1_AVAILABLE = True
        except sqlite3.OperationalError:
            _JSON1_AVAILABLE = False
        finally:
            conn.close()
    except Exception:
        _JSON1_AVAILABLE = False
    return _JSON1_AVAILABLE


# ============================================================
# 台账写队列（串行化 SQLite 写入）
# ============================================================

WRITE_QUEUE_MAXSIZE = 200
WRITE_CLIENT_TIMEOUT = 30

_write_queue = _queue.Queue(maxsize=WRITE_QUEUE_MAXSIZE)
_pending_lids = set()
_pending_lock = _threading.Lock()
_writer_thread = None
_writer_started = False


def _writer_loop():
    while True:
        task = _write_queue.get()
        if task is None:
            _write_queue.task_done()
            break
        try:
            result = _do_update_ledger(**task['kwargs'])
            try:
                task['future'].set_result(result)
            except Exception:
                pass
        except Exception as e:
            try:
                task['future'].set_exception(e)
            except Exception:
                pass
        finally:
            with _pending_lock:
                _pending_lids.discard(task['lid'])
            _write_queue.task_done()


def _ensure_writer_started():
    global _writer_thread, _writer_started
    if _writer_started:
        return
    with _pending_lock:
        if _writer_started:
            return
        t = _threading.Thread(target=_writer_loop, name='ledger-writer', daemon=True)
        t.start()
        _writer_thread = t
        _writer_started = True


def get_pending_ledgers():
    with _pending_lock:
        return sorted(_pending_lids)


def update_ledger(lid, name=None, data=None, teammates=None, viewers=None,
                  column_links=None, cell_links=None, column_ids=None,
                  column_options=None, charts=None, cell_actions=None,
                  expected_updated_at=None, username=None):
    _ensure_writer_started()

    try:
        lid_int = int(lid)
    except (TypeError, ValueError):
        return {'status': 'not_found'}

    with _pending_lock:
        if lid_int in _pending_lids:
            return {'status': 'busy',
                    'msg': '该台账正在保存，请稍后再试'}
        _pending_lids.add(lid_int)

    fut = _Future()
    task = {
        'lid': lid_int,
        'future': fut,
        'kwargs': {
            'lid': lid_int,
            'name': name,
            'data': data,
            'teammates': teammates,
            'viewers': viewers,
            'column_links': column_links,
            'cell_links': cell_links,
            'column_ids': column_ids,
            'column_options': column_options,
            'charts': charts,
            'cell_actions': cell_actions,
            'expected_updated_at': expected_updated_at,
            'username': username,
        },
    }
    try:
        _write_queue.put_nowait(task)
    except _queue.Full:
        with _pending_lock:
            _pending_lids.discard(lid_int)
        return {'status': 'busy',
                'msg': '服务器写入繁忙，请稍后再试'}

    try:
        return fut.result(timeout=WRITE_CLIENT_TIMEOUT)
    except _FutureTimeout:
        return {'status': 'busy',
                'msg': '保存超时，请稍后刷新查看结果'}
    except Exception as e:
        return {'status': 'error',
                'msg': str(e) or '写入失败'}


# ==================== 用户库 ====================

def init_LedgerEditor_db():
    conn = _connect(DATABASE)
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                username      TEXT    NOT NULL UNIQUE,
                password_hash TEXT    NOT NULL,
                status        TEXT    NOT NULL DEFAULT 'pending'
            );
            CREATE TABLE IF NOT EXISTS orgs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT    NOT NULL,
                parent_id  INTEGER DEFAULT NULL,
                created_at TEXT    NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES orgs(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgs_parent ON orgs(parent_id);
            CREATE TABLE IF NOT EXISTS user_features (
                username TEXT    NOT NULL,
                feature  TEXT    NOT NULL,
                enabled  INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (username, feature)
            );
        """)
        cols = [r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
        if 'status' not in cols:
            conn.execute(
                "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'"
            )
        if 'role' not in cols:
            conn.execute(
                "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"
            )
        if 'org_id' not in cols:
            conn.execute(
                "ALTER TABLE users ADD COLUMN org_id INTEGER DEFAULT NULL"
            )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id)")
        # 老库已有账号默认普通用户；root 强制超级管理员
        conn.execute("UPDATE users SET role='user' WHERE role IS NULL OR role=''")
        conn.execute("UPDATE users SET role='super_admin' WHERE username='root'")
        conn.commit()
    finally:
        conn.close()


def create_user(username, password, status='approved', role='user', org_id=None):
    conn = _connect(DATABASE)
    try:
        conn.execute(
            'INSERT INTO users (username, password_hash, status, role, org_id) '
            'VALUES (?, ?, ?, ?, ?)',
            (username, generate_password_hash(password), status, role, org_id)
        )
        conn.commit()
    finally:
        conn.close()


def register_user(username, password, org_id=None):
    if not username or len(username) < 2 or len(username) > 20:
        return False, '用户名长度需在 2-20 之间'
    if username == 'root':
        return False, '该用户名不可用'
    if not password or len(password) < 4:
        return False, '密码至少 4 位'
    conn = _connect(DATABASE)
    try:
        if conn.execute(
            "SELECT 1 FROM users WHERE username = ? LIMIT 1", (username,)
        ).fetchone():
            return False, '用户名已存在'
        if org_id is not None and not conn.execute(
            "SELECT 1 FROM orgs WHERE id=? LIMIT 1", (org_id,)
        ).fetchone():
            return False, '所属组织不存在'
        conn.execute(
            "INSERT INTO users (username, password_hash, status, role, org_id) "
            "VALUES (?, ?, 'pending', 'user', ?)",
            (username, generate_password_hash(password), org_id)
        )
        conn.commit()
        return True, '注册成功，等待管理员审批'
    finally:
        conn.close()


def seed_root():
    conn = _connect(DATABASE)
    try:
        row = conn.execute(
            "SELECT status FROM users WHERE username = 'root' LIMIT 1"
        ).fetchone()
    finally:
        conn.close()
    if row:
        if row[0] != 'approved':
            conn = _connect(DATABASE)
            try:
                conn.execute("UPDATE users SET status='approved' WHERE username='root'")
                conn.commit()
            finally:
                conn.close()
        print('管理员账户已存在')
        return
    create_user('root', 'admin_1qaz!QAZ', 'approved', role='super_admin')
    print('超级管理员账户已创建')


def login_check(username, password):
    conn = _connect(DATABASE)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT password_hash, status, role, org_id FROM users "
            "WHERE username = ? LIMIT 1", (username,)
        ).fetchone()
        if row is None:
            return 'bad'
        if not check_password_hash(row['password_hash'], password):
            return 'bad'
        if row['status'] != 'approved':
            return 'pending'
        return {'status': 'ok', 'role': row['role'] or 'user', 'org_id': row['org_id']}
    finally:
        conn.close()


def get_user_role(username):
    conn = _connect(DATABASE)
    try:
        row = conn.execute(
            "SELECT role, org_id FROM users WHERE username=? LIMIT 1", (username,)
        ).fetchone()
        if not row:
            return 'user', None
        return (row[0] or 'user'), row[1]
    finally:
        conn.close()


def list_users():
    conn = _connect(DATABASE)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT u.username, u.status, u.role, u.org_id, o.name AS org_name "
            "FROM users u LEFT JOIN orgs o ON u.org_id=o.id "
            "ORDER BY (u.username='root') DESC, u.username ASC"
        ).fetchall()
        return [{
            'username': r['username'], 'status': r['status'],
            'role': r['role'] or 'user', 'org_id': r['org_id'],
            'org_name': r['org_name'] or ''
        } for r in rows]
    finally:
        conn.close()


# ---------- 组织（树形） ----------
def list_orgs():
    conn = _connect(DATABASE)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, name, parent_id, created_at FROM orgs ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_org(org_id):
    conn = _connect(DATABASE)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT id, name, parent_id, created_at FROM orgs WHERE id=? LIMIT 1",
            (org_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_org(name, parent_id=None):
    name = str(name or '').strip()
    if not name or len(name) > 50:
        return False, '组织名称需在 1-50 字符', None
    conn = _connect(DATABASE)
    try:
        if parent_id is not None and not conn.execute(
            "SELECT 1 FROM orgs WHERE id=? LIMIT 1", (parent_id,)
        ).fetchone():
            return False, '上级组织不存在', None
        cur = conn.execute(
            "INSERT INTO orgs (name, parent_id, created_at) VALUES (?, ?, ?)",
            (name, parent_id, _now_str())
        )
        conn.commit()
        return True, '已创建', cur.lastrowid
    finally:
        conn.close()


def update_org(org_id, name=None, parent_id='__keep__'):
    conn = _connect(DATABASE)
    try:
        row = conn.execute("SELECT id, parent_id FROM orgs WHERE id=?", (org_id,)).fetchone()
        if not row:
            return False, '组织不存在'
        if name is not None:
            name = str(name).strip()
            if not name or len(name) > 50:
                return False, '组织名称需在 1-50 字符'
            conn.execute("UPDATE orgs SET name=? WHERE id=?", (name, org_id))
        if parent_id != '__keep__':
            # 防止把自己设为上级或形成环
            if parent_id is not None:
                if parent_id == org_id:
                    return False, '上级组织不能是自己'
                cur = parent_id
                seen = set()
                while cur is not None:
                    if cur == org_id or cur in seen:
                        return False, '上级组织不能是自己的下级'
                    seen.add(cur)
                    r = conn.execute("SELECT parent_id FROM orgs WHERE id=?", (cur,)).fetchone()
                    cur = r[0] if r else None
            conn.execute("UPDATE orgs SET parent_id=? WHERE id=?", (parent_id, org_id))
        conn.commit()
        return True, '已更新'
    finally:
        conn.close()


def delete_org(org_id):
    conn = _connect(DATABASE)
    try:
        if conn.execute("SELECT 1 FROM orgs WHERE id=?", (org_id,)).fetchone() is None:
            return False, '组织不存在'
        if conn.execute("SELECT 1 FROM orgs WHERE parent_id=? LIMIT 1", (org_id,)).fetchone():
            return False, '该组织下有子组织，请先移动或删除子组织'
        if conn.execute("SELECT 1 FROM users WHERE org_id=? LIMIT 1", (org_id,)).fetchone():
            return False, '该组织下仍有用户，请先移动用户'
        conn.execute("DELETE FROM orgs WHERE id=?", (org_id,))
        conn.commit()
        return True, '已删除'
    finally:
        conn.close()


def descendant_org_ids(org_id):
    """返回 org_id 及其所有后代组织的 id 列表（含自身）。"""
    conn = _connect(DATABASE)
    try:
        all_rows = conn.execute("SELECT id, parent_id FROM orgs").fetchall()
    finally:
        conn.close()
    children = {}
    for oid, pid in all_rows:
        children.setdefault(pid, []).append(oid)
    result, stack = [], [org_id]
    while stack:
        cur = stack.pop()
        result.append(cur)
        stack.extend(children.get(cur, []))
    return result


def users_in_org_scope(org_id):
    """管理员作用域内的用户名列表（本组织及所有下级）。org_id 为 None 时返回空。"""
    if org_id is None:
        return []
    ids = descendant_org_ids(org_id)
    conn = _connect(DATABASE)
    try:
        placeholders = ','.join('?' for _ in ids)
        rows = conn.execute(
            f"SELECT username FROM users WHERE org_id IN ({placeholders})", ids
        ).fetchall()
        return [r[0] for r in rows]
    finally:
        conn.close()


# ---------- 用户系统角色 / 所属组织 ----------
def set_user_role(username, role):
    if role not in SYS_ROLES:
        return False, '系统角色无效'
    if username == 'root' and role != 'super_admin':
        return False, '不能降级超级管理员 root'
    conn = _connect(DATABASE)
    try:
        cur = conn.execute("UPDATE users SET role=? WHERE username=?", (role, username))
        conn.commit()
        return (True, '已更新') if cur.rowcount else (False, '用户不存在')
    finally:
        conn.close()


def set_user_org(username, org_id):
    conn = _connect(DATABASE)
    try:
        if org_id is not None and not conn.execute(
            "SELECT 1 FROM orgs WHERE id=?", (org_id,)
        ).fetchone():
            return False, '组织不存在'
        cur = conn.execute("UPDATE users SET org_id=? WHERE username=?", (org_id, username))
        conn.commit()
        return (True, '已更新') if cur.rowcount else (False, '用户不存在')
    finally:
        conn.close()


# ---------- 系统功能开关 ----------
def get_user_features(username):
    """返回功能开关字典：默认全开，逐项被显式关闭时覆盖。"""
    result = {k: True for k in FEATURE_KEYS}
    conn = _connect(DATABASE)
    try:
        rows = conn.execute(
            "SELECT feature, enabled FROM user_features WHERE username=?", (username,)
        ).fetchall()
        for feature, enabled in rows:
            if feature in result:
                result[feature] = bool(enabled)
    finally:
        conn.close()
    return result


def set_user_feature(username, feature, enabled):
    if feature not in FEATURE_KEYS:
        return False, '功能项无效'
    conn = _connect(DATABASE)
    try:
        if not conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            return False, '用户不存在'
        conn.execute(
            "INSERT INTO user_features (username, feature, enabled) VALUES (?, ?, ?) "
            "ON CONFLICT(username, feature) DO UPDATE SET enabled=excluded.enabled",
            (username, feature, 1 if enabled else 0)
        )
        conn.commit()
        return True, '已更新'
    finally:
        conn.close()


def list_user_ledger_permissions(username):
    """返回指定用户在所有台账上的成员权限（含未参与的台账 id/name 供管理端选择）。"""
    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    try:
        ledgers = conn.execute(
            "SELECT id, ledger_name FROM ledgers ORDER BY id"
        ).fetchall()
        member_rows = conn.execute(
            "SELECT * FROM ledger_members WHERE username=?", (str(username),)
        ).fetchall()
        by_lid = {r['ledger_id']: r for r in member_rows}
        out = []
        for lg in ledgers:
            lid = lg['id']
            m = by_lid.get(lid)
            item = {
                'ledger_id': lid,
                'ledger_name': lg['ledger_name'],
                'role': m['role'] if m else None,
                'permissions': {},
            }
            if m:
                for k in PERMISSION_KEYS:
                    item['permissions'][k] = int(m[PERM_COL_MAP[k]] or 0)
            out.append(item)
        return out
    finally:
        conn.close()


def count_pending_users():
    conn = _connect(DATABASE)
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM users WHERE status = 'pending'"
        ).fetchone()
        return row[0] if row else 0
    finally:
        conn.close()


def approve_user(username):
    conn = _connect(DATABASE)
    try:
        row = conn.execute(
            "SELECT status FROM users WHERE username = ? LIMIT 1", (username,)
        ).fetchone()
        if not row:
            return False, '用户不存在'
        if row[0] == 'approved':
            return True, '该用户已是通过状态'
        conn.execute("UPDATE users SET status='approved' WHERE username = ?", (username,))
        conn.commit()
        return True, '已通过'
    finally:
        conn.close()


def delete_user(username):
    if username == 'root':
        return False, '不能删除 root'
    lconn = _connect(LEDGER)
    try:
        owned = lconn.execute(
            "SELECT id FROM ledgers WHERE owner = ? LIMIT 1", (username,)
        ).fetchone()
        if owned:
            return False, f'该用户名下仍有台账（id={owned[0]}），请先转移或删除台账'
    finally:
        lconn.close()
    conn = _connect(DATABASE)
    try:
        row = conn.execute(
            "SELECT 1 FROM users WHERE username = ? LIMIT 1", (username,)
        ).fetchone()
        if not row:
            return False, '用户不存在'
        conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()
    finally:
        conn.close()
    lconn = _connect(LEDGER)
    try:
        rows = lconn.execute("SELECT id, teammates, viewers FROM ledgers").fetchall()
        for lid, tm, vw in rows:
            mates = _safe_json(tm, [])
            views = _safe_json(vw, [])
            changed = False
            if isinstance(mates, list) and username in mates:
                mates = [m for m in mates if m != username]
                changed = True
            if isinstance(views, list) and username in views:
                views = [v for v in views if v != username]
                changed = True
            if changed:
                lconn.execute(
                    "UPDATE ledgers SET teammates = ?, viewers = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(mates, ensure_ascii=False),
                     json.dumps(views, ensure_ascii=False),
                     _now_str(), lid)
                )
        lconn.commit()
    finally:
        lconn.close()
    # ★ 清理成员关系和申请
    try:
        mconn = _connect(LEDGER)
        try:
            mconn.execute("DELETE FROM ledger_members WHERE username=?", (username,))
            mconn.execute(
                "UPDATE permission_requests SET status='cancelled' "
                "WHERE username=? AND status='pending'", (username,)
            )
            mconn.commit()
        finally:
            mconn.close()
    except Exception:
        pass
    return True, '已删除'

# ==================== 台账成员权限（函数） ====================

def init_member_db():
    conn = _connect(LEDGER)
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS ledger_members (
                ledger_id           INTEGER NOT NULL,
                username            TEXT    NOT NULL,
                role                TEXT    NOT NULL DEFAULT 'member',
                perm_data_view      INTEGER NOT NULL DEFAULT 0,
                perm_data_edit      INTEGER NOT NULL DEFAULT 0,
                perm_data_delete    INTEGER NOT NULL DEFAULT 0,
                perm_file_upload    INTEGER NOT NULL DEFAULT 0,
                perm_file_download  INTEGER NOT NULL DEFAULT 0,
                perm_qr_generate    INTEGER NOT NULL DEFAULT 0,
                perm_export         INTEGER NOT NULL DEFAULT 0,
                perm_member_manage  INTEGER NOT NULL DEFAULT 0,
                perm_member_approve INTEGER NOT NULL DEFAULT 0,
                perm_log_view       INTEGER NOT NULL DEFAULT 0,
                granted_by          TEXT    NOT NULL DEFAULT '',
                granted_at          TEXT    NOT NULL DEFAULT '',
                PRIMARY KEY (ledger_id, username)
            );
            CREATE INDEX IF NOT EXISTS idx_lm_user ON ledger_members(username);
            CREATE INDEX IF NOT EXISTS idx_lm_lid ON ledger_members(ledger_id);

            CREATE TABLE IF NOT EXISTS permission_requests (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                ledger_id     INTEGER NOT NULL,
                username      TEXT    NOT NULL,
                permission    TEXT    NOT NULL,
                reason        TEXT,
                status        TEXT    NOT NULL DEFAULT 'pending',
                requested_at  TEXT    NOT NULL,
                reviewed_by   TEXT,
                reviewed_at   TEXT,
                review_note   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_pr_lid_status
                ON permission_requests(ledger_id, status);
            CREATE INDEX IF NOT EXISTS idx_pr_user_status
                ON permission_requests(username, status);
        """)
        conn.commit()
    finally:
        conn.close()


def migrate_legacy_members():
    """把老 ledgers 表的 owner/teammates/viewers 迁移到 ledger_members。
       幂等：如果 ledger_members 已有该台账的记录就跳过该台账。
    """
    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, owner, teammates, viewers FROM ledgers"
        ).fetchall()

        now = _now_str()
        migrated_count = 0
        for r in rows:
            lid = r['id']
            has = conn.execute(
                "SELECT 1 FROM ledger_members WHERE ledger_id=? LIMIT 1", (lid,)
            ).fetchone()
            if has:
                continue

            owner = (r['owner'] or '').strip()
            mates = _safe_json(r['teammates'], [])
            views = _safe_json(r['viewers'], [])
            if not isinstance(mates, list): mates = []
            if not isinstance(views, list): views = []

            insert_rows = []
            if owner:
                p = PRESET_PACKS['owner']['perms']
                insert_rows.append((lid, owner, 'owner',
                    p.get('data.view',1), p.get('data.edit',1), p.get('data.delete',1),
                    p.get('file.upload',1), p.get('file.download',1),
                    p.get('qr.generate',1), p.get('export',1),
                    p.get('member.manage',1), p.get('member.approve',1),
                    p.get('log.view',1), 'system', now))

            # 老 teammates → member（编辑包）
            p_edit = PRESET_PACKS['member_edit']['perms']
            for u in mates:
                u = str(u or '').strip()
                if not u or u == owner:
                    continue
                insert_rows.append((lid, u, 'member',
                    p_edit.get('data.view',1), p_edit.get('data.edit',1), 0,
                    p_edit.get('file.upload',0), p_edit.get('file.download',1),
                    p_edit.get('qr.generate',0), p_edit.get('export',1),
                    0, 0, p_edit.get('log.view',0), 'migrate', now))

            # 老 viewers → member（只读包）
            p_view = PRESET_PACKS['member_view']['perms']
            for u in views:
                u = str(u or '').strip()
                if not u or u == owner:
                    continue
                if any(x[1] == u for x in insert_rows):
                    continue  # 既是 teammates 又是 viewers → 保留高权限
                insert_rows.append((lid, u, 'member',
                    p_view.get('data.view',1), 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    'migrate', now))

            for row in insert_rows:
                try:
                    conn.execute(
                        "INSERT OR IGNORE INTO ledger_members "
                        "(ledger_id, username, role, "
                        " perm_data_view, perm_data_edit, perm_data_delete, "
                        " perm_file_upload, perm_file_download, perm_qr_generate, "
                        " perm_export, perm_member_manage, perm_member_approve, "
                        " perm_log_view, granted_by, granted_at) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        row
                    )
                except sqlite3.Error as e:
                    print(f'[迁移] 台账 #{lid} 成员 {row[1]} 失败：{e}')
            migrated_count += 1

        conn.commit()
        if migrated_count > 0:
            print(f'[迁移] 已迁移 {migrated_count} 个台账的成员权限')
    finally:
        conn.close()


def get_ledger_member(lid, username):
    """返回单个成员的权限 dict，若无记录返回 None。"""
    if not lid or not username:
        return None
    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT * FROM ledger_members WHERE ledger_id=? AND username=? LIMIT 1",
            (int(lid), str(username))
        ).fetchone()
        if not row:
            return None
        d = {
            'username': row['username'],
            'role': row['role'],
            'granted_by': row['granted_by'],
            'granted_at': row['granted_at'],
        }
        d.update(_perms_from_row(row))
        return d
    finally:
        conn.close()


def list_ledger_members(lid):
    """返回台账的所有成员（含权限详情）。"""
    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT * FROM ledger_members WHERE ledger_id=? "
            "ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, "
            "         granted_at ASC",
            (int(lid),)
        ).fetchall()
        out = []
        for r in rows:
            d = {
                'username': r['username'],
                'role': r['role'],
                'granted_by': r['granted_by'],
                'granted_at': r['granted_at'],
            }
            d.update(_perms_from_row(r))
            out.append(d)
        return out
    finally:
        conn.close()


def count_ledger_managers(lid):
    conn = _connect(LEDGER)
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM ledger_members "
            "WHERE ledger_id=? AND role IN ('owner','manager')",
            (int(lid),)
        ).fetchone()
        return row[0] if row else 0
    finally:
        conn.close()


def has_permission(username, lid, perm):
    """检查用户对某台账是否有某权限。root 恒真。
       perm 必须是 PERMISSION_KEYS 之一。
    """
    if not username or not lid:
        return False
    if username == 'root':
        return True
    if perm not in PERM_COL_MAP:
        return False
    conn = _connect(LEDGER)
    try:
        col = PERM_COL_MAP[perm]
        row = conn.execute(
            f"SELECT {col} FROM ledger_members WHERE ledger_id=? AND username=? LIMIT 1",
            (int(lid), str(username))
        ).fetchone()
        return bool(row and row[0])
    finally:
        conn.close()


def get_user_permissions(username, lid):
    """返回权限字典（仅用户有权限的键 = 1）。root 返回全 1。"""
    if not username or not lid:
        return {}
    if username == 'root':
        return {k: 1 for k in PERMISSION_KEYS}
    m = get_ledger_member(lid, username)
    if not m:
        return {}
    return {k: m.get(k, 0) for k in PERMISSION_KEYS}


def set_ledger_member(lid, username, role, perms, granted_by):
    """新增或更新成员。perms 是 {perm_key: 0/1} 的字典。
       返回 (ok, msg)。
    """
    if not lid or not username:
        return False, '参数缺失'
    if role not in ('owner', 'manager', 'member'):
        return False, '角色无效'
    if role == 'owner':
        return False, 'owner 通过转让操作变更，不能直接设置'
    cols = ['ledger_id', 'username', 'role', 'granted_by', 'granted_at']
    vals = [int(lid), str(username), str(role), str(granted_by or ''), _now_str()]
    for k in PERMISSION_KEYS:
        cols.append(PERM_COL_MAP[k])
        vals.append(1 if (perms or {}).get(k) else 0)
    placeholders = ','.join(['?'] * len(cols))
    sql = (
        "INSERT OR REPLACE INTO ledger_members (" + ','.join(cols) + ") "
        "VALUES (" + placeholders + ")"
    )
    conn = _connect(LEDGER)
    try:
        conn.execute(sql, vals)
        conn.commit()
        return True, 'ok'
    except sqlite3.Error as e:
        return False, str(e)
    finally:
        conn.close()


def remove_ledger_member(lid, username):
    """删除成员（不能删 owner）。"""
    if not lid or not username:
        return False, '参数缺失'
    conn = _connect(LEDGER)
    try:
        row = conn.execute(
            "SELECT role FROM ledger_members WHERE ledger_id=? AND username=? LIMIT 1",
            (int(lid), str(username))
        ).fetchone()
        if not row:
            return False, '成员不存在'
        if row[0] == 'owner':
            return False, '不能删除所有者，请先转让'
        conn.execute(
            "DELETE FROM ledger_members WHERE ledger_id=? AND username=?",
            (int(lid), str(username))
        )
        conn.commit()
        return True, '已移除'
    finally:
        conn.close()


def transfer_owner(lid, new_owner, keep_grants=True, by_user='root'):
    """转让所有权。
       - keep_grants=True：原 owner 变 manager，保留全部权限
       - keep_grants=False：原 owner 降级为 member（只读包）
       - 现 owner 自动变 manager，保留权限
    """
    if not lid or not new_owner:
        return False, '参数缺失'
    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT owner FROM ledgers WHERE id=?", (int(lid),)
        ).fetchone()
        if not row:
            return False, '台账不存在'
        old_owner = row['owner']
        if old_owner == new_owner:
            return False, '已经是所有者'

        new_m = conn.execute(
            "SELECT 1 FROM ledger_members WHERE ledger_id=? AND username=? LIMIT 1",
            (int(lid), str(new_owner))
        ).fetchone()
        if not new_m:
            return False, '新所有者必须先成为该台账的成员'

        now = _now_str()

        # 1) 更新 ledgers.owner
        conn.execute(
            "UPDATE ledgers SET owner=?, updated_at=? WHERE id=?",
            (str(new_owner), now, int(lid))
        )

        # 2) 新 owner
        conn.execute(
            "UPDATE ledger_members SET role='owner', "
            "perm_data_view=1, perm_data_edit=1, perm_data_delete=1, "
            "perm_file_upload=1, perm_file_download=1, perm_qr_generate=1, "
            "perm_export=1, perm_member_manage=1, perm_member_approve=1, "
            "perm_log_view=1, granted_by=?, granted_at=? "
            "WHERE ledger_id=? AND username=?",
            (by_user, now, int(lid), str(new_owner))
        )

        # 3) 原 owner
        if keep_grants:
            conn.execute(
                "UPDATE ledger_members SET role='manager' "
                "WHERE ledger_id=? AND username=?",
                (int(lid), old_owner)
            )
        else:
            p = PRESET_PACKS['member_view']['perms']
            conn.execute(
                "UPDATE ledger_members SET role='member', "
                "perm_data_view=?, perm_data_edit=?, perm_data_delete=?, "
                "perm_file_upload=?, perm_file_download=?, perm_qr_generate=?, "
                "perm_export=?, perm_member_manage=?, perm_member_approve=?, "
                "perm_log_view=? "
                "WHERE ledger_id=? AND username=?",
                (p.get('data.view',1), 0, 0, 0, 0, 0, 0, 0, 0, 0,
                 int(lid), old_owner)
            )
        conn.commit()
        return True, '已转让'
    except sqlite3.Error as e:
        return False, str(e)
    finally:
        conn.close()


def revoke_all_by_manager(lid, manager_username):
    """撤销某 manager 授予的其他成员（不含 owner/其他 manager）。
       返回撤销的成员数量。
    """
    conn = _connect(LEDGER)
    try:
        cur = conn.execute(
            "DELETE FROM ledger_members "
            "WHERE ledger_id=? AND granted_by=? AND role='member'",
            (int(lid), str(manager_username))
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


# ----- 权限申请 -----

def create_permission_request(lid, username, permission, reason):
    if not lid or not username or not permission:
        return False, '参数缺失', None
    if permission not in PERM_COL_MAP:
        return False, '权限无效', None
    conn = _connect(LEDGER)
    try:
        has = conn.execute(
            "SELECT 1 FROM permission_requests "
            "WHERE ledger_id=? AND username=? AND permission=? AND status='pending' LIMIT 1",
            (int(lid), str(username), str(permission))
        ).fetchone()
        if has:
            return False, '已存在待审批的同权限申请', None
        cur = conn.execute(
            "INSERT INTO permission_requests "
            "(ledger_id, username, permission, reason, status, requested_at) "
            "VALUES (?, ?, ?, ?, 'pending', ?)",
            (int(lid), str(username), str(permission),
             str(reason or ''), _now_str())
        )
        conn.commit()
        return True, 'ok', cur.lastrowid
    finally:
        conn.close()


def list_permission_requests(lid=None, username=None, status=None,
                             limit=100, offset=0):
    try:
        limit = max(1, min(int(limit), 500))
    except (TypeError, ValueError):
        limit = 100
    try:
        offset = max(0, int(offset))
    except (TypeError, ValueError):
        offset = 0
    where, params = [], []
    if lid is not None:
        where.append("ledger_id = ?"); params.append(int(lid))
    if username:
        where.append("username = ?"); params.append(str(username))
    if status:
        where.append("status = ?"); params.append(str(status))
    sql_where = (" WHERE " + " AND ".join(where)) if where else ""
    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT * FROM permission_requests" + sql_where +
            " ORDER BY requested_at DESC LIMIT ? OFFSET ?",
            params + [limit, offset]
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_permission_request(req_id):
    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT * FROM permission_requests WHERE id=?", (int(req_id),)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def review_permission_request(req_id, reviewer, decision, note=''):
    """decision: 'approved' | 'rejected'"""
    if decision not in ('approved', 'rejected'):
        return False, '无效决定'
    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT * FROM permission_requests WHERE id=? LIMIT 1", (int(req_id),)
        ).fetchone()
        if not row:
            return False, '申请不存在'
        if row['status'] != 'pending':
            return False, '该申请已处理'
        if row['username'] == reviewer:
            return False, '不能审批自己的申请'

        now = _now_str()
        conn.execute(
            "UPDATE permission_requests SET status=?, reviewed_by=?, "
            "reviewed_at=?, review_note=? WHERE id=?",
            (str(decision), str(reviewer), now, str(note or ''), int(req_id))
        )
        conn.commit()

        if decision == 'approved':
            return True, '已批准', row['ledger_id'], row['username'], row['permission']
        return True, '已驳回', None, None, None
    except sqlite3.Error as e:
        return False, str(e), None, None, None
    finally:
        conn.close()


def cancel_permission_request(req_id, username):
    conn = _connect(LEDGER)
    try:
        cur = conn.execute(
            "UPDATE permission_requests SET status='cancelled' "
            "WHERE id=? AND username=? AND status='pending'",
            (int(req_id), str(username))
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def count_pending_requests_for_user(username):
    """某用户需要审批的台账里，pending 的数量（用于红点提醒）"""
    if not username:
        return 0
    conn = _connect(LEDGER)
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM permission_requests pr "
            "WHERE pr.status='pending' AND pr.username<>? "
            "AND EXISTS (SELECT 1 FROM ledger_members lm "
            "            WHERE lm.ledger_id=pr.ledger_id "
            "              AND lm.username=? "
            "              AND lm.perm_member_approve=1)",
            (str(username), str(username))
        ).fetchone()
        return row[0] if row else 0
    finally:
        conn.close()

# ==================== 审计日志异步队列 ====================

AUDIT_QUEUE_MAXSIZE = 5000
AUDIT_BATCH_SIZE = 100
AUDIT_FLUSH_INTERVAL = 0.5

_audit_queue = _queue.Queue(maxsize=AUDIT_QUEUE_MAXSIZE)
_audit_thread = None
_audit_started = False
_audit_lock = _threading.Lock()


class _AuditFlushRequest:
    __slots__ = ('future',)

    def __init__(self):
        self.future = _Future()


def _audit_writer_loop():
    conn = None
    pending = []
    last_flush = time.monotonic()

    def _open():
        nonlocal conn
        if conn is None:
            conn = _connect(DATABASE)
        return conn

    def _flush():
        nonlocal pending, conn
        if not pending:
            return
        batch = pending
        pending = []
        try:
            c = _open()
            c.executemany(
                "INSERT INTO audit_logs "
                "(created_at, username, action, target_type, target_id, "
                " target_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
                batch,
            )
            c.commit()
        except sqlite3.Error as e:
            print(f'[审计] 批量写入失败（丢弃 {len(batch)} 条）：{e}')
            try:
                if conn:
                    conn.close()
            except Exception:
                pass
            conn = None

    while True:
        try:
            item = _audit_queue.get(timeout=AUDIT_FLUSH_INTERVAL)
        except _queue.Empty:
            _flush()
            last_flush = time.monotonic()
            continue

        if item is None:
            _flush()
            _audit_queue.task_done()
            try:
                if conn:
                    conn.close()
            except Exception:
                pass
            return

        if isinstance(item, _AuditFlushRequest):
            _flush()
            try:
                item.future.set_result(True)
            except Exception:
                pass
            _audit_queue.task_done()
            last_flush = time.monotonic()
            continue

        pending.append(item)
        if (len(pending) >= AUDIT_BATCH_SIZE
                or (time.monotonic() - last_flush) >= AUDIT_FLUSH_INTERVAL):
            _flush()
            last_flush = time.monotonic()
        _audit_queue.task_done()


def _ensure_audit_writer_started():
    global _audit_thread, _audit_started
    if _audit_started:
        return
    with _audit_lock:
        if _audit_started:
            return
        t = _threading.Thread(target=_audit_writer_loop,
                              name='audit-writer', daemon=True)
        t.start()
        _audit_thread = t
        _audit_started = True


def _flush_audit_now(timeout=5.0):
    if not _audit_started:
        return
    req = _AuditFlushRequest()
    try:
        _audit_queue.put(req, timeout=timeout)
    except _queue.Full:
        return
    try:
        req.future.result(timeout=timeout)
    except Exception:
        pass


def add_audit_log(username, action, target_type=None, target_id=None,
                  target_name=None, detail=None):
    try:
        _ensure_audit_writer_started()
        _audit_queue.put_nowait((
            _now_str(),
            str(username or ''),
            str(action or ''),
            target_type,
            target_id,
            target_name,
            detail,
        ))
    except _queue.Full:
        print(f'[审计] 队列已满，丢弃一条：{action} {target_type} {target_id}')
    except Exception as e:
        print(f'[审计] 入队失败：{e}')


def init_audit_db():
    conn = _connect(DATABASE)
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS audit_logs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at  TEXT    NOT NULL,
                username    TEXT    NOT NULL,
                action      TEXT    NOT NULL,
                target_type TEXT,
                target_id   INTEGER,
                target_name TEXT,
                detail      TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
            CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
            -- 复合索引：覆盖「按用户 + 时间倒序」和「按操作 + 时间倒序」
            CREATE INDEX IF NOT EXISTS idx_audit_user_created
                ON audit_logs(username, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_action_created
                ON audit_logs(action, created_at DESC);
            -- 复合索引已覆盖单列 username，去掉冗余索引以减少写放大
            DROP INDEX IF EXISTS idx_audit_username;
        """)
        conn.commit()
    finally:
        conn.close()


def cleanup_audit_logs(days=90):
    conn = _connect(DATABASE)
    try:
        cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
        cur = conn.execute("DELETE FROM audit_logs WHERE created_at < ?", (cutoff,))
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def _audit_filter_sql(username=None, action=None):
    where, params = [], []
    if username:
        where.append("username = ?"); params.append(username)
    if action:
        where.append("action = ?"); params.append(action)
    sql = (" WHERE " + " AND ".join(where)) if where else ""
    return sql, params


def list_audit_logs(limit=50, offset=0, username=None, action=None):
    try:
        limit = max(1, min(int(limit), 500))
    except (TypeError, ValueError):
        limit = 50
    try:
        offset = max(0, int(offset))
    except (TypeError, ValueError):
        offset = 0
    where_sql, params = _audit_filter_sql(username, action)
    conn = _connect(DATABASE)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, created_at, username, action, target_type, "
            "       target_id, target_name, detail "
            "FROM audit_logs" + where_sql +
            " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
            params + [limit, offset]
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def count_audit_logs(username=None, action=None):
    where_sql, params = _audit_filter_sql(username, action)
    conn = _connect(DATABASE)
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM audit_logs" + where_sql, params
        ).fetchone()
        return row[0] if row else 0
    finally:
        conn.close()


def list_audit_actions():
    conn = _connect(DATABASE)
    try:
        rows = conn.execute(
            "SELECT DISTINCT action FROM audit_logs ORDER BY action ASC"
        ).fetchall()
        return [r[0] for r in rows if r and r[0]]
    finally:
        conn.close()


def clear_audit_logs():
    _flush_audit_now()
    conn = _connect(DATABASE)
    try:
        conn.execute("DELETE FROM audit_logs")
        conn.commit()
    finally:
        conn.close()


# ==================== 台账库 ====================

_LEDGER_SELECT_COLS = (
    "id, ledger_name, created_at, updated_at, owner, "
    "teammates, viewers, data, column_links, cell_links, "
    "column_ids, column_options, charts, cell_actions, allowed_file_types"
)

# light SELECT：data 列只取第一行（表头），不返回完整 data 大 JSON
_LEDGER_SELECT_COLS_LIGHT = (
    "id, ledger_name, created_at, updated_at, owner, "
    "teammates, viewers, "
    "json_extract(data, '$[0]') AS header_row, "
    "column_links, cell_links, column_ids, column_options, "
    "charts, cell_actions, allowed_file_types"
)


def init_ledger_db():
    conn = _connect(LEDGER)
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS ledgers (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                ledger_name    TEXT    NOT NULL,
                created_at     TEXT    NOT NULL,
                updated_at     TEXT    NOT NULL,
                owner          TEXT    NOT NULL,
                teammates      TEXT    NOT NULL DEFAULT '[]',
                viewers        TEXT    NOT NULL DEFAULT '[]',
                data           TEXT    NOT NULL DEFAULT '[]',
                column_links   TEXT    NOT NULL DEFAULT '{}',
                cell_links     TEXT    NOT NULL DEFAULT '{}',
                column_ids     TEXT    NOT NULL DEFAULT '[]',
                column_options TEXT    NOT NULL DEFAULT '{}',
                charts         TEXT    NOT NULL DEFAULT '[]',
                cell_actions   TEXT    NOT NULL DEFAULT '{}',
                allowed_file_types TEXT NOT NULL DEFAULT '[]'
            );
            -- owner 查询索引
            CREATE INDEX IF NOT EXISTS idx_ledgers_owner ON ledgers(owner);
        """)
        cols = [r[1] for r in conn.execute("PRAGMA table_info(ledgers)").fetchall()]
        allowed_default = json.dumps(DEFAULT_FILE_TYPES, ensure_ascii=False)
        for name, default in (
            ('column_links', "'{}'"),
            ('cell_links', "'{}'"),
            ('viewers', "'[]'"),
            ('column_ids', "'[]'"),
            ('column_options', "'{}'"),
            ('charts', "'[]'"),
            ('cell_actions', "'{}'"),
            ('allowed_file_types', "'" + allowed_default + "'"),
        ):
            if name not in cols:
                conn.execute(
                    f"ALTER TABLE ledgers ADD COLUMN {name} TEXT NOT NULL DEFAULT {default}"
                )
        conn.commit()

        has_row_ids = 'row_ids' in cols

        conn.row_factory = sqlite3.Row
        select_cols = "id, ledger_name, data, column_ids"
        if has_row_ids:
            select_cols += ", row_ids"
        rows = conn.execute(f"SELECT {select_cols} FROM ledgers").fetchall()
        conn.row_factory = None
        migrated = 0
        for row in rows:
            old_row_ids = []
            if has_row_ids:
                try:
                    old_row_ids = _safe_json(row['row_ids'], [])
                except (KeyError, IndexError):
                    old_row_ids = []
            if _migrate_ledger_to_uuid_column(conn, row, old_row_ids):
                migrated += 1
        conn.commit()

        if has_row_ids:
            try:
                conn.execute("ALTER TABLE ledgers DROP COLUMN row_ids")
                print('[迁移] 已删除 row_ids 列')
            except sqlite3.Error:
                print('[警告] 当前 SQLite 版本不支持 DROP COLUMN，row_ids 列保留但空置')

        if migrated:
            print(f'[迁移] 已完成 {migrated} 个台账到 uuid 内嵌格式')
    finally:
        conn.close()


def _migrate_ledger_to_uuid_column(conn, row, old_row_ids):
    lid = row['id']
    data = _safe_json(row['data'], [])
    column_ids = _safe_json(row['column_ids'], [])
    if not isinstance(data, list):
        data = []
    if not isinstance(column_ids, list):
        column_ids = []

    if data and isinstance(data[0], list) and len(data[0]) > 0 and data[0][0] == UUID_SENTINEL:
        return False

    if not data:
        new_data = [[UUID_SENTINEL]]
    else:
        first = data[0] if isinstance(data[0], list) else []
        new_data = [[UUID_SENTINEL] + first]
        for i in range(1, len(data)):
            src = data[i] if isinstance(data[i], list) else []
            if i - 1 < len(old_row_ids) and _valid_uuid(old_row_ids[i - 1]):
                u = old_row_ids[i - 1]
            else:
                u = uuid.uuid4().hex
            new_data.append([u] + src)

    ncols = len(new_data[0]) if new_data else 1
    new_cols = [UUID_SENTINEL]
    for cid in column_ids:
        if cid == UUID_SENTINEL:
            continue
        new_cols.append(cid if _valid_uuid(cid) else uuid.uuid4().hex)
    while len(new_cols) < ncols:
        new_cols.append(uuid.uuid4().hex)
    new_cols = new_cols[:ncols]
    new_cols[0] = UUID_SENTINEL

    conn.execute(
        "UPDATE ledgers SET data = ?, column_ids = ? WHERE id = ?",
        (json.dumps(new_data, ensure_ascii=False),
         json.dumps(new_cols, ensure_ascii=False),
         lid)
    )
    return True


def _row_to_ledger(row, with_data=True):
    lid = row['id']

    teammates = _safe_json(row['teammates'], [])
    viewers = _safe_json(row['viewers'], [])
    column_links = _safe_json(row['column_links'], {})
    cell_links = _safe_json(row['cell_links'], {})
    column_options = _safe_json(row['column_options'], {})
    charts = _safe_json(row['charts'], [])
    cell_actions = _safe_json(row['cell_actions'], {})
    allowed_file_types = _safe_json(row['allowed_file_types'], [])
    if not isinstance(allowed_file_types, list):
        allowed_file_types = []

    column_ids = _safe_json(row['column_ids'], [])
    if not isinstance(column_ids, list):
        column_ids = []

    d = {
        'id': lid,
        'name': row['ledger_name'],
        'created_at': row['created_at'],
        'updated_at': row['updated_at'],
        'owner': row['owner'],
        'teammates': teammates,
        'viewers': viewers,
        'column_links': column_links,
        'cell_links': cell_links,
        'column_ids': column_ids,
        'column_options': column_options,
        'charts': charts,
        'cell_actions': cell_actions,
        'allowed_file_types': allowed_file_types,
    }

    if not with_data:
        header = None
        try:
            hr = row['header_row']
        except (IndexError, KeyError):
            hr = None
        if hr is not None:
            try:
                parsed = json.loads(hr)
                if isinstance(parsed, list):
                    header = parsed
            except (json.JSONDecodeError, TypeError):
                header = None

        if header is None:
            try:
                data = _safe_json(row['data'], [])
            except (IndexError, KeyError):
                data = []
            if data and isinstance(data[0], list):
                header = data[0]

        if header and isinstance(header, list) and len(header) > 1:
            d['columns'] = [('' if v is None else str(v)) for v in header[1:]]
        else:
            d['columns'] = []
        return d

    data = _safe_json(row['data'], [])
    if not isinstance(data, list):
        data = []

    column_gids = [UUID_SENTINEL]
    for i, cid in enumerate(column_ids):
        if i == 0:
            continue
        cid = str(cid or '')
        ok = False
        if len(cid) >= 8:
            try:
                int(cid[:8], 16)
                column_gids.append(f"L{lid}_{cid[:8]}")
                ok = True
            except ValueError:
                pass
        if not ok:
            column_gids.append(f"L{lid}_c{i:02d}")

    row_gids = []
    for i in range(1, len(data)):
        data_row = data[i]
        u = ''
        if isinstance(data_row, list) and len(data_row) > 0 and _valid_uuid(data_row[0]):
            u = data_row[0]
        row_gids.append(f"L{lid}_{u}" if u else f"L{lid}_r{i:02d}")

    d['column_gids'] = column_gids
    d['row_gids'] = row_gids
    d['data'] = data
    return d


def create_ledger(ledger_name, owner, data=None, teammates=None, viewers=None,
                  column_links=None, cell_links=None, column_ids=None,
                  column_options=None, charts=None, cell_actions=None,
                  allowed_file_types=None):
    now = _now_str()
    if data is None or not isinstance(data, list) or not data:
        data = [['列1', '列2']]
    first = data[0] if isinstance(data[0], list) else []
    if not first or first[0] != UUID_SENTINEL:
        new_data = [[UUID_SENTINEL] + first]
        for i in range(1, len(data)):
            src = data[i] if isinstance(data[i], list) else []
            new_data.append([uuid.uuid4().hex] + src)
        data = new_data
    ncols = len(data[0])
    if column_ids is None or not isinstance(column_ids, list) or len(column_ids) != ncols:
        column_ids = [UUID_SENTINEL] + [uuid.uuid4().hex for _ in range(ncols - 1)]
    else:
        cleaned = [UUID_SENTINEL]
        for cid in column_ids[1:]:
            cleaned.append(cid if _valid_uuid(cid) else uuid.uuid4().hex)
        while len(cleaned) < ncols:
            cleaned.append(uuid.uuid4().hex)
        column_ids = cleaned[:ncols]

    teammates = teammates or []
    viewers = viewers or []
    column_links = column_links or {}
    cell_links = cell_links or {}
    column_options = column_options or {}
    charts = charts or []
    cell_actions = cell_actions or {}
    if allowed_file_types is None:
        allowed_file_types = list(DEFAULT_FILE_TYPES)

    conn = _connect(LEDGER)
    try:
        cur = conn.execute(
            """INSERT INTO ledgers
                   (ledger_name, created_at, updated_at, owner,
                    teammates, viewers, data, column_links, cell_links,
                    column_ids, column_options, charts, cell_actions,
                    allowed_file_types)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (ledger_name, now, now, owner,
             json.dumps(teammates, ensure_ascii=False),
             json.dumps(viewers, ensure_ascii=False),
             json.dumps(data, ensure_ascii=False),
             json.dumps(column_links, ensure_ascii=False),
             json.dumps(cell_links, ensure_ascii=False),
             json.dumps(column_ids, ensure_ascii=False),
             json.dumps(column_options, ensure_ascii=False),
             json.dumps(charts, ensure_ascii=False),
             json.dumps(cell_actions, ensure_ascii=False),
             json.dumps(allowed_file_types, ensure_ascii=False))
        )
        conn.commit()
        lid_new = cur.lastrowid
    finally:
        conn.close()

    # ★ 自动把 owner 写入 ledger_members
    # 注意：set_ledger_member() 拒绝直接设置 owner（owner 只能通过转让变更），
    # 所以这里必须直接 INSERT，不能用 set_ledger_member。
    try:
        p = PRESET_PACKS['owner']['perms']
        cols = ['ledger_id', 'username', 'role', 'granted_by', 'granted_at']
        vals = [int(lid_new), str(owner), 'owner', str(owner or ''), _now_str()]
        for k in PERMISSION_KEYS:
            cols.append(PERM_COL_MAP[k])
            vals.append(1 if p.get(k) else 0)
        ph = ','.join(['?'] * len(cols))
        conn = _connect(LEDGER)
        try:
            conn.execute(
                "INSERT OR REPLACE INTO ledger_members (" + ','.join(cols) + ") "
                "VALUES (" + ph + ")", vals
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        print(f'[create_ledger] 写入 owner 成员记录失败：{e}')
    return lid_new


# ==================== 演示数据（外部 JSON + 生成器） ====================

_DEMO_GENERATORS = {}


def _demo_generator(name):
    def _decorator(fn):
        _DEMO_GENERATORS[name] = fn
        return fn
    return _decorator


def _is_uuid_str(s):
    if not isinstance(s, str) or len(s) != 32:
        return False
    try:
        int(s, 16)
        return True
    except ValueError:
        return False


@_demo_generator('asset_rows')
def _gen_asset_rows(count, ctx):
    """生成资产台账行：数量列固定为 1，用于图表按「设备类型/状态/机房」分组计数。"""
    import random
    from datetime import datetime, timedelta

    rooms = ['A栋-101', 'A栋-102', 'B栋-201', 'B栋-202', 'C栋-301']
    owners = ['张工', '李工', '王工', '赵工', '孙工']
    brands_models = {
        '服务器': [('华为', 'RH2288 V5', 35000), ('华为', 'RH1288 V3', 22000),
                   ('戴尔', 'R740', 28000), ('戴尔', 'R640', 18000),
                   ('浪潮', 'NF5280M5', 32000), ('浪潮', 'NF5180M5', 20000)],
        '交换机': [('华为', 'S5735-L48', 8500), ('华为', 'S6730-H48', 25000),
                   ('思科', 'C9300-48P', 12000), ('思科', 'C9500-48Y4C', 38000)],
        '路由器': [('思科', 'ISR4331', 15000), ('华为', 'AR6120', 8000)],
        '存储': [('群晖', 'RS3618', 42000), ('群晖', 'RS1619', 58000),
                 ('华为', 'OceanStor 5300', 68000)],
        'UPS': [('山特', 'C10KS', 6800), ('山特', 'C6KS', 4200),
                ('APC', 'SUA3000', 7500)],
        '空调': [('艾默生', 'DME07', 12000), ('施耐德', 'PDU-10K', 15000)],
        '配电柜': [('正泰', 'GGD-1', 10000), ('施耐德', 'Prisma', 18000)],
        'KVM': [('Aten', 'CS1716', 5500), ('Avocent', 'MPU4032', 12000)],
        '防火墙': [('深信服', 'AF-1000', 45000)],
    }
    type_weights = [
        ('服务器', 0.40), ('交换机', 0.25), ('路由器', 0.10),
        ('存储', 0.05), ('UPS', 0.08), ('空调', 0.05),
        ('配电柜', 0.04), ('KVM', 0.02), ('防火墙', 0.01),
    ]

    def _pick_type():
        r = random.random()
        cum = 0.0
        for t, w in type_weights:
            cum += w
            if r < cum:
                return t
        return '服务器'

    def _pick_status():
        r = random.random()
        if r < 0.80:
            return '在用'
        if r < 0.90:
            return '闲置'
        if r < 0.98:
            return '维修中'
        return '报废'

    rows = []
    now = datetime.now()
    for i in range(1, count + 1):
        atype = _pick_type()
        brand, model, price = random.choice(brands_models[atype])
        room = random.choice(rooms)
        cabinet_num = random.randint(1, 20)
        cabinet = f'{room.split("-")[1]}-{cabinet_num:02d}'
        owner = random.choice(owners)
        status = _pick_status()

        days_ago = random.randint(30, 1095)
        purchase_dt = now - timedelta(days=days_ago)
        warranty_dt = purchase_dt + timedelta(days=1095)
        purchase = purchase_dt.strftime('%Y-%m-%d')
        warranty = warranty_dt.strftime('%Y-%m-%d')

        room_idx = rooms.index(room) + 1
        ip = f'10.{room_idx}.{cabinet_num}.{(i % 250) + 1}'

        rows.append([
            f'ASSET-{i:04d}',
            f'{atype[:2]}-{room.split("-")[1]}-{i:03d}',
            atype,
            brand,
            model,
            room,
            cabinet,
            ip,
            owner,
            status,
            '1',
            purchase,
            warranty,
            str(price),
            '查看',
            '查看',
        ])
    return rows


@_demo_generator('inventory_log_rows')
def _gen_inventory_log_rows(count, ctx):
    import random
    from datetime import datetime, timedelta

    assets = (ctx.get('asset_inventory') or {}).get('rows') or []
    if not assets:
        return []

    operators = ['张工', '李工', '王工', '赵工', '孙工']
    now = datetime.now()

    rows = []
    for i in range(1, count + 1):
        asset = random.choice(assets)
        is_inbound = random.random() < 0.4
        itype = '入库' if is_inbound else '出库'
        days_ago = random.randint(0, 365)
        date = (now - timedelta(days=days_ago)).strftime('%Y-%m-%d')
        num = random.randint(1, 3)
        operator = random.choice(operators)
        prefix = 'IN' if is_inbound else 'OUT'
        order_no = f'{prefix}-{date.replace("-", "")}-{i:04d}'
        rows.append([
            order_no,
            date,
            itype,
            asset[1],
            asset[2],
            str(num),
            operator,
            asset[0],
            '',
        ])
    return rows


@_demo_generator('monthly_stats_rows')
def _gen_monthly_stats_rows(count, ctx):
    from collections import defaultdict

    logs = (ctx.get('inventory_log') or {}).get('rows') or []
    if not logs:
        return []

    by_month = defaultdict(lambda: {'in': 0, 'out': 0})
    for log in logs:
        date_str = log[1]
        if len(date_str) < 7:
            continue
        month = date_str[:7]
        try:
            num = int(log[5])
        except (TypeError, ValueError):
            num = 0
        if log[2] == '入库':
            by_month[month]['in'] += num
        else:
            by_month[month]['out'] += num

    today = datetime.now()
    months = []
    for k in range(count - 1, -1, -1):
        y = today.year
        m = today.month - k
        while m <= 0:
            m += 12
            y -= 1
        months.append(f'{y:04d}-{m:02d}')

    rows = []
    for m in months:
        d = by_month.get(m, {'in': 0, 'out': 0})
        net = d['in'] - d['out']
        rows.append([m, str(d['in']), str(d['out']), str(net)])
    return rows


@_demo_generator('inspection_log_rows')
def _gen_inspection_log_rows(count, ctx):
    import random
    from datetime import datetime, timedelta

    assets = (ctx.get('asset_inventory') or {}).get('rows') or []
    if not assets:
        return []

    operators = ['张工', '李工', '王工', '赵工', '孙工']
    results_weighted = [
        ('正常', 0.85), ('温度过高', 0.05), ('网络异常', 0.04),
        ('硬盘告警', 0.03), ('电源异常', 0.03),
    ]
    descriptions = {
        '温度过高': lambda: f'机房温度 {random.randint(28, 38)}℃ 超标',
        '网络异常': lambda: f'丢包率 {random.randint(2, 15)}%',
        '硬盘告警': lambda: f'磁盘 {random.choice(["sda", "sdb", "nvme0n1"])} 告警',
        '电源异常': lambda: '冗余电源一路失联',
    }

    now = datetime.now()
    rows = []
    for i in range(1, count + 1):
        asset = random.choice(assets)
        days_ago = random.randint(0, 30)
        hours_ago = random.randint(0, 23)
        minutes_ago = random.randint(0, 59)
        t = now - timedelta(days=days_ago, hours=hours_ago, minutes=minutes_ago)
        ts = t.strftime('%Y-%m-%d %H:%M:%S')

        r = random.random()
        cum = 0.0
        result = '正常'
        for label, w in results_weighted:
            cum += w
            if r < cum:
                result = label
                break

        desc = ''
        if result != '正常':
            fn = descriptions.get(result)
            if fn:
                desc = fn()

        rows.append([
            ts,
            random.choice(operators),
            asset[1],
            asset[5],
            asset[6],
            result,
            desc,
            asset[0],
        ])
    return rows


@_demo_generator('overview_rows')
def _gen_overview_rows(count, ctx):
    assets = (ctx.get('asset_inventory') or {}).get('rows') or []

    types_order = ['服务器', '交换机', '路由器', '存储', 'UPS',
                   '空调', '配电柜', 'KVM', '防火墙']
    total_all = len(assets)

    by_type = {}
    for r in assets:
        atype = r[2] if len(r) > 2 else ''
        status = r[9] if len(r) > 9 else ''
        if atype not in by_type:
            by_type[atype] = {'total': 0, '在用': 0, '闲置': 0, '维修中': 0, '报废': 0}
        by_type[atype]['total'] += 1
        if status in ('在用', '闲置', '维修中', '报废'):
            by_type[atype][status] += 1

    rows = []
    for t in types_order:
        d = by_type.get(t, {'total': 0, '在用': 0, '闲置': 0, '维修中': 0, '报废': 0})
        pct = round(d['total'] / total_all * 100, 1) if total_all else 0
        rows.append([
            t,
            str(d['total']),
            str(d['在用']),
            str(d['闲置']),
            str(d['维修中']),
            str(d['报废']),
            f'{pct}%',
            '查看',
        ])
    return rows


def _resolve_demo_col_refs(cfg, ledger_meta):
    headers = ledger_meta['headers']
    col_ids = ledger_meta['col_ids']

    def _name_to_uuid(name):
        try:
            idx = headers.index(name)
        except ValueError:
            return None
        return col_ids[idx + 1]

    for item in cfg.get('display', []) or []:
        ref = item.get('col')
        if ref and not _is_uuid_str(ref):
            u = _name_to_uuid(ref)
            if u:
                item['col'] = u

    for act in cfg.get('actions', []) or []:
        ref = act.get('col')
        if ref and not _is_uuid_str(ref):
            u = _name_to_uuid(ref)
            if u:
                act['col'] = u

    log = cfg.get('append_log') or {}
    fields = log.get('fields') or {}
    for k, v in list(fields.items()):
        if isinstance(v, str) and v.startswith('$col:'):
            ref = v[5:]
            if not _is_uuid_str(ref):
                u = _name_to_uuid(ref)
                if u:
                    fields[k] = '$col:' + u
    return cfg


def _load_demo_data():
    import os
    from path_helper import resource_path as _rp

    candidates = []
    try:
        candidates.append(_rp('demo_data.json'))
    except Exception:
        pass
    candidates.append(data_path('demo_data.json'))

    for path in candidates:
        if not path or not os.path.exists(path):
            continue
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f), path
        except (OSError, json.JSONDecodeError) as e:
            print(f'[示例] 读取 {path} 失败：{e}')
    return None, None


def seed_example_ledgers():
    import uuid as _uuid

    TOP_NAME = '数据中心总览'

    conn = _connect(LEDGER)
    try:
        top = conn.execute(
            "SELECT id FROM ledgers WHERE ledger_name = ? LIMIT 1", (TOP_NAME,)
        ).fetchone()
    finally:
        conn.close()
    if top:
        print(f'[示例] 演示台账组已存在（顶层 id={top[0]}），跳过台账创建')
        try:
            _try_ensure_demo_apps_after_skip()
        except Exception as e:
            print(f'[示例] 扫码应用检查失败：{e}')
        return

    demo, path = _load_demo_data()
    if not demo:
        print('[示例] 未找到 demo_data.json（或解析失败），跳过演示数据创建')
        print('[示例] 提示：把 demo_data.json 放到程序同级目录后重启即可')
        return

    print(f'[示例] 使用演示数据文件：{path}')

    ledgers_def = demo.get('ledgers') or {}
    if not ledgers_def:
        print('[示例] demo_data.json 中 ledgers 为空，跳过')
        return

    created = {}
    ctx = {}
    for key, defn in ledgers_def.items():
        headers = list(defn.get('headers') or [])
        if not headers:
            print(f'[示例] 跳过 {key}：headers 为空')
            continue

        n_cols = len(headers) + 1
        col_ids = [UUID_SENTINEL] + [_uuid.uuid4().hex for _ in range(n_cols - 1)]

        raw_rows = defn.get('rows')
        if raw_rows is not None and isinstance(raw_rows, list) and raw_rows:
            rows = raw_rows
        elif defn.get('generate'):
            gen_name = defn['generate'].get('type')
            gen_count = int(defn['generate'].get('count') or 0)
            fn = _DEMO_GENERATORS.get(gen_name)
            if not fn:
                print(f'[示例] 跳过 {key}：未知生成器 {gen_name}')
                continue
            try:
                rows = fn(gen_count, ctx)
            except Exception as e:
                print(f'[示例] 生成 {key} 失败：{e}')
                continue
        else:
            rows = []

        data = [[UUID_SENTINEL] + list(headers)]
        for r in rows:
            data.append([_uuid.uuid4().hex] + [('' if v is None else str(v)) for v in r])

        options = {}
        for col_name, opts in (defn.get('options') or {}).items():
            if col_name in headers:
                col_idx = headers.index(col_name) + 1
                options[col_ids[col_idx]] = list(opts)

        charts = []
        for ch in defn.get('charts') or []:
            cat_name = ch.get('cat_col')
            val_name = ch.get('val_col')
            if cat_name not in headers or val_name not in headers:
                continue
            cat_idx = headers.index(cat_name) + 1
            val_idx = headers.index(val_name) + 1
            # ★ 支持 aggregate / topN（缺省 = 不聚合 / 不截断）
            agg = ch.get('aggregate', 'none')
            if agg not in ('none', 'sum', 'avg', 'count'):
                agg = 'none'
            try:
                top_n = max(0, min(int(ch.get('topN', 0) or 0), 200))
            except (TypeError, ValueError):
                top_n = 0
            charts.append({
                'id': _uuid.uuid4().hex,
                'type': ch.get('type', 'bar'),
                'title': ch.get('title', '图表'),
                'config': {
                    'catColId': col_ids[cat_idx],
                    'valColId': col_ids[val_idx],
                    'aggregate': agg,
                    'topN': top_n,
                },
            })

        lid = create_ledger(
            defn.get('name') or key,
            'root',
            data,
            teammates=['张工', '李工', '王工'],
            column_ids=col_ids,
            column_options=options,
            charts=charts,
        )
        created[key] = {
            'lid': lid,
            'name': defn.get('name') or key,
            'headers': headers,
            'col_ids': col_ids,
        }
        ctx[key] = {'rows': rows}
        print(f'[示例] 创建台账「{created[key]["name"]}」'
              f'(# {lid}, {len(headers)} 列, {len(rows)} 行)')

    links_by_src = {}

    def _resolve_row_count(src_key):
        n = len(ctx.get(src_key, {}).get('rows') or [])
        if n == 0 and src_key in created:
            try:
                ledger = get_ledger_by_id(created[src_key]['lid'])
                n = max(0, len(ledger.get('data') or []) - 1)
            except Exception:
                n = 0
        return n

    def _apply_link(src_key, tgt_key, col_name, row):
        if src_key not in created or tgt_key not in created:
            return
        if not col_name:
            return
        src = created[src_key]
        try:
            col_idx = src['headers'].index(col_name) + 1
        except ValueError:
            print(f'[示例] 跳过链接：{src_key} 没有表头「{col_name}」')
            return
        col_id = src['col_ids'][col_idx]
        tgt_lid = created[tgt_key]['lid']
        d = links_by_src.setdefault(src_key, {})
        if row is not None:
            d[f'{row}:{col_id}'] = tgt_lid
        else:
            n = _resolve_row_count(src_key)
            for r in range(1, n + 1):
                d[f'{r}:{col_id}'] = tgt_lid

    for link in demo.get('links') or []:
        _apply_link(link.get('from'), link.get('to'),
                    link.get('col'), link.get('row'))

    for auto in demo.get('auto_links') or []:
        _apply_link(auto.get('from'), auto.get('to'),
                    auto.get('col'), None)

    for src_key, links in links_by_src.items():
        src = created[src_key]
        existing = {}
        try:
            existing = get_ledger_by_id(src['lid']).get('cell_links') or {}
        except Exception:
            pass
        existing.update(links)
        r = update_ledger(src['lid'], cell_links=existing, username='root')
        if r.get('status') == 'ok':
            print(f'[示例] 关联：{src["name"]} → {len(links)} 条 cell_links')
        else:
            print(f'[示例] ⚠ 关联失败：{src["name"]} {r}')

    try:
        _write_scan_apps_from_demo(demo, created)
    except Exception as e:
        print(f'[示例] 扫码应用初始化失败：{e}')

    print(f'[示例] 演示数据创建完成：{len(created)} 本台账（含多层关联）')


def _try_ensure_demo_apps_after_skip():
    demo, _ = _load_demo_data()
    if not demo:
        return
    name_to_lid = {}
    conn = _connect(LEDGER)
    try:
        rows = conn.execute(
            "SELECT id, ledger_name FROM ledgers"
        ).fetchall()
        for lid, name in rows:
            name_to_lid[name] = lid
    finally:
        conn.close()

    created = {}
    for key, defn in (demo.get('ledgers') or {}).items():
        lid = name_to_lid.get(defn.get('name') or key)
        if not lid:
            continue
        ledger = get_ledger_by_id(lid)
        if not ledger:
            continue
        data = ledger.get('data') or []
        headers = data[0][1:] if data and len(data[0]) > 1 else []
        col_ids = ledger.get('column_ids') or []
        created[key] = {
            'lid': lid,
            'name': defn.get('name') or key,
            'headers': headers,
            'col_ids': col_ids,
        }

    if created:
        _write_scan_apps_from_demo(demo, created)


def _write_scan_apps_from_demo(demo, created):
    import os
    from path_helper import data_path as _dp

    app_dir = _dp('scan_apps')
    os.makedirs(app_dir, exist_ok=True)

    for app_id, cfg in (demo.get('scan_apps') or {}).items():
        if not app_id:
            continue
        app_path = os.path.join(app_dir, f'{app_id}.json')
        if os.path.exists(app_path):
            print(f'[示例] 扫码应用已存在，跳过：{app_path}')
            continue

        cfg = json.loads(json.dumps(cfg, ensure_ascii=False))

        lid_key = cfg.get('ledger_id')
        if lid_key in created:
            cfg['ledger_id'] = created[lid_key]['lid']
            _resolve_demo_col_refs(cfg, created[lid_key])
        else:
            print(f'[示例] 跳过 {app_id}：目标台账 {lid_key} 不存在')
            continue

        log = cfg.get('append_log') or {}
        log_key = log.get('ledger_id')
        if log_key is not None:
            if log_key in created:
                log['ledger_id'] = created[log_key]['lid']
            else:
                print(f'[示例] {app_id}: append_log 目标 {log_key} 不存在，禁用 append_log')
                cfg['append_log'] = {'enabled': False}

        try:
            with open(app_path, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
            print(f'[示例] 扫码应用已写入：{app_path}')
        except OSError as e:
            print(f'[示例] 写 {app_path} 失败：{e}')


def get_ledger_by_id(lid):
    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT " + _LEDGER_SELECT_COLS + " FROM ledgers WHERE id = ? LIMIT 1",
            (lid,)
        ).fetchone()
        return None if row is None else _row_to_ledger(row, with_data=True)
    finally:
        conn.close()


def list_ledgers():
    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    try:
        select = _LEDGER_SELECT_COLS_LIGHT if _JSON1_AVAILABLE else _LEDGER_SELECT_COLS
        rows = conn.execute(
            "SELECT " + select + " FROM ledgers ORDER BY id ASC"
        ).fetchall()
        return [_row_to_ledger(r, with_data=False) for r in rows]
    finally:
        conn.close()


def list_ledgers_for_user(username, light=False):
    if not username:
        return []
    if username == 'root':
        return list_ledgers()

    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    try:
        select = _LEDGER_SELECT_COLS_LIGHT if _JSON1_AVAILABLE else _LEDGER_SELECT_COLS
        rows = conn.execute(
            "SELECT " + select + " FROM ledgers "
            "WHERE id IN (SELECT ledger_id FROM ledger_members "
            "             WHERE username=? AND perm_data_view=1) "
            "ORDER BY id ASC",
            (str(username),)
        ).fetchall()
        return [_row_to_ledger(r, with_data=False) for r in rows]
    finally:
        conn.close()


def get_ledger_stats_for_user(username):
    """返回用户可查看（data.view）的台账摘要列表，供态势大屏使用。

    每项包含：id / name / owner / created_at / updated_at /
    row_count / col_count / columns（列名列表）。
    """
    if not username:
        return []

    visible = list_ledgers_for_user(username, light=True)
    if not visible:
        return []

    ids = [lg['id'] for lg in visible]
    placeholders = ','.join('?' for _ in ids)

    conn = _connect(LEDGER)
    conn.row_factory = sqlite3.Row
    out = []
    try:
        rows = conn.execute(
            "SELECT id, ledger_name, created_at, updated_at, owner, data "
            "FROM ledgers WHERE id IN (" + placeholders + ")",
            tuple(ids)
        ).fetchall()
        by_id = {r['id']: r for r in rows}
    finally:
        conn.close()

    for lid in ids:
        r = by_id.get(lid)
        if not r:
            continue
        data = _safe_json(r['data'], [])
        if not isinstance(data, list):
            data = []
        header = data[0] if data and isinstance(data[0], list) else []
        columns = [('' if v is None else str(v)) for v in header[1:]]
        out.append({
            'id': lid,
            'name': r['ledger_name'],
            'owner': r['owner'],
            'created_at': r['created_at'],
            'updated_at': r['updated_at'],
            'row_count': max(0, len(data) - 1),
            'col_count': len(columns),
            'columns': columns,
        })
    return out


def _extract_data_uuids(data):
    out = []
    for i in range(1, len(data)):
        r = data[i]
        if isinstance(r, list) and len(r) > 0 and _valid_uuid(r[0]):
            out.append(r[0])
    return out


def _do_update_ledger(lid, name=None, data=None, teammates=None, viewers=None,
                      column_links=None, cell_links=None, column_ids=None,
                      column_options=None, charts=None, cell_actions=None,
                      expected_updated_at=None, username=None):
    conn = _connect(LEDGER)
    conn.execute("ATTACH DATABASE ? AS archive", (ARCHIVE,))
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT id, updated_at, data, column_ids, ledger_name "
            "FROM ledgers WHERE id = ? LIMIT 1", (lid,)
        ).fetchone()
        if row is None:
            return {'status': 'not_found'}

        if expected_updated_at is not None and row['updated_at'] != expected_updated_at:
            return {'status': 'conflict', 'current_updated_at': row['updated_at']}

        archived_count = 0
        if data is not None:
            old_data = _safe_json(row['data'], [])
            old_cols = _safe_json(row['column_ids'], [])
            old_name = row['ledger_name']
            old_uuids = _extract_data_uuids(old_data)
            new_uuids = set(_extract_data_uuids(data))
            old_headers = old_data[0][1:] if old_data and len(old_data[0]) > 1 else []
            old_cols_sliced = old_cols[1:] if isinstance(old_cols, list) and len(old_cols) > 1 else []
            for i, old_uuid in enumerate(old_uuids):
                if old_uuid in new_uuids:
                    continue
                old_row = old_data[i + 1] if i + 1 < len(old_data) else []
                cells = old_row[1:] if isinstance(old_row, list) else []
                row_gid = f"L{lid}_{old_uuid}"
                try:
                    conn.execute(
                        "INSERT OR IGNORE INTO archive.archived_rows "
                        "(original_ledger_id, original_ledger_name, row_uuid, row_gid, "
                        " row_index, cells_json, column_headers, column_ids, "
                        " deleted_by, deleted_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (lid, old_name, old_uuid, row_gid, i + 1,
                         json.dumps(cells, ensure_ascii=False),
                         json.dumps(old_headers, ensure_ascii=False),
                         json.dumps(old_cols_sliced, ensure_ascii=False),
                         username or '', _now_str())
                    )
                    archived_count += 1
                except sqlite3.Error as e:
                    print(f'[归档警告] 行 {old_uuid}: {e}')

        sets, params = [], []
        if name is not None:
            sets.append("ledger_name = ?"); params.append(name)
        if data is not None:
            sets.append("data = ?"); params.append(json.dumps(data, ensure_ascii=False))
        if teammates is not None:
            sets.append("teammates = ?"); params.append(json.dumps(teammates, ensure_ascii=False))
        if viewers is not None:
            sets.append("viewers = ?"); params.append(json.dumps(viewers, ensure_ascii=False))
        if column_links is not None:
            sets.append("column_links = ?"); params.append(json.dumps(column_links, ensure_ascii=False))
        if cell_links is not None:
            sets.append("cell_links = ?"); params.append(json.dumps(cell_links, ensure_ascii=False))
        if column_ids is not None:
            sets.append("column_ids = ?"); params.append(json.dumps(column_ids, ensure_ascii=False))
        if column_options is not None:
            sets.append("column_options = ?"); params.append(json.dumps(column_options, ensure_ascii=False))
        if charts is not None:
            sets.append("charts = ?"); params.append(json.dumps(charts, ensure_ascii=False))
        if cell_actions is not None:
            sets.append("cell_actions = ?"); params.append(json.dumps(cell_actions, ensure_ascii=False))
        sets.append("updated_at = ?"); params.append(_now_str())
        params.append(lid)

        if expected_updated_at is not None:
            sql = "UPDATE ledgers SET " + ", ".join(sets) + " WHERE id = ? AND updated_at = ?"
            params.append(expected_updated_at)
        else:
            sql = "UPDATE ledgers SET " + ", ".join(sets) + " WHERE id = ?"

        cur = conn.execute(sql, params)
        conn.commit()
        if cur.rowcount == 0:
            return {'status': 'conflict'}

        updated = conn.execute(
            "SELECT " + _LEDGER_SELECT_COLS + " FROM ledgers WHERE id = ? LIMIT 1",
            (lid,)
        ).fetchone()
        return {'status': 'ok',
                'ledger': _row_to_ledger(updated, with_data=True),
                'archived_count': archived_count}
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def update_allowed_file_types(lid, types):
    conn = _connect(LEDGER)
    try:
        cur = conn.execute(
            "UPDATE ledgers SET allowed_file_types=? WHERE id=?",
            (json.dumps(types, ensure_ascii=False), lid)
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_ledger(lid):
    conn = _connect(LEDGER)
    # ★ 清理成员和权限申请
    try:
        conn.execute("DELETE FROM ledger_members WHERE ledger_id=?", (lid,))
        conn.execute("DELETE FROM permission_requests WHERE ledger_id=?", (lid,))
    except sqlite3.Error:
        pass
    try:
        cur = conn.execute("DELETE FROM ledgers WHERE id = ?", (lid,))
        if cur.rowcount > 0:
            rows = conn.execute(
                "SELECT id, cell_links, column_links FROM ledgers"
            ).fetchall()
            for rid, cl_json, col_json in rows:
                cell_links = _safe_json(cl_json, {})
                column_links = _safe_json(col_json, {})
                changed = False
                for k in list(cell_links.keys()):
                    if cell_links[k] == lid:
                        del cell_links[k]; changed = True
                for k in list(column_links.keys()):
                    if column_links[k] == lid:
                        del column_links[k]; changed = True
                if changed:
                    conn.execute(
                        "UPDATE ledgers SET cell_links = ?, column_links = ?, updated_at = ? WHERE id = ?",
                        (json.dumps(cell_links, ensure_ascii=False),
                         json.dumps(column_links, ensure_ascii=False),
                         _now_str(), rid)
                    )
        conn.commit()
        if cur.rowcount > 0:
            try:
                delete_files_by_ledger(lid)
            except Exception:
                pass
        return cur.rowcount > 0
    finally:
        conn.close()


# ==================== 归档库 ====================

def init_archive_db():
    conn = _connect(ARCHIVE)
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS archived_rows (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                original_ledger_id   INTEGER NOT NULL,
                original_ledger_name TEXT    NOT NULL,
                row_uuid             TEXT    NOT NULL UNIQUE,
                row_gid              TEXT    NOT NULL UNIQUE,
                row_index            INTEGER NOT NULL,
                cells_json           TEXT    NOT NULL,
                column_headers       TEXT    NOT NULL,
                column_ids           TEXT    NOT NULL,
                deleted_by           TEXT    NOT NULL,
                deleted_at           TEXT    NOT NULL,
                is_restored          INTEGER NOT NULL DEFAULT 0,
                restored_at          TEXT,
                restored_to_index    INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_arch_gid ON archived_rows(row_gid);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_arch_uuid ON archived_rows(row_uuid);
            CREATE INDEX IF NOT EXISTS idx_arch_ledger ON archived_rows(original_ledger_id);
            CREATE INDEX IF NOT EXISTS idx_arch_deleted_at ON archived_rows(deleted_at);
        """)
        conn.commit()
    finally:
        conn.close()


def list_archived_rows(username, ledger_id=None, limit=100, offset=0,
                       include_restored=False):
    allowed_ids = None
    if username != 'root':
        lconn = _connect(LEDGER)
        try:
            ids = [r[0] for r in lconn.execute(
                "SELECT id FROM ledgers WHERE owner = ?", (username,)
            ).fetchall()]
            allowed_ids = set(ids)
            if not allowed_ids:
                return []
        finally:
            lconn.close()
    try:
        limit = max(1, min(int(limit), 500))
    except (TypeError, ValueError):
        limit = 100
    try:
        offset = max(0, int(offset))
    except (TypeError, ValueError):
        offset = 0

    conn = _connect(ARCHIVE)
    conn.row_factory = sqlite3.Row
    try:
        where, params = [], []
        if ledger_id is not None:
            where.append("original_ledger_id = ?"); params.append(ledger_id)
        if not include_restored:
            where.append("is_restored = 0")
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        rows = conn.execute(
            "SELECT * FROM archived_rows" + where_sql +
            " ORDER BY deleted_at DESC LIMIT ? OFFSET ?",
            params + [limit, offset]
        ).fetchall()
        out = []
        for r in rows:
            if allowed_ids is not None and r['original_ledger_id'] not in allowed_ids:
                continue
            out.append({
                'id': r['id'],
                'original_ledger_id': r['original_ledger_id'],
                'original_ledger_name': r['original_ledger_name'],
                'row_uuid': r['row_uuid'],
                'row_gid': r['row_gid'],
                'row_index': r['row_index'],
                'cells': _safe_json(r['cells_json'], []),
                'column_headers': _safe_json(r['column_headers'], []),
                'column_ids': _safe_json(r['column_ids'], []),
                'deleted_by': r['deleted_by'],
                'deleted_at': r['deleted_at'],
                'is_restored': r['is_restored'],
                'restored_at': r['restored_at'],
                'restored_to_index': r['restored_to_index'],
            })
        return out
    finally:
        conn.close()


def count_archived_rows(username, ledger_id=None, include_restored=False):
    allowed_ids = None
    if username != 'root':
        lconn = _connect(LEDGER)
        try:
            ids = [r[0] for r in lconn.execute(
                "SELECT id FROM ledgers WHERE owner = ?", (username,)
            ).fetchall()]
            allowed_ids = set(ids)
            if not allowed_ids:
                return 0
        finally:
            lconn.close()

    conn = _connect(ARCHIVE)
    try:
        where, params = [], []
        if ledger_id is not None:
            where.append("original_ledger_id = ?"); params.append(ledger_id)
        if not include_restored:
            where.append("is_restored = 0")
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        rows = conn.execute(
            "SELECT original_ledger_id, COUNT(*) FROM archived_rows" + where_sql +
            " GROUP BY original_ledger_id", params
        ).fetchall()
        total = 0
        for lid, cnt in rows:
            if allowed_ids is None or lid in allowed_ids:
                total += cnt
        return total
    finally:
        conn.close()


def restore_archived_row(archive_id, username):
    conn = _connect(ARCHIVE)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT * FROM archived_rows WHERE id = ? AND is_restored = 0 LIMIT 1",
            (archive_id,)
        ).fetchone()
        if not row:
            return False, '归档不存在或已恢复'
        a = dict(row)
    finally:
        conn.close()

    ledger = get_ledger_by_id(a['original_ledger_id'])
    if not ledger:
        return False, '原台账已不存在，无法恢复'
    if username != 'root' and ledger.get('owner') != username:
        return False, '只有原台账创建者或 root 可以恢复'

    data = ledger.get('data') or [[UUID_SENTINEL]]
    if not data:
        data = [[UUID_SENTINEL]]
    existing_uuids = set(_extract_data_uuids(data))
    if a['row_uuid'] in existing_uuids:
        return False, '该行 ID 已在活动台账中存在（异常状态）'

    old_col_ids = _safe_json(a['column_ids'], [])
    old_cells = _safe_json(a['cells_json'], [])
    old_headers = _safe_json(a['column_headers'], [])

    new_col_ids = ledger.get('column_ids') or []
    new_data = ledger.get('data') or []
    if new_data and isinstance(new_data[0], list) and len(new_data[0]) > 1:
        new_headers = [('' if v is None else str(v)) for v in new_data[0][1:]]
    else:
        new_headers = []

    cell_by_cid = {}
    for i, cid in enumerate(old_col_ids):
        if i < len(old_cells):
            cell_by_cid[cid] = old_cells[i]

    cell_by_header = {}
    for i, h in enumerate(old_headers):
        if i < len(old_cells):
            name = str(h or '').strip()
            if name and name not in cell_by_header:
                cell_by_header[name] = old_cells[i]

    new_cells = [a['row_uuid']]
    for idx, cid in enumerate(new_col_ids[1:]):
        val = None
        if cid in cell_by_cid:
            val = cell_by_cid[cid]
        else:
            name = str(new_headers[idx] or '').strip() if idx < len(new_headers) else ''
            if name and name in cell_by_header:
                val = cell_by_header[name]
            elif idx < len(old_cells):
                val = old_cells[idx]
        if val is None:
            val = ''
        new_cells.append(val)

    insert_pos = a['row_index']
    if insert_pos < 1:
        insert_pos = 1
    if insert_pos > len(data):
        insert_pos = len(data)
    data.insert(insert_pos, new_cells)

    result = update_ledger(
        a['original_ledger_id'],
        data=data,
        expected_updated_at=ledger.get('updated_at'),
        username=username,
    )
    if result.get('status') == 'busy':
        return False, result.get('msg') or '该台账正在保存，请稍后再试'
    if result.get('status') == 'conflict':
        return False, '该台账刚被修改，请重新尝试恢复'
    if result.get('status') != 'ok':
        return False, '恢复失败：' + str(result.get('msg') or result.get('status'))

    aconn = _connect(ARCHIVE)
    try:
        aconn.execute(
            "UPDATE archived_rows SET is_restored=1, restored_at=?, restored_to_index=? WHERE id=?",
            (_now_str(), insert_pos, archive_id)
        )
        aconn.commit()
    finally:
        aconn.close()
    return True, f'已恢复到第 {insert_pos} 行'


# ==================== 扫码 ====================

def scan_gid(gid, username):
    if not isinstance(gid, str):
        return {'status': 'invalid'}
    m = re.match(r'^L(\d+)_([0-9a-f]{32})$', gid.strip(), re.IGNORECASE)
    if not m:
        return {'status': 'invalid'}
    lid = int(m.group(1))
    uuid_full = m.group(2).lower()

    ledger = get_ledger_by_id(lid)
    if ledger:
        data = ledger.get('data') or []
        for i in range(1, len(data)):
            r = data[i]
            if isinstance(r, list) and len(r) > 0 and r[0] == uuid_full:
                if not _can_access_ledger(username, ledger):
                    return {'status': 'forbidden',
                            'ledger_id': lid, 'ledger_name': ledger.get('name')}
                headers = data[0][1:] if data and len(data[0]) > 1 else []
                return {
                    'status': 'active',
                    'ledger_id': lid,
                    'ledger_name': ledger.get('name'),
                    'row_uuid': uuid_full,
                    'row_gid': f"L{lid}_{uuid_full}",
                    'row_index': i,
                    'cells': r[1:],
                    'column_headers': headers,
                }

    aconn = _connect(ARCHIVE)
    aconn.row_factory = sqlite3.Row
    try:
        row = aconn.execute(
            "SELECT * FROM archived_rows WHERE row_gid = ? LIMIT 1",
            (f"L{lid}_{uuid_full}",)
        ).fetchone()
        if row:
            a = dict(row)
            orig = get_ledger_by_id(a['original_ledger_id'])

            if orig is None:
                return {
                    'status': 'ledger_deleted',
                    'ledger_id': a['original_ledger_id'],
                    'ledger_name': a['original_ledger_name'],
                    'row_gid': a['row_gid'],
                    'deleted_at': a['deleted_at'],
                    'message': '该二维码所属台账已被删除，数据不可访问',
                }

            if not _can_access_ledger(username, orig):
                return {'status': 'forbidden',
                        'ledger_id': a['original_ledger_id'],
                        'ledger_name': a['original_ledger_name']}

            return {
                'status': 'archived',
                'ledger_id': a['original_ledger_id'],
                'ledger_name': a['original_ledger_name'],
                'row_uuid': a['row_uuid'],
                'row_gid': a['row_gid'],
                'cells': _safe_json(a['cells_json'], []),
                'column_headers': _safe_json(a['column_headers'], []),
                'deleted_by': a['deleted_by'],
                'deleted_at': a['deleted_at'],
                'is_restored': bool(a['is_restored']),
            }
    finally:
        aconn.close()
    return {'status': 'not_found'}


def _can_access_ledger(username, ledger):
    if not username or not ledger:
        return False
    if username == 'root':
        return True
    if ledger.get('owner') == username:
        return True
    if username in (ledger.get('teammates') or []):
        return True
    if username in (ledger.get('viewers') or []):
        return True
    return False


# ==================== 附件库 ====================

def init_file_db():
    conn = _connect(FILE_DB)
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS files (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ledger_id   INTEGER NOT NULL,
                filename    TEXT    NOT NULL,
                mime_type   TEXT,
                ext         TEXT    NOT NULL,
                size        INTEGER NOT NULL,
                sha256      TEXT,
                content     BLOB    NOT NULL,
                uploader    TEXT    NOT NULL,
                created_at  TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_files_ledger ON files(ledger_id);
            CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader);
        """)
        conn.commit()
    finally:
        conn.close()


def get_ledger_file_usage(lid):
    conn = _connect(FILE_DB)
    try:
        row = conn.execute(
            "SELECT COALESCE(SUM(size),0), COUNT(*) FROM files WHERE ledger_id=?",
            (lid,)
        ).fetchone()
        return (row[0] or 0, row[1] or 0)
    finally:
        conn.close()


def list_files(lid):
    conn = _connect(FILE_DB)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, ledger_id, filename, mime_type, ext, size, "
            "       sha256, uploader, created_at "
            "FROM files WHERE ledger_id=? ORDER BY id ASC", (lid,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_file_meta(fid):
    conn = _connect(FILE_DB)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT id, ledger_id, filename, mime_type, ext, size, "
            "       sha256, uploader, created_at "
            "FROM files WHERE id=? LIMIT 1", (fid,)
        ).fetchone()
        return None if row is None else dict(row)
    finally:
        conn.close()


def get_file_content(fid):
    conn = _connect(FILE_DB)
    try:
        row = conn.execute(
            "SELECT content FROM files WHERE id=? LIMIT 1", (fid,)
        ).fetchone()
        if row is None:
            return None
        return row[0]
    finally:
        conn.close()


FILE_DOWNLOAD_CHUNK = 64 * 1024


def iter_file_chunks(fid):
    conn = _connect(FILE_DB)
    try:
        row = conn.execute(
            "SELECT rowid, size FROM files WHERE id=? LIMIT 1", (fid,)
        ).fetchone()
        if not row:
            return
        rowid, size = row[0], row[1] or 0

        if hasattr(conn, 'blobopen'):
            try:
                with conn.blobopen("files", "content", rowid,
                                   readonly=True) as blob:
                    while True:
                        chunk = blob.read(FILE_DOWNLOAD_CHUNK)
                        if not chunk:
                            return
                        yield chunk
                return
            except (sqlite3.Error, OSError) as e:
                print(f'[文件下载] blobopen 不可用，回退一次性读取：{e}')

        row2 = conn.execute(
            "SELECT content FROM files WHERE id=? LIMIT 1", (fid,)
        ).fetchone()
        if row2 and row2[0] is not None:
            data = row2[0]
            if isinstance(data, memoryview):
                data = data.tobytes()
            for i in range(0, len(data), FILE_DOWNLOAD_CHUNK):
                yield data[i:i + FILE_DOWNLOAD_CHUNK]
    finally:
        conn.close()


def add_file(lid, filename, mime_type, ext, size, sha256, content, uploader):
    if size > MAX_FILE_SIZE:
        return False, '文件过大，请压缩至 100M 以下', None, 'too_large'
    conn = _connect(FILE_DB)
    old_iso = conn.isolation_level
    conn.isolation_level = None
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT COALESCE(SUM(size),0), COUNT(*) FROM files WHERE ledger_id=?",
            (lid,)
        ).fetchone()
        total, cnt = (row[0] or 0), (row[1] or 0)
        if cnt >= MAX_LEDGER_FILE_COUNT:
            conn.execute("ROLLBACK")
            return False, f'该台账附件数量已达上限（{MAX_LEDGER_FILE_COUNT} 个）', None, 'too_many'
        if total + size > MAX_LEDGER_FILE_TOTAL:
            conn.execute("ROLLBACK")
            return False, '该台账附件总容量已满（2GB）', None, 'too_large_total'
        cur = conn.execute(
            "INSERT INTO files "
            "(ledger_id, filename, mime_type, ext, size, sha256, content, uploader, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (lid, filename, mime_type, ext, size, sha256,
             sqlite3.Binary(content), uploader, _now_str())
        )
        conn.execute("COMMIT")
        return True, '上传成功', cur.lastrowid, 'ok'
    except sqlite3.Error as e:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        return False, f'数据库错误：{e}', None, 'db_error'
    finally:
        conn.isolation_level = old_iso
        conn.close()


def delete_file(fid):
    conn = _connect(FILE_DB)
    try:
        cur = conn.execute("DELETE FROM files WHERE id=?", (fid,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_files_by_ledger(lid):
    conn = _connect(FILE_DB)
    try:
        cur = conn.execute("DELETE FROM files WHERE ledger_id=?", (lid,))
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def cleanup_orphan_files():
    lconn = _connect(LEDGER)
    try:
        valid = {r[0] for r in lconn.execute("SELECT id FROM ledgers").fetchall()}
    finally:
        lconn.close()
    fconn = _connect(FILE_DB)
    try:
        rows = fconn.execute("SELECT DISTINCT ledger_id FROM files").fetchall()
        orphan = [r[0] for r in rows if r[0] not in valid]
        if orphan:
            fconn.executemany("DELETE FROM files WHERE ledger_id=?", [(i,) for i in orphan])
            fconn.commit()
        return len(orphan)
    finally:
        fconn.close()


# ==================== 扫码：动作值解析 / 子台账校验 ====================

def resolve_action_value(action, override=None):
    if not isinstance(action, dict):
        return ''
    vt = str(action.get('value_type') or 'fixed').lower()
    if vt == 'fixed':
        if override is not None:
            return override
        return action.get('value') or ''
    now = datetime.now()
    if vt == 'now':
        return now.strftime('%Y-%m-%d %H:%M:%S')
    if vt == 'today':
        return now.strftime('%Y-%m-%d')
    if vt == 'time':
        return now.strftime('%H:%M:%S')
    return action.get('value') or ''


def is_child_ledger(parent_lid, child_lid):
    if not parent_lid or not child_lid:
        return False
    try:
        parent_lid = int(parent_lid)
        child_lid = int(child_lid)
    except (TypeError, ValueError):
        return False
    if parent_lid == child_lid:
        return False
    parent = get_ledger_by_id(parent_lid)
    if not parent:
        return False
    links = parent.get('cell_links') or {}
    if not isinstance(links, dict):
        return False
    for v in links.values():
        try:
            if int(v) == child_lid:
                return True
        except (TypeError, ValueError):
            continue
    return False


# ==================== 离线扫码日志库 ====================
#
# 用途：记录「离线扫码 → JSON 文件 → 联网后上传」过程中的每一条记录。
#  - 上传是幂等的：通过 UNIQUE(batch_id, gid, action_id, scanned_at)
#    约束自动跳过已入库的记录。
#  - status: 'ok'（已写入台账）/ 'failed'（写入失败）
#  - error_msg: 失败原因（权限不足、二维码无效、动作不存在等）
# ============================================================

def init_offline_db():
    conn = _connect(OFFLINE)
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS offline_scan_uploads (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id      TEXT    NOT NULL,
                client_uuid   TEXT    NOT NULL,
                app_id        TEXT    NOT NULL,
                gid           TEXT    NOT NULL,
                action_id     TEXT,
                action_value  TEXT,
                scanned_at    TEXT    NOT NULL,
                uploaded_at   TEXT    NOT NULL,
                uploaded_by   TEXT    NOT NULL,
                status        TEXT    NOT NULL,
                error_msg     TEXT,
                ledger_id     INTEGER,
                row_uuid      TEXT,
                UNIQUE(batch_id, gid, action_id, scanned_at)
            );
            CREATE INDEX IF NOT EXISTS idx_off_app  ON offline_scan_uploads(app_id);
            CREATE INDEX IF NOT EXISTS idx_off_user ON offline_scan_uploads(uploaded_by);
            CREATE INDEX IF NOT EXISTS idx_off_time ON offline_scan_uploads(uploaded_at);
            CREATE INDEX IF NOT EXISTS idx_off_batch ON offline_scan_uploads(batch_id);
        """)
        conn.commit()
    finally:
        conn.close()


def add_offline_scan_upload(batch_id, client_uuid, app_id, gid,
                            action_id, action_value, scanned_at,
                            uploaded_by, status, error_msg=None,
                            ledger_id=None, row_uuid=None):
    """写入/更新离线扫码上传日志。使用 INSERT OR REPLACE：
       - 第一次上传：新增记录
       - 同一批次重复上传同一行：覆盖原记录（便于失败重试后状态刷新）
    """
    if not batch_id or not app_id or not gid:
        return False, 'invalid'
    conn = _connect(OFFLINE)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO offline_scan_uploads "
            "(batch_id, client_uuid, app_id, gid, action_id, action_value, "
            " scanned_at, uploaded_at, uploaded_by, status, error_msg, "
            " ledger_id, row_uuid) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(batch_id), str(client_uuid or ''), str(app_id), str(gid),
                str(action_id) if action_id is not None else None,
                str(action_value) if action_value is not None else None,
                str(scanned_at or _now_str()),
                _now_str(),
                str(uploaded_by or ''),
                str(status or 'ok'),
                str(error_msg) if error_msg else None,
                int(ledger_id) if ledger_id is not None else None,
                str(row_uuid) if row_uuid else None,
            )
        )
        conn.commit()
        return True, 'ok'
    except sqlite3.Error as e:
        return False, str(e)
    finally:
        conn.close()


def list_offline_scan_uploads(batch_id=None, app_id=None, uploaded_by=None,
                              status=None, limit=100, offset=0):
    try:
        limit = max(1, min(int(limit), 500))
    except (TypeError, ValueError):
        limit = 100
    try:
        offset = max(0, int(offset))
    except (TypeError, ValueError):
        offset = 0

    where, params = [], []
    if batch_id:
        where.append("batch_id = ?"); params.append(str(batch_id))
    if app_id:
        where.append("app_id = ?"); params.append(str(app_id))
    if uploaded_by:
        where.append("uploaded_by = ?"); params.append(str(uploaded_by))
    if status:
        where.append("status = ?"); params.append(str(status))
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    conn = _connect(OFFLINE)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT * FROM offline_scan_uploads" + where_sql +
            " ORDER BY id DESC LIMIT ? OFFSET ?",
            params + [limit, offset]
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def count_offline_scan_uploads(batch_id=None, app_id=None,
                               uploaded_by=None, status=None):
    where, params = [], []
    if batch_id:
        where.append("batch_id = ?"); params.append(str(batch_id))
    if app_id:
        where.append("app_id = ?"); params.append(str(app_id))
    if uploaded_by:
        where.append("uploaded_by = ?"); params.append(str(uploaded_by))
    if status:
        where.append("status = ?"); params.append(str(status))
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    conn = _connect(OFFLINE)
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM offline_scan_uploads" + where_sql, params
        ).fetchone()
        return row[0] if row else 0
    finally:
        conn.close()


def check_offline_exists(batch_id, gid, action_id, scanned_at):
    """查询某条离线记录是否已上传过，返回 status（'ok' / 'failed'）或 None。
       用于上传前判断「已成功过的不再重复执行 action」。
    """
    if not batch_id or not gid:
        return None
    conn = _connect(OFFLINE)
    try:
        row = conn.execute(
            "SELECT status FROM offline_scan_uploads "
            "WHERE batch_id=? AND gid=? AND action_id=? AND scanned_at=? "
            "LIMIT 1",
            (
                str(batch_id), str(gid),
                str(action_id) if action_id is not None else '',
                str(scanned_at or ''),
            )
        ).fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def cleanup_offline_uploads(days=180):
    """清理过旧的离线扫码上传日志（默认保留 180 天）。"""
    conn = _connect(OFFLINE)
    try:
        cutoff = (datetime.now() - timedelta(days=days)).strftime(
            "%Y-%m-%d %H:%M:%S"
        )
        cur = conn.execute(
            "DELETE FROM offline_scan_uploads WHERE uploaded_at < ?", (cutoff,)
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


# ==================== 启动时初始化（幂等） ====================

init_LedgerEditor_db()
seed_root()
init_member_db()          # ★ 成员权限表
init_audit_db()
init_archive_db()
init_ledger_db()
migrate_legacy_members()  # ★ 老数据迁移
# 探测 JSON1 扩展（决定 light SELECT 与 WHERE 过滤）
_check_json1()
print(f'[SQLite] JSON1 扩展：{"可用" if _JSON1_AVAILABLE else "不可用（回退到全表扫描）"}')
seed_example_ledgers()
cleanup_audit_logs(days=90)
init_file_db()
_orphan = cleanup_orphan_files()
if _orphan:
    print(f'[附件库] 已清理孤儿附件所属台账：{_orphan} 个')
init_offline_db()
_off_cleaned = cleanup_offline_uploads(days=180)
if _off_cleaned:
    print(f'[离线库] 已清理 {_off_cleaned} 条过期离线扫码日志')