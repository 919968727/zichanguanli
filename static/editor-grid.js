/* ============================================================
 * editor-grid.js —— 表格渲染 / 选区 / 复制粘贴 / 表格事件
 * 【内嵌方案】data-col 使用 gridData 索引（1-based），第 0 位为哨兵不渲染
 *
 * ★ 新增（Excel 习惯）：
 *   - 方向键 ↑↓←→ 移动焦点
 *   - Tab / Shift+Tab 切换单元格
 *   - Ctrl+A 全选、Delete/Backspace 清空选区
 *   - Ctrl+X 剪切选区
 *   - 单元格编辑首次输入时 pushUndo（配合 editor-core.js）
 *
 * ★ 新增（表格筛选）：
 *   - 列头「▼」按钮 → 弹出筛选面板
 *   - 顶部筛选标签栏（显示 X / Y 行，可单独或全部清除）
 *   - 筛选激活时关闭虚拟滚动，全量渲染但只保留匹配行
 *   - 图表点击 → 应用「该列 = 该值」为筛选条件（Ctrl+点击保留跳转）
 * ============================================================ */

var VIRTUAL_THRESHOLD = 300;
var VIRTUAL_BUFFER = 50;

var virtualState = {
  enabled: false,
  totalRows: 0,
  startRow: 0,
  endRow: 0,
  rowHeight: 42,
  scrollEl: null,
};

/* ---------- 表头 HTML ---------- */
function buildTheadHtml() {
  if (!gridData.length) return '';
  var totalCols = gridData[0].length;
  var timeColIdx = findTimeColumn();
  var colIds = getColumnIds();
  var html = '<thead><tr>' +
             '<th class="chk-col" title="全选/取消全选当前可见的数据行">' +
             '<input type="checkbox" id="chkSelectAll" aria-label="全选"></th>' +
             '<th class="rowno">#</th>';
  for (var c = 1; c < totalCols; c++) {
    var isTime = (c === timeColIdx);
    var isOpt = !isTime && isOptionColumn(c);
    var thEditable = currentCanEdit && !isTime && !isOpt;
    var thClass = 'th-text';
    if (isTime) thClass += ' time-col-header';
    if (isOpt) thClass += ' option-col-header';

    var colId = colIds[c] || '';
    var isFiltered = !!(colId && columnFilters[colId] &&
                        Object.keys(columnFilters[colId]).length > 0);
    var filterBtnCls = 'col-filter-btn' + (isFiltered ? ' active' : '');
    var filterBtn = isTime ? '' :
      '<span class="' + filterBtnCls + '" data-col="' + c +
      '" title="' + (isFiltered ? '已筛选（点击修改）' : '筛选') + '">▼</span>';

    html += '<th>' +
            '<span class="' + thClass + '" contenteditable="' +
            (thEditable ? 'true' : 'false') +
            '" data-col="' + c + '">' +
            esc(gridData[0][c] == null ? '' : gridData[0][c]) +
            '</span>' + filterBtn + '</th>';
  }
  html += '<th class="qr-col" title="为每一行生成二维码并保存到附件库">' +
          '<button type="button" class="qr-all-btn" ' +
          'title="为所有行一键生成二维码（文件名取第一列）">全部</button>' +
          '<button type="button" class="qr-settings-btn" title="二维码模板设置">⚙</button></th>';
  html += '</tr></thead>';
  return html;
}

/* ---------- 单行 HTML ---------- */
function buildRowHtml(r) {
  var totalCols = gridData[0].length;
  var cellLinks = getCellLinks();
  var colIds = getColumnIds();
  var timeColIdx = findTimeColumn();

  var rowUuid = getRowUuid(r);
  var rowChecked = isRowSelected(rowUuid) ? ' checked' : '';
  var rowCls = isRowSelected(rowUuid) ? ' class="row-selected"' : '';
  var html = '<tr data-row="' + r + '"' + rowCls + '>' +
             '<td class="chk-cell"><input type="checkbox" class="row-chk" ' +
             'data-row="' + r + '" data-uuid="' + (rowUuid || '') + '"' +
             rowChecked + ' aria-label="选中第 ' + r + ' 行"></td>' +
             '<td class="rowno">' + r + '</td>';
  for (var c2 = 1; c2 < totalCols; c2++) {
    var cellVal = getCell(r, c2);
    var isTime2 = (c2 === timeColIdx);
    if (isTime2) {
      html += '<td data-row="' + r + '" data-col="' + c2 + '" class="time-cell">' +
              '<span class="cell-text time-cell-text" contenteditable="false" ' +
              'data-row="' + r + '" data-col="' + c2 + '">' +
              esc(cellVal == null ? '' : cellVal) +
              '</span></td>';
      continue;
    }
    var isOpt2 = isOptionColumn(c2);
    var colId = colIds[c2] || '';
    var key = r + ':' + colId;
    var linkedId = isOpt2 ? null : cellLinks[key];
    var actionDef = isOpt2 ? null : getCellAction(r, colId);
    var editable = (currentCanEdit && !isOpt2) ? 'true' : 'false';
    var tdCls = isOpt2 ? ' class="option-cell"' : '';
    var cls = linkedId ? 'cell-link-btn has-link' : 'cell-link-btn';
    var title = linkedId
      ? '点击跳转到该单元格关联的台账（右键修改/清除）'
      : '设置单元格关联台账';
    var linkBtnHtml = isOpt2 ? '' :
      '<span class="' + cls + '" data-row="' + r + '" data-col="' + c2 +
      '" title="' + title + '">' + (linkedId ? '🔗' : '+') + '</span>';
    var actionCls = (actionDef && actionDef.name)
      ? 'cell-action-btn has-action' : 'cell-action-btn';
    var actionTitle = (actionDef && actionDef.name)
      ? '左键执行「' + actionDef.name + '」，右键配置'
      : '左键配置交互操作，右键也打开配置';
    var actionBtnHtml = isOpt2 ? '' :
      '<span class="' + actionCls + '" data-row="' + r + '" data-col="' + c2 +
      '" title="' + actionTitle + '">⚡</span>';

    html += '<td data-row="' + r + '" data-col="' + c2 + '"' + tdCls + '>' +
            '<span class="cell-text" contenteditable="' + editable +
            '" data-row="' + r + '" data-col="' + c2 + '">' +
            esc(cellVal == null ? '' : cellVal) +
            '</span>' +
            linkBtnHtml + actionBtnHtml +
            '</td>';
  }
  html += '<td class="qr-cell">' +
          '<button type="button" class="row-qr-btn" data-row="' + r + '" ' +
          'title="生成第 ' + r + ' 行的二维码，并以第一列内容命名保存到附件库">QR</button>' +
          '</td></tr>';
  return html;
}

