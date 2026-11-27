"""UseAsset.py —— 资产管理独立数据层（Asset.db）
表：assets / shipments / lifecycle / attachments / cf_config / loc_config
约定沿用 UseSqlite：WAL、busy_timeout、CREATE TABLE IF NOT EXISTS + ALTER 幂等迁移。
"""
import os
import json
import sqlite3
from datetime import datetime

from path_helper import data_path

ASSET_DB = data_path('Asset.db')
ATTACH_DIR = data_path('asset_attachments')


def _now():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _connect():
    conn = sqlite3.connect(ASSET_DB, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA synchronous=NORMAL')
        conn.execute('PRAGMA busy_timeout=10000')
    except sqlite3.Error:
        pass
    return conn


def _jdump(v):
    return json.dumps(v or {}, ensure_ascii=False)


def _jload(s, fallback):
    try:
        out = json.loads(s or 'null')
        return out if isinstance(out, type(fallback)) else fallback
    except Exception:
        return fallback


def init_asset_db():
    os.makedirs(ATTACH_DIR, exist_ok=True)
    conn = _connect()
    try:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS assets (
            code TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            org TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT '',
            in_type TEXT NOT NULL DEFAULT '采购入库',
            location TEXT NOT NULL DEFAULT '',
            operator TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            date TEXT NOT NULL DEFAULT '',
            custom TEXT NOT NULL DEFAULT '{}',
            loc_values TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner);
        CREATE TABLE IF NOT EXISTS shipments (
            id TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT '',
            from_user TEXT NOT NULL,
            from_org TEXT NOT NULL DEFAULT '',
            from_operator TEXT NOT NULL DEFAULT '',
            to_user TEXT NOT NULL,
            to_org TEXT NOT NULL DEFAULT '',
            date TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            custom_values TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            received_at TEXT DEFAULT '',
            received_by TEXT DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_ship_to ON shipments(to_user, status);
        CREATE INDEX IF NOT EXISTS idx_ship_from ON shipments(from_user);
        CREATE TABLE IF NOT EXISTS lifecycle (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_code TEXT NOT NULL,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            time TEXT NOT NULL,
            place TEXT NOT NULL DEFAULT '',
            from_who TEXT NOT NULL DEFAULT '',
            to_who TEXT NOT NULL DEFAULT '',
            person TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            changes TEXT NOT NULL DEFAULT '[]',
            ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_life_asset ON lifecycle(asset_code, ts);
        CREATE TABLE IF NOT EXISTS attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_type TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime TEXT NOT NULL DEFAULT '',
            size INTEGER NOT NULL DEFAULT 0,
            path TEXT NOT NULL,
            uploader TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_att_owner ON attachments(owner_type, owner_id);
        CREATE TABLE IF NOT EXISTS cf_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL DEFAULT 'text',
            options TEXT NOT NULL DEFAULT '[]',
            required INTEGER NOT NULL DEFAULT 0,
            apply TEXT NOT NULL DEFAULT 'all'
        );
        CREATE TABLE IF NOT EXISTS loc_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'text',
            UNIQUE(kind, name)
        );
        ''')
        # 默认位置（仅在首次初始化时写入）
        if conn.execute('SELECT COUNT(*) FROM loc_config WHERE kind="location"').fetchone()[0] == 0:
            for name in ['A机房-01柜', 'A机房-03柜', '核心机房-08柜', '灾备机房-02柜', '仓库']:
                conn.execute('INSERT INTO loc_config (kind, name, type) VALUES (?,?,?)', ('location', name, 'text'))
        conn.commit()
    finally:
        conn.close()


def _row_asset(r):
    if not r:
        return None
    d = dict(r)
    d['custom'] = _jload(d.get('custom'), {})
    d['locValues'] = _jload(d.get('loc_values'), {})
    d.pop('loc_values', None)
    return d


def list_assets(owner):
    conn = _connect()
    try:
        rows = conn.execute('SELECT * FROM assets WHERE owner=? ORDER BY created_at DESC', (owner,)).fetchall()
        return [_row_asset(r) for r in rows]
    finally:
        conn.close()


def get_asset(code, owner=None):
    conn = _connect()
    try:
        if owner is None:
            r = conn.execute('SELECT * FROM assets WHERE code=?', (code,)).fetchone()
        else:
            r = conn.execute('SELECT * FROM assets WHERE code=? AND owner=?', (code, owner)).fetchone()
        return _row_asset(r)
    finally:
        conn.close()


def create_asset(data, owner):
    now = _now()
    conn = _connect()
    try:
        conn.execute('''INSERT INTO assets
            (code, owner, org, name, type, in_type, location, operator, source, date, custom, loc_values, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
            data['code'], owner, data.get('org', ''), data['name'], data.get('type', ''),
            data.get('in_type', '采购入库'), data.get('location', ''), data.get('operator', ''),
            data.get('source', ''), data.get('date', ''), _jdump(data.get('custom')),
            _jdump(data.get('loc_values')), now, now))
        conn.commit()
    finally:
        conn.close()
    return get_asset(data['code'], owner)


