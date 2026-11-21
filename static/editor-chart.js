/* ============================================================
 * editor-chart.js —— 图表弹窗 + 图表展示区 + 专注模式 + 关联跳转
 * 【内嵌方案】gridData[r][0] 是 uuid，列索引 1-based
 *
 * ★ 新增：聚合 + Top N
 *   - cfg.config.aggregate: 'none' | 'sum' | 'avg' | 'count'
 *   - cfg.config.topN: 0~200（0 = 不截断）
 *   - 大表（>50 行）自动默认 sum + topN=20，小表默认 none + 0
 *   - 聚合后一个分类对应多行时，点击图表不跳转，改为提示
 *
 * ★ 新增：图表点击 → 表格筛选
 *   - 普通单击分类 → 应用「该分类列 = 该值」筛选
 *   - Ctrl/⌘ + 单击 → 保留原行为（跳转关联台账）
 * ============================================================ */

/* ---------- 标签颜色（「其他」用灰色） ---------- */
function colorForLabel(lbl, i) {
  if (typeof lbl === 'string' && lbl.indexOf('其他 (') === 0) return '#94a3b8';
  return CHART_PALETTE[i % CHART_PALETTE.length];
}

/* ---------- 图表构建 ---------- */
function buildChartJsConfig(type, labels, values, valHeader, onItemClick) {
  if (!type || !values || !values.length) return null;

  // ★ 把 evt 也传出去，供上层判断 Ctrl/⌘
  var chartClickHandler = onItemClick ? function (evt, elements) {
    if (elements && elements.length) onItemClick(elements[0].index, evt);
  } : undefined;
  var chartHoverHandler = onItemClick ? function (evt, elements) {
    if (evt && evt.native && evt.native.target) {
      evt.native.target.style.cursor = (elements && elements.length) ? 'pointer' : 'default';
    }
  } : undefined;

  var basePlugins = {
    legend: { display: false },
    tooltip: { backgroundColor: 'rgba(30,41,59,0.95)', padding: 10, cornerRadius: 6 }
  };
  if (type === 'bar') {
    return { type: 'bar', data: { labels: labels, datasets: [{ label: valHeader, data: values,
      backgroundColor: labels.map(colorForLabel),
      borderRadius: 6, borderSkipped: false }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: basePlugins,
        onClick: chartClickHandler, onHover: chartHoverHandler,
        scales: { y: { beginAtZero: true, grid: { color: '#e2e8f0' }, ticks: { font: { size: 11 } } },
                  x: { grid: { display: false }, ticks: { font: { size: 11 } } } } } };
  }
  if (type === 'line') {
    return { type: 'line', data: { labels: labels, datasets: [{ label: valHeader, data: values,
      borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.1)', tension: 0.3, fill: false,
      pointRadius: 4, pointBackgroundColor: '#6366f1', pointBorderColor: '#fff', pointBorderWidth: 1 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: basePlugins,
        onClick: chartClickHandler, onHover: chartHoverHandler,
        scales: { y: { beginAtZero: true, grid: { color: '#e2e8f0' }, ticks: { font: { size: 11 } } },
                  x: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 11 } } } } } };
  }
  if (type === 'area') {
    return { type: 'line', data: { labels: labels, datasets: [{ label: valHeader, data: values,
      borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.25)', tension: 0.3, fill: true,
      pointRadius: 4, pointBackgroundColor: '#6366f1', pointBorderColor: '#fff', pointBorderWidth: 1 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: basePlugins,
        onClick: chartClickHandler, onHover: chartHoverHandler,
        scales: { y: { beginAtZero: true, grid: { color: '#e2e8f0' }, ticks: { font: { size: 11 } } },
                  x: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 11 } } } } } };
  }
  if (type === 'pie') {
    return { type: 'pie', data: { labels: labels, datasets: [{ data: values,
      backgroundColor: labels.map(colorForLabel),
      borderColor: '#fff', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false,
        onClick: chartClickHandler, onHover: chartHoverHandler,
        plugins: { legend: { position: 'right', labels: { padding: 10, font: { size: 11 }, boxWidth: 12 } },
          tooltip: { backgroundColor: 'rgba(30,41,59,0.95)', padding: 10, cornerRadius: 6,
            callbacks: { label: function (ctx) {
              var total = ctx.dataset.data.reduce(function (a, b) { return a + b; }, 0);
              var pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
              return ctx.label + '：' + ctx.parsed + ' (' + pct + '%)'; } } } } } };
  }
  if (type === 'doughnut') {
    return { type: 'doughnut', data: { labels: labels, datasets: [{ data: values,
      backgroundColor: labels.map(colorForLabel),
      borderColor: '#fff', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '55%',
        onClick: chartClickHandler, onHover: chartHoverHandler,
        plugins: { legend: { position: 'right', labels: { padding: 10, font: { size: 11 }, boxWidth: 12 } },
          tooltip: { backgroundColor: 'rgba(30,41,59,0.95)', padding: 10, cornerRadius: 6,
            callbacks: { label: function (ctx) {
              var total = ctx.dataset.data.reduce(function (a, b) { return a + b; }, 0);
              var pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
              return ctx.label + '：' + ctx.parsed + ' (' + pct + '%)'; } } } } } };
  }
  if (type === 'radar') {
    return { type: 'radar', data: { labels: labels, datasets: [{ label: valHeader, data: values,
      borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.15)',
      pointBackgroundColor: '#6366f1', pointBorderColor: '#fff', pointRadius: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: basePlugins,
        onClick: chartClickHandler, onHover: chartHoverHandler,
        scales: { r: { beginAtZero: true, grid: { color: '#e2e8f0' }, angleLines: { color: '#e2e8f0' },
          pointLabels: { font: { size: 11 } },
          ticks: { font: { size: 10 }, backdropColor: 'transparent' } } } } };
  }
  return null;
}

function buildScatterConfig(rows, xHeader, yHeader, onItemClick) {
  if (!rows || !rows.length) return null;

  // ★ 把 evt 也传出去
  var chartClickHandler = onItemClick ? function (evt, elements) {
    if (elements && elements.length) onItemClick(elements[0].index, evt);
  } : undefined;
  var chartHoverHandler = onItemClick ? function (evt, elements) {
    if (evt && evt.native && evt.native.target) {
      evt.native.target.style.cursor = (elements && elements.length) ? 'pointer' : 'default';
    }
  } : undefined;

  return { type: 'scatter', data: { datasets: [{ label: (xHeader || 'X') + ' vs ' + (yHeader || 'Y'),
      data: rows, backgroundColor: 'rgba(99,102,241,0.7)',
      borderColor: '#6366f1', pointRadius: 5, pointHoverRadius: 7 }] },
      options: { responsive: true, maintainAspectRatio: false,
        onClick: chartClickHandler, onHover: chartHoverHandler,
        plugins: { legend: { display: false },
          tooltip: { backgroundColor: 'rgba(30,41,59,0.95)', padding: 10, cornerRadius: 6,
            callbacks: { label: function (ctx) { return '(' + ctx.parsed.x + ', ' + ctx.parsed.y + ')'; } } } },
        scales: { x: { type: 'linear', position: 'bottom',
            title: { display: !!xHeader, text: xHeader || '', font: { size: 11 } },
            grid: { color: '#e2e8f0' }, ticks: { font: { size: 11 } } },
          y: { title: { display: !!yHeader, text: yHeader || '', font: { size: 11 } },
            grid: { color: '#e2e8f0' }, ticks: { font: { size: 11 } } } } } };
}

/* ============================================================
 * 数据抽取：支持聚合 + Top N
 * ============================================================ */
function extractCatValue(catIdx, valIdx, options) {
  options = options || {};
  var aggregate = options.aggregate || 'none';
  var topN = options.topN || 0;
  var excludeColId = options.excludeColId || '';   // ★ 排除自身分类列

  var raw = [];
  for (var r = 1; r < gridData.length; r++) {
    // ★ 应用筛选（排除自身分类列）
    if (typeof rowMatchesFiltersExcluding === 'function') {
      if (!rowMatchesFiltersExcluding(r, excludeColId)) continue;
    }
    var label = (getCell(r, catIdx) || '').trim() || '(空)';
    var num = parseNum(getCell(r, valIdx));
    if (aggregate !== 'count' && num === null) continue;
    raw.push({ label: label, value: num, row: r });
  }

  if (aggregate === 'none') {
    var labels0 = [], values0 = [], rows0 = [];
    raw.forEach(function (it) {
      labels0.push(it.label);
      values0.push(it.value);
      rows0.push([it.row]);
    });
    return { labels: labels0, values: values0, rowIndices: rows0 };
  }

  var groups = {};
  raw.forEach(function (it) {
    if (!groups[it.label]) groups[it.label] = { sum: 0, count: 0, rows: [] };
    groups[it.label].sum += (it.value || 0);
    groups[it.label].count += 1;
    groups[it.label].rows.push(it.row);
  });

  var agg = [];
  Object.keys(groups).forEach(function (label) {
    var g = groups[label];
    var v;
    if (aggregate === 'sum') v = g.sum;
    else if (aggregate === 'avg') v = g.sum / g.count;
    else v = g.count;
    agg.push({ label: label, value: v, rows: g.rows });
  });

  if (topN > 0 && agg.length > topN) {
    agg.sort(function (a, b) { return b.value - a.value; });
    var kept = agg.slice(0, topN);
    var rest = agg.slice(topN);
    var restSum = 0, restCount = 0, restRows = [];
    rest.forEach(function (it) {
      restSum += it.value;
      restCount += 1;
      restRows = restRows.concat(it.rows);
    });
    var restVal;
    if (aggregate === 'sum') restVal = restSum;
    else if (aggregate === 'avg') restVal = restSum / restCount;
    else restVal = restCount;
    kept.push({
      label: '其他 (' + restCount + ' 项)',
      value: restVal,
      rows: restRows
    });
    agg = kept;
  } else if (topN > 0) {
    agg.sort(function (a, b) { return b.value - a.value; });
  }

  var labels = [], values = [], rowIndices = [];
  agg.forEach(function (it) {
    labels.push(it.label);
    values.push(it.value);
    rowIndices.push(it.rows);
  });
  return { labels: labels, values: values, rowIndices: rowIndices };
}

function extractScatter(xIdx, yIdx) {
  var rows = [];
  for (var r = 1; r < gridData.length; r++) {
    // ★ 应用筛选（不排除任何列）
    if (typeof rowMatchesFilters === 'function') {
      if (!rowMatchesFilters(r)) continue;
    }
    var vx = parseNum(getCell(r, xIdx));
    var vy = parseNum(getCell(r, yIdx));
    if (vx === null || vy === null) continue;
    rows.push({ x: vx, y: vy, _r: r });
  }
  return rows;
}

/* ============================================================
 * 点击图表数据项 → 查该行的 cell_links → 打开关联台账
 * ============================================================ */
function jumpToLinkedLedger(rowIdx) {
  if (!currentLedger) return;
  if (rowIdx < 1 || rowIdx >= gridData.length) return;

  var cellLinks = getCellLinks();
  var colIds = getColumnIds();
  var headers = gridData[0] || [];
  var targets = [];

  for (var c = 1; c < headers.length; c++) {
    var colId = colIds[c];
    if (!colId || colId === UUID_SENTINEL) continue;
    var tid = cellLinks[rowIdx + ':' + colId];
    if (!tid || tid === currentId) continue;
    if (!targets.some(function (t) { return t.id === tid; })) {
      targets.push({ id: tid, colName: headers[c] || ('列' + c) });
    }
  }

  if (!targets.length) {
    showActionToast('该行未关联其他台账', 'error');
    return;
  }
  if (targets.length === 1) {
    if (dirty && !confirm('当前台账有未保存的修改，确定要跳转吗？')) return;
    openLedger(targets[0].id);
    return;
  }
  var names = targets.map(function (t) {
    var L = null;
    for (var i = 0; i < cachedLedgerList.length; i++) {
      if (cachedLedgerList[i].id === t.id) { L = cachedLedgerList[i]; break; }
    }
    return (L ? L.name : ('#' + t.id)) + '（' + t.colName + '）';
  });
  var msg = '该行关联了多个台账，请选择要打开的序号：\n\n';
  names.forEach(function (n, i) { msg += (i + 1) + '. ' + n + '\n'; });
  var ans = prompt(msg);
  if (!ans) return;
  var idx = parseInt(ans, 10) - 1;
  if (idx < 0 || idx >= targets.length) { alert('序号无效'); return; }
  if (dirty && !confirm('当前台账有未保存的修改，确定要跳转吗？')) return;
  openLedger(targets[idx].id);
}

/* ============================================================
 * 专注图表模式
 * ============================================================ */
function applyFocusLayout() {
  var mainEl = document.querySelector('main.main');
  if (!mainEl) return;
  mainEl.classList.toggle('focus-chart', gridFocusMode);
  var btn = document.getElementById('showcaseExitFocus');
  if (btn) btn.style.display = gridFocusMode ? '' : 'none';
  setTimeout(function () {
    Object.keys(showcaseChartInstances).forEach(function (k) {
      try { showcaseChartInstances[k].resize(); } catch (e) {}
    });
  }, 50);
}

function enterFocusChartMode() {
  if (!currentLedger) {
    showActionToast('请先打开一本台账', 'error');
    return;
  }
  var charts = getCharts();
  if (!charts.length) {
    showActionToast('当前台账还没有图表，请先点击「图表」按钮添加', 'error');
    return;
  }
  if (showcaseCollapsed) {
    showcaseCollapsed = false;
    saveShowcasePrefs();
    applyShowcaseLayout();
  }
  gridFocusMode = true;
  applyFocusLayout();
  try { localStorage.setItem('gridFocusMode', '1'); } catch (e) {}
}

function exitFocusChartMode() {
  gridFocusMode = false;
  applyFocusLayout();
  applyShowcaseLayout();
  try { localStorage.setItem('gridFocusMode', '0'); } catch (e) {}
}

/* ============================================================
 * 图表展示区（含折叠 / 拖拽 / 与专注模式联动）
 * ============================================================ */
function loadShowcasePrefs() {
  try {
    var c = localStorage.getItem('showcaseCollapsed');
    if (c === '1') showcaseCollapsed = true;
    var h = parseInt(localStorage.getItem('showcaseHeight'), 10);
    if (!isNaN(h) && h >= 120) showcaseHeight = h;
  } catch (e) {}
}
function saveShowcasePrefs() {
  try {
    localStorage.setItem('showcaseCollapsed', showcaseCollapsed ? '1' : '0');
    localStorage.setItem('showcaseHeight', String(showcaseHeight));
  } catch (e) {}
}
function applyShowcaseLayout() {
  showcaseWrapEl.classList.toggle('collapsed', showcaseCollapsed);
  if (!showcaseCollapsed) showcaseWrapEl.style.height = showcaseHeight + 'px';
  else showcaseWrapEl.style.height = '';
  showcaseToggleEl.textContent = showcaseCollapsed ? '展开' : '收起';
  showcaseDragHandleEl.style.display = showcaseCollapsed ? 'none' : '';
}
function destroyShowcaseCharts() {
  Object.keys(showcaseChartInstances).forEach(function (k) {
    try { showcaseChartInstances[k].destroy(); } catch (e) {}
  });
  showcaseChartInstances = {};
}
function renderShowcase() {
  destroyShowcaseCharts();
  var charts = getCharts();
  showcaseCountEl.textContent = String(charts.length);
  if (!charts.length) {
    showcaseWrapEl.classList.add('hidden');
    showcaseBodyEl.innerHTML = '';
    if (gridFocusMode) {
      gridFocusMode = false;
      try { localStorage.setItem('gridFocusMode', '0'); } catch (e) {}
    }
    applyFocusLayout();
    return;
  }
  showcaseWrapEl.classList.remove('hidden');
  applyShowcaseLayout();
  showcaseBodyEl.innerHTML = '';
  charts.forEach(function (cfg) {
    var card = document.createElement('div');
    card.className = 'chart-card';
    card.dataset.id = cfg.id;
    var header = document.createElement('div');
    header.className = 'chart-card-header';
    var titleEl = document.createElement('div');
    titleEl.className = 'chart-card-title';
    titleEl.textContent = cfg.title || '图表';
    titleEl.title = cfg.title || '图表';
    var typeEl = document.createElement('span');
    typeEl.className = 'chart-card-type';
    typeEl.textContent = CHART_TYPE_LABEL[cfg.type] || cfg.type;
    var delBtn = document.createElement('button');
    delBtn.className = 'chart-card-del';
    delBtn.textContent = '×';
    delBtn.title = '从展示中移除';
    delBtn.addEventListener('click', function () {
      if (!currentCanEdit) { alert('只读用户不能修改'); return; }
      if (!confirm('从展示中移除图表「' + (cfg.title || '图表') + '」？')) return;
      removeChartFromShowcase(cfg.id);
    });
    header.appendChild(titleEl);
    header.appendChild(typeEl);
    header.appendChild(delBtn);
    card.appendChild(header);
    var body = document.createElement('div');
    body.className = 'chart-card-body';
    body.id = 'chartCardBody_' + cfg.id;
    card.appendChild(body);
    showcaseBodyEl.appendChild(card);
    setTimeout(function () { renderOneShowcaseChart(cfg, body); }, 0);
  });
  applyFocusLayout();
}

function renderOneShowcaseChart(cfg, bodyEl) {
  bodyEl.innerHTML = '';
  if (CAT_VALUE_TABS.indexOf(cfg.type) >= 0) {
    var catIdx = getColIdxById(cfg.config.catColId);
    var valIdx = getColIdxById(cfg.config.valColId);
    if (catIdx < 1 || valIdx < 1) {
      bodyEl.innerHTML = '<div class="chart-card-error">所引用的列已被删除或重命名</div>';
      return;
    }
    var data = extractCatValue(catIdx, valIdx, {
      aggregate: cfg.config.aggregate || 'none',
      topN: cfg.config.topN || 0,
      excludeColId: cfg.config.catColId || ''   // ★ 排除自身分类列
    });
    if (!data.values.length) {
      bodyEl.innerHTML = '<div class="chart-card-error">数据不足：该列无有效数值</div>';
      return;
    }
    var canvas = document.createElement('canvas');
    bodyEl.appendChild(canvas);
    var valHeader = (gridData[0] && gridData[0][valIdx]) || '数值';

    // ★ 单击 = 筛选；Ctrl/⌘+单击 = 跳转关联台账
    var config = buildChartJsConfig(cfg.type, data.labels, data.values, valHeader,
      function (idx, evt) {
        var label = data.labels[idx];
        var ctrl = !!(evt && evt.native && (evt.native.ctrlKey || evt.native.metaKey));

        // Ctrl/⌘ + 单击 → 保留原跳转逻辑
        if (ctrl) {
          var rows = data.rowIndices[idx];
          if (!rows || !rows.length) return;
          if (rows.length === 1) {
            jumpToLinkedLedger(rows[0]);
          } else {
            showActionToast('该分类包含 ' + rows.length + ' 行，无法定位到具体行', 'error');
          }
          return;
        }

        // 普通单击 → 应用表格筛选
        var catColId = cfg.config.catColId;
        if (catColId && window.applyChartFilter) {
          window.applyChartFilter(catColId, label);
        }
      });
    if (!config) { bodyEl.innerHTML = '<div class="chart-card-error">不支持的图表类型</div>'; return; }
    try { showcaseChartInstances[cfg.id] = new Chart(canvas.getContext('2d'), config); }
    catch (e) { bodyEl.innerHTML = '<div class="chart-card-error">渲染失败：' + esc(e.message) + '</div>'; }
    return;
  }
  if (cfg.type === 'scatter') {
    var xIdx = getColIdxById(cfg.config.xColId);
    var yIdx = getColIdxById(cfg.config.yColId);
    if (xIdx < 1 || yIdx < 1) {
      bodyEl.innerHTML = '<div class="chart-card-error">所引用的列已被删除或重命名</div>';
      return;
    }
    var rows = extractScatter(xIdx, yIdx);
    if (!rows.length) {
      bodyEl.innerHTML = '<div class="chart-card-error">数据不足：X、Y 列无有效数值</div>';
      return;
    }
    var canvas2 = document.createElement('canvas');
    bodyEl.appendChild(canvas2);
    var xHeader = (gridData[0] && gridData[0][xIdx]) || '';
    var yHeader = (gridData[0] && gridData[0][yIdx]) || '';
    var config2 = buildScatterConfig(rows, xHeader, yHeader, function (idx) {
      var pt = rows[idx];
      if (pt && pt._r) jumpToLinkedLedger(pt._r);
    });
    try { showcaseChartInstances[cfg.id] = new Chart(canvas2.getContext('2d'), config2); }
    catch (e) { bodyEl.innerHTML = '<div class="chart-card-error">渲染失败：' + esc(e.message) + '</div>'; }
    return;
  }
  if (cfg.type === 'loc') {
    var posIdx = getColIdxById(cfg.config.locColId);
    if (posIdx < 1) {
      bodyEl.innerHTML = '<div class="chart-card-error">所引用的位置列已被删除</div>';
      return;
    }
    var labelIdx = -1;
    if (cfg.config.locLabelColId) labelIdx = getColIdxById(cfg.config.locLabelColId);
    var rows2 = Math.max(1, Math.min(cfg.config.locRows || 3, 200));
    var cols = Math.max(1, Math.min(cfg.config.locCols || 6, 200));
    var rowStart = cfg.config.locRowStart || 'A';
    var colStart = cfg.config.locColStart || '1';
    var sep = cfg.config.locSep || '';
    var positions = [];
    var posIndexMap = {};
    for (var r2 = 0; r2 < rows2; r2++) {
      var rl = incLabel(rowStart, r2);
      for (var c2 = 0; c2 < cols; c2++) {
        var cl = incLabel(colStart, c2);
        var name = rl + sep + cl;
        var p = { row: r2, col: c2, name: name };
        positions.push(p);
        posIndexMap[name.toUpperCase()] = p;
      }
    }
    var posMap = {};
    for (var i = 1; i < gridData.length; i++) {
      var raw = String(getCell(i, posIdx) || '').trim();
      if (!raw) continue;
      var key = raw.toUpperCase();
      if (!posIndexMap[key]) continue;
      if (!posMap[key]) posMap[key] = { count: 0, labels: [], raws: [], rows: [] };
      posMap[key].count++;
      posMap[key].raws.push(raw);
      posMap[key].rows.push(i);
      if (labelIdx >= 0) {
        var lb = String(getCell(i, labelIdx) || '').trim();
        if (lb) posMap[key].labels.push(lb);
      }
    }
    var info = buildLocSVG(rows2, cols, positions, posMap);
    var box = document.createElement('div');
    box.className = 'loc-svg-box';
    box.innerHTML = info.svg;
    bodyEl.appendChild(box);
    box.addEventListener('click', function (e) {
      var target = e.target.closest('[data-rows]');
      if (!target) return;
      handleLocRowsClick(target);
    });
    return;
  }
  bodyEl.innerHTML = '<div class="chart-card-error">未知图表类型</div>';
}
function handleLocRowsClick(target) {
  var rowsStr = target.getAttribute('data-rows');
  if (!rowsStr) return;
  var rows = rowsStr.split(',').map(Number).filter(function (n) { return n > 0; });
  if (!rows.length) return;
  var cellLinks = getCellLinks();
  var targetIds = [];
  rows.forEach(function (r) {
    Object.keys(cellLinks).forEach(function (k) {
      var parts = k.split(':');
      if (parts.length === 2 && Number(parts[0]) === r) {
        var tid = cellLinks[k];
        if (tid && targetIds.indexOf(tid) === -1) targetIds.push(tid);
      }
    });
  });
  if (!targetIds.length) return;
  if (targetIds.length === 1) {
    if (dirty && !confirm('当前台账有未保存的修改，确定要跳转吗？')) return;
    openLedger(targetIds[0]);
    return;
  }
  var names = targetIds.map(function (tid) {
    var L = null;
    for (var i = 0; i < cachedLedgerList.length; i++) {
      if (cachedLedgerList[i].id === tid) { L = cachedLedgerList[i]; break; }
    }
    return L ? L.name : ('#' + tid);
  });
  var msg = '该位置关联了多个台账，请选择要打开的序号：\n\n';
  names.forEach(function (n, i) { msg += (i + 1) + '. ' + n + '\n'; });
  var ans = prompt(msg);
  if (!ans) return;
  var idx = parseInt(ans, 10) - 1;
  if (idx < 0 || idx >= targetIds.length) { alert('序号无效'); return; }
  if (dirty && !confirm('当前台账有未保存的修改，确定要跳转吗？')) return;
  openLedger(targetIds[idx]);
}
async function removeChartFromShowcase(chartId) {
  if (!currentCanEdit) { alert('只读用户不能修改'); return; }
  var charts = getCharts().filter(function (c) { return c.id !== chartId; });
  var r = await putLedger({ charts: charts });
  if (r.ok) {
    setSaveState('● 已从展示移除');
    renderShowcase();
  }
}
function setupShowcaseDrag() {
  var dragging = false, startY = 0, startH = 0;
  showcaseDragHandleEl.addEventListener('mousedown', function (e) {
    if (showcaseCollapsed) return;
    dragging = true;
    startY = e.clientY;
    startH = showcaseWrapEl.getBoundingClientRect().height;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var delta = startY - e.clientY;
    var newH = Math.max(120, Math.min(startH + delta, window.innerHeight - 200));
    showcaseWrapEl.style.height = newH + 'px';
    showcaseHeight = Math.round(newH);
  });
  document.addEventListener('mouseup', function () {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveShowcasePrefs();
    Object.keys(showcaseChartInstances).forEach(function (k) {
      try { showcaseChartInstances[k].resize(); } catch (e) {}
    });
  });
}

/* ============================================================
 * 图表弹窗（tab 切换 / 预览 / 添加到展示）
 * ============================================================ */
function switchChartTab(tab) {
  chartTab = tab;
  Array.prototype.forEach.call(document.querySelectorAll('.chart-tab'), function (t) {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  var isCatValue = CAT_VALUE_TABS.indexOf(tab) >= 0;
  var isScatter = tab === 'scatter';
  var isLoc = tab === 'loc';
  $('chartPanelCatValue').classList.toggle('hidden', !isCatValue);
  $('chartPanelScatter').classList.toggle('hidden', !isScatter);
  $('chartPanelLoc').classList.toggle('hidden', !isLoc);
  if (isLoc) {
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    if (scatterChartInstance) { scatterChartInstance.destroy(); scatterChartInstance = null; }
  } else if (isScatter) {
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    renderScatterChart();
  } else {
    if (scatterChartInstance) { scatterChartInstance.destroy(); scatterChartInstance = null; }
    renderChart();
  }
}
function openChartDialog() {
  if (currentId === null) { alert('请先打开或新建一本台账'); return; }
  if (!currentCanEdit) { alert('只读用户不能添加图表'); return; }
  if (!gridData.length || !gridData[0].length) { alert('当前台账没有表头，无法生成图表'); return; }
  var headers = gridData[0];
  var catSel = $('chartCat'); var valSel = $('chartVal');
  catSel.innerHTML = ''; valSel.innerHTML = '';
  var firstColIdx = -1;
  headers.forEach(function (h, i) {
    if (i === 0) return;
    if (isTimeColumn(i)) return;
    var text = h || ('列' + i);
    if (firstColIdx < 0) firstColIdx = i;
    var o1 = document.createElement('option'); o1.value = i; o1.textContent = text; catSel.appendChild(o1);
    var o2 = document.createElement('option'); o2.value = i; o2.textContent = text; valSel.appendChild(o2);
  });
  if (firstColIdx >= 0) catSel.value = String(firstColIdx);
  valSel.value = catSel.value;
  var scatterXSel = $('scatterX'); var scatterYSel = $('scatterY');
  scatterXSel.innerHTML = ''; scatterYSel.innerHTML = '';
  headers.forEach(function (h, i) {
    if (i === 0) return;
    if (isTimeColumn(i)) return;
    var text = h || ('列' + i);
    var o1 = document.createElement('option'); o1.value = i; o1.textContent = text; scatterXSel.appendChild(o1);
    var o2 = document.createElement('option'); o2.value = i; o2.textContent = text; scatterYSel.appendChild(o2);
  });
  if (firstColIdx >= 0) { scatterXSel.value = String(firstColIdx); scatterYSel.value = String(firstColIdx); }
  var locColSel = $('locCol'); var locLabelSel = $('locLabelCol');
  locColSel.innerHTML = ''; locLabelSel.innerHTML = '<option value="">— 无 —</option>';
  headers.forEach(function (h, i) {
    if (i === 0) return;
    if (isTimeColumn(i)) return;
    var text = h || ('列' + i);
    var o1 = document.createElement('option'); o1.value = i; o1.textContent = text; locColSel.appendChild(o1);
    var o2 = document.createElement('option'); o2.value = i; o2.textContent = text; locLabelSel.appendChild(o2);
  });
  var guessPos = firstColIdx;
  var posRegex = /机柜|位置|柜位|柜|编号|号/;
  for (var i = 1; i < headers.length; i++) {
    if (isTimeColumn(i)) continue;
    if (posRegex.test(String(headers[i] || ''))) { guessPos = i; break; }
  }
  if (guessPos >= 1) locColSel.value = String(guessPos);
  var guessLabel = '';
  var labelRegex = /名称|设备|型号|名字|品牌/;
  for (var j = 1; j < headers.length; j++) {
    if (isTimeColumn(j)) continue;
    if (j !== guessPos && labelRegex.test(String(headers[j] || ''))) { guessLabel = String(j); break; }
  }
  locLabelSel.value = guessLabel;

  // ★ 智能默认：根据台账行数决定聚合方式
  var totalRows = gridData.length - 1;
  var aggSel = $('chartAggregate');
  var topNInput = $('chartTopN');
  if (aggSel) {
    if (totalRows > 50) {
      aggSel.value = 'sum';
      if (topNInput) topNInput.value = '20';
    } else {
      aggSel.value = 'none';
      if (topNInput) topNInput.value = '0';
    }
  }

  $('chartTitle').value = '';
  $('scatterTitle').value = '';
  $('locTitle').value = '';
  $('chartModal').classList.remove('hidden');
  switchChartTab('bar');
}
function renderChart() {
  if (CAT_VALUE_TABS.indexOf(chartTab) < 0) return;
  var catIdx = parseInt($('chartCat').value, 10);
  var valIdx = parseInt($('chartVal').value, 10);
  if (isNaN(catIdx) || isNaN(valIdx) || catIdx < 1 || valIdx < 1) return;
  var aggEl = $('chartAggregate');
  var topNEl = $('chartTopN');
  var catColId = getColumnIdAt(catIdx);
  var data = extractCatValue(catIdx, valIdx, {
    aggregate: aggEl ? aggEl.value : 'none',
    topN: topNEl ? (parseInt(topNEl.value, 10) || 0) : 0,
    excludeColId: catColId   // ★ 排除自身分类列
  });
  var hasData = data.values.length > 0;
  $('chartEmptyHint').classList.toggle('hidden', hasData);
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  if (!hasData) return;
  var valHeader = gridData[0][valIdx] || '数值';
  var config = buildChartJsConfig(chartTab, data.labels, data.values, valHeader);
  if (!config) return;
  chartInstance = new Chart($('chartCanvas').getContext('2d'), config);
}
function renderScatterChart() {
  var xIdx = parseInt($('scatterX').value, 10);
  var yIdx = parseInt($('scatterY').value, 10);
  if (isNaN(xIdx) || isNaN(yIdx) || xIdx < 1 || yIdx < 1) return;
  var rows = extractScatter(xIdx, yIdx);
  var hasData = rows.length > 0;
  $('scatterEmptyHint').classList.toggle('hidden', hasData);
  if (scatterChartInstance) { scatterChartInstance.destroy(); scatterChartInstance = null; }
  if (!hasData) return;
  var xHeader = gridData[0][xIdx] || '';
  var yHeader = gridData[0][yIdx] || '';
  var config = buildScatterConfig(rows, xHeader, yHeader);
  if (!config) return;
  scatterChartInstance = new Chart($('scatterCanvas').getContext('2d'), config);
}
function closeChart() {
  $('chartModal').classList.add('hidden');
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  if (scatterChartInstance) { scatterChartInstance.destroy(); scatterChartInstance = null; }
}
function addChartFromModal() {
  if (!currentCanEdit) { alert('只读用户不能修改'); return; }
  if (!currentLedger) { alert('请先打开一本台账'); return; }
  var cfg = null;
  if (CAT_VALUE_TABS.indexOf(chartTab) >= 0) {
    var catIdx = parseInt($('chartCat').value, 10);
    var valIdx = parseInt($('chartVal').value, 10);
    if (isNaN(catIdx) || isNaN(valIdx) || catIdx < 1 || valIdx < 1) {
      alert('请选择分类列和数值列'); return;
    }
    var catColId = getColumnIdAt(catIdx);
    var valColId = getColumnIdAt(valIdx);
    var title = ($('chartTitle').value || '').trim();
    if (!title) title = (gridData[0][valIdx] || '数值') + ' - ' + (gridData[0][catIdx] || '分类');
    var aggVal = ($('chartAggregate') && $('chartAggregate').value) || 'none';
    var topNVal = ($('chartTopN') && parseInt($('chartTopN').value, 10)) || 0;
    cfg = { id: uuidHex(), type: chartTab, title: title.slice(0, 100),
      config: {
        catColId: catColId,
        valColId: valColId,
        aggregate: aggVal,
        topN: topNVal
      } };
  } else if (chartTab === 'scatter') {
    var xIdx = parseInt($('scatterX').value, 10);
    var yIdx = parseInt($('scatterY').value, 10);
    if (isNaN(xIdx) || isNaN(yIdx) || xIdx < 1 || yIdx < 1) {
      alert('请选择 X、Y 数值列'); return;
    }
    var xColId = getColumnIdAt(xIdx);
    var yColId = getColumnIdAt(yIdx);
    var title2 = ($('scatterTitle').value || '').trim();
    if (!title2) title2 = (gridData[0][yIdx] || 'Y') + ' vs ' + (gridData[0][xIdx] || 'X');
    cfg = { id: uuidHex(), type: 'scatter', title: title2.slice(0, 100),
      config: { xColId: xColId, yColId: yColId } };
  } else if (chartTab === 'loc') {
    var posIdx = parseInt($('locCol').value, 10);
    if (isNaN(posIdx) || posIdx < 1) { alert('请选择位置列'); return; }
    var posColId = getColumnIdAt(posIdx);
    var labelVal = $('locLabelCol').value;
    var labelColId = labelVal === '' ? '' : getColumnIdAt(parseInt(labelVal, 10));
    var title3 = ($('locTitle').value || '').trim();
    if (!title3) title3 = (gridData[0][posIdx] || '位置') + ' 位置分布';
    cfg = { id: uuidHex(), type: 'loc', title: title3.slice(0, 100),
      config: { locColId: posColId, locLabelColId: labelColId,
        locRows: Math.max(1, Math.min(parseInt($('locRows').value, 10) || 3, 200)),
        locCols: Math.max(1, Math.min(parseInt($('locCols').value, 10) || 6, 200)),
        locRowStart: ($('locRowStart').value || 'A').trim().slice(0, 8),
        locColStart: ($('locColStart').value || '1').trim().slice(0, 8),
        locSep: ($('locSep').value || '').trim().slice(0, 8) } };
  }
  if (!cfg) { alert('当前标签页无可添加的内容'); return; }
  var charts = getCharts().slice();
  if (charts.length >= 20) { alert('最多只能添加 20 个图表'); return; }
  charts.push(cfg);
  putLedger({ charts: charts }).then(function (r) {
    if (r.ok) {
      currentLedger = r.ledger;
      setSaveState('● 已添加到展示');
      closeChart();
      renderShowcase();
    }
  });
}