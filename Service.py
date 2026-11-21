import os
import secrets
import uuid
import hashlib
import re as _re_scan
import scan_apps
import backup_scheduler
from urllib.parse import quote

from flask import (
    Flask, request, redirect, url_for, jsonify, render_template, session,
    Response, make_response, stream_with_context,
)

from path_helper import data_path, resource_path
from UseSqlite import (
    login_check, register_user,
    list_users, count_pending_users, approve_user, delete_user,
    list_ledgers_for_user, get_ledger_by_id, get_ledger_stats_for_user,
    create_ledger, update_ledger, delete_ledger,
    add_audit_log, list_audit_logs, count_audit_logs,
    list_audit_actions, clear_audit_logs,
    list_files, get_file_meta, get_file_content, add_file, delete_file,
    update_allowed_file_types, get_ledger_file_usage,
    MAX_FILE_SIZE, MAX_LEDGER_FILE_TOTAL, MAX_LEDGER_FILE_COUNT,
    DEFAULT_FILE_TYPES,
    list_archived_rows, count_archived_rows, restore_archived_row, scan_gid,
    UUID_SENTINEL,
    resolve_action_value, is_child_ledger,
    iter_file_chunks,
    add_offline_scan_upload, list_offline_scan_uploads,
    count_offline_scan_uploads, check_offline_exists,
    # 成员权限
    PERMISSION_KEYS, PERM_COL_MAP, PERM_LABELS, ROLE_LABELS, PRESET_PACKS,
    get_ledger_member, list_ledger_members, count_ledger_managers,
    has_permission, get_user_permissions,
    set_ledger_member, remove_ledger_member, transfer_owner,
    revoke_all_by_manager,
    create_permission_request, list_permission_requests,
    get_permission_request, review_permission_request,
    cancel_permission_request, count_pending_requests_for_user,
)

ROOT = 'root'


# ============================================================
# 通用工具
# ============================================================

def _safe_next(next_val, default='/dashboard'):
    if not next_val:
        return default
    s = str(next_val).strip()
    if not s.startswith('/') or s.startswith('//'):
        return default
    if s == '/scan' or s.startswith('/scan/'):
        return s
    return default


def _get_or_create_secret_key():
    key_path = data_path('secret.key')
    try:
        with open(key_path, 'rb') as f:
            data = f.read()
            if len(data) >= 32:
                return data
    except (FileNotFoundError, OSError):
        pass
    data = secrets.token_bytes(32)
    try:
        with open(key_path, 'wb') as f:
            f.write(data)
        try:
            os.chmod(key_path, 0o600)
        except OSError:
            pass
    except OSError as e:
        print(f'[警告] 无法写入 secret.key：{e}')
    return data


def _audit(username, action, target_type=None, target_id=None,
           target_name=None, detail=None):
    try:
        add_audit_log(username, action, target_type, target_id,
                      target_name, detail)
    except Exception:
        pass


# ============================================================
# 权限检查（全部走 ledger_members）
# ============================================================

def _perm(username, lid, perm):
    return has_permission(username, lid, perm)


def _can_access(username, ledger):
    """能查看 → data.view"""
    if not ledger:
        return False
    return _perm(username, ledger['id'], 'data.view')


def _can_edit(username, ledger):
    """能编辑 → data.edit"""
    if not ledger:
        return False
    return _perm(username, ledger['id'], 'data.edit')


def _is_owner(username, ledger):
    """是 owner 或 root"""
    if not ledger:
        return False
    if username == ROOT:
        return True
    m = get_ledger_member(ledger['id'], username)
    return bool(m and m['role'] == 'owner')


def _is_manager_or_above(username, ledger):
    """是 owner/manager 或 root"""
    if not ledger:
        return False
    if username == ROOT:
        return True
    m = get_ledger_member(ledger['id'], username)
    return bool(m and m['role'] in ('owner', 'manager'))


def _can_delete_file(username, ledger, file_meta):
    if not username or not ledger or not file_meta:
        return False
    if not _perm(username, ledger['id'], 'file.upload'):
        return False
    return username == ROOT or username == file_meta.get('uploader')


def _grant_check(granter, lid, requested_perms):
    """检查 granter 是否有权授予 requested_perms。"""
    if granter == ROOT:
        return True, None
    m = get_ledger_member(lid, granter)
    if not m:
        return False, 'not_member'
    if m['role'] == 'owner':
        return True, None
    # manager：不能授予自己没有的权限
    for k in PERMISSION_KEYS:
        if (requested_perms or {}).get(k) and not m.get(k):
            return False, k
    return True, None


def _normalize_list(raw, owner):
    if not isinstance(raw, list):
        return []
    out, seen = [], set()
    for t in raw:
        if t is None:
            continue
        s = str(t).strip()
        if not s or s == owner or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _valid_uuid_str(u):
    if not isinstance(u, str) or len(u) != 32:
        return False
    try:
        int(u, 16)
        return True
    except ValueError:
        return False


def _normalize_data(raw):
    rows = []
    if isinstance(raw, list):
        for row in raw:
            if isinstance(row, list):
                rows.append([('' if v is None else str(v)) for v in row])
            else:
                rows.append([])
    if not rows:
        return [[UUID_SENTINEL, '列1', '列2']]
    width = max(len(r) for r in rows)
    for r in rows:
        r.extend([''] * (width - len(r)))
    if not rows[0] or rows[0][0] != UUID_SENTINEL:
        for r in rows:
            r.insert(0, '')
        rows[0][0] = UUID_SENTINEL
    for i in range(1, len(rows)):
        if not _valid_uuid_str(rows[i][0]):
            rows[i][0] = uuid.uuid4().hex
    return rows


def _normalize_column_ids(raw, ncols):
    out = [UUID_SENTINEL]
    if isinstance(raw, list):
        for v in raw:
            if v == UUID_SENTINEL:
                continue
            if _valid_uuid_str(v):
                out.append(v)
            else:
                out.append(uuid.uuid4().hex)
    while len(out) < ncols:
        out.append(uuid.uuid4().hex)
    return out[:ncols]


def _normalize_column_links(raw):
    out = {}
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        try:
            ki = int(k); vi = int(v)
        except (TypeError, ValueError):
            continue
        if ki < 0 or vi <= 0:
            continue
        out[str(ki)] = vi
    return out


def _normalize_cell_links(raw):
    out = {}
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        parts = str(k).split(':', 1)
        if len(parts) != 2:
            continue
        try:
            ri = int(parts[0]); vi = int(v)
        except (TypeError, ValueError):
            continue
        if ri < 1 or vi <= 0:
            continue
        col_id = parts[1]
        if not col_id or col_id == UUID_SENTINEL:
            continue
        out[f"{ri}:{col_id}"] = vi
    return out


def _normalize_column_options(raw):
    out = {}
    if not isinstance(raw, dict):
        return out
    for col_uuid, opts in raw.items():
        if not isinstance(col_uuid, str) or len(col_uuid) != 32:
            continue
        if not _valid_uuid_str(col_uuid):
            continue
        if not isinstance(opts, list):
            continue
        clean, seen = [], set()
        for o in opts:
            if o is None:
                continue
            s = str(o).strip()
            if not s or s in seen:
                continue
            if len(s) > 100:
                s = s[:100]
            seen.add(s); clean.append(s)
            if len(clean) >= 100:
                break
        if clean:
            out[col_uuid] = clean
    return out


def _normalize_charts(raw):
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        cid = str(item.get('id') or '').strip()
        if not cid or len(cid) > 64:
            continue
        ctype = str(item.get('type') or '').strip()
        if ctype not in ('bar', 'line', 'area', 'pie', 'doughnut',
                         'radar', 'scatter', 'loc'):
            continue
        title = str(item.get('title') or '图表').strip()
        if len(title) > 100:
            title = title[:100]
        if not title:
            title = '图表'
        cfg_raw = item.get('config')
        if not isinstance(cfg_raw, dict):
            continue
        cfg = {}
        for k, v in cfg_raw.items():
            if k in ('catColId', 'valColId', 'xColId', 'yColId',
                     'locColId', 'locLabelColId'):
                if v == '':
                    cfg[k] = ''
                elif _valid_uuid_str(v):
                    cfg[k] = v
            elif k == 'aggregate':
                if v in ('none', 'sum', 'avg', 'count'):
                    cfg[k] = v
            elif k == 'topN':
                try:
                    cfg[k] = max(0, min(int(v), 200))
                except (TypeError, ValueError):
                    pass
            elif k in ('locRows', 'locCols'):
                try:
                    cfg[k] = max(1, min(int(v), 200))
                except (TypeError, ValueError):
                    pass
            elif k in ('locRowStart', 'locColStart'):
                cfg[k] = str(v or '')[:8]
            elif k == 'locSep':
                cfg[k] = str(v or '')[:8]
        out.append({'id': cid, 'type': ctype, 'title': title, 'config': cfg})
        if len(out) >= 20:
            break
    return out


