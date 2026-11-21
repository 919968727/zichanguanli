/* ============================================================
 * 台账附件管理器（file-manager.js） — A 方案
 *
 * 行为约定：
 *   - FileManager.open(lid)   切换台账 + 显示 FAB + 预加载文件列表（不打开抽屉）
 *   - FAB 点击                打开/关闭抽屉切换
 *   - 抽屉 DOM                在 loadFiles 和 FileManager.open 中按需创建（幂等）
 *   - FileManager.open()      返回 Promise，调用方应 .catch() 处理异常
 *
 * ★ 不再 monkey-patch window.fetch。
 *   台账打开/关闭由 editor-ledger.js 在 openLedger() / removeLedger() 里
 *   显式调用 FileManager.open/close 完成，避免拦截列表请求误关抽屉。
 * ============================================================ */
(function () {
  'use strict';

  var API = {
    list: function (lid) { return '/api/ledgers/' + lid + '/files'; },
    upload: function (lid) { return '/api/ledgers/' + lid + '/files'; },
    download: function (fid) { return '/api/files/' + fid + '/download'; },
    remove: function (fid) { return '/api/files/' + fid; },
    types: function (lid) { return '/api/ledgers/' + lid + '/file-types'; }
  };

  var MAX_FILE_SIZE = 100 * 1024 * 1024;
  var MAX_BATCH = 10;

  var FILE_TYPE_GROUPS = [
    { name: '文档',     types: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt'] },
    { name: '表格',     types: ['xls', 'xlsx', 'csv', 'ods'] },
    { name: '演示',     types: ['ppt', 'pptx', 'odp'] },
    { name: '图片',     types: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'tiff'] },
    { name: '压缩包',   types: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'] },
    { name: '音视频',   types: ['mp3', 'wav', 'mp4', 'avi', 'mkv', 'mov', 'flv'] },
    { name: '代码/数据', types: ['json', 'xml', 'yaml', 'yml', 'html', 'css', 'js', 'py', 'sql', 'log'] }
  ];

  var state = {
    lid: null,
    files: [],
    allowed: [],
    usage: null,
    canUpload: false,
    canDownload: false,
    canManageTypes: false,
    defaults: [],
    busy: false,
    drawerOpen: false,
    loadedFor: null,
    loading: null
  };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtSize(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function getCSRF() {
    if (typeof window.CSRF === 'string' && window.CSRF) return window.CSRF;
    if (typeof window.CSRF_TOKEN === 'string' && window.CSRF_TOKEN) return window.CSRF_TOKEN;
    if (typeof window.csrfToken === 'string' && window.csrfToken) return window.csrfToken;
    if (typeof window.csrf_token === 'string' && window.csrf_token) return window.csrf_token;
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content) return meta.content;
    return '';
  }

  async function request(url, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    if (options.method && options.method !== 'GET') {
      var tok = getCSRF();
      if (tok) headers['X-CSRF-Token'] = tok;
    }
    var res = await fetch(url, {
      method: options.method || 'GET',
      headers: headers,
      credentials: 'same-origin',
      body: options.body
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401) {
      window.location.href = '/';
      throw new Error('未登录');
    }
    if (!res.ok) {
      throw new Error(data.msg || ('请求失败 HTTP ' + res.status));
    }
    return data;
  }

  /* ============================================================
   * FAB
   * ============================================================ */
  function ensureFab() {
    if ($('fmFab')) return;
    var fab = document.createElement('button');
    fab.id = 'fmFab';
    fab.type = 'button';
    fab.className = 'fm-fab';
    fab.title = '台账附件';
    fab.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>' +
      '</svg>' +
      '<span class="fm-fab-count" id="fmFabCount" hidden>0</span>';
    fab.addEventListener('click', function () {
      if (!state.lid) return;
      if (state.drawerOpen) closeDrawer();
      else openDrawerFor(state.lid);
    });
    document.body.appendChild(fab);
  }

  function showFab() {
    ensureFab();
    var fab = $('fmFab');
    if (fab) fab.classList.add('show');
  }

  function hideFab() {
    var fab = $('fmFab');
    if (fab) fab.classList.remove('show');
    updateFabBadge(0);
  }

  function updateFabBadge(n) {
    var el = $('fmFabCount');
    if (!el) return;
    if (!n) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = n > 99 ? '99+' : String(n);
  }

  /* ============================================================
   * 抽屉 DOM（幂等创建）
   * ============================================================ */
  function ensureDrawerDOM() {
    if ($('fmDrawer')) return;

    var overlay = document.createElement('div');
    overlay.className = 'fm-overlay';
    overlay.id = 'fmOverlay';
    overlay.addEventListener('click', closeDrawer);

    var drawer = document.createElement('aside');
    drawer.className = 'fm-drawer';
    drawer.id = 'fmDrawer';
    drawer.innerHTML = [
      '<div class="fm-head">',
      '  <div class="fm-title">台账附件<span class="fm-count" id="fmCount">0</span></div>',
      '  <button type="button" class="fm-close" id="fmClose" title="关闭">×</button>',
      '</div>',
      '<div class="fm-usage">',
      '  <div class="fm-bar"><div class="fm-bar-inner" id="fmUsageBar"></div></div>',
      '  <div class="fm-usage-text" id="fmUsageText">0 B / 2 GB</div>',
      '</div>',
      '<div class="fm-actions">',
      '  <input type="file" id="fmInput" multiple hidden>',
      '  <button type="button" class="small" id="fmPick" hidden>选择文件上传</button>',
      '  <span class="fm-hint" id="fmUploadHint"></span>',
      '</div>',
      '<div class="fm-types" id="fmTypesWrap" hidden>',
      '  <details>',
      '    <summary>允许上传的文件类型配置（创建者/管理员）</summary>',
      '    <div class="fm-type-groups" id="fmTypeGroups"></div>',
      '    <div class="fm-type-actions">',
      '      <button type="button" class="small" id="fmTypesSave">保存</button>',
      '      <button type="button" class="small outline" id="fmTypesReset">恢复默认</button>',
      '      <span class="fm-hint" id="fmTypeHint"></span>',
      '    </div>',
      '  </details>',
      '</div>',
      '<ul class="fm-list" id="fmList"></ul>'
    ].join('');

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    $('fmClose').addEventListener('click', closeDrawer);
    $('fmPick').addEventListener('click', function () { $('fmInput').click(); });
    $('fmInput').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = '';
      if (files.length) {
        uploadSequential(files).catch(function (err) {
          console.warn('[FileManager] uploadSequential 失败：', err);
        });
      }
    });
    $('fmList').addEventListener('click', onListClick);
    $('fmTypesSave').addEventListener('click', function () {
      saveTypes(collectTypes()).catch(function (err) {
        console.warn('[FileManager] saveTypes 失败：', err);
      });
    });
    $('fmTypesReset').addEventListener('click', function () {
      var defs = (state.defaults && state.defaults.length)
        ? state.defaults.slice()
        : FILE_TYPE_GROUPS.reduce(function (acc, g) { return acc.concat(g.types); }, []);
      saveTypes(defs).catch(function (err) {
        console.warn('[FileManager] saveTypes 失败：', err);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.drawerOpen) closeDrawer();
    });
  }

  function openDrawerFor(lid) {
    ensureDrawerDOM();
    var needLoad = (state.loadedFor !== lid);
    state.lid = lid;
    state.drawerOpen = true;
    document.body.classList.add('fm-drawer-open');
    $('fmOverlay').classList.add('show');
    $('fmDrawer').classList.add('open');
    if (needLoad && state.loading !== lid) {
      loadFiles(lid).catch(function (err) {
        console.warn('[FileManager] loadFiles 失败：', err);
      });
    }
  }

  function closeDrawer() {
    state.drawerOpen = false;
    document.body.classList.remove('fm-drawer-open');
    var ov = $('fmOverlay');
    var dr = $('fmDrawer');
    if (ov) ov.classList.remove('show');
    if (dr) dr.classList.remove('open');
  }

  /* ============================================================
   * 加载 / 渲染
   * ============================================================ */
  async function loadFiles(lid) {
    ensureDrawerDOM();
    state.lid = lid;
    state.loading = lid;
    $('fmUploadHint').textContent = '';
    $('fmTypeHint').textContent = '';
    $('fmList').innerHTML = '<li class="fm-empty">加载中…</li>';

    try {
      var data = await request(API.list(lid));
      state.files = data.files || [];
      state.allowed = data.allowed_file_types || [];
      state.usage = data.usage || null;
      state.canUpload = !!data.can_upload;
      state.canDownload = !!data.can_download;
      state.canManageTypes = !!data.can_manage_types;
      state.loadedFor = lid;
      updateFabBadge(state.files.length);
      render();
    } catch (e) {
      $('fmList').innerHTML = '<li class="fm-empty">' + esc(e.message || '加载失败') + '</li>';
      throw e;
    } finally {
      if (state.loading === lid) state.loading = null;
    }
  }

  function render() {
    $('fmCount').textContent = state.files.length;
    updateFabBadge(state.files.length);

    var u = state.usage || {
      total_size: 0, count: 0,
      max_file_size: MAX_FILE_SIZE,
      max_total_size: 2 * 1024 * 1024 * 1024,
      max_count: 200
    };
    var pct = u.max_total_size
      ? Math.min(100, (u.total_size / u.max_total_size) * 100)
      : 0;
    $('fmUsageBar').style.width = pct + '%';
    $('fmUsageText').textContent =
      fmtSize(u.total_size) + ' / ' + fmtSize(u.max_total_size) +
      '（' + u.count + '/' + u.max_count + ' 个）';

    var pick = $('fmPick');
    pick.hidden = !state.canUpload;
    var allowEmpty = state.canUpload && state.allowed.length === 0;
    pick.disabled = !!state.busy || allowEmpty;
    if (allowEmpty) {
      $('fmUploadHint').textContent = '该台账未配置允许上传的文件类型，请联系创建者。';
    } else if (!state.busy) {
      $('fmUploadHint').textContent = '';
    }

    var list = $('fmList');
    if (!state.files.length) {
      list.innerHTML = '<li class="fm-empty">暂无附件</li>';
    } else {
      var html = '';
      state.files.forEach(function (f) {
        html += '<li class="fm-item" data-fid="' + f.id + '">';
        html += '<div class="fm-name" title="' + esc(f.filename) + '">' + esc(f.filename) + '</div>';
        html += '<div class="fm-meta">' + fmtSize(f.size) + ' · ' +
                esc(f.uploader) + ' · ' + esc(f.created_at) + '</div>';
        html += '<div class="fm-item-btns">';
        if (state.canDownload) {
          html += '<button type="button" class="small" data-act="download">下载</button>';
        }
        if (f.can_delete) {
          html += '<button type="button" class="small danger" data-act="delete">删除</button>';
        }
        html += '</div></li>';
      });
      list.innerHTML = html;
    }

    renderTypePanel();
  }

  function renderTypePanel() {
    var wrap = $('fmTypesWrap');
    wrap.hidden = !state.canManageTypes;
    if (!state.canManageTypes) return;

    var box = $('fmTypeGroups');
    box.innerHTML = '';
    FILE_TYPE_GROUPS.forEach(function (group) {
      var details = document.createElement('details');
      details.className = 'fm-type-group';
      var picked = group.types.filter(function (t) {
        return state.allowed.indexOf(t) > -1;
      }).length;
      var summary = document.createElement('summary');
      summary.textContent = group.name + '（' + picked + '/' + group.types.length + '）';
      details.appendChild(summary);

      var listWrap = document.createElement('div');
      listWrap.className = 'fm-type-list';
      group.types.forEach(function (t) {
        var id = 'fmtype-' + t;
        var label = document.createElement('label');
        label.setAttribute('for', id);
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = id;
        cb.value = t;
        cb.checked = state.allowed.indexOf(t) > -1;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' .' + t));
        listWrap.appendChild(label);
      });
      details.appendChild(listWrap);
      box.appendChild(details);
    });
  }

  function onListClick(e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var li = btn.closest('li[data-fid]');
    if (!li) return;
    var fid = parseInt(li.getAttribute('data-fid'), 10);
    var f = state.files.find(function (x) { return x.id === fid; });
    if (!f) return;
    var act = btn.getAttribute('data-act');
    if (act === 'download') {
      window.location.href = API.download(f.id);
    } else if (act === 'delete') {
      deleteFile(f).catch(function (err) {
        console.warn('[FileManager] deleteFile 失败：', err);
      });
    }
  }

  async function uploadSequential(files) {
    if (state.busy) return;
    if (state.allowed.length === 0) {
      $('fmUploadHint').textContent = '该台账未配置允许上传的文件类型';
      return;
    }
    var picked = files.slice(0, MAX_BATCH);
    var total = picked.length;
    var okCount = 0;
    var errMsgs = [];

    state.busy = true;
    render();

    for (var i = 0; i < total; i++) {
      var f = picked[i];
      var ext = (f.name.indexOf('.') > -1 ? f.name.split('.').pop() : '').toLowerCase();
      if (!ext || state.allowed.indexOf(ext) === -1) {
        errMsgs.push(f.name + '：不允许的类型');
        continue;
      }
      if (f.size > MAX_FILE_SIZE) {
        errMsgs.push(f.name + '：文件过大，请压缩至 100M 以下');
        continue;
      }
      $('fmUploadHint').textContent =
        '正在上传 ' + (i + 1) + '/' + total + '：' + f.name;
      try {
        var fd = new FormData();
        fd.append('file', f);
        await request(API.upload(state.lid), { method: 'POST', body: fd });
        okCount++;
      } catch (err) {
        errMsgs.push(f.name + '：' + (err.message || '上传失败'));
      }
    }

    state.busy = false;
    if (okCount && errMsgs.length === 0) {
      $('fmUploadHint').textContent = '成功上传 ' + okCount + ' 个文件';
    } else if (okCount && errMsgs.length) {
      $('fmUploadHint').textContent =
        '成功上传 ' + okCount + ' 个；失败 ' + errMsgs.length + ' 个（' +
        errMsgs.slice(0, 3).join('；') + (errMsgs.length > 3 ? '…' : '') + '）';
    } else {
      $('fmUploadHint').textContent = '上传失败：' + errMsgs.slice(0, 3).join('；');
    }

    await refresh();
  }

  async function deleteFile(f) {
    if (!confirm('确定删除附件「' + f.filename + '」？删除后不可恢复。')) return;
    try {
      await request(API.remove(f.id), { method: 'DELETE' });
      await refresh();
    } catch (e) {
      alert(e.message || '删除失败');
    }
  }

  function collectTypes() {
    var boxes = document.querySelectorAll('#fmTypeGroups input[type="checkbox"]');
    var out = [];
    Array.prototype.forEach.call(boxes, function (cb) {
      if (cb.checked) out.push(cb.value);
    });
    return out;
  }

  async function saveTypes(types) {
    if (!state.lid) return;
    $('fmTypeHint').textContent = '保存中…';
    try {
      var data = await request(API.types(state.lid), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ types: types })
      });
      state.allowed = data.allowed_file_types || [];
      if (data.default_file_types) state.defaults = data.default_file_types;
      $('fmTypeHint').textContent = '已保存';
      render();
    } catch (e) {
      $('fmTypeHint').textContent = e.message || '保存失败';
    }
  }

  function refresh() {
    if (!state.lid) return Promise.resolve();
    return loadFiles(state.lid);
  }

  /* ============================================================
   * 对外 API
   * ============================================================ */
  window.FileManager = {
    // 切到某个台账：显示 FAB，预加载附件列表，不打开抽屉
    // 返回 Promise，调用方应 .catch()
    open: function (lid) {
      if (!lid) return Promise.resolve();
      ensureDrawerDOM();
      ensureFab();
      var changed = (state.lid !== lid);
      state.lid = lid;
      showFab();
      if (changed) {
        state.files = [];
        state.allowed = [];
        state.usage = null;
        state.loadedFor = null;
        updateFabBadge(0);
      }
      if (state.loadedFor !== lid && state.loading !== lid) {
        return loadFiles(lid);
      }
      return Promise.resolve();
    },
    showDrawer: function () {
      if (state.lid) openDrawerFor(state.lid);
    },
    hideDrawer: closeDrawer,
    close: function () {
      closeDrawer();
      state.lid = null;
      state.files = [];
      state.allowed = [];
      state.usage = null;
      state.loadedFor = null;
      state.loading = null;
      hideFab();
    },
    refresh: refresh,
    currentCount: function () { return state.files.length; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureFab);
  } else {
    ensureFab();
  }
})();