# -*- coding: utf-8 -*-
"""
数据库定期备份（后台线程，跨平台）。

仅使用 Python 标准库，Windows / Linux / macOS 等 Python 支持的平台均可运行。

目录结构（backups/ 位于可写数据目录，与 *.db 同级）：
    backups/
        15分钟备份/2026-11-17_15-15-00/Ledger.db ...
        时备份/    2026-11-17_15-00-00/...
        日备份/    2026-11-17_00-00-00/...
        月备份/    2026-11-01_00-00-00/...
        年备份/    2026-01-01_00-00-00/...

每个时间子文件夹内是 5 个库的独立快照；各档位保留最新 12 个时间文件夹，
超出后删除最旧的（等价于下一次备份时覆盖）。
使用 sqlite3 的 backup API 生成一致性快照，WAL 模式下也安全。
"""
import os
import re
import shutil
import sqlite3
import threading
import time
from datetime import datetime

from path_helper import data_path

# 需要备份的库（名称 → 路径）
BACKUP_DBS = [
    ('LedgerEditor.db', data_path('LedgerEditor.db')),
    ('Ledger.db', data_path('Ledger.db')),
    ('Archive.db', data_path('Archive.db')),
    ('file.db', data_path('file.db')),
    ('Offline.db', data_path('Offline.db')),
]

BACKUP_ROOT = data_path('backups')
RETAIN = 12

# 时间子文件夹名：YYYY-MM-DD_HHMMSS（跨平台安全，不含 ':' 等非法字符）
_FOLDER_RE = re.compile(r'^\d{4}-\d{2}-\d{2}_\d{6}$')


def _floor_15min(dt):
    return dt.replace(minute=(dt.minute // 15) * 15, second=0, microsecond=0)


def _floor_hour(dt):
    return dt.replace(minute=0, second=0, microsecond=0)


def _floor_day(dt):
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def _floor_month(dt):
    return dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _floor_year(dt):
    return dt.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)


# (档位目录名, 时段取整函数)
TIERS = [
    ('15分钟备份', _floor_15min),
    ('时备份', _floor_hour),
    ('日备份', _floor_day),
    ('月备份', _floor_month),
    ('年备份', _floor_year),
]


def _backup_one(src, dst):
    """用 sqlite3 backup API 生成一致性快照，先写 .part 再原子替换。"""
    tmp = dst + '.part'
    if os.path.exists(tmp):
        try:
            os.remove(tmp)
        except OSError:
            pass

    src_conn = sqlite3.connect(src, timeout=15)
    try:
        dst_conn = sqlite3.connect(tmp)
        try:
            src_conn.backup(dst_conn)
            dst_conn.commit()
        finally:
            dst_conn.close()
    finally:
        src_conn.close()

    os.replace(tmp, dst)


def _prune(tier_dir):
    """只保留最新 RETAIN 个时间子文件夹，删除更旧的。"""
    try:
        names = [
            n for n in os.listdir(tier_dir)
            if _FOLDER_RE.match(n) and os.path.isdir(os.path.join(tier_dir, n))
        ]
    except OSError:
        return

    names.sort()  # YYYY-MM-DD_HHMMSS 字典序即时间序
    for old in names[:max(0, len(names) - RETAIN)]:
        try:
            shutil.rmtree(os.path.join(tier_dir, old), ignore_errors=True)
        except OSError:
            pass


def _try_lock(lock_path, stale_seconds=300):
    """跨进程文件锁（O_EXCL 原子创建），防止多 worker 部署时并发备份同一档位。"""
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode('utf-8'))
        os.close(fd)
        return True
    except FileExistsError:
        try:
            if time.time() - os.path.getmtime(lock_path) > stale_seconds:
                os.remove(lock_path)
                return _try_lock(lock_path, stale_seconds)
        except OSError:
            pass
        return False


def _unlock(lock_path):
    try:
        os.remove(lock_path)
    except OSError:
        pass


def _run_tier(folder_name):
    lock_path = os.path.join(BACKUP_ROOT, folder_name + '.lock')
    if not _try_lock(lock_path):
        print('[backup] %s 上次备份未完成或他进程正在备份，跳过本次' % folder_name, flush=True)
        return
    try:
        ts = datetime.now().strftime('%Y-%m-%d_%H%M%S')
        dest_dir = os.path.join(BACKUP_ROOT, folder_name, ts)
        os.makedirs(dest_dir, exist_ok=True)

        ok = 0
        for db_name, src in BACKUP_DBS:
            if not os.path.isfile(src):
                continue
            try:
                _backup_one(src, os.path.join(dest_dir, db_name))
                ok += 1
            except Exception as e:
                print('[backup] %s 备份失败 %s: %s' % (folder_name, db_name, e), flush=True)

        if ok == 0:
            # 一个库都没备份成功，清理空目录，避免堆积无意义文件夹
            try:
                shutil.rmtree(dest_dir, ignore_errors=True)
            except OSError:
                pass
            return

        print('[backup] %s 完成 @ %s（%d/%d 个库）' % (
            folder_name, ts, ok, len(BACKUP_DBS)), flush=True)
        _prune(os.path.join(BACKUP_ROOT, folder_name))
    finally:
        _unlock(lock_path)


_STATE = {
    'started': False,
    'stop': threading.Event(),
    'last': {},  # 档位目录名 -> 上次已处理的时段边界 datetime
}


def _loop():
    # 启动时把各档位“当前时段”视为已处理，避免每次重启都立刻补一批备份；
    # 下一个自然时段到达时再开始备份。
    now = datetime.now()
    for name, floor_fn in TIERS:
        _STATE['last'][name] = floor_fn(now)

    while not _STATE['stop'].is_set():
        try:
            now = datetime.now()
            for name, floor_fn in TIERS:
                due = floor_fn(now)
                last = _STATE['last'].get(name)
                if last is None or due > last:
                    try:
                        _run_tier(name)
                    except Exception as e:
                        print('[backup] %s 调度异常: %s' % (name, e), flush=True)
                    _STATE['last'][name] = due
        except Exception as e:
            print('[backup] 调度循环异常: %s' % e, flush=True)

        _STATE['stop'].wait(15)


def start():
    """幂等启动后台备份线程。"""
    if _STATE['started']:
        return
    _STATE['started'] = True
    t = threading.Thread(target=_loop, name='ledger-backup-scheduler', daemon=True)
    t.start()
    print('[backup] 后台备份调度器已启动（15分钟/时/日/月/年，各保留 %d 份）' % RETAIN, flush=True)