def update_asset(code, owner, changes):
    allowed = {'name', 'org', 'type', 'location', 'operator', 'source', 'date', 'custom', 'loc_values'}
    fields = []
    vals = []
    for k, v in changes.items():
        if k not in allowed:
            continue
        fields.append(k + '=?')
        vals.append(_jdump(v) if k in ('custom', 'loc_values') else (v or ''))
    if not fields:
        return get_asset(code, owner)
    fields.append('updated_at=?')
    vals.append(_now())
    vals.extend([code, owner])
    conn = _connect()
    try:
        conn.execute('UPDATE assets SET ' + ','.join(fields) + ' WHERE code=? AND owner=?', vals)
        conn.commit()
    finally:
        conn.close()
    return get_asset(code, owner)


def delete_asset(code, owner, keep_lifecycle=False):
    """删除资产。keep_lifecycle=True 时保留流转历史（用于出库在途场景）。"""
    conn = _connect()
    try:
        n = conn.execute('DELETE FROM assets WHERE code=? AND owner=?', (code, owner)).rowcount
        conn.execute('DELETE FROM attachments WHERE owner_type=? AND owner_id=?', ('asset', code))
        if not keep_lifecycle:
            conn.execute('DELETE FROM lifecycle WHERE asset_code=?', (code,))
        conn.commit()
        return n > 0
    finally:
        conn.close()


def add_life_event(asset_code, ev):
    conn = _connect()
    try:
        conn.execute('''INSERT INTO lifecycle
            (asset_code, type, title, time, place, from_who, to_who, person, note, changes, ts)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)''', (
            asset_code, ev.get('type', ''), ev.get('title', ''), ev.get('time', ''),
            ev.get('place', ''), ev.get('from', ''), ev.get('to', ''), ev.get('person', ''),
            ev.get('note', ''), _jdump(ev.get('changes') or []), ev.get('ts', 0)))
        conn.commit()
    finally:
        conn.close()