/* ---------- 批量选中：全选框三态同步 ---------- */
function updateSelectAllState() {
  var box = document.getElementById('chkSelectAll');
  if (!box) return;
  var total = 0, checked = 0;
  for (var r = 1; r < gridData.length; r++) {
    if (typeof rowMatchesFilters === 'function' && !rowMatchesFilters(r)) continue;
    total++;
    if (isRowSelected(getRowUuid(r))) checked++;
  }
  box.checked = total > 0 && checked === total;
  box.indeterminate = checked > 0 && checked < total;
  box.disabled = total === 0;
  updateBatchBar();
}

/* ---------- 全量渲染（行数少 / 筛选激活时用） ---------- */
function renderGridFull() {
  var html = buildTheadHtml() + '<tbody>';
  for (var r = 1; r < gridData.length; r++) {
    if (!rowMatchesFilters(r)) continue;
    html += buildRowHtml(r);
  }
  html += '</tbody>';
  gridEl.innerHTML = html;
  renderSelectionHighlight();
  updateSelectAllState();
}

/* ---------- 主入口 ---------- */
function renderGrid() {
  if (!gridData.length) {
    gridEl.innerHTML = '';
    renderFilterBar();
    updateSelectAllState();
    return;
  }
  var totalRows = gridData.length - 1;
  var hasFilter = hasActiveFilters();

  // ★ 筛选激活时强制全量渲染（跳过虚拟滚动）
  if (hasFilter || totalRows <= VIRTUAL_THRESHOLD) {
    virtualState.enabled = false;
    renderGridFull();
    renderFilterBar();
    return;
  }

  // 虚拟滚动
  virtualState.enabled = true;
  virtualState.totalRows = totalRows;
  virtualState.scrollEl = gridEl.parentElement || null;
  virtualState.startRow = 0;
  virtualState.endRow = 0;

  gridEl.innerHTML = buildTheadHtml() + '<tbody></tbody>';
  var st = virtualState.scrollEl ? virtualState.scrollEl.scrollTop : 0;
  updateVirtualRows(st);
  setupVirtualScrollHandler();
  renderFilterBar();
  updateSelectAllState();
}

/* ---------- 虚拟滚动（筛选激活时不会进入） ---------- */
function updateVirtualRows(scrollTop) {
  var totalRows = virtualState.totalRows;
  if (!totalRows) return;
  var scrollEl = virtualState.scrollEl;
  if (!scrollEl) return;

  var estH = virtualState.rowHeight || 42;
  var viewH = scrollEl.clientHeight || 600;
  var st = typeof scrollTop === 'number' ? scrollTop : scrollEl.scrollTop;

  var firstVisible = Math.max(0, Math.floor(st / estH));
  var lastVisible = Math.min(totalRows - 1, Math.ceil((st + viewH) / estH));

  var start = Math.max(0, firstVisible - VIRTUAL_BUFFER);
  var end = Math.min(totalRows - 1, lastVisible + VIRTUAL_BUFFER);

  if (start + 1 === virtualState.startRow && end + 1 === virtualState.endRow) {
    return;
  }
  virtualState.startRow = start + 1;
  virtualState.endRow = end + 1;

  var colspan = gridData[0].length + 2; // +1 原有 QR 列，+1 新增 checkbox 列
  var parts = [];

  if (start > 0) {
    var topH = start * estH;
    parts.push(
      '<tr class="virtual-pad" aria-hidden="true">' +
      '<td colspan="' + colspan +
      '" style="height:' + topH + 'px;"></td></tr>'
    );
  }

  for (var r = start + 1; r <= end + 1; r++) {
    parts.push(buildRowHtml(r));
  }

  if (end < totalRows - 1) {
    var bottomH = (totalRows - 1 - end) * estH;
    parts.push(
      '<tr class="virtual-pad" aria-hidden="true">' +
      '<td colspan="' + colspan +
      '" style="height:' + bottomH + 'px;"></td></tr>'
    );
  }

  var tbody = gridEl.querySelector('tbody');
  if (tbody) tbody.innerHTML = parts.join('');
  else gridEl.innerHTML = buildTheadHtml() + '<tbody>' + parts.join('') + '</tbody>';

  measureRowHeight();
  renderSelectionHighlight();
  updateSelectAllState();
}