def _normalize_cell_actions(raw):
    out = {}
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        parts = str(k).split(':', 1)
        if len(parts) != 2:
            continue
        try:
            ri = int(parts[0])
        except (TypeError, ValueError):
            continue
        if ri < 1:
            continue
        col_id = parts[1]
        if not col_id or col_id == UUID_SENTINEL:
            continue
        if not _valid_uuid_str(col_id):
            continue
        if not isinstance(v, dict):
            continue
        name = str(v.get('name') or '').strip()
        if not name:
            continue
        if len(name) > 100:
            name = name[:100]
        fields = []
        fields_raw = v.get('fields')
        if isinstance(fields_raw, list):
            seen = set()
            for f in fields_raw:
                if not _valid_uuid_str(f):
                    continue
                if f in seen:
                    continue
                seen.add(f); fields.append(f)
                if len(fields) >= 100:
                    break
        out[f'{ri}:{col_id}'] = {'name': name, 'fields': fields}
    return out


def _normalize_file_types(raw):
    if not isinstance(raw, list):
        return []
    out, seen = [], set()
    for t in raw:
        if t is None:
            continue
        s = str(t).strip().lower().lstrip('.')
        if not s or len(s) > 10:
            continue
        if not all(c.isalnum() for c in s):
            continue
        if s in seen:
            continue
        seen.add(s); out.append(s)
        if len(out) >= 200:
            break
    return out


# ============================================================
# 应用工厂
# ============================================================