def list_life(asset_code):
    conn = _connect()
    try:
        rows = conn.execute('SELECT * FROM lifecycle WHERE asset_code=? ORDER BY ts ASC, id ASC', (asset_code,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d['changes'] = _jload(d.get('changes'), [])
            d.pop('asset_code', None)
            out.append(d)
        return out
    finally:
        conn.close()


def create_shipment(ship):
    conn = _connect()
    try:
        conn.execute('''INSERT INTO shipments
            (id, code, name, type, from_user, from_org, from_operator, to_user, to_org, date, note, status, custom_values, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
            ship['id'], ship['code'], ship['name'], ship.get('type', ''),
            ship['from_user'], ship.get('from_org', ''), ship.get('from_operator', ''),
            ship['to_user'], ship.get('to_org', ''), ship.get('date', ''), ship.get('note', ''),
            'pending', _jdump(ship.get('custom_values')), _now()))
        conn.commit()
    finally:
        conn.close()


def list_shipments(user, direction):
    col = 'to_user' if direction == 'incoming' else 'from_user'
    conn = _connect()
    try:
        rows = conn.execute('SELECT * FROM shipments WHERE ' + col + '=? ORDER BY created_at DESC', (user,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d['customValues'] = _jload(d.get('custom_values'), {})
            d.pop('custom_values', None)
            out.append(d)
        return out
    finally:
        conn.close()


def get_shipment(sid):
    conn = _connect()
    try:
        r = conn.execute('SELECT * FROM shipments WHERE id=?', (sid,)).fetchone()
        if not r:
            return None
        d = dict(r)
        d['customValues'] = _jload(d.get('custom_values'), {})
        d.pop('custom_values', None)
        return d
    finally:
        conn.close()


def receive_shipment(sid, user, expect_user):
    """原子接收：只有 pending 且接收方匹配才成功，防重复接收。"""
    conn = _connect()
    try:
        conn.execute('BEGIN IMMEDIATE')
        r = conn.execute('SELECT * FROM shipments WHERE id=?', (sid,)).fetchone()
        if not r or r['status'] != 'pending' or r['to_user'] != expect_user:
            conn.rollback()
            return None
        conn.execute('UPDATE shipments SET status=?, received_at=?, received_by=? WHERE id=?',
                     ('received', _now(), user, sid))
        conn.commit()
        return get_shipment(sid)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def add_attachment(owner_type, owner_id, filename, mime, size, path, uploader):
    conn = _connect()
    try:
        cur = conn.execute('''INSERT INTO attachments
            (owner_type, owner_id, filename, mime, size, path, uploader, created_at)
            VALUES (?,?,?,?,?,?,?,?)''',
            (owner_type, owner_id, filename, mime, size, path, uploader, _now()))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def list_attachments(owner_type, owner_id):
    conn = _connect()
    try:
        rows = conn.execute('''SELECT id, filename, mime, size, path, uploader, created_at
            FROM attachments WHERE owner_type=? AND owner_id=? ORDER BY id''', (owner_type, owner_id)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_attachment(aid):
    conn = _connect()
    try:
        r = conn.execute('SELECT * FROM attachments WHERE id=?', (aid,)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def delete_attachment(aid):
    conn = _connect()
    try:
        n = conn.execute('DELETE FROM attachments WHERE id=?', (aid,)).rowcount
        conn.commit()
        return n > 0
    finally:
        conn.close()


def get_cf_config():
    conn = _connect()
    try:
        rows = conn.execute('SELECT name, type, options, required, apply FROM cf_config ORDER BY id').fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d['options'] = _jload(d.get('options'), [])
            d['required'] = bool(d.get('required'))
            out.append(d)
        return out
    finally:
        conn.close()


def set_cf_config(items):
    conn = _connect()
    try:
        conn.execute('DELETE FROM cf_config')
        for f in items:
            conn.execute('INSERT INTO cf_config (name, type, options, required, apply) VALUES (?,?,?,?,?)', (
                f['name'], f.get('type', 'text'), _jdump(f.get('options') or []),
                1 if f.get('required') else 0, f.get('apply', 'all')))
        conn.commit()
    finally:
        conn.close()


def get_loc_config():
    conn = _connect()
    try:
        rows = conn.execute('SELECT id, kind, name, type FROM loc_config ORDER BY id').fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def set_loc_config(locations, fields):
    conn = _connect()
    try:
        conn.execute('DELETE FROM loc_config')
        for name in locations:
            conn.execute('INSERT INTO loc_config (kind, name, type) VALUES (?,?,?)', ('location', name, 'text'))
        for f in fields:
            conn.execute('INSERT INTO loc_config (kind, name, type) VALUES (?,?,?)',
                         ('field', f['name'], f.get('type', 'text')))
        conn.commit()
    finally:
        conn.close()


init_asset_db()