function measureRowHeight() {
  var rows = gridEl.querySelectorAll('tbody tr[data-row]');
  if (rows.length < 3) return;
  var n = rows.length;
  var samples = [];
  var maxSample = Math.min(10, n);
  for (var i = 0; i < maxSample; i++) {
    samples.push(rows[i].getBoundingClientRect().height);
  }
  for (i = Math.max(0, n - 10); i < n; i++) {
    samples.push(rows[i].getBoundingClientRect().height);
  }
  var sum = 0, cnt = 0;
  for (i = 0; i < samples.length; i++) {
    if (samples[i] > 0) { sum += samples[i]; cnt++; }
  }
  if (cnt > 0) {
    var measured = sum / cnt;
    virtualState.rowHeight = virtualState.rowHeight * 0.7 + measured * 0.3;
  }
}

function setupVirtualScrollHandler() {
  var el = virtualState.scrollEl || gridEl.parentElement;
  if (!el || el._virtualBound) return;
  el._virtualBound = true;
  var raf = null;
  el.addEventListener('scroll', function () {
    if (!virtualState.enabled) return;
    var ae = document.activeElement;
    if (ae && gridEl.contains(ae)) return;
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = null;
      updateVirtualRows();
    });
  }, { passive: true });
}

function scrollToRow(r) {
  if (!virtualState.enabled || !virtualState.scrollEl) return;
  var totalRows = virtualState.totalRows;
  if (r < 1) r = 1;
  if (r > totalRows) r = totalRows;
  var estH = virtualState.rowHeight || 42;
  var viewH = virtualState.scrollEl.clientHeight || 600;
  var targetIdx = r - 1;
  var offset = Math.max(0, targetIdx * estH - Math.floor(viewH / 3));
  virtualState.scrollEl.scrollTop = offset;
  updateVirtualRows(offset);
}

window.scrollToRowIfEnabled = function (r) {
  if (virtualState.enabled) scrollToRow(r);
};

function doFocusCell(el) {
  el.focus();
  var range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  var sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
}

function focusCell(r, c) {
  var el = gridEl.querySelector(
    '.cell-text[data-row="' + r + '"][data-col="' + c + '"]'
  );
  if (el) { doFocusCell(el); return; }
  if (!virtualState.enabled) return;

  scrollToRow(r);
  var el2 = gridEl.querySelector(
    '.cell-text[data-row="' + r + '"][data-col="' + c + '"]'
  );
  if (el2) { doFocusCell(el2); return; }
  requestAnimationFrame(function () {
    var el3 = gridEl.querySelector(
      '.cell-text[data-row="' + r + '"][data-col="' + c + '"]'
    );
    if (el3) doFocusCell(el3);
  });
}

/* ---------- 选区 ---------- */
function clearSelection() {
  selection = null;
  Array.prototype.forEach.call(gridEl.querySelectorAll('.cell-selected'), function (el) {
    el.classList.remove('cell-selected');
  });
}
function hasSelection() { return !!selection; }
function setSelection(r1, c1, r2, c2) {
  selection = { r1: r1, c1: c1, r2: r2, c2: c2 };
  renderSelectionHighlight();
}
function renderSelectionHighlight() {
  Array.prototype.forEach.call(gridEl.querySelectorAll('.cell-selected'), function (el) {
    el.classList.remove('cell-selected');
  });
  if (!selection) return;
  var r1 = Math.min(selection.r1, selection.r2);
  var r2 = Math.max(selection.r1, selection.r2);
  var c1 = Math.min(selection.c1, selection.c2);
  var c2 = Math.max(selection.c1, selection.c2);
  for (var r = r1; r <= r2; r++) {
    for (var c = c1; c <= c2; c++) {
      var td = gridEl.querySelector('td[data-row="' + r + '"][data-col="' + c + '"]');
      if (td) td.classList.add('cell-selected');
    }
  }
}

function buildTSVFromSelection() {
  if (!selection) return '';
  var r1 = Math.min(selection.r1, selection.r2);
  var r2 = Math.max(selection.r1, selection.r2);
  var c1 = Math.min(selection.c1, selection.c2);
  var c2 = Math.max(selection.c1, selection.c2);
  var lines = [];
  for (var r = r1; r <= r2; r++) {
    var cells = [];
    for (var c = c1; c <= c2; c++) {
      var v = getCell(r, c);
      cells.push(v == null ? '' : String(v));
    }
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}
function buildHTMLFromSelection() {
  if (!selection) return '';
  var r1 = Math.min(selection.r1, selection.r2);
  var r2 = Math.max(selection.r1, selection.r2);
  var c1 = Math.min(selection.c1, selection.c2);
  var c2 = Math.max(selection.c1, selection.c2);
  var out = ['<table>'];
  for (var r = r1; r <= r2; r++) {
    out.push('<tr>');
    for (var c = c1; c <= c2; c++) {
      var v = getCell(r, c);
      out.push('<td>' + (v == null ? '' : escXml(v)) + '</td>');
    }
    out.push('</tr>');
  }
  out.push('</table>');
  return out.join('');
}

function parseTSV(text) {
  text = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (!text) return [];
  return text.split('\n').map(function (line) { return line.split('\t'); });
}
function parseHTMLTable(html) {
  try {
    var div = document.createElement('div');
    div.innerHTML = html;
    var table = div.querySelector('table');
    if (!table) return null;
    var rows = table.querySelectorAll('tr');
    var matrix = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].querySelectorAll('td, th');
      var row = [];
      for (var j = 0; j < cells.length; j++) {
        row.push((cells[j].textContent || '').replace(/\u00a0/g, ' ').trim());
      }
      matrix.push(row);
    }
    return matrix;
  } catch (e) { return null; }
}