def create_app(secure_cookie=True):
    app = Flask(
        __name__,
        template_folder=resource_path('templates'),
        static_folder=resource_path('static'),
    )
    app.config.update(
        SECRET_KEY=_get_or_create_secret_key(),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',
        SESSION_COOKIE_SECURE=secure_cookie,
        MAX_CONTENT_LENGTH=MAX_FILE_SIZE + 10 * 1024 * 1024,
    )

    @app.errorhandler(413)
    def _payload_too_large(e):
        return jsonify({'msg': '文件过大，请压缩至 100M 以下'}), 413

    @app.before_request
    def _csrf_guard():
        if 'csrf_token' not in session:
            session['csrf_token'] = secrets.token_hex(32)
        if request.method in ('POST', 'PUT', 'DELETE', 'PATCH'):
            sent = request.headers.get('X-CSRF-Token') or ''
            token = session.get('csrf_token') or ''
            if not token or not secrets.compare_digest(str(sent), str(token)):
                return jsonify({'msg': 'CSRF 校验失败，请刷新页面'}), 403
        return None

    @app.context_processor
    def _inject_csrf():
        return {'csrf_token': session.get('csrf_token', '')}

    # ============================================================
    # 基础页面
    # ============================================================

    @app.route('/')
    def index():
        if 'username' in session:
            return redirect(url_for('dashboard'))
        return render_template('index.html')

    @app.route('/admin')
    def admin_page():
        if 'username' not in session:
            return redirect(url_for('index'))
        if session['username'] != ROOT:
            return redirect(url_for('editor'))
        return render_template('admin.html', username=session['username'])

    @app.route('/editor')
    def editor():
        if 'username' not in session:
            return redirect(url_for('index'))
        return render_template('editor.html', username=session['username'])

    @app.route('/dashboard')
    def dashboard():
        if 'username' not in session:
            return redirect(url_for('index'))
        return render_template('dashboard.html', username=session['username'])

    # ============================================================
    # 登录/注册/退出
    # ============================================================

    @app.route('/login', methods=['POST'])
    def login():
        data = request.get_json(silent=True) or {}
        username = (data.get('username') or '').strip()
        password = data.get('password') or ''
        next_url = _safe_next(data.get('next'), '/dashboard')
        if not username or not password:
            return jsonify({'code': 400, 'msg': 'username 和 password 不能为空'}), 400
        result = login_check(username, password)
        if result == 'ok':
            current_csrf = session.get('csrf_token', '')
            session.clear()
            session['csrf_token'] = current_csrf or secrets.token_hex(32)
            session['username'] = username
            session.permanent = False
            _audit(username, 'login', 'user', None, username)
            return jsonify({'code': 0, 'msg': '登录成功', 'redirect': next_url})
        if result == 'pending':
            _audit(username, 'login_failed', 'user', None, username, '账号待审批')
            return jsonify({'code': 403, 'msg': '账号待管理员审批'}), 403
        _audit(username, 'login_failed', 'user', None, username, '用户名或密码错误')
        return jsonify({'code': 401, 'msg': '用户名或密码错误'}), 401

    @app.route('/api/register', methods=['POST'])
    def api_register():
        body = request.get_json(silent=True) or {}
        username = (body.get('username') or '').strip()
        password = body.get('password') or ''
        ok, msg = register_user(username, password)
        if not ok:
            return jsonify({'code': 400, 'msg': msg}), 400
        _audit(username, 'register', 'user', None, username, msg)
        return jsonify({'code': 0, 'msg': msg})

    @app.route('/logout', methods=['POST'])
    def logout():
        username = session.get('username')
        if username:
            _audit(username, 'logout', 'user', None, username)
        session.clear()
        return jsonify({'code': 0, 'msg': '已退出'})

    # ============================================================
    # 台账列表 / CRUD
    # ============================================================

    @app.route('/api/ledgers', methods=['GET'])
    def api_ledger_list():
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        light = request.args.get('light') == '1'
        return jsonify({'ledgers': list_ledgers_for_user(username, light=light)})

    @app.route('/api/dashboard/summary', methods=['GET'])
    def api_dashboard_summary():
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        return jsonify({'ledgers': get_ledger_stats_for_user(username)})

    @app.route('/api/ledgers', methods=['POST'])
    def api_ledger_create():
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        body = request.get_json(silent=True) or {}
        name = (body.get('name') or '').strip() or '未命名台账'
        lid = create_ledger(name, username, [['列1', '列2']], [])
        _audit(username, 'create_ledger', 'ledger', lid, name)
        return jsonify({'code': 0, 'ledger': get_ledger_by_id(lid)})

    def _ledger_with_meta(lid, username):
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return None
        m = get_ledger_member(lid, username)
        ledger['role'] = (m['role'] if m else None) or ('owner' if username == ROOT else None)
        ledger['permissions'] = get_user_permissions(username, lid)
        ledger['can_edit'] = bool(ledger['permissions'].get('data.edit'))
        ledger['can_manage'] = bool(ledger['permissions'].get('member.manage'))
        ledger['is_owner'] = _is_owner(username, ledger)
        return ledger

    @app.route('/api/ledgers/<int:lid>', methods=['GET'])
    def api_ledger_get(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _can_access(username, ledger):
            return jsonify({'msg': '无权访问该台账'}), 403
        return jsonify({'ledger': _ledger_with_meta(lid, username)})

    @app.route('/api/ledgers/<int:lid>', methods=['PUT'])
    def api_ledger_update(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404

        body = request.get_json(silent=True) or {}
        name, data = None, None
        column_links, cell_links = None, None
        column_ids, column_options = None, None
        charts = None
        cell_actions = None
        changes = []

        # ★ 旧的 teammates/viewers 字段已废弃
        if 'teammates' in body or 'viewers' in body:
            return jsonify({
                'msg': '成员管理请使用 /api/ledgers/<id>/members 接口'
            }), 400

        # name → member.manage
        if 'name' in body:
            if not _perm(username, lid, 'member.manage'):
                return jsonify({'msg': '没有重命名台账的权限'}), 403
            name = (body.get('name') or '').strip() or '未命名台账'
            if name != (ledger.get('name') or ''):
                changes.append('名称')

        # data → data.edit；减行 → data.delete
        if 'data' in body:
            if not _perm(username, lid, 'data.edit'):
                return jsonify({'msg': '没有编辑数据的权限'}), 403
            data = _normalize_data(body.get('data'))
            old_n = len(ledger.get('data') or [])
            new_n = len(data)
            if new_n < old_n and not _perm(username, lid, 'data.delete'):
                return jsonify({'msg': '没有删除行的权限'}), 403
            if data != _normalize_data(ledger.get('data')):
                changes.append('表格内容')

        # 其它字段 → data.edit
        need_edit = False
        for k in ('column_links', 'cell_links', 'column_ids',
                  'column_options', 'charts', 'cell_actions'):
            if k in body:
                need_edit = True
                break
        if need_edit and not _perm(username, lid, 'data.edit'):
            return jsonify({'msg': '没有编辑台账的权限'}), 403

        if 'column_links' in body:
            column_links = _normalize_column_links(body.get('column_links'))
            if column_links != (ledger.get('column_links') or {}):
                changes.append('列关联')
        if 'cell_links' in body:
            cell_links = _normalize_cell_links(body.get('cell_links'))
            if cell_links != (ledger.get('cell_links') or {}):
                changes.append('单元格关联')
        if 'column_ids' in body:
            ncols = len(data[0]) if (data and data[0]) else len(
                (ledger.get('data') or [[]])[0]
            )
            column_ids = _normalize_column_ids(body.get('column_ids'), ncols)
        if 'column_options' in body:
            column_options = _normalize_column_options(body.get('column_options'))
            if column_options != (ledger.get('column_options') or {}):
                changes.append('选项列')
        if 'charts' in body:
            charts = _normalize_charts(body.get('charts'))
            if charts != (ledger.get('charts') or []):
                changes.append('图表展示')
        if 'cell_actions' in body:
            cell_actions = _normalize_cell_actions(body.get('cell_actions'))
            if cell_actions != (ledger.get('cell_actions') or {}):
                changes.append('单元格交互')

        expected = body.get('expected_updated_at')
        if expected is not None:
            expected = str(expected)

        result = update_ledger(
            lid, name=name, data=data,
            teammates=None, viewers=None,
            column_links=column_links, cell_links=cell_links,
            column_ids=column_ids, column_options=column_options,
            charts=charts,
            cell_actions=cell_actions,
            expected_updated_at=expected,
            username=username,
        )

        if result['status'] == 'not_found':
            return jsonify({'msg': '台账不存在'}), 404
        if result['status'] == 'busy':
            resp = jsonify({
                'msg': result.get('msg') or '该台账正在保存，请稍后再试',
                'busy': True,
            })
            resp.headers['Retry-After'] = '2'
            return resp, 429
        if result['status'] == 'error':
            return jsonify({
                'msg': result.get('msg') or '写入失败，请稍后重试',
            }), 500
        if result['status'] == 'conflict':
            return jsonify({
                'msg': '该台账已被他人修改，请刷新后重试',
                'current_updated_at': result.get('current_updated_at'),
            }), 409

        updated = _ledger_with_meta(lid, username)
        archived_n = result.get('archived_count', 0)
        if archived_n > 0:
            changes.append(f'封存 {archived_n} 行')
            _audit(username, 'archive_rows', 'ledger', lid,
                   updated.get('name'), f'封存 {archived_n} 行到回收站')
        if changes:
            _audit(username, 'update_ledger', 'ledger', lid,
                   updated.get('name'), '修改：' + '、'.join(changes))
        return jsonify({'code': 0, 'ledger': updated,
                        'archived_count': archived_n})

    @app.route('/api/ledgers/<int:lid>', methods=['DELETE'])
    def api_ledger_delete(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _is_owner(username, ledger):
            return jsonify({'msg': '只有所有者可以删除台账'}), 403
        _audit(username, 'delete_ledger', 'ledger', lid, ledger.get('name'))
        delete_ledger(lid)
        return jsonify({'code': 0, 'msg': '已删除'})

    # ============================================================
    # 成员管理
    # ============================================================

    @app.route('/api/ledgers/<int:lid>/members', methods=['GET'])
    def api_members_list(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'data.view'):
            return jsonify({'msg': '无权访问'}), 403

        can_manage = _perm(username, lid, 'member.manage')
        members = list_ledger_members(lid) if can_manage else []
        preset_packs = PRESET_PACKS if can_manage else {}
        my_m = get_ledger_member(lid, username)
        my_perms = {k: (my_m.get(k, 0) if my_m else 0) for k in PERMISSION_KEYS}
        if username == ROOT:
            my_perms = {k: 1 for k in PERMISSION_KEYS}

        return jsonify({
            'members': members,
            'permission_keys': PERMISSION_KEYS,
            'permission_labels': PERM_LABELS,
            'role_labels': ROLE_LABELS,
            'preset_packs': preset_packs,
            'my_role': (my_m['role'] if my_m else ('root' if username == ROOT else None)),
            'my_permissions': my_perms,
            'is_owner': _is_owner(username, ledger),
            'is_root': username == ROOT,
        })

    @app.route('/api/ledgers/<int:lid>/members', methods=['POST'])
    def api_members_add(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'member.manage'):
            return jsonify({'msg': '没有成员管理权限'}), 403

        body = request.get_json(silent=True) or {}
        target = (body.get('username') or '').strip()
        role = (body.get('role') or 'member').strip()
        perms = body.get('permissions') or {}
        preset = (body.get('preset') or '').strip()

        if not target:
            return jsonify({'msg': '用户名不能为空'}), 400
        if target == ROOT:
            return jsonify({'msg': '不能添加 root'}), 400
        if target == username:
            return jsonify({'msg': '不能添加自己'}), 400
        if role not in ('member', 'manager'):
            return jsonify({'msg': '角色只能是 member 或 manager'}), 400
        if role == 'manager' and not _is_owner(username, ledger):
            return jsonify({'msg': '只有所有者可以添加管理者'}), 403

        # 用 preset 覆盖 perms
        if preset and preset in PRESET_PACKS:
            perms = dict(PRESET_PACKS[preset]['perms'])
            role = PRESET_PACKS[preset]['role']
            if role == 'owner':
                return jsonify({'msg': '所有者通过转让操作变更'}), 400

        # 规范 perms：只保留合法的 key，0/1
        clean_perms = {}
        for k in PERMISSION_KEYS:
            clean_perms[k] = 1 if perms.get(k) else 0

        ok, bad = _grant_check(username, lid, clean_perms)
        if not ok:
            if bad == 'not_member':
                return jsonify({'msg': '你不是该台账成员'}), 403
            return jsonify({'msg': f'你无权授予「{PERM_LABELS.get(bad, bad)}」'}), 403

        existing = get_ledger_member(lid, target)
        if existing:
            return jsonify({'msg': '该用户已是成员，请用编辑'}), 400

        ok, msg = set_ledger_member(lid, target, role, clean_perms, granted_by=username)
        if not ok:
            return jsonify({'msg': msg}), 400
        _audit(username, 'add_member', 'ledger', lid, ledger.get('name'),
               f'{target}（{ROLE_LABELS.get(role, role)}，'
               f'权限：{",".join(k for k in PERMISSION_KEYS if clean_perms.get(k))}）')
        return jsonify({'code': 0, 'msg': '已添加'})

    @app.route('/api/ledgers/<int:lid>/members/<target>', methods=['PUT'])
    def api_members_update(lid, target):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'member.manage'):
            return jsonify({'msg': '没有成员管理权限'}), 403

        existing = get_ledger_member(lid, target)
        if not existing:
            return jsonify({'msg': '成员不存在'}), 404
        if existing['role'] == 'owner':
            return jsonify({'msg': '不能修改所有者'}), 403
        if target == ROOT:
            return jsonify({'msg': '不能修改 root'}), 403

        if not _is_owner(username, ledger):
            # manager 不能修改其他 manager
            if existing['role'] == 'manager':
                return jsonify({'msg': '只有所有者可以修改管理者'}), 403

        body = request.get_json(silent=True) or {}
        new_role = body.get('role') or existing['role']
        preset = (body.get('preset') or '').strip()

        if preset and preset in PRESET_PACKS:
            perms = dict(PRESET_PACKS[preset]['perms'])
            new_role = PRESET_PACKS[preset]['role']
            if new_role == 'owner':
                return jsonify({'msg': '所有者通过转让操作变更'}), 400
        else:
            raw = body.get('permissions')
            if raw is None:
                perms = {k: existing.get(k, 0) for k in PERMISSION_KEYS}
            else:
                perms = {}
                for k in PERMISSION_KEYS:
                    perms[k] = 1 if raw.get(k) else 0

        if new_role not in ('member', 'manager'):
            return jsonify({'msg': '角色无效'}), 400
        if new_role == 'manager' and not _is_owner(username, ledger):
            return jsonify({'msg': '只有所有者可以设置管理者'}), 403

        ok, bad = _grant_check(username, lid, perms)
        if not ok:
            if bad == 'not_member':
                return jsonify({'msg': '你不是该台账成员'}), 403
            return jsonify({'msg': f'你无权授予「{PERM_LABELS.get(bad, bad)}」'}), 403

        ok, msg = set_ledger_member(lid, target, new_role, perms, granted_by=username)
        if not ok:
            return jsonify({'msg': msg}), 400
        _audit(username, 'update_member', 'ledger', lid, ledger.get('name'),
               f'{target} → {ROLE_LABELS.get(new_role, new_role)}')
        return jsonify({'code': 0, 'msg': '已更新'})

    @app.route('/api/ledgers/<int:lid>/members/<target>', methods=['DELETE'])
    def api_members_remove(lid, target):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'member.manage'):
            return jsonify({'msg': '没有成员管理权限'}), 403

        existing = get_ledger_member(lid, target)
        if not existing:
            return jsonify({'msg': '成员不存在'}), 404
        if existing['role'] == 'owner':
            return jsonify({'msg': '不能移除所有者，请先转让'}), 403
        if not _is_owner(username, ledger) and existing['role'] == 'manager':
            return jsonify({'msg': '只有所有者可以移除管理者'}), 403

        ok, msg = remove_ledger_member(lid, target)
        if not ok:
            return jsonify({'msg': msg}), 400
        _audit(username, 'remove_member', 'ledger', lid, ledger.get('name'),
               f'移除 {target}')
        return jsonify({'code': 0, 'msg': '已移除'})

    @app.route('/api/ledgers/<int:lid>/transfer-owner', methods=['POST'])
    def api_transfer_owner(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _is_owner(username, ledger):
            return jsonify({'msg': '只有所有者可以转让'}), 403

        body = request.get_json(silent=True) or {}
        new_owner = (body.get('new_owner') or '').strip()
        keep_grants = bool(body.get('keep_grants', True))

        if not new_owner:
            return jsonify({'msg': '新所有者不能为空'}), 400

        ok, msg = transfer_owner(lid, new_owner, keep_grants, by_user=username)
        if not ok:
            return jsonify({'msg': msg}), 400
        _audit(username, 'transfer_owner', 'ledger', lid, ledger.get('name'),
               f'转让给 {new_owner}（keep_grants={keep_grants}）')
        return jsonify({'code': 0, 'msg': '已转让'})

    @app.route('/api/ledgers/<int:lid>/revoke-grants', methods=['POST'])
    def api_revoke_grants(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _is_owner(username, ledger):
            return jsonify({'msg': '只有所有者可以撤销'}), 403

        body = request.get_json(silent=True) or {}
        manager_name = (body.get('manager') or '').strip()
        if not manager_name:
            return jsonify({'msg': 'manager 不能为空'}), 400

        n = revoke_all_by_manager(lid, manager_name)
        _audit(username, 'revoke_grants', 'ledger', lid, ledger.get('name'),
               f'撤销 {manager_name} 授予的 {n} 个成员')
        return jsonify({'code': 0, 'msg': f'已撤销 {n} 个成员', 'count': n})

    # ============================================================
    # 权限申请
    # ============================================================

    @app.route('/api/ledgers/<int:lid>/requests', methods=['GET'])
    def api_requests_list(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'data.view'):
            return jsonify({'msg': '无权访问'}), 403

        can_approve = _perm(username, lid, 'member.approve')
        status = (request.args.get('status') or '').strip() or None

        try:
            limit = int(request.args.get('limit', 100))
        except (TypeError, ValueError):
            limit = 100
        try:
            offset = int(request.args.get('offset', 0))
        except (TypeError, ValueError):
            offset = 0

        if can_approve:
            rows = list_permission_requests(
                lid=lid, status=status, limit=limit, offset=offset
            )
        else:
            rows = list_permission_requests(
                lid=lid, username=username, status=status,
                limit=limit, offset=offset
            )

        return jsonify({
            'requests': rows,
            'permission_labels': PERM_LABELS,
            'can_approve': can_approve,
        })

    @app.route('/api/ledgers/<int:lid>/requests', methods=['POST'])
    def api_requests_create(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'data.view'):
            return jsonify({'msg': '你不是该台账成员'}), 403

        body = request.get_json(silent=True) or {}
        permission = (body.get('permission') or '').strip()
        reason = (body.get('reason') or '').strip()

        if permission not in PERM_COL_MAP:
            return jsonify({'msg': '权限无效'}), 400
        if _perm(username, lid, permission):
            return jsonify({'msg': '你已有该权限'}), 400
        if username == ROOT:
            return jsonify({'msg': 'root 不需要申请'}), 400

        ok, msg, rid = create_permission_request(lid, username, permission, reason)
        if not ok:
            return jsonify({'msg': msg}), 400
        _audit(username, 'request_permission', 'ledger', lid, ledger.get('name'),
               f'申请「{PERM_LABELS.get(permission, permission)}」：{reason}')
        return jsonify({'code': 0, 'msg': '已提交', 'request_id': rid})

    @app.route('/api/ledgers/<int:lid>/requests/<int:rid>/review', methods=['POST'])
    def api_requests_review(lid, rid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'member.approve'):
            return jsonify({'msg': '没有审批权限'}), 403

        req = get_permission_request(rid)
        if not req or req['ledger_id'] != lid:
            return jsonify({'msg': '申请不存在'}), 404
        if req['username'] == username:
            return jsonify({'msg': '不能审批自己的申请'}), 403

        body = request.get_json(silent=True) or {}
        decision = (body.get('decision') or '').strip()
        note = (body.get('note') or '').strip()
        if decision not in ('approved', 'rejected'):
            return jsonify({'msg': '决定无效'}), 400

        # manager 不能批准超出自己权限的申请
        if decision == 'approved':
            ok, bad = _grant_check(username, lid, {req['permission']: 1})
            if not ok:
                if bad == 'not_member':
                    return jsonify({'msg': '你不是该台账成员'}), 403
                return jsonify({
                    'msg': f'你无权批准「{PERM_LABELS.get(bad, bad)}」'
                }), 403

        ok, msg, r_lid, r_user, r_perm = review_permission_request(
            rid, username, decision, note
        )
        if not ok:
            return jsonify({'msg': msg}), 400

        # 批准时立即生效
        if decision == 'approved' and r_perm:
            target_m = get_ledger_member(r_lid, r_user)
            if target_m:
                perms = {k: target_m.get(k, 0) for k in PERMISSION_KEYS}
                perms[r_perm] = 1
                set_ledger_member(r_lid, r_user, target_m['role'], perms,
                                  granted_by=username)
            _audit(username, 'approve_permission', 'ledger', r_lid,
                   ledger.get('name'),
                   f'批准 {r_user} 的「{PERM_LABELS.get(r_perm, r_perm)}」：{note}')
        else:
            _audit(username, 'reject_permission', 'ledger', lid,
                   ledger.get('name'),
                   f'驳回 {req["username"]} 的「'
                   f'{PERM_LABELS.get(req["permission"], req["permission"])}」'
                   + (f'：{note}' if note else ''))

        return jsonify({'code': 0, 'msg': '已处理'})

    @app.route('/api/ledgers/<int:lid>/requests/<int:rid>', methods=['DELETE'])
    def api_requests_cancel(lid, rid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        req = get_permission_request(rid)
        if not req or req['ledger_id'] != lid:
            return jsonify({'msg': '申请不存在'}), 404
        if req['username'] != username:
            return jsonify({'msg': '只能取消自己的申请'}), 403
        if not cancel_permission_request(rid, username):
            return jsonify({'msg': '取消失败'}), 400
        return jsonify({'code': 0, 'msg': '已取消'})

    @app.route('/api/my/pending-requests-count', methods=['GET'])
    def api_my_pending_count():
        username = session.get('username')
        if not username:
            return jsonify({'count': 0})
        return jsonify({'count': count_pending_requests_for_user(username)})

    # ============================================================
    # 扫码数据（旧的 /api/scan/<gid>）
    # ============================================================

    @app.route('/api/scan/<gid>', methods=['GET'])
    def api_scan(gid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        result = scan_gid(gid, username)
        return jsonify(result)

    # ============================================================
    # 归档（回收站）
    # ============================================================

    @app.route('/api/archive/rows', methods=['GET'])
    def api_archive_rows():
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        try:
            limit = int(request.args.get('limit', 100))
        except (TypeError, ValueError):
            limit = 100
        try:
            offset = int(request.args.get('offset', 0))
        except (TypeError, ValueError):
            offset = 0
        ledger_id = request.args.get('ledger_id')
        if ledger_id:
            try:
                ledger_id = int(ledger_id)
            except ValueError:
                ledger_id = None
        include_restored = request.args.get('include_restored') == '1'

        # 权限：如果指定了 ledger_id，需要 data.view
        if ledger_id:
            if not _perm(username, ledger_id, 'data.view'):
                return jsonify({'msg': '无权访问'}), 403

        rows = list_archived_rows(username, ledger_id=ledger_id,
                                  limit=limit, offset=offset,
                                  include_restored=include_restored)
        # 过滤：只保留用户有 data.view 的台账
        if not ledger_id and username != ROOT:
            allowed = set()
            for r in rows:
                l_id = r['original_ledger_id']
                if l_id not in allowed:
                    if _perm(username, l_id, 'data.view'):
                        allowed.add(l_id)
                    else:
                        allowed.add(None)
            rows = [r for r in rows if r['original_ledger_id'] in allowed]
        total = count_archived_rows(username, ledger_id=ledger_id,
                                    include_restored=include_restored)
        return jsonify({
            'rows': rows, 'total': total,
            'limit': limit, 'offset': offset,
            'is_root': username == ROOT,
        })

    @app.route('/api/archive/rows/<int:archive_id>/restore', methods=['POST'])
    def api_archive_restore(archive_id):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ok, msg = restore_archived_row(archive_id, username)
        if not ok:
            return jsonify({'code': 400, 'msg': msg}), 400
        _audit(username, 'restore_row', 'system', archive_id, None, msg)
        return jsonify({'code': 0, 'msg': msg})

    # ============================================================
    # 单元格交互
    # ============================================================

    _SAMPLE_INTERACT_RESPONSES = {
        '远程链接设备': '设备链接成功',
        '远程连接设备': '设备连接成功',
        '重启设备': '设备重启指令已下发',
        '下发配置': '配置下发成功',
        '断链设备': '设备已断开连接',
        '关闭设备': '设备关机指令已下发',
    }

    @app.route('/api/ledgers/<int:lid>/interact', methods=['POST'])
    def api_ledger_interact(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'data.edit'):
            return jsonify({'msg': '没有编辑权限'}), 403

        body = request.get_json(silent=True) or {}
        action_name = (body.get('action_name') or '').strip()
        if not action_name:
            return jsonify({'msg': '操作名称不能为空'}), 400
        if len(action_name) > 100:
            action_name = action_name[:100]
        try:
            row = int(body.get('row', 0))
        except (TypeError, ValueError):
            row = 0
        if row < 0:
            row = 0
        col_id = str(body.get('col_id') or '')[:64]
        cell_value = str(body.get('cell_value') or '')[:500]
        row_data_raw = body.get('row_data')
        row_data_clean = {}
        if isinstance(row_data_raw, dict):
            for cid, val in row_data_raw.items():
                if not _valid_uuid_str(cid):
                    continue
                row_data_clean[cid] = str(val if val is not None else '')[:500]
        _audit(username, 'interact', 'ledger', lid, ledger.get('name'),
               '交互：' + action_name + '｜行 ' + str(row) +
               '｜列 ' + col_id[:8] +
               ('｜值 ' + cell_value[:60] if cell_value else '') +
               ('｜附加 ' + str(len(row_data_clean)) + ' 列' if row_data_clean else ''))
        response_msg = _SAMPLE_INTERACT_RESPONSES.get(
            action_name, '操作「' + action_name + '」已发送'
        )
        return jsonify({
            'code': 0, 'msg': response_msg,
            'echo': {'user': username, 'ledger_id': lid, 'row': row,
                     'col_id': col_id, 'action_name': action_name,
                     'cell_value': cell_value, 'row_data': row_data_clean}
        })

    # ============================================================
    # 附件
    # ============================================================

    @app.route('/api/ledgers/<int:lid>/files', methods=['GET'])
    def api_file_list(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'data.view'):
            return jsonify({'msg': '无权访问该台账'}), 403

        can_download = _perm(username, lid, 'file.download')
        can_upload = _perm(username, lid, 'file.upload')

        files = list_files(lid)
        for f in files:
            f['can_delete'] = _can_delete_file(username, ledger, f)
        total_size, count = get_ledger_file_usage(lid)
        return jsonify({
            'files': files,
            'allowed_file_types': ledger.get('allowed_file_types') or [],
            'can_upload': can_upload,
            'can_download': can_download,
            'can_manage_types': _is_owner(username, ledger),
            'usage': {
                'total_size': total_size, 'count': count,
                'max_file_size': MAX_FILE_SIZE,
                'max_total_size': MAX_LEDGER_FILE_TOTAL,
                'max_count': MAX_LEDGER_FILE_COUNT,
            },
        })

    @app.route('/api/ledgers/<int:lid>/files', methods=['POST'])
    def api_file_upload(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'file.upload'):
            return jsonify({'msg': '没有上传权限'}), 403

        allowed = ledger.get('allowed_file_types') or []
        if not allowed:
            return jsonify({'msg': '该台账未配置允许上传的文件类型，已禁止上传'}), 400
        f = request.files.get('file')
        if f is None or not f.filename:
            return jsonify({'msg': '未选择文件'}), 400
        raw_name = str(f.filename)
        if '.' not in raw_name:
            return jsonify({'msg': '文件缺少扩展名，已拒绝'}), 400
        ext = raw_name.rsplit('.', 1)[-1].strip().lower()
        if not ext or not ext.isalnum() or len(ext) > 10:
            return jsonify({'msg': '扩展名不合法'}), 400
        if ext not in allowed:
            return jsonify({'msg': f'该台账不允许上传 .{ext} 文件'}), 400
        data = f.read()
        size = len(data)
        if size == 0:
            return jsonify({'msg': '文件为空'}), 400
        if size > MAX_FILE_SIZE:
            return jsonify({'msg': '文件过大，请压缩至 100M 以下'}), 413
        filename = raw_name[:255]
        mime = (f.mimetype or 'application/octet-stream')[:120]
        sha = hashlib.sha256(data).hexdigest()
        ok, msg, fid, code = add_file(
            lid, filename, mime, ext, size, sha, data, username
        )
        if not ok:
            status = 413 if code in ('too_large', 'too_large_total') else 400
            return jsonify({'msg': msg}), status
        _audit(username, 'file_upload', 'ledger', lid, ledger.get('name'),
               f'{filename}｜{size} 字节｜.{ext}')
        return jsonify({'code': 0, 'msg': msg, 'file': get_file_meta(fid)})

    @app.route('/api/files/<int:fid>/download', methods=['GET'])
    def api_file_download(fid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        meta = get_file_meta(fid)
        if not meta:
            return jsonify({'msg': '文件不存在'}), 404
        ledger = get_ledger_by_id(meta['ledger_id'])
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, ledger['id'], 'file.download'):
            return jsonify({'msg': '没有下载权限'}), 403

        _audit(username, 'file_download', 'ledger', ledger['id'],
               ledger.get('name'), meta['filename'])

        resp = Response(
            stream_with_context(iter_file_chunks(fid)),
            mimetype='application/octet-stream',
        )
        resp.headers['Content-Disposition'] = (
            "attachment; filename*=UTF-8''" + quote(meta['filename'], safe='')
        )
        resp.headers['X-Content-Type-Options'] = 'nosniff'
        resp.headers['Content-Length'] = str(meta['size'])
        return resp

    @app.route('/api/files/<int:fid>', methods=['DELETE'])
    def api_file_delete(fid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        meta = get_file_meta(fid)
        if not meta:
            return jsonify({'msg': '文件不存在'}), 404
        ledger = get_ledger_by_id(meta['ledger_id'])
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _can_delete_file(username, ledger, meta):
            return jsonify({'msg': '只有 root 或上传者本人可以删除该文件'}), 403
        _audit(username, 'file_delete', 'ledger', meta['ledger_id'],
               ledger.get('name'),
               f"{meta['filename']}｜上传者 {meta['uploader']}")
        delete_file(fid)
        return jsonify({'code': 0, 'msg': '已删除'})

    @app.route('/api/ledgers/<int:lid>/file-types', methods=['PUT'])
    def api_file_types_update(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'member.manage'):
            return jsonify({'msg': '没有管理权限'}), 403
        body = request.get_json(silent=True) or {}
        types = _normalize_file_types(body.get('types'))
        old = ledger.get('allowed_file_types') or []
        update_allowed_file_types(lid, types)
        if types != old:
            added = sorted(set(types) - set(old))
            removed = sorted(set(old) - set(types))
            parts = []
            if added:
                parts.append('新增 ' + ','.join(added))
            if removed:
                parts.append('移除 ' + ','.join(removed))
            _audit(username, 'file_types_update', 'ledger', lid,
                   ledger.get('name'), '；'.join(parts) or '无变化')
        return jsonify({'code': 0, 'allowed_file_types': types,
                        'default_file_types': DEFAULT_FILE_TYPES})

    # ============================================================
    # 管理后台（账号）
    # ============================================================

    def _require_root():
        return session.get('username') == ROOT

    @app.route('/api/admin/users', methods=['GET'])
    def api_admin_users():
        if not _require_root():
            return jsonify({'msg': '无权限'}), 403
        return jsonify({
            'users': list_users(),
            'pending_count': count_pending_users(),
        })

    @app.route('/api/admin/pending-count', methods=['GET'])
    def api_admin_pending_count():
        if not _require_root():
            return jsonify({'count': 0})
        return jsonify({'count': count_pending_users()})

    @app.route('/api/admin/users/<username>/approve', methods=['POST'])
    def api_admin_approve(username):
        if not _require_root():
            return jsonify({'msg': '无权限'}), 403
        ok, msg = approve_user(username)
        if not ok:
            return jsonify({'code': 400, 'msg': msg}), 400
        _audit(session.get('username'), 'approve_user', 'user', None, username, msg)
        return jsonify({'code': 0, 'msg': msg})

    @app.route('/api/admin/users/<username>', methods=['DELETE'])
    def api_admin_delete_user(username):
        if not _require_root():
            return jsonify({'msg': '无权限'}), 403
        ok, msg = delete_user(username)
        if not ok:
            return jsonify({'code': 400, 'msg': msg}), 400
        _audit(session.get('username'), 'delete_user', 'user', None, username, msg)
        return jsonify({'code': 0, 'msg': msg})

    @app.route('/api/admin/audit-logs', methods=['GET'])
    def api_admin_audit_logs():
        if not _require_root():
            return jsonify({'msg': '无权限'}), 403
        try:
            limit = int(request.args.get('limit', 50))
        except (TypeError, ValueError):
            limit = 50
        try:
            offset = int(request.args.get('offset', 0))
        except (TypeError, ValueError):
            offset = 0
        username = (request.args.get('username') or '').strip() or None
        action = (request.args.get('action') or '').strip() or None
        logs = list_audit_logs(limit=limit, offset=offset,
                               username=username, action=action)
        total = count_audit_logs(username=username, action=action)
        return jsonify({
            'logs': logs, 'total': total,
            'limit': limit, 'offset': offset,
            'actions': list_audit_actions(),
        })

    @app.route('/api/admin/audit-logs', methods=['DELETE'])
    def api_admin_clear_audit_logs():
        if not _require_root():
            return jsonify({'msg': '无权限'}), 403
        clear_audit_logs()
        _audit(session.get('username'), 'clear_audit', 'system', None, None,
               '清空审计日志')
        return jsonify({'code': 0, 'msg': '已清空'})

    # ============================================================
    # 台账日志（log.view 权限）
    # ============================================================

    @app.route('/api/ledgers/<int:lid>/logs', methods=['GET'])
    def api_ledger_logs(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'log.view'):
            return jsonify({'msg': '没有查看日志权限'}), 403

        try:
            limit = int(request.args.get('limit', 100))
        except (TypeError, ValueError):
            limit = 100
        try:
            offset = int(request.args.get('offset', 0))
        except (TypeError, ValueError):
            offset = 0

        # 从 audit_logs 里筛 target_type='ledger' 且 target_id=lid
        # 简化：目前 list_audit_logs 不支持按 target 过滤，
        # 所以这里用较简单的方式——查询全部，过滤 target_id
        logs = list_audit_logs(limit=500, offset=0)
        filtered = [l for l in logs
                    if l.get('target_type') == 'ledger'
                    and l.get('target_id') == lid]
        total = len(filtered)
        page = filtered[offset:offset + limit]

        return jsonify({
            'logs': page, 'total': total,
            'limit': limit, 'offset': offset,
            'ledger_name': ledger.get('name'),
        })

    # ============================================================
    # 扫码终端
    # ============================================================

    def _can_use_scan_app(username, lid):
        """能否在扫码终端使用某台账的扫码应用 → qr.generate"""
        return _perm(username, lid, 'qr.generate')

    def _can_manage_scan_app(username, lid):
        """能否配置扫码应用 → member.manage"""
        return _perm(username, lid, 'member.manage')

    def _col_idx_by_uuid(ledger, col_uuid):
        ids = ledger.get('column_ids') or []
        try:
            return ids.index(col_uuid)
        except (ValueError, AttributeError):
            return -1

    def _find_time_col(ledger, data):
        if not data or not data[0]:
            return -1
        for i in range(1, len(data[0])):
            if str(data[0][i]).strip() == '更新时间':
                return i
        return -1

    def _now_str_scan():
        from datetime import datetime as _dt
        return _dt.now().strftime('%Y-%m-%d %H:%M:%S')

    def _resolve_tpl(tpl, ledger, row_data, action, username, gid,
                     resolved_value=None):
        if not tpl:
            return ''
        if tpl == '$user':
            return username or ''
        if tpl == '$now':
            return _now_str_scan()
        if tpl == '$gid':
            return gid or ''
        if tpl == '$action_label':
            return (action or {}).get('label', '')
        if tpl == '$action_value':
            if resolved_value is not None:
                return resolved_value
            return (action or {}).get('value', '')
        if tpl.startswith('$col:'):
            idx = _col_idx_by_uuid(ledger, tpl[5:])
            return row_data[idx] if 0 < idx < len(row_data) else ''
        return tpl

    def _append_log_row(log_cfg, src_ledger, row_data, action, username, gid,
                        resolved_value=None):
        try:
            target_lid = log_cfg.get('ledger_id')
            target = get_ledger_by_id(target_lid) if target_lid else None
            if not target:
                return
            tdata = target.get('data') or [['__uuid__']]
            headers = tdata[0] if tdata else []
            fields = log_cfg.get('fields') or {}
            import uuid as _uuid
            new_row = [_uuid.uuid4().hex]
            for ci in range(1, len(headers)):
                header = str(headers[ci]).strip()
                tpl = fields.get(header, '')
                new_row.append(_resolve_tpl(tpl, src_ledger, row_data,
                                            action, username, gid,
                                            resolved_value))
            tdata.append(new_row)
            r = update_ledger(target_lid, data=tdata, username=username)
            if r.get('status') == 'busy':
                print(f'[扫码日志] 目标台账 #{target_lid} 正在保存，跳过本条日志')
            elif r.get('status') != 'ok':
                print(f'[扫码日志] 追加失败：{r}')
        except Exception as e:
            print(f'[扫码日志] 追加失败：{e}')

    def _resolve_scan_gid(username, app_id, gid):
        """校验 gid + 权限 + 找行。"""
        cfg = scan_apps.load(app_id)
        if not cfg:
            return {'ok': False, 'status': 'app_not_found',
                    'msg': '应用不存在', 'http': 404}
        lid = cfg.get('ledger_id')
        if not _can_use_scan_app(username, lid):
            return {'ok': False, 'status': 'forbidden',
                    'msg': '无权使用该应用', 'http': 403}

        m = _re_scan.match(r'^L(\d+)_([0-9a-f]{32})$', (gid or '').strip(),
                           _re_scan.IGNORECASE)
        if not m:
            return {'ok': False, 'status': 'invalid',
                    'msg': '无效二维码', 'http': 200}
        gid_lid = int(m.group(1))
        row_uuid = m.group(2).lower()

        if gid_lid != lid:
            return {'ok': False, 'status': 'wrong_ledger',
                    'msg': f'该二维码不属于本应用（台账 #{gid_lid}）', 'http': 200}

        ledger = get_ledger_by_id(gid_lid)
        if not ledger:
            return {'ok': False, 'status': 'ledger_deleted',
                    'msg': '台账已删除', 'http': 200}

        data = ledger.get('data') or []
        row_idx = -1
        for i in range(1, len(data)):
            if isinstance(data[i], list) and data[i] and data[i][0] == row_uuid:
                row_idx = i
                break
        if row_idx < 0:
            return {'ok': False, 'status': 'not_found',
                    'msg': '未找到该行', 'http': 200}

        display_data = []
        for item in cfg.get('display', []):
            ci = _col_idx_by_uuid(ledger, item.get('col'))
            val = data[row_idx][ci] if 0 < ci < len(data[row_idx]) else ''
            display_data.append({
                'label': item.get('label') or '',
                'value': val,
                'highlight': bool(item.get('highlight')),
                'col_id': item.get('col'),
            })

        return {
            'ok': True,
            'cfg': cfg,
            'ledger': ledger,
            'data': data,
            'row_idx': row_idx,
            'row_uuid': row_uuid,
            'lid': gid_lid,
            'display_data': display_data,
        }

    def _apply_scan_action(username, app_id, resolved, action_id,
                           action_value=None):
        cfg = resolved['cfg']
        ledger = resolved['ledger']
        data = resolved['data']
        row_idx = resolved['row_idx']
        row_uuid = resolved['row_uuid']
        lid = resolved['lid']
        display_data = resolved['display_data']

        action = next((a for a in cfg.get('actions', [])
                       if a.get('id') == action_id), None)
        if not action:
            return {'msg': '操作不存在'}, 400
        if action.get('type') != 'set_value':
            return {'msg': '不支持的操作类型'}, 400

        col_uuid = action.get('col')
        col_idx = _col_idx_by_uuid(ledger, col_uuid)
        if col_idx <= 0:
            return {'msg': '目标列不存在'}, 400

        override = action_value
        if override is not None:
            override = str(override)
        value = resolve_action_value(action, override)

        data[row_idx][col_idx] = value
        time_idx = _find_time_col(ledger, data)
        if time_idx > 0:
            data[row_idx][time_idx] = _now_str_scan()

        result = update_ledger(lid, data=data, username=username)
        if result.get('status') == 'busy':
            return {
                'status': 'busy',
                'msg': result.get('msg') or '保存繁忙，请稍后重试',
            }, 200
        if result.get('status') != 'ok':
            return {'msg': result.get('msg') or '保存失败'}, 500

        value_type = str(action.get('value_type') or 'fixed')
        _audit(username, 'scan_action', 'ledger', lid, ledger.get('name'),
               f'{cfg.get("name", app_id)}：{action.get("label")} '
               f'| 行 {row_uuid[:8]} | 值 ({value_type}) {str(value)[:80]}')

        log_cfg = cfg.get('append_log') or {}
        if log_cfg.get('enabled'):
            target_lid = log_cfg.get('ledger_id')
            if is_child_ledger(lid, target_lid):
                _append_log_row(log_cfg, ledger, data[row_idx],
                                action, username, f"L{lid}_{row_uuid}", value)
            else:
                _audit(username, 'scan_append_log_skipped', 'ledger', lid,
                       ledger.get('name'),
                       f'日志目标 #{target_lid} 不是台账 #{lid} 的关联子台账，已跳过')

        for d in display_data:
            if d.get('col_id') == col_uuid:
                d['value'] = value

        return {
            'status': 'ok',
            'action_label': action.get('label'),
            'display_data': display_data,
        }, 200

    @app.route('/scan-login')
    def scan_login():
        next_url = _safe_next(request.args.get('next'), '/scan')
        if 'username' in session:
            return redirect(next_url)
        return render_template('scan-login.html', next_url=next_url)

    @app.route('/scan')
    def scan_home():
        if 'username' not in session:
            return redirect(url_for('scan_login', next='/scan'))
        username = session['username']
        # 有 qr.generate 权限的台账 → 列出对应扫码应用
        apps = []
        for app_id in scan_apps.list_app_ids():
            cfg = scan_apps.load(app_id)
            if not cfg:
                continue
            lid = cfg.get('ledger_id')
            if _can_use_scan_app(username, lid):
                apps.append({
                    'app_id': app_id,
                    'name': cfg.get('name') or app_id,
                    'icon': cfg.get('icon') or '📷',
                    'description': cfg.get('description') or '',
                    'ledger_id': lid,
                })
        return render_template('scan-home.html',
                               username=username, apps=apps)

    @app.route('/scan/<app_id>')
    def scan_app(app_id):
        if 'username' not in session:
            return redirect(url_for('scan_login', next='/scan/' + app_id))
        username = session['username']
        cfg = scan_apps.load(app_id)
        if not cfg:
            return '应用不存在', 404
        if not _can_use_scan_app(username, cfg.get('ledger_id')):
            return '无权使用该应用', 403

        html = render_template(
            'scan.html',
            username=username, app_id=app_id, app_config=cfg,
        )
        resp = make_response(html)
        resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        resp.headers['Pragma'] = 'no-cache'
        resp.headers['Expires'] = '0'
        return resp

    @app.route('/api/scan-apps/<app_id>/scan', methods=['POST'])
    def api_scan_app(app_id):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401

        body = request.get_json(silent=True) or {}
        gid = (body.get('gid') or '').strip()
        action_id = (body.get('action_id') or '').strip()
        action_value = body.get('action_value')
        if not gid:
            return jsonify({'msg': 'gid 不能为空'}), 400

        resolved = _resolve_scan_gid(username, app_id, gid)
        if not resolved.get('ok'):
            payload = {'status': resolved.get('status'),
                       'msg': resolved.get('msg')}
            return jsonify(payload), resolved.get('http', 200)

        if not action_id:
            actions = []
            for a in resolved['cfg'].get('actions', []):
                actions.append({
                    'id': a.get('id'),
                    'label': a.get('label'),
                    'danger': bool(a.get('danger')),
                    'confirm': bool(a.get('confirm')),
                })
            return jsonify({
                'status': 'active',
                'display_data': resolved['display_data'],
                'actions': actions,
            })

        resp, http = _apply_scan_action(username, app_id, resolved,
                                         action_id, action_value)
        return jsonify(resp), http

    # ============================================================
    # 扫码配置（member.manage）
    # ============================================================

    @app.route('/api/ledgers/<int:lid>/columns', methods=['GET'])
    def api_ledger_columns(lid):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        ledger = get_ledger_by_id(lid)
        if not ledger:
            return jsonify({'msg': '台账不存在'}), 404
        if not _perm(username, lid, 'data.view'):
            return jsonify({'msg': '无权访问'}), 403
        data = ledger.get('data') or []
        headers = data[0] if data else []
        col_ids = ledger.get('column_ids') or []
        cols = []
        for i in range(1, min(len(headers), len(col_ids))):
            cols.append({
                'uuid': col_ids[i],
                'name': str(headers[i]) if headers[i] else f'列{i}',
            })
        return jsonify({
            'ledger_id': lid,
            'ledger_name': ledger.get('name'),
            'columns': cols,
            'can_edit': bool(_perm(username, lid, 'data.edit')),
        })

    @app.route('/api/scan-config/apps', methods=['GET'])
    def api_scan_config_list():
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        apps = []
        for app_id in scan_apps.list_app_ids():
            cfg = scan_apps.load(app_id)
            if not cfg:
                continue
            lid = cfg.get('ledger_id')
            if _can_manage_scan_app(username, lid):
                apps.append(cfg)
        return jsonify({'apps': apps})

    @app.route('/api/scan-config/apps', methods=['POST'])
    def api_scan_config_create():
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        body = request.get_json(silent=True) or {}
        app_id = (body.get('app_id') or '').strip()
        cfg = body.get('config') or {}
        if not app_id:
            return jsonify({'msg': 'app_id 不能为空'}), 400
        if scan_apps.exists(app_id):
            return jsonify({'msg': 'app_id 已存在'}), 400
        lid = cfg.get('ledger_id')
        if not _can_manage_scan_app(username, lid):
            return jsonify({'msg': '没有该台账的管理权限'}), 403
        log_cfg = cfg.get('append_log') or {}
        if log_cfg.get('enabled'):
            if not is_child_ledger(lid, log_cfg.get('ledger_id')):
                return jsonify({'msg': '追加日志的目标台账必须是本台账的关联子台账'}), 400
        ok, msg = scan_apps.save(app_id, cfg)
        if not ok:
            return jsonify({'msg': msg}), 400
        _audit(username, 'scan_config_create', 'system', None, app_id, cfg.get('name'))
        return jsonify({'code': 0, 'msg': msg, 'app_id': app_id})

    @app.route('/api/scan-config/apps/<app_id>', methods=['PUT'])
    def api_scan_config_update(app_id):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        old = scan_apps.load(app_id)
        if not old:
            return jsonify({'msg': '应用不存在'}), 404
        if not _can_manage_scan_app(username, old.get('ledger_id')):
            return jsonify({'msg': '没有管理权限'}), 403
        body = request.get_json(silent=True) or {}
        cfg = body.get('config') or {}
        new_lid = cfg.get('ledger_id')
        if not _can_manage_scan_app(username, new_lid):
            return jsonify({'msg': '没有该台账的管理权限'}), 403
        log_cfg = cfg.get('append_log') or {}
        if log_cfg.get('enabled'):
            if not is_child_ledger(new_lid, log_cfg.get('ledger_id')):
                return jsonify({'msg': '追加日志的目标台账必须是本台账的关联子台账'}), 400
        ok, msg = scan_apps.save(app_id, cfg)
        if not ok:
            return jsonify({'msg': msg}), 400
        _audit(username, 'scan_config_update', 'system', None, app_id, cfg.get('name'))
        return jsonify({'code': 0, 'msg': msg})

    @app.route('/api/scan-config/apps/<app_id>', methods=['DELETE'])
    def api_scan_config_delete(app_id):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        cfg = scan_apps.load(app_id)
        if not cfg:
            return jsonify({'msg': '应用不存在'}), 404
        if not _can_manage_scan_app(username, cfg.get('ledger_id')):
            return jsonify({'msg': '没有管理权限'}), 403
        ok, msg = scan_apps.delete(app_id)
        if not ok:
            return jsonify({'msg': msg}), 400
        _audit(username, 'scan_config_delete', 'system', None, app_id, cfg.get('name'))
        return jsonify({'code': 0, 'msg': msg})

    # ============================================================
    # 离线扫码（qr.generate）
    # ============================================================

    @app.route('/scan-config/apps/<app_id>/offline.html', methods=['GET'])
    def scan_config_offline_html(app_id):
        username = session.get('username')
        if not username:
            return redirect(url_for('scan_login',
                                    next=f'/scan-config/apps/{app_id}/offline.html'))

        cfg = scan_apps.load(app_id)
        if not cfg:
            return '应用不存在', 404
        if not _can_use_scan_app(username, cfg.get('ledger_id')):
            return '无权生成该应用的离线页面', 403

        offline_cfg = {
            'app_id': app_id,
            'name': cfg.get('name') or app_id,
            'icon': cfg.get('icon') or '📷',
            'description': cfg.get('description') or '',
            'actions': [
                {
                    'id': a.get('id'),
                    'label': a.get('label'),
                    'danger': bool(a.get('danger')),
                    'confirm': bool(a.get('confirm')),
                }
                for a in (cfg.get('actions') or [])
            ],
        }

        jsqr_code = ''
        try:
            jsqr_path = resource_path('static/jsQR.js')
            with open(jsqr_path, 'r', encoding='utf-8') as f:
                jsqr_code = f.read()
        except (OSError, UnicodeDecodeError) as e:
            print(f'[离线页] 读取 jsQR.js 失败：{e}')

        html = render_template(
            'scan-offline-single.html',
            app_config=offline_cfg,
            jsqr_code=jsqr_code,
        )
        from datetime import datetime as _dt
        day = _dt.now().strftime('%Y%m%d')
        filename = f'offline-{app_id}-{day}.html'
        resp = make_response(html)
        resp.headers['Content-Type'] = 'text/html; charset=utf-8'
        resp.headers['Content-Disposition'] = (
            "attachment; filename*=UTF-8''" + quote(filename, safe='')
        )
        resp.headers['Cache-Control'] = 'no-store'
        _audit(username, 'scan_offline_generate', 'system', None, app_id,
               f'生成离线页面 {filename}')
        return resp

    @app.route('/offline-upload')
    def offline_upload_page():
        if 'username' not in session:
            return redirect(url_for('scan_login', next='/offline-upload'))
        return render_template('scan-offline-upload.html',
                               username=session['username'])

    @app.route('/offline')
    def offline_legacy_redirect():
        return redirect(url_for('offline_upload_page'))

    @app.route('/api/offline/uploads', methods=['GET'])
    def api_offline_uploads_list():
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        is_root = (username == ROOT)
        try:
            limit = int(request.args.get('limit', 50))
        except (TypeError, ValueError):
            limit = 50
        try:
            offset = int(request.args.get('offset', 0))
        except (TypeError, ValueError):
            offset = 0

        batch_id = (request.args.get('batch_id') or '').strip() or None
        app_id = (request.args.get('app_id') or '').strip() or None
        status = (request.args.get('status') or '').strip() or None
        uploaded_by = None if is_root else username

        rows = list_offline_scan_uploads(
            batch_id=batch_id, app_id=app_id,
            uploaded_by=uploaded_by, status=status,
            limit=limit, offset=offset,
        )
        total = count_offline_scan_uploads(
            batch_id=batch_id, app_id=app_id,
            uploaded_by=uploaded_by, status=status,
        )
        return jsonify({
            'uploads': rows, 'total': total,
            'limit': limit, 'offset': offset,
            'is_root': is_root,
        })

    @app.route('/api/offline/uploads', methods=['POST'])
    def api_offline_upload():
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401

        body = request.get_json(silent=True) or {}
        batch_id = (body.get('batch_id') or '').strip()
        scans = body.get('scans') or []
        if not batch_id:
            return jsonify({'msg': 'batch_id 不能为空'}), 400
        if not isinstance(scans, list) or not scans:
            return jsonify({'msg': 'scans 不能为空'}), 400
        if len(scans) > 5000:
            return jsonify({'msg': '单批次最多 5000 条'}), 400

        ok_n = 0
        fail_n = 0
        skip_n = 0
        results = []

        for idx, item in enumerate(scans):
            if not isinstance(item, dict):
                fail_n += 1
                results.append({'index': idx, 'status': 'failed', 'msg': '格式错误'})
                continue

            app_id = (item.get('app_id') or '').strip()
            gid = (item.get('gid') or '').strip()
            action_id = (item.get('action_id') or '').strip()
            action_value = item.get('action_value')
            scanned_at = (item.get('scanned_at') or '').strip()
            client_uuid = (item.get('client_uuid') or '').strip()

            if not app_id or not gid or not action_id:
                fail_n += 1
                results.append({'index': idx, 'status': 'failed',
                                'msg': '缺少 app_id / gid / action_id'})
                continue

            existing = check_offline_exists(batch_id, gid, action_id, scanned_at)
            if existing == 'ok':
                skip_n += 1
                results.append({'index': idx, 'status': 'skipped',
                                'msg': '该记录之前已成功上传'})
                continue

            resolved = _resolve_scan_gid(username, app_id, gid)
            if not resolved.get('ok'):
                fail_n += 1
                msg = resolved.get('msg') or '校验失败'
                results.append({'index': idx, 'status': 'failed', 'msg': msg})
                add_offline_scan_upload(
                    batch_id, client_uuid, app_id, gid,
                    action_id, action_value, scanned_at,
                    username, 'failed', msg,
                )
                continue

            resp, http = _apply_scan_action(
                username, app_id, resolved, action_id, action_value
            )
            st = resp.get('status') or ('ok' if http == 200 and 'msg' not in resp else 'failed')

            if st == 'ok':
                ok_n += 1
                results.append({'index': idx, 'status': 'ok',
                                'action_label': resp.get('action_label')})
                add_offline_scan_upload(
                    batch_id, client_uuid, app_id, gid,
                    action_id, action_value, scanned_at,
                    username, 'ok', None,
                    resolved.get('lid'), resolved.get('row_uuid'),
                )
            elif st == 'busy':
                fail_n += 1
                msg = resp.get('msg') or '保存繁忙'
                results.append({'index': idx, 'status': 'busy', 'msg': msg})
                add_offline_scan_upload(
                    batch_id, client_uuid, app_id, gid,
                    action_id, action_value, scanned_at,
                    username, 'failed', 'busy: ' + msg,
                    resolved.get('lid'), resolved.get('row_uuid'),
                )
            else:
                fail_n += 1
                msg = resp.get('msg') or '失败'
                results.append({'index': idx, 'status': 'failed', 'msg': msg})
                add_offline_scan_upload(
                    batch_id, client_uuid, app_id, gid,
                    action_id, action_value, scanned_at,
                    username, 'failed', msg,
                    resolved.get('lid'), resolved.get('row_uuid'),
                )

        _audit(username, 'offline_upload', 'system', None, batch_id,
               f'批次 {batch_id}：成功 {ok_n}，失败 {fail_n}，跳过 {skip_n}')

        return jsonify({
            'code': 0,
            'batch_id': batch_id,
            'ok': ok_n,
            'failed': fail_n,
            'skipped': skip_n,
            'total': len(scans),
            'results': results,
        })

    @app.route('/api/offline/uploads/<batch_id>', methods=['GET'])
    def api_offline_uploads_batch(batch_id):
        username = session.get('username')
        if not username:
            return jsonify({'msg': '未登录'}), 401
        is_root = (username == ROOT)
        uploaded_by = None if is_root else username

        rows = list_offline_scan_uploads(
            batch_id=batch_id, uploaded_by=uploaded_by, limit=500,
        )
        return jsonify({
            'batch_id': batch_id,
            'rows': rows,
            'is_root': is_root,
        })

    # 启动数据库定期备份后台线程（幂等；直接运行与 WSGI 部署均会触发一次）
    backup_scheduler.start()

    return app


# ============================================================
# 启动
# ============================================================

def _serve_waitress(app, host, port, cert_key=None):
    from waitress import serve

    common = dict(
        threads=24,
        connection_limit=200,
        channel_timeout=60,
        cleanup_interval=30,
        expose_tracebacks=False,
        ident='LedgerEditor',
        asyncore_use_poll=False,
        backlog=1024,
        recv_bytes=8192,
        send_bytes=8192,
        max_request_body_size=150 * 1024 * 1024,
        max_request_header_size=65536,
        channel_request_lookahead=0,
        inbuf_overflow=524288,
    )

    if cert_key is None:
        print(f'[*] waitress 启动：http://{host}:{port}  threads={common["threads"]}')
        serve(app, host=host, port=port, url_scheme='http', **common)
        return

    import ssl, socket
    cert_path, key_path = cert_key

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert_path, key_path)
    try:
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    except Exception:
        pass

    raw = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    raw.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    raw.bind((host, port))
    raw.listen(1024)
    ssl_sock = ctx.wrap_socket(raw, server_side=True)

    print(f'[*] waitress 启动：https://{host}:{port}  threads={common["threads"]}')
    try:
        serve(app, sockets=[ssl_sock], url_scheme='https', **common)
    finally:
        try:
            ssl_sock.close()
        except Exception:
            pass


def service(service_ip, service_port, backend='auto', use_https=True):
    cert_key = None
    if use_https:
        try:
            from cert_helper import ensure_cert
            extra = [] if service_ip in ('0.0.0.0', '') else [service_ip]
            cert_path, key_path = ensure_cert(extra_ips=extra)
            cert_key = (cert_path, key_path)
            print(f'[HTTPS] 证书 : {cert_path}')
            print(f'[HTTPS] 私钥 : {key_path}')
        except Exception as e:
            print(f'[警告] 生成证书失败，回退到 HTTP：{e}')
            use_https = False
            cert_key = None
    app = create_app(secure_cookie=use_https)
    if backend == 'auto':
        try:
            import waitress  # noqa: F401
            backend = 'waitress'
        except ImportError:
            backend = 'flask'
    if backend == 'waitress':
        _serve_waitress(app, service_ip, service_port, cert_key)
    else:
        scheme = 'https' if cert_key else 'http'
        print(f'[*] Flask 内置服务器启动：{scheme}://{service_ip}:{service_port}')
        kwargs = dict(host=service_ip, port=service_port, debug=False)
        if cert_key:
            kwargs['ssl_context'] = cert_key
        app.run(**kwargs)