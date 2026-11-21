/* 扫码应用配置弹窗 */
(function () {
  'use strict';

  var modal = document.getElementById('scanConfigModal');
  var btn = document.getElementById('btnScanConfig');
  if (!modal || !btn) {
    console.warn('[scan-config] 未找到 #scanConfigModal 或 #btnScanConfig，跳过初始化');
    return;
  }

  var allLedgers = [];
  var appListEl, formEl, appIdEl, nameEl, iconEl, ledgerSel, descEl;
  var displaysEl, actionsEl, logEnabledEl, logEl, logLedgerSel, fieldsEl;
  var audioEl, autoClearEl;
  var editingAppId = null;
  var currentCols = [];

  var $ = function (id) { return document.getElementById(id); };

  var REQUIRED_IDS = [
    'scanCfgAppList', 'scanCfgForm', 'scanCfgAppId', 'scanCfgName',
    'scanCfgIcon', 'scanCfgLedger', 'scanCfgDesc', 'scanCfgDisplays',
    'scanCfgActions', 'scanCfgAppendLogEnabled', 'scanCfgAppendLog',
    'scanCfgLogLedger', 'scanCfgFields', 'scanCfgSuccessAudio',
    'scanCfgAutoClear'
  ];

  function initRefs() {
    appListEl    = $('scanCfgAppList');
    formEl       = $('scanCfgForm');
    appIdEl      = $('scanCfgAppId');
    nameEl       = $('scanCfgName');
    iconEl       = $('scanCfgIcon');
    ledgerSel    = $('scanCfgLedger');
    descEl       = $('scanCfgDesc');
    displaysEl   = $('scanCfgDisplays');
    actionsEl    = $('scanCfgActions');
    logEnabledEl = $('scanCfgAppendLogEnabled');
    logEl        = $('scanCfgAppendLog');
    logLedgerSel = $('scanCfgLogLedger');
    fieldsEl     = $('scanCfgFields');
    audioEl      = $('scanCfgSuccessAudio');
    autoClearEl  = $('scanCfgAutoClear');

    var missing = REQUIRED_IDS.filter(function (id) { return !$(id); });
    if (missing.length) {
      console.error('[scan-config] 缺少必要 DOM 元素：', missing.join(', '));
      return false;
    }
    return true;
  }

  if (!initRefs()) {
    console.error('[scan-config] 初始化失败，跳过事件绑定');
    return;
  }

  // ★★★ 字段映射提示（变量表 + 列 UUID 对照表） ★★★

  function injectHintStyleOnce() {
    if (document.getElementById('scanCfgFieldHintStyle')) return;
    var st = document.createElement('style');
    st.id = 'scanCfgFieldHintStyle';
    st.textContent = [
      '.scan-cfg-field-hint{margin:6px 0 10px;background:#f8fafc;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;font-size:12.5px;color:var(--text);}',
      '.scan-cfg-field-hint > details{margin:0;}',
      '.scan-cfg-field-hint > details + details{margin-top:8px;border-top:1px dashed var(--border);padding-top:8px;}',
      '.scan-cfg-field-hint summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--primary-dark);user-select:none;list-style:none;outline:none;}',
      '.scan-cfg-field-hint summary::-webkit-details-marker{display:none;}',
      '.scan-cfg-field-hint summary::before{content:"▸ ";display:inline-block;transition:transform .15s;}',
      '.scan-cfg-field-hint details[open] summary::before{content:"▾ ";}',
      '.scan-cfg-field-hint-body{margin-top:8px;}',
      '.scan-cfg-field-hint .tip{color:var(--text-muted);font-size:12px;line-height:1.7;margin:0 0 8px;}',
      '.scan-cfg-field-hint table{width:100%;border-collapse:collapse;font-size:12px;}',
      '.scan-cfg-field-hint th,.scan-cfg-field-hint td{padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top;}',
      '.scan-cfg-field-hint th{color:var(--text-muted);font-weight:600;background:#eef2ff;}',
      '.scan-cfg-field-hint code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;background:#fff;border:1px solid var(--border);border-radius:4px;padding:1px 5px;color:var(--primary-dark);}',
      '.scan-cfg-field-hint .warn{color:#b45309;font-size:12px;line-height:1.7;background:#fef3c7;border:1px solid #fde68a;border-radius:4px;padding:6px 8px;margin:8px 0 0;}',
      '.scan-cfg-col-uuid-list{list-style:none;padding:0;margin:6px 0 0;display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto;}',
      '.scan-cfg-col-uuid-list li{display:flex;align-items:center;gap:8px;padding:3px 0;}',
      '.scan-cfg-col-uuid-list .col-name{flex:0 0 110px;color:var(--text);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.scan-cfg-col-uuid-list code{flex:1;cursor:pointer;user-select:all;}',
      '.scan-cfg-col-uuid-list code:hover{background:var(--primary-soft);border-color:var(--primary);}',
      '.scan-cfg-col-uuid-list .empty{color:var(--text-light);font-size:12px;padding:6px 0;}',
      '.scan-cfg-hint-toast{position:fixed;top:80px;left:50%;transform:translateX(-50%) translateY(-6px);padding:8px 18px;border-radius:8px;background:#10b981;color:#fff;font-size:12.5px;font-weight:600;box-shadow:0 6px 20px rgba(16,185,129,.4);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:99999;}',
      '.scan-cfg-hint-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function ensureFieldHint() {
    injectHintStyleOnce();

    var existing = document.getElementById('scanCfgFieldHint');
    if (existing) { refreshColumnUuidTable(); return; }

    var anchor = document.getElementById('scanCfgFields');
    if (!anchor || !anchor.parentNode) return;

    var box = document.createElement('div');
    box.id = 'scanCfgFieldHint';
    box.className = 'scan-cfg-field-hint';
    box.innerHTML = [
      '<details open>',
      '  <summary>📖 字段模板变量说明</summary>',
      '  <div class="scan-cfg-field-hint-body">',
      '    <p class="tip">',
      '      左栏填<b>目标台账（日志台账）里已有的表头名</b>，右栏填值模板。<br>',
      '      左栏写了但目标台账没有这个表头 → 该行被忽略；<br>',
      '      目标台账有但这里没写的列 → 追加时填空串。',
      '    </p>',
      '    <table>',
      '      <thead><tr><th style="width:170px;">模板</th><th>含义</th><th style="width:220px;">示例值</th></tr></thead>',
      '      <tbody>',
      '        <tr><td><code>$col:列UUID</code></td><td>从本台账（被扫的那本）当前行取该列的值。必须是 32 位十六进制列 UUID，不能写表头名</td><td><code>华为 RH2288</code></td></tr>',
      '        <tr><td><code>$user</code></td><td>当前扫码的用户名</td><td><code>张三</code></td></tr>',
      '        <tr><td><code>$now</code></td><td>服务端当前时间（精确到秒，与手机时钟无关）</td><td><code>2024-11-12 14:23:05</code></td></tr>',
      '        <tr><td><code>$gid</code></td><td>本次扫到的二维码唯一标识</td><td><code>L1_a3f2b9c8…</code></td></tr>',
      '        <tr><td><code>$action_label</code></td><td>本次点击的快捷操作按钮名</td><td><code>标记正常</code></td></tr>',
      '        <tr><td><code>$action_value</code></td><td>本次操作<b>实际写入本台账的值</b>。随操作类型变化：<br>· 固定值 → 固定值原文<br>· 扫码时间 / 日期 / 时分秒 → 对应时间文本</td><td><code>正常</code> 或 <code>2024-11-12 14:23:05</code></td></tr>',
      '        <tr><td>其它任意文本</td><td>原样写入的固定文本</td><td><code>自动生成</code></td></tr>',
      '      </tbody>',
      '    </table>',
      '    <p class="warn">',
      '      ⚠ 模板变量必须<b>整串完全等于</b>该变量才会替换。<br>',
      '      「时间：$now」「$now (UTC)」这类会被当作固定文本原样写入，请拆成单独一行。<br>',
      '      ⚠ 拼写错误不会报错，只会原样写入。配置完记得扫码测试一次核对。',
      '    </p>',
      '  </div>',
      '</details>',
      '<details>',
      '  <summary>🔑 当前台账列 UUID 对照（用于 <code>$col:xxx</code>）</summary>',
      '  <p class="tip" style="margin:6px 0 0;">点击任意 UUID 即可复制。仅列出<b>当前目标台账</b>的列（切换上方"目标台账"会同步刷新）。</p>',
      '  <ul id="scanCfgColUuidList" class="scan-cfg-col-uuid-list"></ul>',
      '</details>'
    ].join('');

    anchor.parentNode.insertBefore(box, anchor);
    refreshColumnUuidTable();
  }

  function refreshColumnUuidTable() {
    var list = document.getElementById('scanCfgColUuidList');
    if (!list) return;
    list.innerHTML = '';
    if (!currentCols || !currentCols.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '（尚未加载到列信息，请先在"目标台账"里选择一本台账）';
      list.appendChild(li);
      return;
    }
    currentCols.forEach(function (c) {
      var li = document.createElement('li');

      var name = document.createElement('span');
      name.className = 'col-name';
      name.textContent = c.name || '(未命名)';
      name.title = c.name || '';

      var code = document.createElement('code');
      code.textContent = c.uuid;
      code.title = '点击复制 UUID';
      code.addEventListener('click', function () {
        copyToClipboard(c.uuid);
      });

      li.appendChild(name);
      li.appendChild(code);
      list.appendChild(li);
    });
  }

  function copyToClipboard(text) {
    function done() { showHintToast('✓ 已复制 ' + String(text).slice(0, 12) + '…'); }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(); });
        return;
      }
    } catch (e) {}
    fallback();

    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { alert('复制失败，请手动选中 UUID 复制'); }
      document.body.removeChild(ta);
    }
  }

  var _hintToastTimer = null;
  function showHintToast(msg) {
    var el = document.getElementById('scanCfgHintToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scanCfgHintToast';
      el.className = 'scan-cfg-hint-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_hintToastTimer);
    _hintToastTimer = setTimeout(function () { el.classList.remove('show'); }, 1600);
  }

  // ============ 打开 / 关闭 ============
  btn.addEventListener('click', openModal);
  $('scanCfgClose').addEventListener('click', closeModal);
  $('scanCfgCancel').addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();
  });

  async function openModal() {
    if (!initRefs()) {
      alert('页面结构异常，找不到配置弹窗的必要元素');
      return;
    }
    modal.classList.remove('hidden');
    formEl.classList.add('hidden');
    editingAppId = null;
    try {
      await loadLedgers();
      await loadApps();
    } catch (e) {
      alert('加载失败：' + (e && e.message ? e.message : e));
    }
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  // ============ 台账列表 ============
  async function loadLedgers() {
    var data = await api('/api/ledgers?light=1');
    allLedgers = data.ledgers || [];

    ledgerSel.innerHTML = '<option value="">— 选择 —</option>';
    allLedgers.forEach(function (L) {
      var o1 = document.createElement('option');
      o1.value = L.id; o1.textContent = L.name + ' (#' + L.id + ')';
      ledgerSel.appendChild(o1);
    });
    if (typeof currentId !== 'undefined' && currentId) {
      ledgerSel.value = String(currentId);
    }
    await refreshLogLedgerOptions();
  }

  async function refreshLogLedgerOptions() {
    var lid = parseInt(ledgerSel.value, 10) || 0;
    var childIds = {};
    if (lid) {
      try {
        var detail = await api('/api/ledgers/' + lid);
        var ledger = (detail && detail.ledger) || {};
        var cellLinks = ledger.cell_links || {};
        Object.keys(cellLinks).forEach(function (k) {
          var tid = cellLinks[k];
          if (tid && tid !== lid) childIds[tid] = true;
        });
      } catch (e) {
        console.warn('[scan-config] 读取主台账 cell_links 失败：', e);
      }
    }

    logLedgerSel.innerHTML = '';
    var ids = Object.keys(childIds);
    if (!ids.length) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '（本台账暂无关联子台账，请先在单元格设置关联）';
      logLedgerSel.appendChild(empty);
      return;
    }
    ids.forEach(function (cid) {
      cid = parseInt(cid, 10);
      var L = null;
      for (var i = 0; i < allLedgers.length; i++) {
        if (allLedgers[i].id === cid) { L = allLedgers[i]; break; }
      }
      if (!L) return;
      var o = document.createElement('option');
      o.value = L.id; o.textContent = L.name + ' (#' + L.id + ')';
      logLedgerSel.appendChild(o);
    });
  }

  // ============ 应用列表 ============
  async function loadApps() {
    var data = await api('/api/scan-config/apps');
    var apps = data.apps || [];
    appListEl.innerHTML = '';
    if (!apps.length) {
      appListEl.innerHTML = '<div class="scan-cfg-empty">暂无扫码应用</div>';
      return;
    }
    apps.forEach(function (cfg) {
      var row = document.createElement('div');
      row.className = 'scan-cfg-app-row';
      row.innerHTML =
        '<span class="scan-cfg-app-icon">' + esc(cfg.icon || '📷') + '</span>' +
        '<span class="scan-cfg-app-name">' + esc(cfg.name || cfg.app_id) + '</span>' +
        '<span class="scan-cfg-app-id">' + esc(cfg.app_id) + '</span>';
      row.addEventListener('click', function () { editApp(cfg); });
      appListEl.appendChild(row);
    });
  }

  // ============ 编辑应用 ============
  async function editApp(cfg) {
    editingAppId = cfg.app_id;
    appIdEl.value = cfg.app_id;
    appIdEl.disabled = true;
    nameEl.value = cfg.name || '';
    iconEl.value = cfg.icon || '📷';
    descEl.value = cfg.description || '';
    ledgerSel.value = String(cfg.ledger_id || '');
    audioEl.checked = !!cfg.success_audio;
    autoClearEl.value = cfg.auto_clear_after_ms || 0;
    logEnabledEl.checked = !!(cfg.append_log && cfg.append_log.enabled);
    logEl.classList.toggle('hidden', !logEnabledEl.checked);

    await loadCols(cfg.ledger_id);
    await refreshLogLedgerOptions();
    if (cfg.append_log && cfg.append_log.ledger_id) {
      var targetVal = String(cfg.append_log.ledger_id);
      var exists = Array.prototype.some.call(
        logLedgerSel.options,
        function (o) { return o.value === targetVal; }
      );
      if (exists) logLedgerSel.value = targetVal;
    }

    renderDisplays(cfg.display || []);
    renderActions(cfg.actions || []);
    renderFields(cfg.append_log ? (cfg.append_log.fields || {}) : {});
    ensureFieldHint();   // ★ 已加载 column 后，确保提示块与 UUID 表都存在

    formEl.classList.remove('hidden');
    $('scanCfgDelete').style.display = '';
    $('scanCfgDownloadOffline').style.display = '';
    formEl.scrollIntoView({ behavior: 'smooth' });
  }

  $('scanCfgNewBtn').addEventListener('click', async function () {
    editingAppId = null;
    appIdEl.value = '';
    appIdEl.disabled = false;
    nameEl.value = '';
    iconEl.value = '📷';
    descEl.value = '';
    ledgerSel.value = (typeof currentId !== 'undefined' && currentId)
      ? String(currentId) : '';
    audioEl.checked = true;
    autoClearEl.value = 800;
    logEnabledEl.checked = false;
    logEl.classList.add('hidden');
    logLedgerSel.value = '';
    displaysEl.innerHTML = '';
    actionsEl.innerHTML = '';
    fieldsEl.innerHTML = '';

    var lid = (typeof currentId !== 'undefined' && currentId) ? currentId : 0;
    await loadCols(lid);
    await refreshLogLedgerOptions();
    ensureFieldHint();   // ★

    formEl.classList.remove('hidden');
    $('scanCfgDelete').style.display = 'none';
    $('scanCfgDownloadOffline').style.display = 'none';
    formEl.scrollIntoView({ behavior: 'smooth' });
  });

  // ============ 列信息 ============
  async function loadCols(lid) {
    currentCols = [];
    if (!lid) return;
    try {
      var data = await api('/api/ledgers/' + lid + '/columns');
      currentCols = data.columns || [];
    } catch (e) {
      currentCols = [];
    }
  }

  ledgerSel.addEventListener('change', async function () {
    await loadCols(parseInt(ledgerSel.value, 10) || 0);
    await refreshLogLedgerOptions();
    refreshColumnUuidTable();   // ★ 换台账后刷新 UUID 对照表
  });

  logEnabledEl.addEventListener('change', function () {
    logEl.classList.toggle('hidden', !logEnabledEl.checked);
    if (logEnabledEl.checked) {
      ensureFieldHint();        // ★ 首次展开时立即插入提示
      if (!fieldsEl.children.length) {
        renderFields({});
      }
    }
  });

  // ============ 展示字段 ============
  function renderDisplays(items) {
    displaysEl.innerHTML = '';
    items.forEach(function (d) { addDisplayRow(d); });
  }

  function addDisplayRow(d) {
    d = d || {};
    var row = document.createElement('div');
    row.className = 'scan-cfg-item';

    var colSel = document.createElement('select');
    currentCols.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.uuid; o.textContent = c.name;
      if (d.col === c.uuid) o.selected = true;
      colSel.appendChild(o);
    });

    var labelInp = document.createElement('input');
    labelInp.className = 'label-input';
    labelInp.placeholder = '显示标签';
    if (d.label) labelInp.value = d.label;
    else if (d.col) {
      var sel0 = currentCols.find(function (c) { return c.uuid === d.col; });
      if (sel0) labelInp.value = sel0.name;
    }

    colSel.addEventListener('change', function () {
      if (!labelInp.value) {
        var sel = currentCols.find(function (c) { return c.uuid === colSel.value; });
        if (sel) labelInp.value = sel.name;
      }
    });

    var hlLabel = document.createElement('label');
    hlLabel.className = 'cb-label';
    var hlCb = document.createElement('input');
    hlCb.type = 'checkbox';
    if (d.highlight) hlCb.checked = true;
    hlLabel.appendChild(hlCb);
    hlLabel.appendChild(document.createTextNode(' 高亮'));

    var delBtn = document.createElement('button');
    delBtn.className = 'del';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', function () { row.remove(); });

    row.appendChild(colSel);
    row.appendChild(labelInp);
    row.appendChild(hlLabel);
    row.appendChild(delBtn);
    displaysEl.appendChild(row);
  }

  $('scanCfgAddDisplay').addEventListener('click', function () { addDisplayRow(); });

  // ============ 快捷操作 ============
  function renderActions(items) {
    actionsEl.innerHTML = '';
    items.forEach(function (a) { addActionRow(a); });
  }

  function addActionRow(a) {
    a = a || {};
    var row = document.createElement('div');
    row.className = 'scan-cfg-item';

    var idInp = document.createElement('input');
    idInp.placeholder = 'ID（唯一）';
    idInp.style.flex = '0 0 100px';
    idInp.value = a.id || '';

    var labelInp = document.createElement('input');
    labelInp.placeholder = '按钮名';
    labelInp.style.flex = '0 0 90px';
    labelInp.value = a.label || '';

    var colSel = document.createElement('select');
    currentCols.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.uuid; o.textContent = c.name;
      if (a.col === c.uuid) o.selected = true;
      colSel.appendChild(o);
    });

    var valTypeSel = document.createElement('select');
    valTypeSel.style.flex = '0 0 100px';
    [
      { v: 'fixed', t: '固定值' },
      { v: 'now',   t: '扫码时间' },
      { v: 'today', t: '扫码日期' },
      { v: 'time',  t: '扫码时分秒' }
    ].forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.v; o.textContent = opt.t;
      if ((a.value_type || 'fixed') === opt.v) o.selected = true;
      valTypeSel.appendChild(o);
    });

    var valueInp = document.createElement('input');
    valueInp.style.flex = '0 0 120px';
    var vt0 = a.value_type || 'fixed';
    valueInp.value = vt0 === 'fixed' ? (a.value || '') : '';
    valueInp.disabled = vt0 !== 'fixed';
    valueInp.placeholder = '写入值';

    function syncValueInput() {
      var t = valTypeSel.value;
      if (t === 'fixed') {
        valueInp.disabled = false;
        valueInp.placeholder = '写入值';
        valueInp.value = a.value || '';
      } else {
        valueInp.disabled = true;
        valueInp.value = '';
        if (t === 'now')   valueInp.placeholder = 'yyyy-MM-dd HH:mm:ss';
        if (t === 'today') valueInp.placeholder = 'yyyy-MM-dd';
        if (t === 'time')  valueInp.placeholder = 'HH:mm:ss';
      }
    }
    valTypeSel.addEventListener('change', syncValueInput);

    var confirmLabel = document.createElement('label');
    confirmLabel.className = 'cb-label';
    var confirmCb = document.createElement('input');
    confirmCb.type = 'checkbox';
    if (a.confirm) confirmCb.checked = true;
    confirmLabel.appendChild(confirmCb);
    confirmLabel.appendChild(document.createTextNode(' 确认'));

    var dangerLabel = document.createElement('label');
    dangerLabel.className = 'cb-label';
    var dangerCb = document.createElement('input');
    dangerCb.type = 'checkbox';
    if (a.danger) dangerCb.checked = true;
    dangerLabel.appendChild(dangerCb);
    dangerLabel.appendChild(document.createTextNode(' 危险'));

    var delBtn = document.createElement('button');
    delBtn.className = 'del';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', function () { row.remove(); });

    row.appendChild(idInp);
    row.appendChild(labelInp);
    row.appendChild(colSel);
    row.appendChild(valTypeSel);
    row.appendChild(valueInp);
    row.appendChild(confirmLabel);
    row.appendChild(dangerLabel);
    row.appendChild(delBtn);
    actionsEl.appendChild(row);
  }

  $('scanCfgAddAction').addEventListener('click', function () { addActionRow(); });

  // ============ 日志字段 ============
  function renderFields(fieldsMap) {
    fieldsEl.innerHTML = '';
    Object.keys(fieldsMap).forEach(function (k) { addFieldRow(k, fieldsMap[k]); });
    refreshColumnUuidTable();   // ★ 保证 UUID 对照表实时刷新
  }

  function addFieldRow(k, v) {
    var row = document.createElement('div');
    row.className = 'scan-cfg-item';

    var keyInp = document.createElement('input');
    keyInp.placeholder = '目标台账里的表头名';
    keyInp.value = k || '';

    var valInp = document.createElement('input');
    valInp.placeholder = '$col:列UUID / $user / $now / $gid / $action_label / $action_value / 固定文本';
    valInp.value = v || '';
    valInp.title = '点上方「字段模板变量说明」查看全部可用变量；$col:xxx 里的 xxx 是列 UUID，可从「当前台账列 UUID 对照」中直接复制';

    var delBtn = document.createElement('button');
    delBtn.className = 'del';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', function () { row.remove(); });

    row.appendChild(keyInp);
    row.appendChild(valInp);
    row.appendChild(delBtn);
    fieldsEl.appendChild(row);
  }

  $('scanCfgAddField').addEventListener('click', function () { addFieldRow(); });

  // ============ 收集配置 ============
  function collectConfig() {
    var displays = [];
    displaysEl.querySelectorAll('.scan-cfg-item').forEach(function (row) {
      var sel = row.querySelector('select');
      var ins = row.querySelectorAll('input[type="text"], input:not([type])');
      var cbs = row.querySelectorAll('input[type="checkbox"]');
      var col = sel ? sel.value : '';
      var label = ins[0] ? ins[0].value : '';
      var hl = cbs[0] ? cbs[0].checked : false;
      if (col) displays.push({ col: col, label: label, highlight: hl });
    });

    var actions = [];
    actionsEl.querySelectorAll('.scan-cfg-item').forEach(function (row) {
      var inputs = row.querySelectorAll('input');
      var sels = row.querySelectorAll('select');
      var cbs = row.querySelectorAll('input[type="checkbox"]');
      var id = inputs[0] ? inputs[0].value.trim() : '';
      var label = inputs[1] ? inputs[1].value.trim() : '';
      var col = sels[0] ? sels[0].value : '';
      var vt = sels[1] ? sels[1].value : 'fixed';
      var value = inputs[2] ? inputs[2].value : '';
      var confirm = cbs[0] ? cbs[0].checked : false;
      var danger = cbs[1] ? cbs[1].checked : false;
      if (id && label && col) {
        var act = {
          id: id, label: label, type: 'set_value',
          col: col,
          value: vt === 'fixed' ? value : '',
          confirm: confirm, danger: danger
        };
        if (vt !== 'fixed') act.value_type = vt;
        actions.push(act);
      }
    });

    var fields = {};
    fieldsEl.querySelectorAll('.scan-cfg-item').forEach(function (row) {
      var ins = row.querySelectorAll('input');
      var k = ins[0] ? ins[0].value.trim() : '';
      var v = ins[1] ? ins[1].value : '';
      if (k) fields[k] = v;
    });

    var cfg = {
      name: nameEl.value.trim() || appIdEl.value.trim(),
      icon: iconEl.value.trim() || '📷',
      description: descEl.value.trim(),
      ledger_id: parseInt(ledgerSel.value, 10) || null,
      display: displays,
      actions: actions,
      success_audio: audioEl.checked,
      auto_clear_after_ms: parseInt(autoClearEl.value, 10) || 0
    };

    if (logEnabledEl.checked && logLedgerSel.value) {
      cfg.append_log = {
        enabled: true,
        ledger_id: parseInt(logLedgerSel.value, 10),
        fields: fields
      };
    }

    return cfg;
  }

  // ============ 保存 / 删除 ============
  $('scanCfgSave').addEventListener('click', async function () {
    var appId = appIdEl.value.trim();
    if (!appId) { alert('请填写应用 ID'); return; }
    if (!/^[a-z0-9_]{1,50}$/.test(appId)) {
      alert('应用 ID 只能用 a-z 0-9 _，1-50 字符'); return;
    }
    if (logEnabledEl.checked && !logLedgerSel.value) {
      alert('已勾选"追加日志到其它台账"，但未选择目标子台账。\n请先在本台账的某个单元格设置关联，再选择。');
      return;
    }
    var cfg = collectConfig();
    if (!cfg.ledger_id) { alert('请选择目标台账'); return; }
    try {
      if (editingAppId) {
        await api('/api/scan-config/apps/' + encodeURIComponent(appId), {
          method: 'PUT',
          body: JSON.stringify({ config: cfg })
        });
      } else {
        await api('/api/scan-config/apps', {
          method: 'POST',
          body: JSON.stringify({ app_id: appId, config: cfg })
        });
      }
      alert('已保存');
      editingAppId = appId;
      appIdEl.disabled = true;
      $('scanCfgDelete').style.display = '';
      await loadApps();
    } catch (e) {
      alert('保存失败：' + (e && e.message ? e.message : e));
    }
  });

  $('scanCfgDownloadOffline').addEventListener('click', function () {
    if (!editingAppId) return;
    window.location.href =
      '/scan-config/apps/' + encodeURIComponent(editingAppId) + '/offline.html';
  });

  $('scanCfgDelete').addEventListener('click', async function () {
    if (!editingAppId) return;
    if (!confirm('确定删除该扫码应用？此操作不可恢复。')) return;
    try {
      await api('/api/scan-config/apps/' + encodeURIComponent(editingAppId),
        { method: 'DELETE' });
      alert('已删除');
      editingAppId = null;
      formEl.classList.add('hidden');
      await loadApps();
    } catch (e) {
      alert('删除失败：' + (e && e.message ? e.message : e));
    }
  });

})();