function applyPasteMatrix(matrix, startRow, startCol) {
  if (!currentCanEdit) { alert('只读用户不能粘贴修改内容'); return; }
  if (!matrix || !matrix.length) return;
  if (typeof pushUndo === 'function') pushUndo();

  var pasteRows = matrix.length;
  var pasteCols = 0;
  matrix.forEach(function (row) { if (row.length > pasteCols) pasteCols = row.length; });
  if (pasteCols === 0) return;
  if (startCol < 1) startCol = 1;
  if (pasteRows > 5000) {
    if (!confirm('本次粘贴包含 ' + pasteRows + ' 行数据，可能耗时较长，确定继续吗？')) return;
  }
  var timeColIdx = findTimeColumn();
  var timeColData = null;
  var timeColId = null;
  var removedTimeCol = false;
  if (timeColIdx >= 0) {
    var pasteEndCol = startCol + pasteCols - 1;
    if (pasteEndCol >= timeColIdx) {
      timeColData = [];
      for (var r0 = 0; r0 < gridData.length; r0++) timeColData.push(getCell(r0, timeColIdx));
      ensureColumnIds();
      timeColId = getColumnIds()[timeColIdx] || uuidHex();
      gridData[0].splice(timeColIdx, 1);
      for (var r1 = 1; r1 < gridData.length; r1++) {
        if (gridData[r1]) gridData[r1].splice(timeColIdx, 1);
      }
      getColumnIds().splice(timeColIdx, 1);
      removedTimeCol = true;
    }
  }
  var targetEndRow = startRow + pasteRows - 1;
  while (gridData.length <= targetEndRow) {
    gridData.push([uuidHex()].concat(new Array(colCount()).fill('')));
  }
  var targetEndCol = startCol + pasteCols - 1;
  while ((gridData[0] ? gridData[0].length : 0) <= targetEndCol) {
    var newIdx = (gridData[0] ? gridData[0].length : 1);
    gridData[0].push('列' + newIdx);
    for (var r2 = 1; r2 < gridData.length; r2++) {
      if (gridData[r2]) gridData[r2].push('');
    }
    getColumnIds().push(uuidHex());
  }
  var affectedRows = {};
  for (var pr = 0; pr < pasteRows; pr++) {
    var tr = startRow + pr;
    if (tr >= gridData.length) break;
    for (var pc = 0; pc < matrix[pr].length; pc++) {
      var tc = startCol + pc;
      if (tc >= gridData[0].length) break;
      var val = matrix[pr][pc] == null ? '' : String(matrix[pr][pc]);
      setCell(tr, tc, val);
      if (tr >= 1) affectedRows[tr] = true;
    }
  }
  if (removedTimeCol && timeColData) {
    gridData[0].push(TIME_COL_HEADER);
    for (var r3 = 1; r3 < gridData.length; r3++) {
      if (gridData[r3]) {
        gridData[r3].push(timeColData[r3] != null ? timeColData[r3] : '');
      }
    }
    getColumnIds().push(timeColId);
    var newTimeColIdx = findTimeColumn();
    Object.keys(affectedRows).forEach(function (ri) {
      var n = Number(ri);
      if (gridData[n]) gridData[n][newTimeColIdx] = nowStr();
    });
  } else if (timeColIdx >= 0) {
    Object.keys(affectedRows).forEach(function (ri) {
      var n = Number(ri);
      if (gridData[n]) gridData[n][timeColIdx] = nowStr();
    });
  }
  renderGrid();
  if (window.scrollToRowIfEnabled) window.scrollToRowIfEnabled(startRow);
  setSelection(startRow, startCol, startRow + pasteRows - 1, startCol + pasteCols - 1);
  markDirty();
  setSaveState('● 已粘贴 ' + pasteRows + ' 行 × ' + pasteCols + ' 列');
}

/* ---------- 编辑上下文 ---------- */
var _editPushed = false;
window.__pushUndoOnceForEdit = function () {
  if (_editPushed) return;
  _editPushed = true;
  if (typeof pushUndo === 'function') pushUndo();
};
gridEl.addEventListener('focusin', function () { _editPushed = false; });
gridEl.addEventListener('focusout', function () {
  setTimeout(function () { _editPushed = false; }, 0);
});

/* ---------- 表格事件 ---------- */
gridEl.addEventListener('input', function (e) {
  if (!currentCanEdit) return;
  var cell = e.target;
  if (!cell) return;
  if (cell.classList && cell.classList.contains('cell-text')) {
    if (cell.classList.contains('time-cell-text')) return;
    var r = Number(cell.dataset.row), c = Number(cell.dataset.col);
    if (!gridData[r]) return;
    if (isTimeColumn(c) || isOptionColumn(c)) return;
    var oldVal = getCell(r, c);
    var newVal = cell.textContent;
    if ((oldVal == null ? '' : String(oldVal)) === newVal) return;
    if (window.__pushUndoOnceForEdit) window.__pushUndoOnceForEdit();
    setCell(r, c, newVal);
    touchRowTime(r);
    markDirty();
  } else if (cell.classList && cell.classList.contains('th-text')) {
    var colIdx = Number(cell.dataset.col);
    if (colIdx < 1) { cell.textContent = ''; return; }
    if (isTimeColumn(colIdx) || isOptionColumn(colIdx)) {
      cell.textContent = gridData[0][colIdx] || '';
      return;
    }
    var oldH = gridData[0][colIdx] == null ? '' : String(gridData[0][colIdx]);
    var newH = cell.textContent;
    if (oldH === newH) return;
    if (String(newH).trim() === TIME_COL_HEADER) {
      cell.textContent = oldH;
      alert('该列名已被系统保留，请使用其它名称');
      return;
    }
    if (window.__pushUndoOnceForEdit) window.__pushUndoOnceForEdit();
    gridData[0][colIdx] = newH;
    markDirty();
  }
});

