/* assets.js —— 资产管理（真实后端：Asset.db + /api/assets*） */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function lsGet(k, fallback) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var LS_COLS = 'asset_demo_colcfg_v1';
  var CSRF = (typeof window.CSRF !== 'undefined') ? window.CSRF : '';
  var USER = (typeof CURRENT_USER !== 'undefined') ? CURRENT_USER : '';
  var ORG = (typeof CURRENT_ORG !== 'undefined' && CURRENT_ORG) ? CURRENT_ORG : '';
  var IS_ADMIN = !!(typeof CAN_MANAGE_USERS !== 'undefined' && CAN_MANAGE_USERS);
  var IS_SUPER = !!(typeof IS_SUPER_ADMIN !== 'undefined' && IS_SUPER_ADMIN);

  /* 统一 API 封装（沿用 editor-core.js 的约定） */
  async function api(url, options) {
    options = options || {};
    var headers = options.headers || {};
    if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (CSRF) headers['X-CSRF-Token'] = CSRF;
    var res = await fetch(url, { method: options.method || 'GET', headers: headers,
      body: options.body ? (options.body instanceof FormData ? options.body : JSON.stringify(options.body)) : undefined,
      credentials: 'same-origin' });
    var data;
    try { data = await res.json(); } catch (e) { data = { msg: '响应解析失败' }; }
    if (res.status === 401) { location.href = '/'; throw new Error('未登录'); }
    if (!res.ok) { var err = new Error(data.msg || ('请求失败 ' + res.status)); err.status = res.status; err.data = data; throw err; }
    return data;
  }

  /* 服务端数据镜像 */
  var myAssets = [], shipments = [], customFields = [], locations = [], locFields = [];
  var PEOPLE = [];

  async function bootstrap() {
    var d = await api('/api/assets/bootstrap');
    USER = d.user || USER;
    myAssets = (d.assets || []).map(function (a) {
      a.user = a.owner;
      a.inType = a.in_type || a.inType;
      a.locValues = a.locValues || {};
      return a;
    });
    shipments = (d.incoming || []).concat(d.outgoing || []).map(function (s) {
      return {
        id: s.id, code: s.code, name: s.name, type: s.type,
        fromUser: s.from_user, fromOrg: s.from_org, fromOperator: s.from_operator,
        toUser: s.to_user, toOrg: s.to_org, date: s.date, note: s.note,
        status: s.status, customValues: s.customValues || {}, receivedBy: s.received_by,
        attachments: []
      };
    });
    customFields = d.custom_fields || [];
    locations = d.locations || [];
    locFields = d.loc_fields || [];
    PEOPLE = [{ name: USER, org: d.org_name || ORG, self: true }];
    (d.people || []).forEach(function (u) { PEOPLE.push({ name: u.username, org: u.org || '' }); });
    return d;
  }
  function orgOf(name) {
    for (var i = 0; i < PEOPLE.length; i++) if (PEOPLE[i].name === name) return PEOPLE[i].org;
    return '';
  }
  function assetsOf(u) { return myAssets.filter(function (a) { return (a.owner || a.user) === u; }); }
  function pendingFor(u) { return shipments.filter(function (s) { return (s.toUser || s.to_user) === u && s.status === 'pending'; }); }
  function sentBy(u) { return shipments.filter(function (s) { return (s.fromUser || s.from_user) === u; }); }
  var simUser = USER; // 保留变量名以兼容 UI 代码，但不再可切换

  function uid() {
    var s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = 'ASSET-';
    for (var i = 0; i < 10; i++) out += s.charAt(Math.floor(Math.random() * s.length));
    return out;
  }
  function nowDate() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function nowFull() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  /* 生命周期事件：时间 / 地点 / 来自谁 / 给谁 / 经办人 / 备注 */
  function lifeEvent(type, title, opt) {
    opt = opt || {};
    return {
      ts: Date.now(), type: type, title: title, time: opt.time || nowFull(),
      place: opt.place || '—', from: opt.from || '', to: opt.to || '',
      person: opt.person || simUser, note: opt.note || '',
      changes: opt.changes || null
    };
  }

  /* ---------- 展示列配置 ---------- */
  var ALL_COLS = ['资产唯一编码', '所属组织', '所属用户', '资产名称', '资产类型',
                  '入库类型', '入库位置', '经办人', '来源', '入库日期', '附件'];
  var DEFAULT_COLS = ['资产唯一编码', '所属组织', '所属用户', '资产名称', '入库类型', '入库位置'];
  var savedCols = lsGet(LS_COLS, null);
  var state = {
    view: 'my', cols: Array.isArray(savedCols) ? savedCols : DEFAULT_COLS.slice(),
    page: 1, pageSize: 10, preview: 'row', current: null, addedThisSession: 0, addedByUser: {},
    selected: {},  // 勾选的资产编码（按资产唯一编码去重）
    filters: {}    // 列筛选：{ 列名: {mode, op, value, from, to, values} }
  };
  function saveCols() { lsSet(LS_COLS, state.cols); }

  /* 示例台账数据（结构与我的资产台账一致，仅供切换查看，不写入） */
  function demoLedgerRows(key) {
    var prefix = key === 'inventory' ? 'INV' : 'INS';
    var types = ['服务器', '交换机', '路由器', '存储'];
    var out = [];
    for (var i = 0; i < 60; i++) {
      out.push({
        code: prefix + '-' + String(i + 1).padStart(4, '0'),
        org: ['华东分公司', '华北分公司', '总部'][i % 3],
        user: ['张伟', '李娜', '王强'][i % 3],
        name: types[i % types.length] + '-' + (i + 1),
        type: types[i % types.length],
        inType: '采购入库', location: ['A机房-01柜', '核心机房-08柜'][i % 2],
        operator: '系统', source: '示例供应商', date: '2026-01-15',
        files: [], locValues: {}, addedAt: 0
      });
    }
    return out;
  }
  function currentRows() {
    var rows = state.view === 'my' ? assetsOf(simUser) : demoLedgerRows(state.view);
    return applyFilters(rows);
  }

  /* ---------- 按列筛选 ---------- */
  function columnType(col) {
    if (col.indexOf('cf:') === 0) {
      var n = col.slice(3);
      for (var i = 0; i < customFields.length; i++) {
        if (customFields[i].name === n) return customFields[i].type || 'text';
      }
      return 'text';
    }
    if (col === '入库日期') return 'date';
    // 有限枚举值列：像表格一样按值勾选筛选
    var enumCols = ['资产类型', '所属组织', '所属用户', '入库类型', '入库位置', '经办人'];
    if (enumCols.indexOf(col) >= 0) return 'select';
    if (col === '附件') return 'text';
    return 'text';
  }
  function columnLabel(col) { return col.indexOf('cf:') === 0 ? col.slice(3) : col; }

  function applyFilters(rows) {
    var keys = Object.keys(state.filters);
    if (!keys.length) return rows;
    return rows.filter(function (r) {
      for (var i = 0; i < keys.length; i++) {
        if (!matchFilter(r, keys[i], state.filters[keys[i]])) return false;
      }
      return true;
    });
  }
  function matchFilter(r, col, f) {
    var raw = cellValue(r, col);
    var v = String(raw == null ? '' : raw);
    var isEmpty = v === '' || v === '—';
    if (f.mode === 'set') {
      if (!f.values || !f.values.length) return true;
      return f.values.indexOf(v) >= 0;
    }
    if (f.op === 'empty') return isEmpty;
    if (f.op === 'notempty') return !isEmpty;
    if (f.mode === 'range') {
      var from = f.from || '', to = f.to || '';
      if (!from && !to) return true;
      if (isEmpty) return false;
      if (columnType(col) === 'number') {
        var num = Number(v);
        if (from && !(num >= Number(from))) return false;
        if (to && !(num <= Number(to))) return false;
        return true;
      }
      // 日期按字符串比较（YYYY-MM-DD 可直接字典序比较）
      if (from && v < from) return false;
      if (to && v > to) return false;
      return true;
    }
    var needle = String(f.value || '');
    if (!needle) return true;
    switch (f.op) {
      case 'eq': return v === needle;
      case 'neq': return v !== needle;
      case 'start': return v.indexOf(needle) === 0;
      case 'end': return v.slice(-needle.length) === needle;
      case 'notcontains': return v.indexOf(needle) < 0;
      case 'contains':
      default: return v.indexOf(needle) >= 0;
    }
  }

  function updateBadges() {
    var n = pendingFor(simUser).length;
    [['pendingBadge'], ['pendingTabBadge']].forEach(function (p) {
      var el = $(p[0]);
      if (!el) return;
      el.textContent = n;
      el.classList.toggle('hidden', n === 0);
    });
    var sum = $('pendingSummary');
    if (sum) sum.textContent = n
      ? ('你有 ' + n + ' 张待接收单，来源由对方出库时生成，接收时自动带出。')
      : '采购入库随机生成编码；接收调拨来自他人出库，来源自动带出。';
  }

  function renderMyLedgerCard() {
    $('mlName').textContent = simUser + '的资产台账';
    $('mlCount').textContent = assetsOf(simUser).length;
    $('mlAdded').textContent = state.addedByUser[simUser] || 0;
    updateBadges();
  }

  /* ---------- 筛选面板 ---------- */
  var filterCol = null;
  var TEXT_OPS = [
    ['contains', '包含'], ['notcontains', '不包含'], ['eq', '等于'],
    ['neq', '不等于'], ['start', '开头是'], ['end', '结尾是'],
    ['empty', '为空'], ['notempty', '不为空']
  ];

  function openFilterPanel(col, btn) {
    filterCol = col;
    var panel = $('filterPanel');
    var type = columnType(col);
    var cur = state.filters[col] || {};
    $('fpTitle').textContent = '筛选 · ' + columnLabel(col);
    var body = $('fpBody');
    var html = '';

    if (type === 'select') {
      // 值多选：收集该列所有唯一值（基于未筛选的当前台账）
      var base = state.view === 'my' ? assetsOf(simUser) : demoLedgerRows(state.view);
      var vals = {};
      base.forEach(function (r) {
        var v = cellValue(r, col);
        if (v && v !== '—') vals[v] = true;
      });
      var keys = Object.keys(vals).sort();
      var picked = cur.mode === 'set' ? (cur.values || []) : [];
      html += '<div class="fp-values">' + (keys.length
        ? keys.map(function (v) {
            return '<label><input type="checkbox" data-fp-value="' + esc(v) + '"' +
              (picked.indexOf(v) >= 0 ? ' checked' : '') + '> ' + esc(v) + '</label>';
          }).join('')
        : '<span class="hint">该列暂无可选值</span>') + '</div>';
    } else if (type === 'date' || type === 'number') {
      var ftype = type === 'date' ? 'date' : 'number';
      html += '<div class="fld"><label>起始' + (type === 'date' ? '日期' : '值') + '</label>' +
        '<input type="' + ftype + '" id="fpFrom" value="' + esc(cur.from || '') + '"></div>';
      html += '<div class="fld"><label>结束' + (type === 'date' ? '日期' : '值') + '</label>' +
        '<input type="' + ftype + '" id="fpTo" value="' + esc(cur.to || '') + '"></div>';
    } else {
      var ops = TEXT_OPS;
      var op = cur.op || 'contains';
      html += '<div class="fld"><label>条件</label><select id="fpOp">' +
        ops.map(function (o) {
          return '<option value="' + o[0] + '"' + (o[0] === op ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select></div>';
      html += '<div class="fld"><label>值</label><input type="text" id="fpValue" value="' +
        esc(cur.value || '') + '" placeholder="输入筛选内容"></div>';
    }
    body.innerHTML = html;

    var rect = btn.getBoundingClientRect();
    panel.classList.remove('hidden');
    panel.style.left = Math.min(rect.left, window.innerWidth - 270) + 'px';
    panel.style.top = (rect.bottom + 4) + 'px';
  }
  function closeFilterPanel() { $('filterPanel').classList.add('hidden'); filterCol = null; }

  function applyFilterFromPanel() {
    if (!filterCol) return;
    var type = columnType(filterCol);
    var cond;
    if (type === 'select') {
      var vals = [];
      Array.prototype.forEach.call($('fpBody').querySelectorAll('[data-fp-value]'), function (cb) {
        if (cb.checked) vals.push(cb.dataset.fpValue);
      });
      cond = { mode: 'set', values: vals };
    } else if (type === 'date' || type === 'number') {
      cond = { mode: 'range', from: $('fpFrom').value.trim(), to: $('fpTo').value.trim() };
    } else {
      cond = { mode: 'text', op: $('fpOp').value, value: $('fpValue').value.trim() };
    }
    var active = (cond.mode === 'set' && cond.values.length) ||
      (cond.mode === 'range' && (cond.from || cond.to)) ||
      (cond.mode === 'text' && (cond.value || cond.op === 'empty' || cond.op === 'notempty'));
    if (active) state.filters[filterCol] = cond;
    else delete state.filters[filterCol];
    state.page = 1;
    state.selected = {};
    closeFilterPanel();
    renderTable();
  }
  function resetColumnFilter() {
    if (!filterCol) return;
    delete state.filters[filterCol];
    state.page = 1;
    closeFilterPanel();
    renderTable();
  }
  function clearAllFilters() {
    state.filters = {};
    state.page = 1;
    state.selected = {};
    closeFilterPanel();
    renderTable();
  }

  /* ---------- 资产列表勾选 ---------- */
  function canOperate() { return state.view === 'my'; }
  function selectedCodes() {
    // 只保留当前身份台账里仍存在的编码，避免删除/出库后残留失效勾选
    var valid = {};
    assetsOf(simUser).forEach(function (a) { if (state.selected[a.code]) valid[a.code] = true; });
    state.selected = valid;
    return Object.keys(valid);
  }
  function isSelected(code) { return !!state.selected[code]; }
  function clearSelection() { state.selected = {}; renderTable(); }
  function updateBatchBar() {
    var bar = $('assetBatchBar');
    if (!bar) return;
    var codes = selectedCodes();
    bar.classList.toggle('hidden', !codes.length);
    $('assetSelCount').textContent = codes.length;
  }
  function toggleSelect(code, checked) {
    if (checked) state.selected[code] = true;
    else delete state.selected[code];
    renderTable();
  }
  function toggleSelectAll(checked) {
    var rows = currentRows();
    var start = (state.page - 1) * state.pageSize;
    rows.slice(start, start + state.pageSize).forEach(function (r) {
      if (checked) state.selected[r.code] = true;
      else delete state.selected[r.code];
    });
    renderTable();
  }

  function renderColCfg() {
    var host = $('colCfg');
    var hint = host.querySelector('.hint');
    host.innerHTML = '';
    host.appendChild(hint);
    var cols = ALL_COLS.concat(customFields.map(function (f) { return cfKey(f.name); }));
    cols.forEach(function (c) {
      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.cols.indexOf(c) >= 0;
      cb.addEventListener('change', function () {
        if (cb.checked && state.cols.indexOf(c) < 0) state.cols.push(c);
        if (!cb.checked) state.cols = state.cols.filter(function (x) { return x !== c; });
        saveCols(); renderTable();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(c.indexOf('cf:') === 0 ? c.slice(3) : c));
      host.appendChild(label);
    });
  }

  function cellValue(r, col) {
    if (col.indexOf('cf:') === 0) {
      var n = col.slice(3);
      return (r.custom && r.custom[n]) ? r.custom[n] : '—';
    }
    switch (col) {
      case '资产唯一编码': return r.code;
      case '所属组织': return r.org;
      case '所属用户': return r.owner || r.user;
      case '资产名称': return r.name;
      case '资产类型': return r.type || '—';
      case '入库类型': return r.in_type || r.inType;
      case '入库位置': return r.location || '—';
      case '经办人': return r.operator || '—';
      case '来源': return r.source || '—';
      case '入库日期': return r.date;
      case '附件': return (r.files && r.files.length) ? (r.files.length + ' 个') : '—';
      default: return '—';
    }
  }

  function renderTable() {
    var head = document.querySelector('#assetTable thead');
    var body = document.querySelector('#assetTable tbody');
    var cardHost = $('cardPreview');
    var isCard = state.preview === 'card';
    $('assetTable').classList.toggle('hidden', isCard);
    cardHost.classList.toggle('hidden', !isCard);

    head.innerHTML = '<tr><th style="width:110px;">' +
      '<input type="checkbox" id="headCheck" class="head-check" title="全选本页">' +
      '<span style="margin-left:5px;">序号</span></th>' +
      state.cols.map(function (c) {
        var active = !!state.filters[c];
        return '<th><span class="th-inner">' + esc(columnLabel(c)) +
          '<button class="filter-btn' + (active ? ' active' : '') + '" data-filter="' + esc(c) + '"' +
          ' title="' + (active ? '已筛选，点击修改' : '按此列筛选') + '">' + (active ? '▼' : '▽') + '</button>' +
          '</span></th>';
      }).join('') + '</tr>';
    var rows = currentRows();
    var total = rows.length;
    var start = (state.page - 1) * state.pageSize;
    var pageRows = rows.slice(start, start + state.pageSize);
    var viewName = state.view === 'my' ? ('我的资产台账（' + simUser + '）') : (state.view === 'inventory' ? '库存台账（示例）' : '巡检记录（示例）');
    var filterCount = Object.keys(state.filters).length;
    $('listMeta').textContent = viewName + ' · ' + (filterCount ? ('筛选后 ' + total + ' 条 / 全部 ' +
      (state.view === 'my' ? assetsOf(simUser).length : demoLedgerRows(state.view).length) + ' 条') : ('共 ' + total + ' 条')) +
      ' · 第 ' + state.page + ' 页' + (state.view === 'my' ? '（入库后自动追加）' : '（示例数据，只读）');
    $('btnClearFilters').classList.toggle('hidden', filterCount === 0);

    body.innerHTML = pageRows.map(function (r, idx) {
      var title = r.name + '（' + r.code + '）';
      var sel = isSelected(r.code);
      return '<tr class="' + (canOperate() ? 'clickable' : '') + (sel ? ' sel-row' : '') + '" data-code="' + esc(r.code) + '">' +
        '<td><span class="row-check-wrap">' +
        '<input type="checkbox" class="row-check" data-code="' + esc(r.code) + '"' + (sel ? ' checked' : '') +
        (canOperate() ? '' : ' disabled') + '>' +
        (start + idx + 1) + '</span></td>' +
        state.cols.map(function (c) {
          var v = cellValue(r, c);
          if (c === '入库类型') {
            var cls = v === '采购入库' ? 'tag-green' : 'tag-blue';
            return '<td><span class="tag ' + cls + '">' + esc(v) + '</span></td>';
          }
          return '<td title="' + esc(title) + '">' + esc(v) + '</td>';
        }).join('') + '</tr>';
    }).join('') || '<tr><td colspan="' + (state.cols.length + 1) + '" class="empty">' +
      (filterCount ? '没有符合当前筛选条件的记录，请调整或清除筛选' :
        '台账为空，请先在上方「出入库操作」采购入库，或在对方出库后接收调拨') + '</td></tr>';

    // 全选框状态：本页全选则 checked，部分选中则半选
    var hc = $('headCheck');
    if (hc) {
      var pageCodes = pageRows.map(function (r) { return r.code; });
      var all = pageCodes.length > 0 && pageCodes.every(function (c) { return isSelected(c); });
      var some = pageCodes.some(function (c) { return isSelected(c); });
      hc.checked = all;
      hc.indeterminate = !all && some;
      hc.disabled = !canOperate() || !pageCodes.length;
      hc.addEventListener('change', function () { toggleSelectAll(this.checked); });
    }
    head.querySelectorAll('.filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (filterCol === btn.dataset.filter && !$('filterPanel').classList.contains('hidden')) {
          closeFilterPanel();
        } else {
          openFilterPanel(btn.dataset.filter, btn);
        }
      });
    });
    body.querySelectorAll('.row-check').forEach(function (cb) {
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () { toggleSelect(cb.dataset.code, cb.checked); });
    });
    body.querySelectorAll('tr[data-code]').forEach(function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.closest('input')) return;
        openEditModal(tr.dataset.code);
      });
    });
    updateBatchBar();

    cardHost.innerHTML = pageRows.map(function (r, idx) {
      var sel = isSelected(r.code);
      return '<div class="subcard' + (sel ? ' sel-row' : '') + '" data-code="' + esc(r.code) + '" style="margin-bottom:10px;' + (canOperate() ? 'cursor:pointer;' : '') + '">' +
        '<div class="t"><input type="checkbox" class="row-check" data-code="' + esc(r.code) + '"' + (sel ? ' checked' : '') +
        (canOperate() ? '' : ' disabled') + '> ' +
        '<span class="ic">#</span> ' + esc(r.code) + ' · ' + esc(r.name) + '</div>' +
        '<p>' + state.cols.filter(function (c) { return c !== '资产唯一编码' && c !== '资产名称'; })
          .map(function (c) { return esc(c) + '：' + esc(cellValue(r, c)); }).join('　') + '</p></div>';
    }).join('') +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:10px;">' +
      '<button class="btn sm" id="prevPage"' + (state.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<span class="hint">第 ' + state.page + ' 页</span>' +
      '<button class="btn sm" id="nextPage"' + (start + state.pageSize >= total ? ' disabled' : '') + '>下一页</button></div>';
    cardHost.querySelectorAll('.row-check').forEach(function (cb) {
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () { toggleSelect(cb.dataset.code, cb.checked); });
    });
    cardHost.querySelectorAll('[data-code]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.closest('input')) return;
        openEditModal(el.dataset.code);
      });
    });
    var pp = $('prevPage'), np = $('nextPage');
    if (pp) pp.addEventListener('click', function () { state.page--; renderTable(); });
    if (np) np.addEventListener('click', function () { state.page++; renderTable(); });
  }

  /* ---------- 6 大业务模块（保留原 demo 内容，统计改为真实条数） ---------- */
  var MODULES = {
    inout: {
      title: '出入库', desc: '登记资产的入库、出库业务，关联单据与经手人；所有操作留痕可追溯。',
      cards: [
        { t: '🟢 采购入库', p: '随机生成唯一编码，上传采购单附件留存。', fields: ['采购日期', '供应商'] },
        { t: '📥 接收调拨', p: '选择对方发来的待接收单，来源自动带出不可改。', fields: ['入库位置', '接收经办人'] },
        { t: '📤 出库登记', p: '从我的台账选资产、指定接收方，生成待接收单。', fields: ['接收方', '出库经办人'] }
      ]
    },
    transfer: {
      title: '调拨转移', desc: '部门 / 人员 / 位置变更，全流程留痕，记录变更前后的值。',
      cards: [
        { t: '🏢 部门变更', p: '将资产调拨到其他部门。', fields: ['调入部门', '调拨原因'] },
        { t: '👤 人员变更', p: '变更资产负责人 / 使用人。', fields: ['新负责人', '交接日期'] },
        { t: '📍 位置变更', p: '机房、机柜或存放位置调整。', fields: ['新位置', '变更原因'] }
      ],
      timeline: [['2026-09-12', '部门变更：技术部 → 运维部'], ['2026-06-03', '位置变更：A机房-03柜 → 核心机房-08柜']]
    },
    maint: {
      title: '维修保养', desc: '报修单、维修记录、保养计划与到期提醒。',
      cards: [
        { t: '🛠️ 报修单', p: '提交报修，填写故障现象、紧急程度。', fields: ['故障现象', '紧急程度'] },
        { t: '🔧 维修记录', p: '记录维修过程、配件、费用。', fields: ['维修方', '维修费用'] },
        { t: '📅 保养计划', p: '设置保养周期与到期提醒。', fields: ['保养周期', '提醒天数'] }
      ]
    },
    count: {
      title: '盘点', desc: '盘点计划、PDA/扫码盘点、盘盈盘亏处理与差异审批。',
      cards: [
        { t: '📋 盘点计划', p: '创建盘点任务，指定范围与盘点人。', fields: ['盘点范围', '截止时间'] },
        { t: '📱 PDA/扫码盘点', p: '通过 PDA 或扫码录入实盘数量。（占位）', fields: ['扫码设备', '盘点批次'] },
        { t: '⚖️ 盘盈盘亏', p: '比对账实差异并生成处理单。', fields: ['账面数量', '实盘数量'] },
        { t: '✅ 差异审批', p: '差异结果提交审批。', fields: ['审批人', '审批意见'] }
      ]
    },
    dispose: {
      title: '报废处置', desc: '报废申请、审批、处置方式与残值记录。',
      cards: [
        { t: '📝 报废申请', p: '提交报废申请，填写原因与预计残值。', fields: ['报废原因', '预计残值'] },
        { t: '✅ 报废审批', p: '按审批流审核。', fields: ['审批人', '审批意见'] },
        { t: '♻️ 处置方式', p: '变卖 / 拆解 / 捐赠 / 销毁。', fields: ['处置方式', '处置日期'] },
        { t: '💰 残值记录', p: '登记残值回收金额。', fields: ['实际残值', '凭证编号'] }
      ]
    },
    ledger: {
      title: '资产台账', desc: '多条件查询、组合筛选、导出。',
      cards: [
        { t: '🔍 多条件查询', p: '按编号、名称、组织、状态组合查询。', fields: ['关键词', '所属组织'] },
        { t: '🎯 组合筛选', p: '多维度筛选，快速定位。', fields: ['资产类型', '入库位置'] },
        { t: '📤 导出', p: '导出当前筛选结果。（占位）', fields: ['导出字段', '文件格式'] }
      ]
    }
  };
  function renderModule(key) {
    var m = MODULES[key];
    if (!m) return '';
    var html = '<h4>' + esc(m.title) + '</h4><p class="mod-desc">' + esc(m.desc) + '</p>';
    html += '<div class="stat-row">' +
      '<div class="stat"><div class="n">' + assetsOf(simUser).length + '</div><div class="l">台账资产总数</div></div>' +
      '<div class="stat"><div class="n">' + (state.addedByUser[simUser] || 0) + '</div><div class="l">本次会话入库</div></div>' +
      '<div class="stat"><div class="n">' + locations.length + '</div><div class="l">可选位置数</div></div>' +
      '</div>';
    html += '<div class="subgrid">' + m.cards.map(function (c) {
      return '<div class="subcard"><div class="t"><span class="ic">' + esc(c.t.charAt(0)) + '</span>' + esc(c.t.slice(1)) + '</div>' +
        '<p>' + esc(c.p) + '</p>' +
        '<div class="form-row">' + c.fields.map(function (f) {
          return '<input type="text" placeholder="' + esc(f) + '">';
        }).join('') + '</div>' +
        '<div class="form-row"><button class="btn sm primary demo-act">提交（Demo）</button></div></div>';
    }).join('') + '</div>';
    if (m.timeline) {
      html += '<h4 style="margin-top:18px;">变更留痕</h4><div class="timeline">' +
        m.timeline.map(function (t) { return '<div class="ti"><b>' + esc(t[0]) + '</b>　' + esc(t[1]) + '</div>'; }).join('') + '</div>';
    }
    return html;
  }

  /* ---------- 抽屉（保留，从列表行按钮进入） ---------- */
  function openDrawer(idx) {
    state.current = currentRows()[idx];
    if (!state.current) return;
    $('drawerAsset').textContent = '资产编号：' + state.current.code + '　资产名称：' + state.current.name +
      '　所属组织：' + state.current.org;
    $('drawerBody').innerHTML = renderModule('inout');
    $('drawerTabs').querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.mod === 'inout'); });
    $('drawer').classList.add('open'); $('overlay').classList.add('show');
  }
  function closeDrawer() { $('drawer').classList.remove('open'); $('overlay').classList.remove('show'); }
  /* ---------- 更新台账信息（点击列表行进入） ---------- */
  var editingCode = null;
  /* ---------- 入库弹窗（采购 / 接收调拨） ---------- */
  var inTab = 'purchase';
  var selectedShip = null;

  function openInModal(tab) {
    inTab = tab || 'purchase';
    $('inModal').classList.add('show');
    $('inTabPurchase').classList.toggle('hidden', inTab !== 'purchase');
    $('inTabRecycle').classList.toggle('hidden', inTab !== 'recycle');
    $('inModal').querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.intab === inTab);
    });
    if (inTab === 'purchase') {
      $('inPurCode').value = '';
      $('inGenCode').click();
      renderCustomInputs('inPurCustom', 'purchase');
    } else {
      selectedShip = null;
      $('inRecForm').classList.add('hidden');
      fillLocationSelect();
      renderRecLocFields();
      renderCustomInputs('inRecCustom', 'receive');
      renderPendingList();
      updateBadges();
    }
  }
  function closeInModal() { $('inModal').classList.remove('show'); }

  function renderPendingList() {
    var host = $('inPendingList');
    var list = pendingFor(simUser);
    if (!list.length) {
      host.innerHTML = '<div class="ship-empty">暂无发给你的待接收单。请让对方在「出库登记」中指定你为接收方，或切换顶部模拟身份演示。</div>';
      return;
    }
    host.innerHTML = list.map(function (s) {
      return '<div class="ship-card' + (selectedShip && selectedShip.id === s.id ? ' sel' : '') + '" data-ship="' + esc(s.id) + '">' +
        '<div class="sc-t"><span class="tag tag-blue">待接收</span>' + esc(s.code) + ' · ' + esc(s.name) + '</div>' +
        '<div class="sc-m">来源：' + esc(s.fromUser) + ' / ' + esc(s.fromOrg) + '（经办 ' + esc(s.fromOperator) + '）　发出：' + esc(s.date) +
        (s.note ? '　备注：' + esc(s.note) : '') + esc(attachSummary(s.attachments)) + '</div></div>';
    }).join('');
    host.querySelectorAll('[data-ship]').forEach(function (el) {
      el.addEventListener('click', function () { selectShip(el.dataset.ship); });
    });
  }

  function selectShip(id) {
    var found = null;
    pendingFor(simUser).forEach(function (s) { if (s.id === id) found = s; });
    if (!found) return;
    selectedShip = found;
    $('inRecCode').value = found.code;
    $('inRecName').value = found.name;
    $('inRecSource').value = found.fromUser + ' / ' + found.fromOrg;
    $('inRecSrcOperator').value = found.fromOperator;
    $('inRecDate').value = nowDate();
    $('inRecOrg').value = orgOf(simUser) || '默认组织';
    $('inRecOperator').value = simUser;
    $('inRecLoc').value = '';
    renderRecLocFields();
    fillCustomValues('inRecCustom', 'receive', found.customValues);
    var attEl = $('inRecAttach');
    if (attEl) {
      attEl.classList.toggle('hidden', !(found.attachments && found.attachments.length));
      attEl.textContent = '📎 本单交接单：' + (found.attachments || []).map(function (f) { return f.name; }).join('、');
    }
    renderPendingList();
    $('inRecForm').classList.remove('hidden');
  }

  function fillLocationSelect() {
    var sel = $('inRecLoc');
    sel.innerHTML = '<option value="">请选择位置</option>' + locations.map(function (l) {
      return '<option value="' + esc(l) + '">' + esc(l) + '</option>';
    }).join('');
  }
  function renderRecLocFields() {
    var host = $('inRecLocFields');
    if (!locFields.length) { host.innerHTML = ''; return; }
    host.innerHTML = locFields.map(function (f) {
      return '<div class="fld"><label>' + esc(f.name) + '</label>' +
        '<input type="' + (f.type || 'text') + '" data-locfield="' + esc(f.name) + '" placeholder="' + esc(f.name) + '"></div>';
    }).join('');
  }

  function renderCustomInputs(hostId, kind) {
    var host = $(hostId);
    if (!host) return;
    var list = fieldsFor(kind);
    if (!list.length) { host.innerHTML = ''; return; }
    host.innerHTML = list.map(function (f) {
      var input;
      if (f.type === 'select') {
        var dlId = 'cfdl_' + f.name.replace(/[^\w\u4e00-\u9fa5]/g, '_');
        var opts = (f.options || []).map(function (o) { return '<option value="' + esc(o) + '"></option>'; }).join('');
        input = '<input type="text" list="' + esc(dlId) + '" data-cf="' + esc(f.name) + '" placeholder="选择或输入">' +
          '<datalist id="' + esc(dlId) + '">' + opts + '</datalist>';
      } else {
        input = '<input type="' + (f.type || 'text') + '" data-cf="' + esc(f.name) + '" placeholder="' + esc(f.name) + '">';
      }
      return '<div class="fld"><label>' + esc(f.name) + (f.required ? ' <span class="req">*</span>' : '') + '</label>' + input + '</div>';
    }).join('');
  }
  function collectCustom(hostId, kind) {
    var out = {};
    var host = $(hostId);
    fieldsFor(kind).forEach(function (f) {
      var el = host ? host.querySelector('[data-cf="' + f.name + '"]') : null;
      var v = el ? String(el.value || '').trim() : '';
      if (f.required && !v) throw new Error('请填写「' + f.name + '」');
      out[f.name] = v;
    });
    return out;
  }
  function fillCustomValues(hostId, kind, values) {
    var host = $(hostId);
    if (!host || !values) return;
    fieldsFor(kind).forEach(function (f) {
      var el = host.querySelector('[data-cf="' + f.name + '"]');
      var v = values[f.name];
      if (!el || v == null || v === '') return;
      if (el.tagName === 'SELECT' && !Array.prototype.some.call(el.options, function (o) { return o.value === v; })) {
        var opt = document.createElement('option'); opt.value = v; opt.textContent = v; el.appendChild(opt);
      }
      el.value = v;
    });
  }

  async function submitInbound() {
    if (inTab === 'purchase') {
      var code = $('inPurCode').value.trim();
      var name = $('inPurName').value.trim();
      if (!code || !name) { alert('请填写资产编码和名称'); return; }
      var customVals = {};
      try { customVals = collectCustom('inPurCustom', 'purchase'); } catch (e) { alert(e.message); return; }
      try {
        await api('/api/assets', { method: 'POST', body: {
          code: code, name: name, type: $('inPurType').value.trim(), org: orgOf(simUser) || '',
          source: $('inPurVendor').value.trim(), date: $('inPurDate').value.trim() || nowDate(),
          in_type: '采购入库', location: '', operator: simUser, custom: customVals
        }});
        if (pendingFiles.length) await uploadAttachments('asset', code, pendingFiles);
        pendingFiles = [];
        await bootstrap(); state.view = 'my'; state.page = 1; renderMyLedgerCard(); renderTable(); closeInModal();
        alert('入库成功，已追加到「' + USER + '的资产台账」\n编码：' + code);
      } catch (e) { alert('入库失败：' + e.message); }
    } else {
      if (!selectedShip) { alert('请先选择一张待接收单'); return; }
      var loc = $('inRecLoc').value;
      if (!loc) { alert('请选择入库位置'); return; }
      var lv = {};
      locFields.forEach(function (f) {
        var el = $('inRecLocFields').querySelector('[data-locfield="' + f.name + '"]');
        lv[f.name] = el ? el.value : '';
      });
      var customVals2 = {};
      try { customVals2 = collectCustom('inRecCustom', 'receive'); } catch (e) { alert(e.message); return; }
      try {
        await api('/api/shipments/' + encodeURIComponent(selectedShip.id) + '/receive', { method: 'POST', body: {
          org: $('inRecOrg').value.trim(), location: loc, operator: $('inRecOperator').value.trim() || simUser,
          date: $('inRecDate').value.trim() || nowDate(), loc_values: lv, custom: customVals2
        }});
        await bootstrap(); state.view = 'my'; state.page = 1; renderMyLedgerCard(); renderTable(); closeInModal();
        alert('接收成功，资产已入账');
      } catch (e) { alert('接收失败：' + e.message); }
    }
  }

  async function openEditModal(code) {
    var asset = null;
    assetsOf(simUser).forEach(function (a) { if (a.code === code) asset = a; });
    if (!asset) { alert('资产不存在'); return; }
    try {
      var detail = await api('/api/assets/' + encodeURIComponent(code));
      asset.attachments = detail.attachments || [];
      asset.timeline = detail.timeline || [];
    } catch (e) { alert('加载资产详情失败：' + e.message); }
    editingCode = code;
    editingAsset = asset;
    var host = $('editFields');
    function textField(label, key, value, readonly) {
      return '<div class="fld"><label>' + esc(label) + '</label>' +
        '<input type="text" data-edit="' + key + '" value="' + esc(value || '') + '"' +
        (readonly ? ' readonly' : '') + '></div>';
    }
    var html = '';
    html += textField('资产唯一编码（不可改）', 'code', asset.code, true);
    html += textField('所属用户（不可改）', 'user', asset.user, true);
    html += textField('资产名称', 'name', asset.name, false);
    html += textField('资产类型', 'type', asset.type, false);
    html += textField('所属组织', 'org', asset.org, false);
    html += textField('入库位置', 'location', asset.location, false);
    html += textField('经办人', 'operator', asset.operator, false);
    html += textField('来源（接收调拨由单据带出）', 'source', asset.source, asset.inType === '接收调拨');
    html += textField('入库日期', 'date', asset.date, false);
    // 位置自定义字段
    locFields.forEach(function (f) {
      var v = asset.locValues && asset.locValues[f.name];
      html += textField('位置字段·' + f.name, 'loc:' + f.name, v || '', false);
    });
    // 台账自定义字段（按当前配置，可编辑）
    customFields.forEach(function (f) {
      var v = asset.custom && asset.custom[f.name];
      var key = 'cf:' + f.name;
      if (f.type === 'select') {
        var dlId = 'edit_cfdl_' + f.name.replace(/[^\w\u4e00-\u9fa5]/g, '_');
        var opts = (f.options || []).map(function (o) { return '<option value="' + esc(o) + '"></option>'; }).join('');
        html += '<div class="fld"><label>' + esc(f.name) + (f.required ? ' <span class="req">*</span>' : '') + '</label>' +
          '<input type="text" list="' + esc(dlId) + '" data-edit="' + esc(key) + '" value="' + esc(v || '') + '">' +
          '<datalist id="' + esc(dlId) + '">' + opts + '</datalist></div>';
      } else {
        html += '<div class="fld"><label>' + esc(f.name) + (f.required ? ' <span class="req">*</span>' : '') + '</label>' +
          '<input type="' + (f.type || 'text') + '" data-edit="' + esc(key) + '" value="' + esc(v || '') + '"></div>';
      }
    });
    host.innerHTML = html;
    renderEditAttachments(asset);
    renderLifeTimeline(asset);
    $('editModal').classList.add('show');
  }
  /* ---------- 附件：Demo 把文件读成 dataURL 存入 localStorage ---------- */
  var MAX_ATTACH_BYTES = 2 * 1024 * 1024; // 单文件上限 2MB
  function readFilesToAttachments(files) {
    return new Promise(function (resolve) {
      var arr = Array.prototype.slice.call(files || []);
      var out = [], skipped = [];
      var i = 0;
      function next() {
        if (i >= arr.length) return resolve({ attachments: out, skipped: skipped });
        var f = arr[i++];
        if (f.size > MAX_ATTACH_BYTES) { skipped.push(f.name + '（超过 2MB）'); return next(); }
        var fr = new FileReader();
        fr.onload = function () {
          out.push({ name: f.name, size: f.size, type: f.type || '', dataUrl: fr.result });
          next();
        };
        fr.onerror = function () { skipped.push(f.name + '（读取失败）'); next(); };
        fr.readAsDataURL(f);
      }
      next();
    });
  }
  var pendingFiles = [];
  async function uploadAttachments(ownerType, ownerId, files) {
    for (var i = 0; i < files.length; i++) {
      var fd = new FormData();
      fd.append('file', files[i]);
      await api('/api/assets/' + encodeURIComponent(ownerId) + '/attachments', { method: 'POST', body: fd });
    }
  }
  function notifySkipped(skipped) {
    if (skipped && skipped.length) alert('以下附件未加入（Demo 单文件上限 2MB）：\n' + skipped.join('\n'));
  }
  function downloadAttachment(att) {
    if (!att) return;
    var a = document.createElement('a');
    a.href = att.id ? ('/api/attachments/' + att.id + '/download') : att.dataUrl;
    a.download = att.filename || att.name || 'attachment';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function dataUrlToText(dataUrl) {
    try {
      var b64 = String(dataUrl).split(',')[1] || '';
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) { return ''; }
  }
  function previewAttachment(att) {
    if (!att) return;
    var type = (att.mime || att.type || '').toLowerCase();
    var name = att.filename || att.name || '';
    var url = att.id ? ('/api/attachments/' + att.id + '/download') : att.dataUrl;
    if (!url) { alert('该附件没有可预览的内容'); return; }
    var win = window.open('', '_blank');
    if (!win) { alert('请允许弹出窗口后重试'); return; }
    var body;
    if (type.indexOf('image/') === 0) body = '<img src="' + url + '" style="max-width:100%;">';
    else if (type === 'application/pdf' || /\.pdf$/i.test(name)) body = '<iframe src="' + url + '" style="width:100%;height:90vh;border:0;"></iframe>';
    else if (type.indexOf('text/') === 0 || /\.(txt|csv|md|json|log|xml|html)$/i.test(name)) {
      body = '<h3>' + esc(name) + '</h3><div id="txtBody" style="white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:13px;border:1px solid #ddd;padding:12px;background:#fafafa;">加载中…</div>' +
        '<script>fetch(' + JSON.stringify(url) + ').then(function(r){return r.text();}).then(function(t){document.getElementById("txtBody").textContent=t;});<\/script>';
    }
    else body = '<p style="font-family:sans-serif;">附件：<b>' + esc(name) + '</b><br>此类型不支持内嵌预览，可点击下方按钮下载。</p>';
    win.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(name) + '</title></head><body style="margin:16px;">' +
      body + '<div style="margin-top:14px;"><button onclick="window.print()">🖨️ 打印</button></div></body></html>');
    win.document.close();
  }
  function attachSummary(attachments) {
    if (!attachments || !attachments.length) return '';
    return '　📎 交接单：' + attachments.map(function (f) { return f.name; }).join('、');
  }
  function renderFileList(hostId, files) {
    var host = $(hostId);
    if (!host) return;
    host.innerHTML = files.map(function (f) {
      return '<div class="file-item">📎 <span>' + esc(f.name) + '</span>（' +
        (f.size ? Math.max(1, Math.round(f.size / 1024)) + ' KB' : 'Demo') + '，不上传）</div>';
    }).join('');
  }
  var outFiles = [], batchOutFiles = [];
  function bindFileInput(inputId, hostId, stateKey) {
    var input = $(inputId);
    if (!input) return;
    input.addEventListener('change', function () {
      var files = this.files;
      readFilesToAttachments(files).then(function (res) {
        if (stateKey === 'out') outFiles = res.attachments; else batchOutFiles = res.attachments;
        renderFileList(hostId, res.attachments);
        notifySkipped(res.skipped);
      });
    });
  }

  var editingAsset = null;
  async function reloadEditAttachments() {
    if (!editingCode || !editingAsset) return;
    try {
      var detail = await api('/api/assets/' + encodeURIComponent(editingCode));
      editingAsset.attachments = detail.attachments || [];
      renderEditAttachments(editingAsset);
    } catch (e) { alert('刷新附件失败：' + e.message); }
  }
  function renderEditAttachments(asset) {
    var host = $('editAttachList');
    if (!host) return;
    var files = asset.attachments || asset.files || [];
    if (!files.length) {
      host.innerHTML = '<span class="hint">该资产暂无附件，可点下方「添加附件」上传</span>';
      return;
    }
    host.innerHTML = files.map(function (f, i) {
      return '<div class="attach-item">' +
        '<span>📎</span><span class="an" data-att-preview="' + i + '">' + esc(f.filename || f.name) + '</span>' +
        '<span class="hint">' + (f.size ? Math.max(1, Math.round(f.size / 1024)) + ' KB' : '') + '</span>' +
        '<span class="aops">' +
        '<button class="btn sm" data-att-print="' + i + '">🖨️ 打印</button>' +
        '<button class="btn sm" data-att-download="' + i + '">⬇️ 下载</button>' +
        (f.id && (f.uploader === USER || IS_SUPER) ? '<button class="btn sm" data-att-del="' + i + '">🗑️ 删除</button>' : '') +
        '</span></div>';
    }).join('');
    host.querySelectorAll('[data-att-preview]').forEach(function (el) {
      el.addEventListener('click', function () { previewAttachment(files[Number(el.dataset.attPreview)]); });
    });
    host.querySelectorAll('[data-att-print]').forEach(function (el) {
      el.addEventListener('click', function () { previewAttachment(files[Number(el.dataset.attPrint)]); });
    });
    host.querySelectorAll('[data-att-download]').forEach(function (el) {
      el.addEventListener('click', function () { downloadAttachment(files[Number(el.dataset.attDownload)]); });
    });
    host.querySelectorAll('[data-att-del]').forEach(function (el) {
      el.addEventListener('click', async function () {
        var f = files[Number(el.dataset.attDel)];
        if (!f || !f.id) return;
        if (!confirm('删除附件「' + (f.filename || f.name) + '」？')) return;
        try {
          await api('/api/attachments/' + f.id, { method: 'DELETE' });
          await reloadEditAttachments();
        } catch (e) { alert('删除失败：' + e.message); }
      });
    });
  }
  function renderLifeTimeline(asset) {
    var host = $('editTimeline');
    if (!host) return;
    var list = asset.timeline || [];
    if (!list.length) {
      host.innerHTML = '<div class="life-empty">暂无流转记录（旧版演示数据）</div>';
      return;
    }
    host.innerHTML = list.slice().reverse().map(function (e) {
      var meta = [];
      meta.push('<span>📍 地点：<b>' + esc(e.place || '—') + '</b></span>');
      if (e.from) meta.push('<span>👤 来自：<b>' + esc(e.from) + '</b></span>');
      if (e.to) meta.push('<span>➡️ 给谁：<b>' + esc(e.to) + '</b></span>');
      var actorLabel = e.type === 'edit' ? '👤 更新人：' : '✍️ 经办：';
      meta.push('<span>' + actorLabel + '<b>' + esc(e.person || '—') + '</b></span>');
      var changesHtml = '';
      if (e.changes && e.changes.length) {
        changesHtml = '<div class="le-changes">' + e.changes.map(function (c) {
          return '<div class="le-change"><b>' + esc(c.field) + '</b>：' +
            '<span class="le-old">' + esc(c.old) + '</span> → <span class="le-new">' + esc(c.now) + '</span></div>';
        }).join('') + '</div>';
      }
      return '<div class="life-ev ev-' + esc(e.type || '') + '">' +
        '<div class="le-hd"><b>' + esc(e.title || e.type) + '</b>' +
        '<span class="le-time">' + esc(e.time || '') + '</span></div>' +
        '<div class="le-meta">' + meta.join('') + '</div>' +
        (e.note ? '<div class="le-note">' + esc(e.note) + '</div>' : '') +
        changesHtml +
        '</div>';
    }).join('');
  }
  function closeEditModal() { $('editModal').classList.remove('show'); editingCode = null; editingAsset = null; }
  async function saveEdit() {
    if (!editingCode) return;
    var asset = null;
    for (var i = 0; i < myAssets.length; i++) {
      if (myAssets[i].code === editingCode) { asset = myAssets[i]; break; }
    }
    if (!asset) { alert('资产不存在'); return; }
    var vals = {};
    Array.prototype.forEach.call($('editFields').querySelectorAll('[data-edit]'), function (el) {
      vals[el.dataset.edit] = String(el.value || '').trim();
    });
    try {
      var result = await api('/api/assets/' + encodeURIComponent(editingCode), { method: 'PUT', body: {
        name: vals['name'], type: vals['type'], org: vals['org'], location: vals['location'],
        operator: vals['operator'], source: vals['source'], date: vals['date'],
        loc_values: (function () { var o = {}; locFields.forEach(function (f) { o[f.name] = vals['loc:' + f.name] || ''; }); return o; })(),
        custom: (function () { var o = {}; customFields.forEach(function (f) { o[f.name] = vals['cf:' + f.name] || ''; }); return o; })()
      }});
      await bootstrap();
      renderMyLedgerCard(); renderTable();
      var savedCode = editingCode;
      closeEditModal();
      alert(result.changes && result.changes.length
        ? ('台账信息已更新：' + savedCode + '\n' + result.changes.length + ' 个字段的变更已记入全生命周期')
        : '没有字段发生变化');
    } catch (e) { alert('保存失败：' + e.message); }
  }

  function qrSvc() {
    if (typeof window.QrCardService === 'undefined') {
      alert('二维码打印组件未加载，请刷新页面');
      return null;
    }
    return window.QrCardService;
  }
  /* 资产标签的可选字段（核心字段 + 自定义字段） */
  function qrFieldOptions() {
    var opts = [
      ['name', '资产名称'], ['code', '资产唯一编码'], ['org', '所属组织'],
      ['location', '入库位置'], ['operator', '经办人'], ['source', '来源'], ['date', '入库日期']
    ];
    customFields.forEach(function (f) { opts.push(['cf:' + f.name, f.name]); });
    return opts;
  }
  function qrFieldValue(asset, key) {
    if (key.indexOf('cf:') === 0) {
      var n = key.slice(3);
      return (asset.custom && asset.custom[n]) ? asset.custom[n] : '';
    }
    return ({
      name: asset.name, code: asset.code, org: asset.org, location: asset.location,
      operator: asset.operator, source: asset.source, date: asset.date
    })[key] || '';
  }
  function qrLinesFor(asset, cfg) {
    var lines = [];
    (cfg.columns || []).forEach(function (key) {
      var v = qrFieldValue(asset, key);
      if (!v) return;
      var label = '';
      qrFieldOptions().forEach(function (o) { if (o[0] === key) label = o[1]; });
      lines.push((label ? label + '：' : '') + v);
    });
    return lines;
  }

  function openQrLabelModal(assets) {
    var svc = qrSvc();
    if (!svc) return;
    if (!assets || !assets.length) { alert('请先选择要打印二维码的资产'); return; }
    qrTargets = assets;
    qrBound = true;
    var cfg = svc.loadPrintCfg();
    $('qrModalTitle').textContent = assets.length === 1
      ? ('🏷️ 二维码标签 · ' + assets[0].name)
      : ('🏷️ 批量打印二维码 · ' + assets.length + ' 项');
    $('qrInfo').textContent = assets.length === 1
      ? ('资产编码：' + assets[0].code + '　二维码内容即资产唯一编码，与扫码识别一致。')
      : ('已选 ' + assets.length + ' 项资产，将为每项生成一张标签。');
    $('qrTitle').value = cfg.title || '';

    // 纸张下拉（复用 PAPER_SIZES）
    var ps = $('qrPaper');
    ps.innerHTML = '';
    svc.PAPER_SIZES.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.id + ' (' + p.w + '×' + p.h + 'mm)';
      ps.appendChild(o);
    });
    var oc = document.createElement('option');
    oc.value = 'custom'; oc.textContent = '自定义';
    ps.appendChild(oc);
    var validPaper = !!svc.paperById(cfg.paper) || cfg.paper === 'custom';
    ps.value = validPaper ? cfg.paper : 'A4';
    $('qrPaperW').value = cfg.paperW || 210;
    $('qrPaperH').value = cfg.paperH || 297;
    $('qrPaperCustom').style.display = ps.value === 'custom' ? '' : 'none';

    $('qrLabelPreset').value = ['40x30', '50x30', 'custom'].indexOf(cfg.labelPreset) >= 0 ? cfg.labelPreset : '40x30';
    $('qrLabelW').value = cfg.labelW || 40;
    $('qrLabelH').value = cfg.labelH || 30;
    $('qrLabelCustom').style.display = $('qrLabelPreset').value === 'custom' ? '' : 'none';

    // 字段多选：默认勾选资产名称 + 编码
    var defaults = ['name', 'code'];
    var picked = cfg.columns && cfg.columns.length ? cfg.columns : defaults;
    $('qrFields').innerHTML = qrFieldOptions().map(function (o) {
      return '<label class="bp-field-check"><input type="checkbox" data-qrfield="' + esc(o[0]) + '"' +
        (picked.indexOf(o[0]) >= 0 ? ' checked' : '') + '> ' + esc(o[1]) + '</label>';
    }).join('');

    $('qrLabelModal').classList.add('show');
    refreshQrPreview();
  }
  function closeQrLabelModal() { $('qrLabelModal').classList.remove('show'); }

  function collectQrCfg() {
    var svc = qrSvc();
    var cfg = svc ? svc.defaultPrintCfg() : null;
    if (!cfg) return null;
    cfg.title = ($('qrTitle').value || '').trim();
    cfg.columns = [];
    Array.prototype.forEach.call($('qrFields').querySelectorAll('[data-qrfield]'), function (cb) {
      if (cb.checked) cfg.columns.push(cb.dataset.qrfield);
    });
    cfg.paper = $('qrPaper').value;
    cfg.paperW = Number($('qrPaperW').value) || 210;
    cfg.paperH = Number($('qrPaperH').value) || 297;
    cfg.labelPreset = $('qrLabelPreset').value;
    cfg.labelW = Number($('qrLabelW').value) || 40;
    cfg.labelH = Number($('qrLabelH').value) || 30;
    return cfg;
  }

  async function refreshQrPreview() {
    var svc = qrSvc();
    var host = $('qrPreview');
    if (!svc || !host) return;
    qrPreviewUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    qrPreviewUrls = [];
    host.innerHTML = '';
    var cfg = collectQrCfg();
    svc.savePrintCfg(cfg);
    var lab = svc.effectiveLabel(cfg);
    var scale = Math.min(3.78, 220 / lab.w);
    // 预览最多显示 6 张，避免刷屏
    qrTargets.slice(0, 6).forEach(function (asset) {
      var card = document.createElement('div');
      card.className = 'bp-preview-card';
      card.style.width = Math.round(lab.w * scale) + 'px';
      card.style.minHeight = Math.round(lab.h * scale) + 'px';
      if (cfg.title) {
        var t = document.createElement('div');
        t.className = 'bp-preview-title';
        t.textContent = cfg.title;
        t.style.fontSize = Math.max(11, Math.min(20, lab.w * 0.5)) + 'px';
        card.appendChild(t);
      }
      svc.renderCard(asset.code, qrLinesFor(asset, cfg), svc.printTemplate(cfg)).then(function (blob) {
        var url = URL.createObjectURL(blob);
        qrPreviewUrls.push(url);
        var img = document.createElement('img');
        img.className = 'bp-preview-img';
        img.src = url; img.alt = '标签预览';
        card.appendChild(img);
      }).catch(function (e) {
        host.innerHTML = '<span class="bp-preview-empty">预览生成失败：' + esc(e && e.message ? e.message : e) + '</span>';
      });
      host.appendChild(card);
    });
  }

  async function doQrPrint() {
    var svc = qrSvc();
    if (!svc || !qrTargets.length) return;
    var cfg = collectQrCfg();
    svc.savePrintCfg(cfg);
    var btn = $('qrPrint');
    var old = btn.textContent;
    btn.disabled = true; btn.textContent = '生成中…';
    try {
      var cards = [];
      for (var i = 0; i < qrTargets.length; i++) {
        var asset = qrTargets[i];
        var blob = await svc.renderCard(asset.code, qrLinesFor(asset, cfg), svc.printTemplate(cfg));
        cards.push({ dataUrl: await svc.blobToDataURL(blob), title: cfg.title });
      }
      if (!cards.length) { alert('没有可打印的二维码'); return; }
      var html = svc.buildPrintHtml(cards, cfg);
      svc.printHtml(html, function (e) { alert('唤起打印失败：' + (e && e.message ? e.message : e)); });
    } catch (e) {
      alert('二维码打印失败：' + (e && e.message ? e.message : e));
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  }

  /* ---------- 批量导入 ---------- */
  var importState = { headers: [], rows: [], map: {} };
  var IMPORT_TARGETS = [
    { key: 'code', label: '资产唯一编码', required: false },
    { key: 'name', label: '资产名称', required: true },
    { key: 'type', label: '资产类型', required: false },
    { key: 'org', label: '所属组织', required: false },
    { key: 'location', label: '入库位置', required: false },
    { key: 'operator', label: '经办人', required: false },
    { key: 'source', label: '来源', required: false },
    { key: 'date', label: '入库日期', required: false }
  ];
  function importTargetList() {
    return IMPORT_TARGETS
      .concat(locFields.map(function (f) { return { key: 'loc:' + f.name, label: '位置字段·' + f.name, required: false }; }))
      .concat(customFields.map(function (f) { return { key: cfKey(f.name), label: f.name, required: false }; }));
  }

  function resetImport() {
    importState = { headers: [], rows: [], map: {} };
    $('impFileInfo').classList.add('hidden');
    $('impMapArea').classList.add('hidden');
    $('impPreviewArea').classList.add('hidden');
    $('impSubmit').disabled = true;
    $('impFile').value = '';
  }
  function openImportModal() {
    if (!canOperate()) { alert('示例台账为只读，不能导入'); return; }
    resetImport();
    $('importModal').classList.add('show');
  }
  function closeImportModal() { $('importModal').classList.remove('show'); }

  function parseImportFile(file) {
    if (typeof XLSX === 'undefined') { alert('Excel 库未加载，请刷新页面'); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
        if (!aoa.length) { alert('文件为空'); return; }
        var headers = aoa[0].map(function (h, i) {
          return String(h || '').trim() || ('列' + (i + 1));
        });
        var rows = [];
        for (var i = 1; i < aoa.length; i++) {
          var obj = {};
          var any = false;
          headers.forEach(function (h, j) {
            obj[h] = String(aoa[i][j] == null ? '' : aoa[i][j]).trim();
            if (obj[h]) any = true;
          });
          if (any) rows.push(obj);
        }
        if (!rows.length) { alert('文件没有数据行'); return; }
        importState = { headers: headers, rows: rows, map: {} };
        autoMapImport();
        renderImportMap();
        renderImportPreview();
        $('impFileInfo').textContent = '已读取：' + file.name + '（' + rows.length + ' 行 / ' + headers.length + ' 列）';
        $('impFileInfo').className = 'io-msg ok';
        $('impMapArea').classList.remove('hidden');
        $('impPreviewArea').classList.remove('hidden');
        // 提交按钮状态由 renderImportPreview 根据校验结果决定
      } catch (err) {
        $('impFileInfo').textContent = '解析失败：' + (err && err.message ? err.message : err);
        $('impFileInfo').className = 'io-msg err';
        $('impFileInfo').classList.remove('hidden');
      }
    };
    reader.onerror = function () { alert('文件读取失败'); };
    reader.readAsArrayBuffer(file);
  }

  /* 按列名自动匹配目标字段（完全相等 > 包含） */
  function autoMapImport() {
    var targets = importTargetList();
    importState.map = {};
    importState.headers.forEach(function (h) {
      var hit = null;
      targets.forEach(function (t) {
        if (h === t.label) hit = t.key;
        else if (!hit && h.indexOf(t.label) >= 0) hit = t.key;
      });
      if (hit) importState.map[hit] = h;
    });
  }

  function renderImportMap() {
    var host = $('impMap');
    host.innerHTML = importTargetList().map(function (t) {
      var selected = importState.map[t.key] || '';
      return '<div class="fld"><label>' + esc(t.label) + (t.required ? ' <span class="req">*</span>' : '') + '</label>' +
        '<select data-map="' + esc(t.key) + '"><option value="">— 不导入 —</option>' +
        importState.headers.map(function (h) {
          return '<option value="' + esc(h) + '"' + (h === selected ? ' selected' : '') + '>' + esc(h) + '</option>';
        }).join('') + '</select></div>';
    }).join('');
    host.querySelectorAll('[data-map]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        importState.map[sel.dataset.map] = sel.value;
        renderImportPreview();
      });
    });
  }

  function mappedRow(row) {
    var out = {};
    importTargetList().forEach(function (t) {
      var src = importState.map[t.key];
      out[t.key] = src ? (row[src] || '').trim() : '';
    });
    return out;
  }
  function validateImport() {
    var mapped = importState.rows.map(mappedRow);
    var errs = [];
    var nameCol = importState.map['name'];
    if (!nameCol) errs.push('必须映射「资产名称」列');
    if (nameCol) {
      mapped.forEach(function (m, i) {
        if (!m.name) errs.push('第 ' + (i + 2) + ' 行资产名称为空');
      });
    }
    // 编码重复检查（文件内 + 台账已有）
    var existing = {};
    myAssets.forEach(function (a) { existing[a.code] = true; });
    var seen = {};
    mapped.forEach(function (m, i) {
      if (!m.code) return;
      if (seen[m.code]) errs.push('第 ' + (i + 2) + ' 行编码重复：' + m.code);
      if (existing[m.code]) errs.push('第 ' + (i + 2) + ' 行编码已存在：' + m.code);
      seen[m.code] = true;
    });
    return { mapped: mapped, errors: errs };
  }
  function renderImportPreview() {
    var result = validateImport();
    var preview = $('impPreview');
    var cols = importTargetList().filter(function (t) { return importState.map[t.key]; });
    var head = cols.map(function (t) { return '<th>' + esc(t.label) + '</th>'; }).join('');
    var body = importState.rows.slice(0, 5).map(function (row) {
      var m = mappedRow(row);
      return '<tr>' + cols.map(function (t) { return '<td>' + esc(m[t.key] || '—') + '</td>'; }).join('') + '</tr>';
    }).join('');
    preview.innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
    var sum = $('impSummary');
    if (result.errors.length) {
      sum.className = 'io-msg err';
      sum.innerHTML = '校验发现 ' + result.errors.length + ' 个问题：<br>' +
        result.errors.slice(0, 5).map(esc).join('<br>') + (result.errors.length > 5 ? '<br>…' : '');
      $('impSubmit').disabled = true;
    } else {
      sum.className = 'io-msg ok';
      sum.textContent = '校验通过：可导入 ' + result.mapped.length + ' 条资产（重复编码将跳过）';
      $('impSubmit').disabled = false;
    }
  }
  async function submitImport() {
    var result = validateImport();
    if (result.errors.length) { alert('请先修复校验问题'); return; }
    var count = 0;
    try {
      for (var i = 0; i < result.mapped.length; i++) {
        var m = result.mapped[i];
        var custom = {}, locValues = {};
        importTargetList().forEach(function (t) {
          if (t.key.indexOf(cfKey('')) === 0) custom[t.key.slice(3)] = m[t.key];
          else if (t.key.indexOf('loc:') === 0) locValues[t.key.slice(4)] = m[t.key];
        });
        await api('/api/assets', { method: 'POST', body: {
          code: m.code || uid(), name: m.name, type: m.type || '', org: m.org || orgOf(simUser) || '',
          location: m.location || '', operator: m.operator || simUser, source: m.source || '',
          date: m.date || nowDate(), in_type: '批量导入', custom: custom, loc_values: locValues
        }});
        count++;
      }
      await bootstrap();
      state.view = 'my'; state.page = 1; state.selected = {}; state.filters = {};
      $('ledgerSel').value = 'my';
      renderMyLedgerCard(); renderTable(); closeImportModal();
      alert('批量导入完成：' + count + ' 条资产已入账');
    } catch (e) { alert('导入失败：' + e.message); }
  }

  function exportColumns() {
    // 展示列 + 自定义字段（去重，用中文名）
    var cols = state.cols.slice();
    customFields.forEach(function (f) {
      var k = cfKey(f.name);
      if (cols.indexOf(k) < 0) cols.push(k);
    });
    return cols;
  }
  function exportRowsFor(scope) {
    if (scope === 'selected') {
      var codes = selectedCodes();
      return assetsOf(simUser).filter(function (a) { return codes.indexOf(a.code) >= 0; });
    }
    if (scope === 'filtered') return applyFilters(assetsOf(simUser));
    return assetsOf(simUser).slice();
  }
  function openExportModal() {
    if (!canOperate()) { alert('示例台账为只读，不能导出'); return; }
    var sel = $('expScope');
    sel.value = selectedCodes().length ? 'selected' : 'all';
    updateExportInfo();
    $('exportModal').classList.add('show');
  }
  function closeExportModal() { $('exportModal').classList.remove('show'); }
  function updateExportInfo() {
    var scope = $('expScope').value;
    var rows = exportRowsFor(scope);
    $('expInfo').textContent = '将导出 ' + rows.length + ' 条资产（' +
      ({ all: '全部资产', filtered: '当前筛选结果', selected: '已勾选资产' })[scope] + '）';
  }
  function doExport() {
    if (typeof XLSX === 'undefined') { alert('Excel 库未加载，请刷新页面'); return; }
    var scope = $('expScope').value;
    var rows = exportRowsFor(scope);
    if (!rows.length) { alert('没有可导出的资产'); return; }
    var cols = exportColumns();
    var aoa = [cols.map(columnLabel)];
    rows.forEach(function (r) {
      aoa.push(cols.map(function (c) { return cellValue(r, c) === '—' ? '' : cellValue(r, c); }));
    });
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = cols.map(function (c) { return { wch: Math.max(12, columnLabel(c).length * 2 + 4) }; });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '资产台账');
    var safe = String(simUser).replace(/[\\/:*?"<>|]/g, '_');
    XLSX.writeFile(wb, safe + '-资产台账.xlsx');
    closeExportModal();
  }

  /* ---------- 批量操作 ---------- */
  async function batchDelete() {
    var codes = selectedCodes();
    if (!codes.length) { alert('请先勾选要删除的资产'); return; }
    if (!confirm('确定删除选中的 ' + codes.length + ' 项资产？')) return;
    try {
      var r = await api('/api/assets/batch-delete', { method: 'POST', body: { codes: codes } });
      await bootstrap(); clearSelection(); renderMyLedgerCard(); renderTable();
      alert('已删除 ' + r.deleted + ' 项资产');
    } catch (e) { alert('删除失败：' + e.message); }
  }

  function openBatchOutModal() {
    if (!canOperate()) { alert('示例台账为只读，不能出库'); return; }
    var codes = selectedCodes();
    if (!codes.length) { alert('请先勾选要出库的资产'); return; }
    var picked = assetsOf(simUser).filter(function (a) { return codes.indexOf(a.code) >= 0; });
    $('batchOutInfo').textContent = '已选 ' + picked.length + ' 项资产，将生成 ' + picked.length +
      ' 张待接收单：' + picked.slice(0, 5).map(function (a) { return a.code; }).join('、') +
      (picked.length > 5 ? ' 等' : '');
    $('batchOutToUser').innerHTML = '<option value="">请选择接收方</option>' + PEOPLE.filter(function (p) {
      return p.name !== simUser;
    }).map(function (p) {
      return '<option value="' + esc(p.name) + '">' + esc(p.name) + ' · ' + esc(p.org || '默认组织') + '</option>';
    }).join('');
    $('batchOutToOrg').value = '';
    $('batchOutOperator').value = simUser;
    $('batchOutDate').value = nowDate();
    $('batchOutNote').value = '';
    batchOutFiles = [];
    $('batchOutFileList').innerHTML = '';
    $('batchOutFiles').value = '';
    $('batchOutModal').classList.add('show');
  }
  function closeBatchOutModal() { $('batchOutModal').classList.remove('show'); }
  async function submitBatchOut() {
    var toUser = $('batchOutToUser').value;
    if (!toUser) { alert('请选择接收方'); return; }
    var codes = selectedCodes();
    if (!codes.length) { alert('没有可出库的资产'); return; }
    try {
      var r = await api('/api/shipments', { method: 'POST', body: {
        codes: codes, to_user: toUser, to_org: orgOf(toUser),
        operator: $('batchOutOperator').value.trim() || simUser,
        date: $('batchOutDate').value.trim() || nowDate(), note: $('batchOutNote').value.trim()
      }});
      await bootstrap(); clearSelection(); renderMyLedgerCard(); updateBadges(); closeBatchOutModal();
      alert('已批量出库 ' + r.created.length + ' 项，生成待接收单发给 ' + toUser);
    } catch (e) { alert('批量出库失败：' + e.message); }
  }

  function fillOutAssetSelect() {
    var list = assetsOf(simUser);
    $('outAsset').innerHTML = list.length
      ? '<option value="">请选择要出库的资产</option>' + list.map(function (a) {
          return '<option value="' + esc(a.code) + '">' + esc(a.code) + ' · ' + esc(a.name) + '</option>';
        }).join('')
      : '<option value="">（你的台账暂无资产，请先采购入库或接收调拨）</option>';
  }
  function fillOutUserSelect() {
    $('outToUser').innerHTML = '<option value="">请选择接收方</option>' + PEOPLE.filter(function (p) {
      return p.name !== simUser;
    }).map(function (p) {
      return '<option value="' + esc(p.name) + '">' + esc(p.name) + ' · ' + esc(p.org || '默认组织') + '</option>';
    }).join('');
    $('outToOrg').value = '';
  }
  function renderOutMyShips() {
    var host = $('outMyShipList');
    if (!host) return;
    var list = sentBy(simUser);
    if (!list.length) { host.innerHTML = '<div class="ship-empty">你还没有发出过单据</div>'; return; }
    host.innerHTML = list.map(function (s) {
      var done = s.status === 'received';
      return '<div class="ship-card' + (done ? ' done' : '') + '">' +
        '<div class="sc-t"><span class="tag ' + (done ? 'tag-green' : 'tag-amber') + '">' + (done ? '已接收' : '待接收') + '</span>' +
        esc(s.code) + ' · ' + esc(s.name) + '</div>' +
        '<div class="sc-m">发给：' + esc(s.toUser) + ' / ' + esc(s.toOrg || '默认组织') +
        '　发出：' + esc(s.date) + (done ? '　接收人：' + esc(s.receivedBy || '') : '') +
        esc(attachSummary(s.attachments)) + '</div></div>';
    }).join('');
  }
  function openOutModal() {
    $('outModal').classList.add('show');
    fillOutAssetSelect();
    fillOutUserSelect();
    $('outOperator').value = simUser;
    $('outDate').value = nowDate();
    $('outNote').value = '';
    outFiles = [];
    $('outFiles').value = '';
    var own = 0;
    assetsOf(simUser).forEach(function (a) { own = Math.max(own, (a.files || []).length); });
    $('outFileList').innerHTML = own
      ? '<div class="file-item">ℹ️ 所选资产已有附件（最多 ' + own + ' 个）将自动随单同步给接收方</div>'
      : '';
    renderOutMyShips();
  }
  function closeOutModal() { $('outModal').classList.remove('show'); }

  async function submitOutbound() {
    var code = $('outAsset').value;
    var toUser = $('outToUser').value;
    if (!code || !toUser) { alert('请选择资产和接收方'); return; }
    try {
      var r = await api('/api/shipments', { method: 'POST', body: {
        code: code, to_user: toUser, to_org: orgOf(toUser),
        operator: $('outOperator').value.trim() || simUser,
        date: $('outDate').value.trim() || nowDate(), note: $('outNote').value.trim()
      }});
      await bootstrap(); renderMyLedgerCard(); renderTable(); renderOutMyShips(); updateBadges(); closeOutModal();
      alert('出库成功，已生成待接收单给 ' + toUser);
    } catch (e) { alert('出库失败：' + e.message); }
  }

  function fieldsFor(kind) {
    return customFields.filter(function (f) { return f.apply === 'all' || f.apply === kind; });
  }
  function cfKey(name) { return 'cf:' + name; }

  /* 按入库类型动态渲染自定义字段输入项 */
  function renderCustomInputs(hostId, kind) {
    var host = $(hostId);
    if (!host) return;
    var list = fieldsFor(kind);
    if (!list.length) { host.innerHTML = ''; return; }
    host.innerHTML = list.map(function (f) {
      var input;
      if (f.type === 'select') {
        // datalist：既可从预设选，也允许输入配置外的值
        var dlId = 'cfdl_' + f.name.replace(/[^\w\u4e00-\u9fa5]/g, '_');
        var opts = (f.options || []).map(function (o) {
          return '<option value="' + esc(o) + '"></option>';
        }).join('');
        input = '<input type="text" list="' + esc(dlId) + '" data-cf="' + esc(f.name) +
          '" placeholder="选择或输入">' + '<datalist id="' + esc(dlId) + '">' + opts + '</datalist>';
      } else {
        input = '<input type="' + (f.type || 'text') + '" data-cf="' + esc(f.name) +
          '" placeholder="' + esc(f.name) + '">';
      }
      return '<div class="fld"><label>' + esc(f.name) +
        (f.required ? ' <span class="req">*</span>' : '') + '</label>' + input + '</div>';
    }).join('');
  }

  /* 采集自定义字段值；必填项未填时抛错由调用方提示 */
  function collectCustom(hostId, kind) {
    var out = {};
    var host = $(hostId);
    fieldsFor(kind).forEach(function (f) {
      var el = host ? host.querySelector('[data-cf="' + f.name + '"]') : null;
      var v = el ? String(el.value || '').trim() : '';
      if (f.required && !v) throw new Error('请填写「' + f.name + '」');
      out[f.name] = v;
    });
    return out;
  }

  /* 用单据携带的值预填接收表单的自定义字段 */
  function fillCustomValues(hostId, kind, values) {
    var host = $(hostId);
    if (!host || !values) return;
    fieldsFor(kind).forEach(function (f) {
      var el = host.querySelector('[data-cf="' + f.name + '"]');
      var v = values[f.name];
      if (!el || v == null || v === '') return;
      // 下拉值不在当前选项里时补一个选项，避免历史单据值丢失
      if (el.tagName === 'SELECT' && !Array.prototype.some.call(el.options, function (o) { return o.value === v; })) {
        var opt = document.createElement('option');
        opt.value = v; opt.textContent = v;
        el.appendChild(opt);
      }
      el.value = v;
    });
  }

  /* ---------- 位置配置弹窗 ---------- */
  async function saveConfig() {
    try {
      await api('/api/assets/config', { method: 'PUT', body: {
        custom_fields: customFields, locations: locations, loc_fields: locFields
      }});
      renderLocConfig(); renderCfConfig(); renderColCfg(); renderTable();
    } catch (e) { alert('保存配置失败：' + e.message); }
  }

  function openLocModal() { $('locModal').classList.add('show'); renderLocConfig(); renderCfConfig(); }
  function closeLocModal() { $('locModal').classList.remove('show'); }
  function renderLocConfig() {
    $('locList').innerHTML = locations.length
      ? locations.map(function (l, i) {
          return '<span class="loc-chip">' + esc(l) +
            ' <button class="btn sm" data-del-loc="' + i + '" style="padding:0 5px;">×</button></span>';
        }).join('')
      : '<span class="hint">暂无位置</span>';
    $('locFieldRows').innerHTML = locFields.length
      ? locFields.map(function (f, i) {
          return '<div class="fldcfg-row">' +
            '<input type="text" value="' + esc(f.name) + '" data-fname="' + i + '">' +
            '<select data-ftype="' + i + '">' +
              ['text', 'number', 'date'].map(function (tp) {
                return '<option value="' + tp + '"' + (f.type === tp ? ' selected' : '') + '>' +
                  ({ text: '文本', number: '数字', date: '日期' })[tp] + '</option>';
              }).join('') +
            '</select>' +
            '<button class="btn sm danger" data-del-field="' + i + '">删除</button></div>';
        }).join('')
      : '<p class="hint">暂无位置字段</p>';
  }

  function renderCfConfig() {
    var host = $('cfFieldRows');
    if (!host) return;
    if (!customFields.length) { host.innerHTML = '<p class="hint">暂无台账自定义字段</p>'; return; }
    var types = [['text', '文本'], ['number', '数字'], ['date', '日期'], ['select', '下拉']];
    var applies = [['all', '采购+接收'], ['purchase', '仅采购'], ['receive', '仅接收']];
    host.innerHTML = customFields.map(function (f, i) {
      return '<div class="cf-row">' +
        '<input type="text" value="' + esc(f.name) + '" data-cf-name="' + i + '" placeholder="字段名">' +
        '<select data-cf-type="' + i + '">' + types.map(function (t) {
          return '<option value="' + t[0] + '"' + (f.type === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
        }).join('') + '</select>' +
        '<input type="text" value="' + esc((f.options || []).join(',')) + '" data-cf-opts="' + i + '" placeholder="下拉选项（逗号分隔）">' +
        '<select data-cf-apply="' + i + '">' + applies.map(function (a) {
          return '<option value="' + a[0] + '"' + (f.apply === a[0] ? ' selected' : '') + '>' + a[1] + '</option>';
        }).join('') + '</select>' +
        '<label class="cf-required"><input type="checkbox" data-cf-req="' + i + '"' + (f.required ? ' checked' : '') + '> 必填</label>' +
        '<button class="btn sm danger" data-del-cf="' + i + '">删除</button></div>';
    }).join('');
  }

  /* 保存配置时对字段列表做一致性校验 */
  async function commitCfConfig() {
    customFields.forEach(function (f, i) {
      var nameEl = $('cfFieldRows').querySelector('[data-cf-name="' + i + '"]');
      var typeEl = $('cfFieldRows').querySelector('[data-cf-type="' + i + '"]');
      var optsEl = $('cfFieldRows').querySelector('[data-cf-opts="' + i + '"]');
      var applyEl = $('cfFieldRows').querySelector('[data-cf-apply="' + i + '"]');
      var reqEl = $('cfFieldRows').querySelector('[data-cf-req="' + i + '"]');
      if (nameEl && nameEl.value.trim()) f.name = nameEl.value.trim();
      if (typeEl) f.type = typeEl.value;
      if (optsEl) f.options = optsEl.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (applyEl) f.apply = applyEl.value;
      if (reqEl) f.required = !!reqEl.checked;
    });
    await api('/api/assets/config', { method: 'PUT', body: {
      custom_fields: customFields, locations: locations, loc_fields: locFields
    }});
    syncCustomCols();
    renderCfConfig();
    renderColCfg();
    renderTable();
  }

  /* 自定义字段纳入「自定义展示列」，新增时默认勾选显示 */
  function syncCustomCols(addName) {
    var names = customFields.map(function (f) { return f.name; });
    state.cols = state.cols.filter(function (c) {
      return c.indexOf('cf:') !== 0 || names.indexOf(c.slice(3)) >= 0;
    });
    if (addName && state.cols.indexOf(cfKey(addName)) < 0) state.cols.push(cfKey(addName));
    saveCols();
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    // 二维码标签
    $('editQrLabel').addEventListener('click', function () {
      if (!editingCode) return;
      var asset = null;
      assetsOf(simUser).forEach(function (a) { if (a.code === editingCode) asset = a; });
      if (asset) openQrLabelModal([asset]);
    });
    $('btnBatchPrintQr').addEventListener('click', function () {
      var codes = selectedCodes();
      var picked = assetsOf(simUser).filter(function (a) { return codes.indexOf(a.code) >= 0; });
      openQrLabelModal(picked);
    });
    $('qrClose').addEventListener('click', closeQrLabelModal);
    $('qrCancel').addEventListener('click', closeQrLabelModal);
    $('qrPrint').addEventListener('click', doQrPrint);
    $('qrPaper').addEventListener('change', function () {
      $('qrPaperCustom').style.display = this.value === 'custom' ? '' : 'none';
      refreshQrPreview();
    });
    $('qrLabelPreset').addEventListener('change', function () {
      $('qrLabelCustom').style.display = this.value === 'custom' ? '' : 'none';
      refreshQrPreview();
    });
    ['qrTitle', 'qrPaperW', 'qrPaperH', 'qrLabelW', 'qrLabelH'].forEach(function (id) {
      $(id).addEventListener('input', refreshQrPreview);
    });
    $('qrFields').addEventListener('change', refreshQrPreview);
    // 批量导入 / 导出
    $('btnImport').addEventListener('click', openImportModal);
    $('btnExport').addEventListener('click', openExportModal);
    $('impClose').addEventListener('click', closeImportModal);
    $('impCancel').addEventListener('click', closeImportModal);
    $('impDrop').addEventListener('click', function () { $('impFile').click(); });
    $('impFile').addEventListener('change', function () {
      if (this.files && this.files[0]) parseImportFile(this.files[0]);
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      $('impDrop').addEventListener(ev, function (e) { e.preventDefault(); this.style.borderColor = 'var(--a-primary)'; });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      $('impDrop').addEventListener(ev, function (e) { e.preventDefault(); this.style.borderColor = ''; });
    });
    $('impDrop').addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) parseImportFile(e.dataTransfer.files[0]);
    });
    $('impSubmit').addEventListener('click', submitImport);
    $('expClose').addEventListener('click', closeExportModal);
    $('expCancel').addEventListener('click', closeExportModal);
    $('expScope').addEventListener('change', updateExportInfo);
    $('expSubmit').addEventListener('click', doExport);
    // 列筛选面板
    $('fpClose').addEventListener('click', closeFilterPanel);
    $('fpApply').addEventListener('click', applyFilterFromPanel);
    $('fpReset').addEventListener('click', resetColumnFilter);
    $('btnClearFilters').addEventListener('click', clearAllFilters);
    document.addEventListener('click', function (e) {
      if (!$('filterPanel').classList.contains('hidden') &&
          !e.target.closest('#filterPanel') && !e.target.closest('.filter-btn')) {
        closeFilterPanel();
      }
    });
    $('colCfgToggle').addEventListener('click', function () { $('colCfg').classList.toggle('hidden'); });
    $('previewMode').addEventListener('change', function () { state.preview = this.value; renderTable(); });
    $('pageSize').addEventListener('change', function () { state.pageSize = Number(this.value) || 10; state.page = 1; renderTable(); });
    $('applyBtn').addEventListener('click', function () {
      state.view = $('ledgerSel').value;
      state.page = 1;
      state.selected = {};
      state.filters = {};
      closeFilterPanel();
      renderTable();
    });
    $('btnInPurchase').addEventListener('click', function () { openInModal('purchase'); });
    $('btnInRecycle').addEventListener('click', function () { openInModal('recycle'); });
    $('btnOutbound').addEventListener('click', openOutModal);
    $('btnLocConfig').addEventListener('click', openLocModal);
    // 批量操作
    $('btnBatchOut').addEventListener('click', openBatchOutModal);
    $('btnBatchDel').addEventListener('click', batchDelete);
    $('btnBatchClear').addEventListener('click', clearSelection);
    $('batchOutToUser').addEventListener('change', function () {
      $('batchOutToOrg').value = orgOf(this.value) || '';
    });
    bindFileInput('batchOutFiles', 'batchOutFileList', 'batch');
    $('batchOutSubmit').addEventListener('click', submitBatchOut);
    $('batchOutCancel').addEventListener('click', closeBatchOutModal);
    $('batchOutClose').addEventListener('click', closeBatchOutModal);
    // 更新台账信息
    $('btnUserManage').addEventListener('click', openUserModal);
    $('umClose').addEventListener('click', closeUserModal);
    $('umCreate').addEventListener('click', async function () {
      try {
        await api('/api/admin/users', { method: 'POST', body: {
          username: $('umNewName').value.trim(), password: $('umNewPass').value,
          role: $('umNewRole').value, org_id: $('umNewOrg').value || null
        }});
        $('umNewName').value = ''; $('umNewPass').value = '';
        await loadUserList(); alert('用户已创建');
      } catch (e) { alert('创建失败：' + e.message); }
    });
    $('umOrgCreate').addEventListener('click', async function () {
      try {
        await api('/api/admin/orgs', { method: 'POST', body: { name: $('umNewOrgName').value.trim(), parent_id: null } });
        $('umNewOrgName').value = '';
        await loadOrgList(); await loadUserList(); alert('组织已创建');
      } catch (e) { alert('创建失败：' + e.message); }
    });
    $('umList').addEventListener('click', async function (e) {
      var b = e.target.closest('[data-um-approve]');
      if (b) { try { await api('/api/admin/users/' + encodeURIComponent(b.dataset.umApprove) + '/approve', { method: 'POST' }); await loadUserList(); } catch (err) { alert(err.message); } return; }
      var d = e.target.closest('[data-um-del]');
      if (d && confirm('确定删除用户 ' + d.dataset.umDel + '？')) {
        try { await api('/api/admin/users/' + encodeURIComponent(d.dataset.umDel), { method: 'DELETE' }); await loadUserList(); } catch (err) { alert(err.message); }
      }
    });
    $('umList').addEventListener('change', async function (e) {
      var role = e.target.closest('[data-um-role]');
      if (role) { try { await api('/api/admin/users/' + encodeURIComponent(role.dataset.umRole) + '/role', { method: 'PUT', body: { role: role.value } }); await loadUserList(); } catch (err) { alert(err.message); } return; }
      var org = e.target.closest('[data-um-org]');
      if (org) { try { await api('/api/admin/users/' + encodeURIComponent(org.dataset.umOrg) + '/org', { method: 'PUT', body: { org_id: org.value || null } }); await loadUserList(); } catch (err) { alert(err.message); } }
    });
    $('umOrgs').addEventListener('click', async function (e) {
      var d = e.target.closest('[data-um-orgdel]');
      if (d && confirm('确定删除该组织？')) {
        try { await api('/api/admin/orgs/' + d.dataset.umOrgdel, { method: 'DELETE' }); await loadOrgList(); await loadUserList(); } catch (err) { alert(err.message); }
      }
    });
    $('editClose').addEventListener('click', closeEditModal);
    $('editCancel').addEventListener('click', closeEditModal);
    $('editSave').addEventListener('click', saveEdit);
    $('editAttachAdd').addEventListener('click', function () { $('editAttachInput').click(); });
    $('editAttachInput').addEventListener('change', async function () {
      if (!editingCode) return;
      var files = Array.prototype.slice.call(this.files);
      if (!files.length) return;
      var hint = $('editAttachHint');
      hint.textContent = '上传中…';
      try {
        await uploadAttachments('asset', editingCode, files);
        hint.textContent = '';
        await reloadEditAttachments();
        await bootstrap();
        renderMyLedgerCard(); renderTable();
      } catch (e) { hint.textContent = ''; alert('附件上传失败：' + e.message); }
      this.value = '';
    });

    $('inGenCode').addEventListener('click', function () { $('inPurCode').value = uid(); });
    $('inRecLoc').addEventListener('change', renderRecLocFields);
    $('inPurFiles').addEventListener('change', function () {
      var files = this.files;
      pendingFiles = Array.prototype.slice.call(files);
      readFilesToAttachments(files).then(function (res) {
        renderFileList('inPurFileList', res.attachments);
        notifySkipped(res.skipped);
      });
    });
    $('inModal').querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { openInModal(t.dataset.intab); });
    });
    $('inSubmit').addEventListener('click', submitInbound);
    $('inCancel').addEventListener('click', closeInModal);
    $('inClose').addEventListener('click', closeInModal);

    $('outToUser').addEventListener('change', function () { $('outToOrg').value = orgOf(this.value) || ''; });
    bindFileInput('outFiles', 'outFileList', 'out');
    $('outSubmit').addEventListener('click', submitOutbound);
    $('outCancel').addEventListener('click', closeOutModal);
    $('outClose').addEventListener('click', closeOutModal);

    $('locClose').addEventListener('click', closeLocModal);
    $('locDone').addEventListener('click', async function () {
      locFields.forEach(function (f, i) {
        var el = $('locFieldRows').querySelector('[data-fname="' + i + '"]');
        var tp = $('locFieldRows').querySelector('[data-ftype="' + i + '"]');
        if (el && el.value.trim()) f.name = el.value.trim();
        if (tp) f.type = tp.value;
      });
      await saveConfig(); closeLocModal();
    });
    $('addLocBtn').addEventListener('click', async function () {
      var v = $('newLocName').value.trim();
      if (!v) { alert('请输入位置名称'); return; }
      if (locations.indexOf(v) >= 0) { alert('该位置已存在'); return; }
      locations.push(v); $('newLocName').value = ''; await saveConfig();
    });
    $('locList').addEventListener('click', async function (e) {
      var b = e.target.closest('button[data-del-loc]');
      if (!b) return;
      locations.splice(Number(b.dataset.delLoc), 1); await saveConfig();
    });
    $('addFieldBtn').addEventListener('click', async function () {
      var v = $('newFieldName').value.trim();
      if (!v) { alert('请输入字段名'); return; }
      locFields.push({ name: v, type: $('newFieldType').value });
      $('newFieldName').value = ''; await saveConfig();
    });
    $('locFieldRows').addEventListener('click', async function (e) {
      var b = e.target.closest('button[data-del-field]');
      if (!b) return;
      locFields.splice(Number(b.dataset.delField), 1); await saveConfig();
    });

    $('addCfBtn').addEventListener('click', function () {
      var name = $('newCfName').value.trim();
      if (!name) { alert('请输入台账字段名'); return; }
      if (customFields.some(function (f) { return f.name === name; })) { alert('该字段已存在'); return; }
      var type = $('newCfType').value;
      var opts = $('newCfOptions').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (type === 'select' && !opts.length) { alert('下拉类型请填写选项（逗号分隔）'); return; }
      customFields.push({
        name: name, type: type, options: opts,
        required: !!$('newCfRequired').checked, apply: $('newCfApply').value
      });
      syncCustomCols(name);
      $('newCfName').value = ''; $('newCfOptions').value = ''; $('newCfRequired').checked = false;
      renderCfConfig(); renderColCfg(); renderTable();
    });
    $('cfFieldRows').addEventListener('click', async function (e) {
      var b = e.target.closest('button[data-del-cf]');
      if (!b) return;
      var removed = customFields[Number(b.dataset.delCf)];
      customFields.splice(Number(b.dataset.delCf), 1);
      syncCustomCols();
      if (removed) {
        state.cols = state.cols.filter(function (c) { return c !== cfKey(removed.name); });
        saveCols();
      }
      renderCfConfig(); renderColCfg(); renderTable();
    });

    $('drawerClose').addEventListener('click', closeDrawer);
    $('overlay').addEventListener('click', closeDrawer);
    $('drawerTabs').addEventListener('click', function (e) {
      var tab = e.target.closest('.tab');
      if (!tab) return;
      $('drawerTabs').querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      $('drawerBody').innerHTML = renderModule(tab.dataset.mod);
    });
    $('drawerBody').addEventListener('click', function (e) {
      if (e.target.classList.contains('demo-act')) {
        e.target.textContent = '已提交（Demo 不写库）'; e.target.disabled = true;
      }
    });
  }

  /* ---------- 用户管理（复用 /api/admin/*） ---------- */
  var umCtx = null;
  async function openUserModal() {
    if (!IS_ADMIN) { alert('只有管理员可以管理用户'); return; }
    try {
      umCtx = await api('/api/admin/context');
      $('umNewOrg').innerHTML = '<option value="">无组织</option>' + (umCtx.orgs || []).map(function (o) {
        return '<option value="' + o.id + '">' + esc(o.name) + '</option>';
      }).join('');
      $('umNewRole').innerHTML = (umCtx.sys_roles || []).filter(function (r) {
        return r.key !== 'super_admin' || (typeof SYS_ROLE !== 'undefined' && SYS_ROLE === 'super_admin');
      }).map(function (r) {
        return '<option value="' + r.key + '">' + esc(r.label) + '</option>';
      }).join('');
      $('userModal').classList.add('show');
      await loadUserList();
      await loadOrgList();
    } catch (e) { alert('加载用户管理失败：' + e.message); }
  }
  function closeUserModal() { $('userModal').classList.remove('show'); }
  async function loadUserList() {
    var d = await api('/api/admin/users');
    $('umPending').textContent = d.pending_count ? ('（' + d.pending_count + ' 个待审批）') : '';
    $('umList').innerHTML = (d.users || []).map(function (u) {
      var st = u.status === 'approved' ? '<span class="tag tag-green">已批准</span>' : '<span class="tag tag-amber">待审批</span>';
      var roleOpts = (umCtx.sys_roles || []).map(function (r) {
        return '<option value="' + r.key + '"' + (u.role === r.key ? ' selected' : '') + '>' + esc(r.label) + '</option>';
      }).join('');
      var orgOpts = '<option value="">无组织</option>' + (umCtx.orgs || []).map(function (o) {
        return '<option value="' + o.id + '"' + (u.org_id === o.id ? ' selected' : '') + '>' + esc(o.name) + '</option>';
      }).join('');
      return '<div class="um-row">' +
        '<span class="uname">' + esc(u.username) + '</span>' + st +
        '<select data-um-role="' + esc(u.username) + '">' + roleOpts + '</select>' +
        '<select data-um-org="' + esc(u.username) + '">' + orgOpts + '</select>' +
        '<span class="sp"></span>' +
        (u.status === 'pending' ? '<button class="btn sm" data-um-approve="' + esc(u.username) + '">批准</button>' : '') +
        '<button class="btn sm danger" data-um-del="' + esc(u.username) + '">删除</button></div>';
    }).join('');
  }
  async function loadOrgList() {
    var d = await api('/api/admin/orgs');
    $('umOrgs').innerHTML = (d.orgs || []).map(function (o) {
      return '<div class="um-row"><span class="uname">' + esc(o.name) + '</span><span class="sp"></span>' +
        '<button class="btn sm danger" data-um-orgdel="' + o.id + '">删除</button></div>';
    }).join('') || '<span class="hint">暂无组织</span>';
  }

  async function init() {
    try {
      await bootstrap();
      syncCustomCols();
      renderMyLedgerCard();
      renderColCfg();
      renderTable();
      bind();
    } catch (e) {
      document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;">加载失败：' + esc(e.message) + '</div>';
    }
  }


  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
