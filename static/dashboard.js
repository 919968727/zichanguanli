/* ============================================================
 * dashboard.js —— 态势大屏（一屏多台账、多图表矩阵）
 * 左侧面板配置图表：台账 / 分类列 / 数值列 / 统计方式 / Top N / 图表类型 / 标题
 * 数据抽取与聚合语义参考 editor-chart.js 的 extractCatValue
 * ============================================================ */

(function () {
  'use strict';

  var CHART_KEY = 'ledger_dashboard_charts_v1';
  var MAX_CHARTS = 20;
  var GRID_COLS = 4;          // 网格总列数，与 dashboard.css 的 repeat(4,..) 对应

  var summary = [];           // /api/dashboard/summary 返回的可 view 台账摘要
  var ledgerCache = {};       // lid -> { ledger, data }
  var ledgerPromises = {};    // lid -> 进行中的加载 Promise
  var charts = [];            // [{id, lid, title, type, catCol, valCol, aggregate, topN, spanW, spanH}]
  var chartInstances = {};    // chartId -> Chart
  var editingId = null;
  var renderGen = 0;          // 渲染代际，防止过期异步回调画到已销毁的卡片上
  var dragId = null;          // 正在拖拽的图表 id

  var DS_PALETTE = [
    '#22d3ee', '#818cf8', '#f472b6', '#34d399', '#fbbf24',
    '#fb7185', '#38bdf8', '#a78bfa', '#4ade80', '#facc15',
    '#2dd4bf', '#e879f9'
  ];

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toNum(v) {
    var s = String(v == null ? '' : v).replace(/[,，\s%￥$]/g, '');
    if (!s) return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function clampInt(v, min, max, def) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  function uuidHex() {
    return 'xxxxxxxxxxxx'.replace(/[x]/g, function () {
      return Math.floor(Math.random() * 16).toString(16);
    });
  }

  function colorForLabel(lbl, i) {
    if (typeof lbl === 'string' && lbl.indexOf('其他 (') === 0) return '#64748b';
    return DS_PALETTE[i % DS_PALETTE.length];
  }

  async function fetchJSON(url) {
    var resp = await fetch(url, { credentials: 'same-origin' });
    if (resp.status === 401) { window.location.href = '/'; throw new Error('未登录'); }
    var body = await resp.json();
    if (!resp.ok) throw new Error(body && body.msg ? body.msg : ('请求失败 ' + resp.status));
    return body;
  }

  /* ---------- 图表配置持久化 ---------- */
  function normalizeCfg(c) {
    // 兼容旧配置：补齐尺寸字段；限制在合法范围内
    c.spanW = clampInt(c.spanW, 1, GRID_COLS, 2);
    c.spanH = clampInt(c.spanH, 1, 3, 1);
    return c;
  }
  function loadCharts() {
    try {
      var s = localStorage.getItem(CHART_KEY);
      if (s) {
        var t = JSON.parse(s);
        if (Array.isArray(t)) return t.map(normalizeCfg);
      }
    } catch (e) {}
    return [];
  }
  function saveCharts() {
    try { localStorage.setItem(CHART_KEY, JSON.stringify(charts)); } catch (e) {}
  }

  /* ---------- 台账数据 ---------- */
  function ensureLedgerData(lid) {
    if (ledgerCache[lid]) return Promise.resolve(ledgerCache[lid]);
    if (ledgerPromises[lid]) return ledgerPromises[lid];
    var p = fetchJSON('/api/ledgers/' + lid).then(function (body) {
      var ledger = body.ledger || {};
      var data = ledger.data || [];
      if (!Array.isArray(data)) data = [];
      var entry = { ledger: ledger, data: data };
      ledgerCache[lid] = entry;
      return entry;
    });
    ledgerPromises[lid] = p;
    return p;
  }

  function isNumericColumn(data, c) {
    var nonEmpty = 0, numeric = 0;
    var limit = Math.min(data.length, 40);
    for (var r = 1; r < limit; r++) {
      var row = data[r];
      if (!row) continue;
      var v = String(row[c] == null ? '' : row[c]).trim();
      if (!v) continue;
      nonEmpty++;
      if (toNum(v) != null) numeric++;
    }
    if (!nonEmpty) return false;
    return numeric / nonEmpty >= 0.5;
  }

  function columnNameOf(h, c) {
    var n = h[c];
    return (n == null || String(n).trim() === '') ? ('列' + c) : String(n);
  }

  function idxOfName(h, name) {
    for (var c = 1; c < h.length; c++) {
      if (columnNameOf(h, c) === name) return c;
    }
    return -1;
  }

  /* ---------- 侧栏表单 ---------- */
  function populateLedgerSel() {
    var sel = $('dsLedgerSel');
    sel.innerHTML = '';
    if (!summary.length) {
      sel.innerHTML = '<option value="">暂无台账</option>';
      return;
    }
    summary.forEach(function (it) {
      var opt = document.createElement('option');
      opt.value = it.id;
      opt.textContent = it.name;
      sel.appendChild(opt);
    });
  }

  function populateColumns(lid) {
    var h = (ledgerCache[lid] && ledgerCache[lid].data[0]) || [];
    var catSel = $('dsCatCol'), valSel = $('dsValCol');
    catSel.innerHTML = '';
    valSel.innerHTML = '';
    for (var c = 1; c < h.length; c++) {
      var name = columnNameOf(h, c);
      if (name === '更新时间') continue;
      var o1 = document.createElement('option');
      o1.value = name; o1.textContent = name;
      catSel.appendChild(o1);
      var o2 = document.createElement('option');
      o2.value = name; o2.textContent = name;
      valSel.appendChild(o2);
    }
  }

  function setSelectValue(sel, val) {
    var found = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === val) { sel.value = val; found = true; break; }
    }
    if (!found && val) {
      var opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val + '（已删除）';
      sel.appendChild(opt);
      sel.value = val;
    }
  }

  function resetForm() {
    editingId = null;
    $('dsTitle').value = '';
    $('dsAddChart').classList.remove('hidden');
    $('dsSaveChart').classList.add('hidden');
    $('dsCancelEdit').classList.add('hidden');
  }

  /* ---------- 数据抽取（语义对齐 editor-chart.js） ---------- */
  function extractGroups(data, catIdx, valIdx, agg, topN) {
    var raw = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (!row) continue;
      var label = String(row[catIdx] == null ? '' : row[catIdx]).trim() || '(空)';
      var num = toNum(row[valIdx]);
      if (agg !== 'count' && num === null) continue;
      raw.push({ label: label, value: num });
    }

    if (agg === 'none') {
      return {
        labels: raw.map(function (x) { return x.label; }),
        values: raw.map(function (x) { return x.value; })
      };
    }

    var groups = {};
    raw.forEach(function (it) {
      if (!groups[it.label]) groups[it.label] = { sum: 0, count: 0 };
      groups[it.label].sum += (it.value || 0);
      groups[it.label].count += 1;
    });

    var list = [];
    Object.keys(groups).forEach(function (label) {
      var g = groups[label];
      var v;
      if (agg === 'sum') v = g.sum;
      else if (agg === 'avg') v = g.sum / g.count;
      else v = g.count;
      list.push({ label: label, value: v });
    });

    if (topN > 0) {
      list.sort(function (a, b) { return b.value - a.value; });
      if (list.length > topN) {
        var kept = list.slice(0, topN);
        var rest = list.slice(topN);
        var restSum = 0, restCount = 0;
        rest.forEach(function (it) { restSum += it.value; restCount += 1; });
        var restVal;
        if (agg === 'sum') restVal = restSum;
        else if (agg === 'avg') restVal = restSum / restCount;
        else restVal = restCount;
        kept.push({ label: '其他 (' + restCount + ' 项)', value: restVal });
        list = kept;
      }
    }

    return {
      labels: list.map(function (x) { return x.label; }),
      values: list.map(function (x) { return x.value; })
    };
  }

  /* ---------- 图表构建（深色主题） ---------- */
  function buildConfig(type, labels, values, valHeader) {
    var gridColor = 'rgba(56,189,248,0.12)';
    var tickColor = '#7c8db5';
    var tooltip = {
      backgroundColor: 'rgba(11,22,44,0.95)',
      borderColor: 'rgba(34,211,238,0.3)',
      borderWidth: 1,
      padding: 10,
      cornerRadius: 6,
      titleColor: '#dbe7f5',
      bodyColor: '#dbe7f5'
    };

    if (type === 'bar') {
      return { type: 'bar', data: { labels: labels, datasets: [{ label: valHeader, data: values,
        backgroundColor: labels.map(colorForLabel), borderRadius: 6, borderSkipped: false }] },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: tooltip },
          scales: { y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor } },
                    x: { grid: { display: false }, ticks: { color: tickColor, maxRotation: 45 } } } } };
    }
    if (type === 'line') {
      return { type: 'line', data: { labels: labels, datasets: [{ label: valHeader, data: values,
        borderColor: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.08)', tension: 0.3, fill: false,
        pointRadius: 3, pointBackgroundColor: '#22d3ee' }] },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: tooltip },
          scales: { y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor } },
                    x: { grid: { color: gridColor }, ticks: { color: tickColor, maxRotation: 45 } } } } };
    }
    if (type === 'area') {
      return { type: 'line', data: { labels: labels, datasets: [{ label: valHeader, data: values,
        borderColor: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.22)', tension: 0.3, fill: true,
        pointRadius: 3, pointBackgroundColor: '#22d3ee' }] },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: tooltip },
          scales: { y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor } },
                    x: { grid: { color: gridColor }, ticks: { color: tickColor, maxRotation: 45 } } } } };
    }
    if (type === 'pie' || type === 'doughnut') {
      return { type: type, data: { labels: labels, datasets: [{ data: values,
        backgroundColor: labels.map(colorForLabel), borderColor: '#0a1226', borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false,
          cutout: type === 'doughnut' ? '55%' : undefined,
          plugins: { legend: { position: 'right', labels: { color: '#dbe7f5', padding: 10, boxWidth: 12 } },
            tooltip: { backgroundColor: 'rgba(11,22,44,0.95)', borderColor: 'rgba(34,211,238,0.3)',
              borderWidth: 1, padding: 10, cornerRadius: 6, titleColor: '#dbe7f5', bodyColor: '#dbe7f5',
              callbacks: { label: function (ctx) {
                var total = ctx.dataset.data.reduce(function (a, b) { return a + b; }, 0);
                var pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
                return ctx.label + '：' + ctx.parsed + ' (' + pct + '%)'; } } } } } };
    }
    if (type === 'radar') {
      return { type: 'radar', data: { labels: labels, datasets: [{ label: valHeader, data: values,
        borderColor: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.15)',
        pointBackgroundColor: '#22d3ee' }] },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: tooltip },
          scales: { r: { beginAtZero: true, grid: { color: gridColor }, angleLines: { color: gridColor },
            pointLabels: { color: tickColor }, ticks: { color: tickColor, backdropColor: 'transparent' } } } } };
    }
    return null;
  }

  /* ---------- 渲染 ---------- */
  function destroyAllCharts() {
    Object.keys(chartInstances).forEach(function (id) {
      try { chartInstances[id].destroy(); } catch (e) {}
    });
    chartInstances = {};
  }

  function renderAll() {
    renderGen++;
    destroyAllCharts();
    var grid = $('dsGrid');
    grid.innerHTML = '';
    if (!charts.length) {
      grid.innerHTML = '<div class="ds-empty">尚未添加图表，请在左侧选择台账与数据列后点击「添加图表」</div>';
      return;
    }
    charts.forEach(function (cfg) { renderCard(cfg); });
  }

  function ledgerNameOf(lid) {
    for (var i = 0; i < summary.length; i++) {
      if (summary[i].id === lid) return summary[i].name;
    }
    return '台账 ' + lid;
  }

  /* ---------- 卡片拖拽排序 ---------- */
  function clearDragStyles() {
    var grid = $('dsGrid');
    if (!grid) return;
    grid.classList.remove('drag-active');
    Array.prototype.forEach.call(grid.querySelectorAll('.ds-chart-card'), function (el) {
      el.classList.remove('drag-over', 'dragging');
    });
  }
  function bindCardDrag(card, id) {
    var head = card.querySelector('[data-drag="1"]');
    if (!head) return;
    card.draggable = false;
    head.draggable = true;
    head.addEventListener('dragstart', function (e) {
      dragId = id;
      card.classList.add('dragging');
      $('dsGrid').classList.add('drag-active');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch (err) {}
    });
    head.addEventListener('dragend', function () { dragId = null; clearDragStyles(); });
    card.addEventListener('dragover', function (e) {
      if (!dragId || dragId === id) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', function () { card.classList.remove('drag-over'); });
    card.addEventListener('drop', function (e) {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (!dragId || dragId === id) return;
      var from = -1, to = -1;
      for (var i = 0; i < charts.length; i++) {
        if (charts[i].id === dragId) from = i;
        if (charts[i].id === id) to = i;
      }
      if (from < 0 || to < 0) return;
      var moved = charts.splice(from, 1)[0];
      charts.splice(to, 0, moved);
      dragId = null;
      saveCharts();
      renderAll();
    });
  }

  function renderCard(cfg) {
    var grid = $('dsGrid');
    var gen = renderGen;
    var card = document.createElement('div');
    card.className = 'ds-panel ds-chart-card';
    card.dataset.id = cfg.id;
    // 应用尺寸：占 spanW 列 x spanH 行
    var w = clampInt(cfg.spanW, 1, GRID_COLS, 2);
    var h = clampInt(cfg.spanH, 1, 3, 1);
    card.style.gridColumn = 'span ' + w;
    card.style.gridRow = 'span ' + h;
    card.innerHTML =
      '<div class="ds-chart-head" data-drag="1">' +
        '<span class="ds-drag-handle" title="拖动调整顺序">⋮⋮</span>' +
        '<div class="ds-chart-title" title="' + esc(cfg.title) + '">' + esc(cfg.title) + '</div>' +
        '<div class="ds-chart-tools">' +
          '<button class="ds-mini" data-act="edit" title="设置">⚙</button>' +
          '<button class="ds-mini" data-act="del" title="删除">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="ds-chart-sub"><span class="ds-ledger-tag">' + esc(ledgerNameOf(cfg.lid)) + '</span>' +
        '<span class="ds-span-tag">' + w + '×' + h + '</span></div>' +
      '<div class="ds-chart-wrap"><canvas></canvas></div>';
    grid.appendChild(card);

    card.querySelector('[data-act="edit"]').addEventListener('click', function () { editChart(cfg.id); });
    card.querySelector('[data-act="del"]').addEventListener('click', function () { removeChart(cfg.id); });
    bindCardDrag(card, cfg.id);

    var canvas = card.querySelector('canvas');
    ensureLedgerData(cfg.lid).then(function (entry) {
      if (gen !== renderGen) return;   // 本次渲染已被刷新，跳过过期回调
      var h = entry.data[0] || [];
      var catIdx = idxOfName(h, cfg.catCol);
      var valIdx = idxOfName(h, cfg.valCol);
      if (catIdx < 1 || valIdx < 1) { showCardEmpty(card, '配置的列已不存在，请点 ⚙ 重新设置'); return; }
      var g = extractGroups(entry.data, catIdx, valIdx, cfg.aggregate, cfg.topN);
      if (!g.labels.length) { showCardEmpty(card, '暂无可用数据'); return; }
      var valHeader = (cfg.aggregate === 'count') ? '记录数' : columnNameOf(h, valIdx);
      var config = buildConfig(cfg.type, g.labels, g.values, valHeader);
      if (!config) { showCardEmpty(card, '暂不支持该图表类型'); return; }
      chartInstances[cfg.id] = new Chart(canvas.getContext('2d'), config);
    }).catch(function (e) {
      showCardEmpty(card, '加载失败：' + (e && e.message ? e.message : e));
    });
  }

  function showCardEmpty(card, msg) {
    var wrap = card.querySelector('.ds-chart-wrap');
    wrap.innerHTML = '<div class="ds-empty">' + esc(msg) + '</div>';
  }

  /* ---------- 表单操作 ---------- */
  function readForm() {
    var lid = parseInt($('dsLedgerSel').value, 10);
    var cat = $('dsCatCol').value;
    var val = $('dsValCol').value;
    if (isNaN(lid)) { alert('请选择台账'); return null; }
    if (!cat || !val) { alert('请选择分类列和数值列'); return null; }
    return {
      lid: lid,
      catCol: cat,
      valCol: val,
      aggregate: $('dsAgg').value,
      topN: clampInt($('dsTopN').value, 0, 200, 0),
      type: $('dsChartType').value,
      title: (($('dsTitle').value || '').trim()) || (val + ' - ' + cat),
      spanW: clampInt($('dsSpanW').value, 1, GRID_COLS, 2),
      spanH: clampInt($('dsSpanH').value, 1, 3, 1)
    };
  }

  function addChart() {
    var f = readForm();
    if (!f) return;
    if (charts.length >= MAX_CHARTS) { alert('最多只能添加 ' + MAX_CHARTS + ' 个图表'); return; }
    charts.push({
      id: uuidHex(), lid: f.lid, title: f.title.slice(0, 100), type: f.type,
      catCol: f.catCol, valCol: f.valCol, aggregate: f.aggregate, topN: f.topN,
      spanW: f.spanW, spanH: f.spanH
    });
    saveCharts();
    renderAll();
    resetForm();
  }

  function editChart(id) {
    var cfg = null;
    for (var i = 0; i < charts.length; i++) if (charts[i].id === id) cfg = charts[i];
    if (!cfg) return;
    editingId = id;
    $('dsLedgerSel').value = String(cfg.lid);
    ensureLedgerData(cfg.lid).then(function () {
      populateColumns(cfg.lid);
      setSelectValue($('dsCatCol'), cfg.catCol);
      setSelectValue($('dsValCol'), cfg.valCol);
      $('dsAgg').value = cfg.aggregate;
      $('dsTopN').value = cfg.topN;
      $('dsChartType').value = cfg.type;
      $('dsTitle').value = cfg.title;
      $('dsSpanW').value = String(clampInt(cfg.spanW, 1, GRID_COLS, 2));
      $('dsSpanH').value = String(clampInt(cfg.spanH, 1, 3, 1));
      $('dsAddChart').classList.add('hidden');
      $('dsSaveChart').classList.remove('hidden');
      $('dsCancelEdit').classList.remove('hidden');
    });
  }

  function saveEdit() {
    if (!editingId) return;
    var cfg = null;
    for (var i = 0; i < charts.length; i++) if (charts[i].id === editingId) cfg = charts[i];
    if (!cfg) return;
    var f = readForm();
    if (!f) return;
    cfg.lid = f.lid;
    cfg.catCol = f.catCol;
    cfg.valCol = f.valCol;
    cfg.aggregate = f.aggregate;
    cfg.topN = f.topN;
    cfg.type = f.type;
    cfg.title = f.title.slice(0, 100);
    cfg.spanW = f.spanW;
    cfg.spanH = f.spanH;
    saveCharts();
    renderAll();
    resetForm();
  }

  function resetLayout() {
    if (!charts.length) return;
    if (!confirm('重置布局？将恢复所有图表的默认尺寸与排列顺序（图表本身不删除）。')) return;
    charts.forEach(function (cfg) { cfg.spanW = 2; cfg.spanH = 1; });
    saveCharts();
    renderAll();
  }

  function removeChart(id) {
    if (!confirm('删除该图表？')) return;
    if (chartInstances[id]) { try { chartInstances[id].destroy(); } catch (e) {} delete chartInstances[id]; }
    charts = charts.filter(function (c) { return c.id !== id; });
    saveCharts();
    if (editingId === id) resetForm();
    renderAll();
  }

  /* ---------- 首次访问：为每个可查看台账自动生成一张默认图表 ---------- */
  async function autoCreateCharts() {
    for (var i = 0; i < summary.length; i++) {
      var s = summary[i];
      try {
        var entry = await ensureLedgerData(s.id);
        var h = entry.data[0] || [];
        var cols = [];
        for (var c = 1; c < h.length; c++) {
          var nm = columnNameOf(h, c);
          if (nm === '更新时间') continue;
          cols.push(nm);
        }
        if (!cols.length) continue;
        var cat = cols[0];
        var val = cat, valIdx = -1;
        for (var c2 = 1; c2 < h.length; c2++) {
          if (columnNameOf(h, c2) === '更新时间') continue;
          if (isNumericColumn(entry.data, c2)) { val = columnNameOf(h, c2); valIdx = c2; break; }
        }
        var agg, topN;
        if (valIdx >= 0) {
          agg = s.row_count > 50 ? 'sum' : 'none';
          topN = s.row_count > 50 ? 20 : 0;
        } else {
          val = cat;
          agg = 'count';
          topN = s.row_count > 50 ? 20 : 0;
        }
        charts.push({
          id: uuidHex(), lid: s.id, title: (val + ' - ' + cat).slice(0, 100),
          type: 'bar', catCol: cat, valCol: val, aggregate: agg, topN: topN,
          spanW: 2, spanH: 1   // 默认每张占 1/2 宽 x 1 行
        });
      } catch (e) { /* 该台账加载失败则跳过 */ }
    }
    saveCharts();
  }

  /* ---------- 时钟 / 全屏 / 刷新 ---------- */
  function tick() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    $('dsClock').textContent = p(d.getFullYear()) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      var el = document.documentElement;
      if (el.requestFullscreen) el.requestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  }

  function toggleSide() {
    var collapsed = $('dsShell').classList.toggle('collapsed');
    $('dsSideToggle').textContent = collapsed ? '展开面板' : '配置面板';
  }

  function refreshData() {
    ledgerCache = {};
    ledgerPromises = {};
    renderAll();
  }

  async function refreshAll() {
    try {
      var body = await fetchJSON('/api/dashboard/summary');
      summary = body.ledgers || [];
      populateLedgerSel();
    } catch (e) { /* 保持现有画面 */ }
    refreshData();
  }

  /* ---------- 初始化 ---------- */
  function bind() {
    $('dsLedgerSel').addEventListener('change', function () {
      var lid = parseInt(this.value, 10);
      if (isNaN(lid)) return;
      ensureLedgerData(lid).then(function () { populateColumns(lid); });
    });
    $('dsAddChart').addEventListener('click', addChart);
    $('dsSaveChart').addEventListener('click', saveEdit);
    $('dsCancelEdit').addEventListener('click', resetForm);
    $('dsRefresh').addEventListener('click', refreshAll);
    $('dsFullscreen').addEventListener('click', toggleFullscreen);
    $('dsSideToggle').addEventListener('click', toggleSide);
    $('dsResetLayout').addEventListener('click', resetLayout);
  }

  async function init() {
    if (window.Chart) {
      Chart.defaults.color = '#7c8db5';
      Chart.defaults.borderColor = 'rgba(56,189,248,0.15)';
    }
    bind();
    tick();
    setInterval(tick, 1000);
    try {
      var body = await fetchJSON('/api/dashboard/summary');
      summary = body.ledgers || [];
      populateLedgerSel();
      if (summary.length) {
        ensureLedgerData(summary[0].id).then(function () { populateColumns(summary[0].id); })
          .catch(function () {});
      }
      charts = loadCharts();
      if (!charts.length) {
        await autoCreateCharts();
      }
      renderAll();
    } catch (e) {
      $('dsGrid').innerHTML = '<div class="ds-empty">加载失败：' + esc(e.message) + '</div>';
    }
    setInterval(refreshData, 60000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