gridEl.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  var cell = e.target;
  if (cell.classList && cell.classList.contains('th-text')) { e.preventDefault(); return; }
  if (!cell.classList || !cell.classList.contains('cell-text')) return;
  e.preventDefault();
  if (!currentCanEdit) return;
  if (cell.classList.contains('time-cell-text')) return;
  var r = Number(cell.dataset.row) + 1;
  var c = Number(cell.dataset.col);
  if (r < gridData.length) focusCell(r, c);
});

/* ---------- 批量选中：行 checkbox / 表头全选 ---------- */
gridEl.addEventListener('change', function (e) {
  var t = e.target;
  if (t.id === 'chkSelectAll') {
    var on = t.checked;
    for (var r = 1; r < gridData.length; r++) {
      if (typeof rowMatchesFilters === 'function' && !rowMatchesFilters(r)) continue;
      var u = getRowUuid(r);
      if (!u) continue;
      if (on) selectedRows[u] = true; else delete selectedRows[u];
    }
    renderGrid();
    return;
  }
  if (t.classList && t.classList.contains('row-chk')) {
    var uuid = t.dataset.uuid;
    var on2 = t.checked;
    setRowSelected(uuid, on2);
    var tr = t.closest('tr');
    if (tr) tr.classList.toggle('row-selected', on2);
    updateBatchBar();
  }
});

gridEl.addEventListener('mousedown', function (e) {
  // 筛选按钮 / 批量勾选框：不触发选区
  if (e.target.closest('.col-filter-btn') || e.target.closest('.chk-cell')) return;
  var cell = e.target.closest('td[data-row]');
  if (!cell) return;
  if (e.button !== 0) return;
  if (e.target.closest('.cell-link-btn') || e.target.closest('.cell-action-btn')) return;
  var r = Number(cell.dataset.row);
  var c = Number(cell.dataset.col);
  if (isNaN(r) || isNaN(c)) return;
  if (e.shiftKey && lastActiveCell) {
    e.preventDefault();
    suppressNextClick = true;
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
    setSelection(lastActiveCell.row, lastActiveCell.col, r, c);
    return;
  }
  lastActiveCell = { row: r, col: c };
  if (hasSelection()) clearSelection();
});

gridEl.addEventListener('click', function (e) {
  if (suppressNextClick) { suppressNextClick = false; return; }

  // ★ 筛选按钮
  var filterBtn = e.target.closest('.col-filter-btn');
  if (filterBtn) {
    e.preventDefault(); e.stopPropagation();
    var fc = Number(filterBtn.dataset.col);
    if (!isNaN(fc) && fc >= 1) openColumnFilterPanel(fc, filterBtn);
    return;
  }

  var actionBtn = e.target.closest('.cell-action-btn');
  if (actionBtn) {
    e.preventDefault(); e.stopPropagation();
    var ar = Number(actionBtn.dataset.row);
    var ac = Number(actionBtn.dataset.col);
    if (isNaN(ar) || isNaN(ac)) return;
    triggerInteractAction(ar, ac);
    return;
  }

  var cellBtn = e.target.closest('.cell-link-btn');
  if (cellBtn) {
    e.preventDefault(); e.stopPropagation();
    var r = Number(cellBtn.dataset.row);
    var c = Number(cellBtn.dataset.col);
    if (isTimeColumn(c) || isOptionColumn(c)) return;
    var colId = getColumnIdAt(c);
    var linkedId = getCellLinks()[r + ':' + colId];
    if (linkedId) {
      if (dirty && !confirm('当前台账有未保存的修改，确定要跳转吗？')) return;
      openLedger(linkedId);
    } else {
      openLinkDialog({ type: 'cell', row: r, col: c });
    }
    return;
  }

  var cellText = e.target.closest('.cell-text');
  if (!cellText) return;
  if (cellText.classList.contains('time-cell-text')) return;
  var rr = Number(cellText.dataset.row);
  var cc = Number(cellText.dataset.col);
  if (isNaN(rr) || isNaN(cc) || rr < 1) return;
  if (!isOptionColumn(cc)) return;
  e.preventDefault(); e.stopPropagation();
  if (!currentCanEdit) return;
  var opts = getColumnOptionsForIdx(cc);
  var curVal = getCell(rr, cc);
  curVal = curVal == null ? '' : String(curVal);
  var cellEl = cellText.parentElement || cellText;
  showOptionPicker(cellEl, opts, curVal, function (picked) {
    if (getCell(rr, cc) === picked) return;
    if (typeof pushUndo === 'function') pushUndo();
    setCell(rr, cc, picked);
    cellText.textContent = picked;
    touchRowTime(rr);
    markDirty();
  });
});

