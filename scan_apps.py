"""扫码应用配置读写。

每个应用 = scan_apps/<app_id>.json
每次请求现读文件（文件小、无性能压力、改完即生效）
"""
import os, json, re
from path_helper import data_path

APP_ID_RE = re.compile(r'^[a-z0-9_]{1,50}$')


def _apps_dir():
    d = data_path('scan_apps')
    os.makedirs(d, exist_ok=True)
    return d


def _app_path(app_id):
    if not APP_ID_RE.match(app_id or ''):
        return None
    return os.path.join(_apps_dir(), f'{app_id}.json')


def list_app_ids():
    d = _apps_dir()
    return sorted(
        fn[:-5] for fn in os.listdir(d)
        if fn.endswith('.json') and APP_ID_RE.match(fn[:-5])
    )


def load(app_id):
    path = _app_path(app_id)
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        cfg['app_id'] = app_id
        return cfg
    except (OSError, json.JSONDecodeError) as e:
        print(f'[scan_apps] {app_id} 加载失败：{e}')
        return None


def load_all():
    out = {}
    for app_id in list_app_ids():
        cfg = load(app_id)
        if cfg:
            out[app_id] = cfg
    return out


def save(app_id, cfg):
    path = _app_path(app_id)
    if not path:
        return False, 'app_id 不合法（只能 a-z 0-9 _，1-50 字符）'
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        return True, '已保存'
    except OSError as e:
        return False, f'写入失败：{e}'


def delete(app_id):
    path = _app_path(app_id)
    if not path or not os.path.exists(path):
        return False, '不存在'
    try:
        os.remove(path)
        return True, '已删除'
    except OSError as e:
        return False, f'删除失败：{e}'


def exists(app_id):
    path = _app_path(app_id)
    return bool(path and os.path.exists(path))


def list_for_user(username, check_perm):
    """check_perm(username, ledger_id) -> bool"""
    out = []
    for app_id in list_app_ids():
        cfg = load(app_id)
        if not cfg:
            continue
        lid = cfg.get('ledger_id')
        if lid and check_perm(username, lid):
            out.append({
                'app_id': app_id,
                'name': cfg.get('name') or app_id,
                'icon': cfg.get('icon') or '📷',
                'description': cfg.get('description') or '',
                'ledger_id': lid,
            })
    return out