gridEl.addEventListener('contextmenu', function (e) {
  var actionBtn = e.target.closest('.cell-action-btn');
  if (actionBtn) {
    e.preventDefault(); e.stopPropagation();
    var ar = Number(actionBtn.dataset.row);
    var ac = Number(actionBtn.dataset.col);
    if (isNaN(ar) || isNaN(ac)) return;
    openCellActionEditor(ar, ac);
    return;
  }
  var cellBtn = e.target.closest('.cell-link-btn');
  if (cellBtn) {
    e.preventDefault(); e.stopPropagation();
    if (isTimeColumn(Number(cellBtn.dataset.col)) ||
        isOptionColumn(Number(cellBtn.dataset.col))) return;
    openLinkDialog({
      type: 'cell',
      row: Number(cellBtn.dataset.row),
      col: Number(cellBtn.dataset.col)
    });
    return;
  }
  var rowNo = e.target.closest('td.rowno');
  if (rowNo) {
    e.preventDefault(); e.stopPropagation();
    var r = parseInt(rowNo.textContent, 10);
    if (!isNaN(r) && r >= 1) showRowCtxMenu(e.clientX, e.clientY, r);
    return;
  }
  var th = e.target.closest('th');
  if (th && !th.classList.contains('rowno') && !th.classList.contains('qr-col')) {
    var thText = th.querySelector('.th-text');
    if (!thText) return;
    var colIdx = Number(thText.dataset.col);
    if (isNaN(colIdx) || colIdx < 1) return;
    e.preventDefault(); e.stopPropagation();
    showColCtxMenu(e.clientX, e.clientY, colIdx);
    return;
  }
});

document.addEventListener('copy', function (e) {
  if (!hasSelection()) return;
  var active = document.activeElement;
  if (active && active.classList && active.classList.contains('cell-text')) return;
  var tsv = buildTSVFromSelection();
  var html = buildHTMLFromSelection();
  if (e.clipboardData) {
    e.clipboardData.setData('text/plain', tsv);
    e.clipboardData.setData('text/html', html);
    e.preventDefault();
    e.stopPropagation();
    setSaveState('● 已复制 ' +
      (Math.abs(selection.r2 - selection.r1) + 1) + ' 行 × ' +
      (Math.abs(selection.c2 - selection.c1) + 1) + ' 列');
  }
}, true);

document.addEventListener('paste', function (e) {
  var cd = e.clipboardData || window.clipboardData;
  if (!cd) return;
  var text = cd.getData('text/plain') || '';
  var html = cd.getData('text/html') || '';
  var active = document.activeElement;
  var activeIsCell = active && active.classList && active.classList.contains('cell-text');
  var isMulti = /[\t\n]/.test(text.trim());
  if (activeIsCell && !isMulti) return;
  if (!currentCanEdit) return;
  var matrix = null;
  if (text && isMulti) {
    matrix = parseTSV(text);
  } else if (html && /<table[\s>]/i.test(html)) {
    matrix = parseHTMLTable(html);
  } else if (text && !isMulti && !activeIsCell) {
    matrix = [[text]];
  }
  if (!matrix || !matrix.length) return;
  e.preventDefault();
  e.stopPropagation();
  var startRow = 1, startCol = 1;
  if (hasSelection()) {
    startRow = Math.min(selection.r1, selection.r2);
    startCol = Math.min(selection.c1, selection.c2);
  } else if (lastActiveCell) {
    startRow = lastActiveCell.row;
    startCol = lastActiveCell.col;
  } else if (activeIsCell) {
    startRow = Number(active.dataset.row);
    startCol = Number(active.dataset.col);
  }
  if (startRow < 1) startRow = 1;
  if (startCol < 1) startCol = 1;
  applyPasteMatrix(matrix, startRow, startCol);
}, true);

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && hasSelection()) clearSelection();
  if (e.key === 'F2' && hasSelection() && currentCanEdit) {
    var r = Math.min(selection.r1, selection.r2);
    var c = Math.min(selection.c1, selection.c2);
    var cell = gridEl.querySelector('.cell-text[data-row="' + r + '"][data-col="' + c + '"]');
    if (cell && cell.getAttribute('contenteditable') === 'true') {
      clearSelection();
      cell.focus();
      var range = document.createRange();
      range.selectNodeContents(cell);
      range.collapse(false);
      var s = window.getSelection();
      s.removeAllRanges(); s.addRange(range);
    }
  }
});

/* ============================================================
 * ★ Excel 习惯快捷键
 * ============================================================ */
(function () {
  'use strict';
  if (!gridEl) return;

  function _isEditingCell() {
    var ae = document.activeElement;
    return !!(ae && ae.classList &&
      (ae.classList.contains('cell-text') || ae.classList.contains('th-text')) &&
      !ae.classList.contains('time-cell-text'));
  }

  function _currentAnchor() {
    if (hasSelection && hasSelection()) {
      return { r: Math.min(selection.r1, selection.r2),
               c: Math.min(selection.c1, selection.c2) };
    }
    if (lastActiveCell) return { r: lastActiveCell.row, c: lastActiveCell.col };
    return { r: 1, c: 1 };
  }

  function _navigate(newR, newC) {
    if (!gridData.length) return;
    var maxR = gridData.length - 1;
    var maxC = gridData[0].length - 1;
    newR = Math.max(1, Math.min(maxR, newR));
    newC = Math.max(1, Math.min(maxC, newC));
    if (hasSelection && hasSelection()) clearSelection();
    lastActiveCell = { row: newR, col: newC };
    focusCell(newR, newC);
  }

  gridEl.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'a') {
      if (_isEditingCell()) return;
      if (!gridData.length) return;
      e.preventDefault();
      setSelection(1, 1, gridData.length - 1, gridData[0].length - 1);
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (_isEditingCell()) return;
      if (!hasSelection || !hasSelection()) return;
      e.preventDefault();
      if (!currentCanEdit) return;
      if (typeof pushUndo === 'function') pushUndo();
      var r1 = Math.min(selection.r1, selection.r2);
      var r2 = Math.max(selection.r1, selection.r2);
      var c1 = Math.min(selection.c1, selection.c2);
      var c2 = Math.max(selection.c1, selection.c2);
      var tcol = findTimeColumn();
      var changed = false;
      for (var r = r1; r <= r2; r++) {
        for (var c = c1; c <= c2; c++) {
          if (c === tcol) continue;
          if (isOptionColumn && isOptionColumn(c)) continue;
          if (getCell(r, c) !== '') { setCell(r, c, ''); changed = true; }
        }
        if (changed && tcol > 0) touchRowTime(r);
      }
      if (changed) { renderGrid(); markDirty(); setSaveState('● 已清空选区'); }
      return;
    }

    var navKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'];
    if (navKeys.indexOf(e.key) < 0) return;

    var editingInCell = _isEditingCell();
    if (editingInCell && e.key !== 'Tab') return;
    if (!gridData.length) return;

    var base = _currentAnchor();
    var newR = base.r, newC = base.c;
    if (e.key === 'ArrowUp') newR--;
    else if (e.key === 'ArrowDown') newR++;
    else if (e.key === 'ArrowLeft') newC--;
    else if (e.key === 'ArrowRight') newC++;
    else if (e.key === 'Tab') {
      if (e.shiftKey) {
        newC--;
        if (newC < 1) { newC = gridData[0].length - 1; newR--; }
      } else {
        newC++;
        if (newC >= gridData[0].length) { newC = 1; newR++; }
      }
    }
    e.preventDefault();
    if (editingInCell) document.activeElement.blur();
    _navigate(newR, newC);
  });

  document.addEventListener('cut', function (e) {
    if (!hasSelection || !hasSelection()) return;
    var active = document.activeElement;
    if (active && active.classList && active.classList.contains('cell-text')) return;
    var tsv = buildTSVFromSelection();
    var html = buildHTMLFromSelection();
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', tsv);
      e.clipboardData.setData('text/html', html);
      e.preventDefault();
    }
    if (!currentCanEdit) return;
    if (typeof pushUndo === 'function') pushUndo();
    var r1 = Math.min(selection.r1, selection.r2);
    var r2 = Math.max(selection.r1, selection.r2);
    var c1 = Math.min(selection.c1, selection.c2);
    var c2 = Math.max(selection.c1, selection.c2);
    var tcol = findTimeColumn();
    for (var r = r1; r <= r2; r++) {
      for (var c = c1; c <= c2; c++) {
        if (c === tcol) continue;
        if (isOptionColumn && isOptionColumn(c)) continue;
        setCell(r, c, '');
      }
      if (tcol > 0) touchRowTime(r);
    }
    renderGrid();
    markDirty();
    setSaveState('● 已剪切选区');
  }, true);
})();

/* ============================================================
 * ★ 表格筛选 —— 筛选栏 / 筛选面板
 * ============================================================ */

/* 渲染顶部筛选标签栏 */
function renderFilterBar() {
  if (!filterBarEl || !filterChipsEl) return;
  var activeCols = getActiveFilterColIds();
  if (activeCols.length === 0) {
    filterBarEl.classList.add('hidden');
    filterChipsEl.innerHTML = '';
    return;
  }
  filterBarEl.classList.remove('hidden');
  filterChipsEl.innerHTML = '';

  if (filterCountEl) {
    var shown = countFilteredRows();
    var total = gridData.length - 1;
    filterCountEl.textContent = shown + ' / ' + total + ' 行';
  }

  activeCols.forEach(function (colId) {
    var colIdx = getColIdxById(colId);
    if (colIdx < 1) return;
    var vals = Object.keys(columnFilters[colId]);
    var colName = gridData[0][colIdx] || ('列' + colIdx);
    var labelText = vals.length > 3
      ? vals.slice(0, 3).join(', ') + '… (' + vals.length + ')'
      : vals.join(', ');
    var chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.innerHTML =
      '<span class="filter-chip-label">' +
      esc(colName) + '：' + esc(labelText) +
      '</span>' +
      '<button class="filter-chip-x" title="清除此筛选">×</button>';
    chip.querySelector('.filter-chip-x').addEventListener('click', function (e) {
      e.stopPropagation();
      clearColumnFilter(colId);
      renderGrid();
      if (window.renderShowcase) window.renderShowcase();
    });
    filterChipsEl.appendChild(chip);
  });
}

/* 全局点击：清除全部按钮 */
document.addEventListener('click', function (e) {
  if (e.target.closest('#btnClearFilters')) {
    clearAllColumnFilters();
    renderGrid();
    if (window.renderShowcase) window.renderShowcase();
  }
});

/* ---------- 筛选面板（浮动） ---------- */
var _filterPanelEl = null;
var _filterPanelColIdx = -1;
var _filterPanelColId = '';

function closeColumnFilterPanel() {
  if (_filterPanelEl && _filterPanelEl.parentNode) {
    _filterPanelEl.parentNode.removeChild(_filterPanelEl);
  }
  _filterPanelEl = null;
  _filterPanelColIdx = -1;
  _filterPanelColId = '';
}

function openColumnFilterPanel(colIdx, anchorEl) {
  closeColumnFilterPanel();
  var colId = getColumnIdAt(colIdx);
  if (!colId || colId === UUID_SENTINEL) return;
  _filterPanelColIdx = colIdx;
  _filterPanelColId = colId;

  var existing = columnFilters[colId] || null;
  var allValues = getUniqueColumnValues(colIdx, 300);

  // 检测是否有空值
  var hasEmpty = false;
  for (var r = 1; r < gridData.length; r++) {
    if ((getCell(r, colIdx) || '').trim() === '') { hasEmpty = true; break; }
  }

  var panel = document.createElement('div');
  panel.className = 'col-filter-panel';
  panel.innerHTML = [
    '<div class="cfp-title">筛选：<b>',
    esc(gridData[0][colIdx] || ('列' + colIdx)),
    '</b></div>',
    '<input type="text" class="cfp-search" placeholder="搜索值…" autocomplete="off">',
    '<div class="cfp-actions">',
    '  <a href="javascript:;" data-act="all">全选</a>',
    '  <a href="javascript:;" data-act="none">清空</a>',
    '</div>',
    '<ul class="cfp-list"></ul>',
    '<div class="cfp-footer">',
    '  <button class="cfp-cancel" type="button">取消</button>',
    '  <button class="cfp-apply" type="button">应用</button>',
    '</div>'
  ].join('');

  // 渲染值列表
  var list = panel.querySelector('.cfp-list');
  function _makeItem(val, displayText, checked) {
    var li = document.createElement('li');
    li.innerHTML =
      '<label>' +
      '<input type="checkbox" data-val="' + esc(val) + '"' +
      (checked ? ' checked' : '') + '>' +
      '<span>' + esc(displayText) + '</span>' +
      '</label>';
    return li;
  }
  if (hasEmpty) {
    var emptyChecked = existing ? !!existing[''] : true;
    list.appendChild(_makeItem('', '(空)', emptyChecked));
  }
  allValues.forEach(function (v) {
    var checked = existing ? !!existing[v] : true;
    list.appendChild(_makeItem(v, v, checked));
  });
  if (!hasEmpty && allValues.length === 0) {
    list.innerHTML = '<li class="cfp-empty">该列无数据</li>';
  }

  // 全选/清空
  panel.querySelector('[data-act="all"]').addEventListener('click', function () {
    panel.querySelectorAll('.cfp-list input[type="checkbox"]').forEach(function (cb) {
      cb.checked = true;
    });
  });
  panel.querySelector('[data-act="none"]').addEventListener('click', function () {
    panel.querySelectorAll('.cfp-list input[type="checkbox"]').forEach(function (cb) {
      cb.checked = false;
    });
  });

  // 搜索过滤
  var searchEl = panel.querySelector('.cfp-search');
  searchEl.addEventListener('input', function () {
    var q = searchEl.value.trim().toLowerCase();
    panel.querySelectorAll('.cfp-list li').forEach(function (li) {
      var cb = li.querySelector('input');
      if (!cb) return;
      var v = String(cb.dataset.val || '').toLowerCase();
      li.style.display = (q === '' || v.indexOf(q) >= 0) ? '' : 'none';
    });
  });

  // 取消/应用
  panel.querySelector('.cfp-cancel').addEventListener('click', closeColumnFilterPanel);
  panel.querySelector('.cfp-apply').addEventListener('click', function () {
    var newSet = {};
    var totalCbs = 0;
    panel.querySelectorAll('.cfp-list input[type="checkbox"]').forEach(function (cb) {
      totalCbs++;
      if (cb.checked) newSet[cb.dataset.val || ''] = true;
    });
    if (totalCbs > 0 && Object.keys(newSet).length === totalCbs) {
      // 全部勾选 = 等于不筛选
      clearColumnFilter(_filterPanelColId);
    } else {
      setColumnFilter(_filterPanelColId, newSet);
    }
    closeColumnFilterPanel();
    renderGrid();
    if (window.renderShowcase) window.renderShowcase();
  });

  // 定位：锚点下方，避开视口边界
  document.body.appendChild(panel);
  var rect = anchorEl.getBoundingClientRect();
  var pw = panel.offsetWidth;
  var ph = panel.offsetHeight;
  var left = rect.left;
  var top = rect.bottom + 4;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';

  _filterPanelEl = panel;

  // 点击面板外部关闭
  setTimeout(function () {
    function _onDocClick(ev) {
      if (!_filterPanelEl) {
        document.removeEventListener('mousedown', _onDocClick, true);
        return;
      }
      if (_filterPanelEl.contains(ev.target) ||
          ev.target.closest('.col-filter-btn')) return;
      closeColumnFilterPanel();
      document.removeEventListener('mousedown', _onDocClick, true);
    }
    document.addEventListener('mousedown', _onDocClick, true);
  }, 0);
}

/* ============================================================
 * ★ 图表点击 → 应用筛选
 * ============================================================ */
function applyChartFilter(catColId, label) {
  if (!catColId) return;
  if (label && label.indexOf('其他 (') === 0) {
    showActionToast('「其他」是合并项，无法筛选', 'error');
    return;
  }
  // 单条件筛选：只保留这一个
  clearAllColumnFilters();
  var set = {};
  set[String(label)] = true;
  setColumnFilter(catColId, set);

  renderGrid();
  if (window.renderShowcase) window.renderShowcase();

  var colIdx = getColIdxById(catColId);
  var colName = colIdx >= 1 ? (gridData[0][colIdx] || '') : '未知列';
  showActionToast('已筛选：' + colName + ' = ' + label, 'success');

  // 滚到表格顶部
  var scrollEl = gridEl.parentElement;
  if (scrollEl) scrollEl.scrollTop = 0;
}

window.applyChartFilter = applyChartFilter;