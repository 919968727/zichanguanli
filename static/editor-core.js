/* ============================================================
 * editor-core.js —— 状态 / 工具 / 数据访问 / API
 * 【内嵌方案】data[r][0] = uuid，data[0][0] = "__uuid__"
 * ★ 新增：Undo/Redo 快照管理
 * ★ 新增：表格筛选状态 + 工具函数
 * ============================================================ */

var TIME_COL_HEADER = '更新时间';
var CAT_VALUE_TABS = ['bar', 'line', 'area', 'pie', 'doughnut', 'radar'];
var CHART_TYPE_LABEL = {
  bar: '柱状图', line: '折线图', area: '面积图', pie: '饼图',
  doughnut: '环形图', radar: '雷达图', scatter: '散点图', loc: '位置格'
};
var DEFAULT_HEADER = ['列1', '列2', '列3'];
var CHART_PALETTE = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981',
                     '#06b6d4', '#f43f5e', '#84cc16', '#14b8a6', '#eab308', '#a855f7', '#ef4444'];
var UUID_SENTINEL = '__uuid__';

var currentId = null;
var currentLedger = null;
var currentCanEdit = false;
var currentCanManage = false;
var gridData = [];
var dirty = false;
var chartInstance = null;
var scatterChartInstance = null;
var chartTab = 'bar';
var locSvgString = null;
var locSvgSize = { w: 0, h: 0 };
var cachedLedgerList = [];
var expandedGroups = {};
var showcaseCollapsed = false;
var showcaseHeight = 320;
var showcaseChartInstances = {};
var selection = null;
var lastActiveCell = null;
var suppressNextClick = false;
// ★ 批量选中：按行 UUID 记录（行号会因删/插漂移，UUID 稳定）
var selectedRows = Object.create(null);
function getRowUuid(r) { return (gridData[r] && gridData[r][0]) || null; }
function isRowSelected(uuid) { return !!(uuid && selectedRows[uuid]); }
function setRowSelected(uuid, on) {
  if (!uuid) return;
  if (on) selectedRows[uuid] = true; else delete selectedRows[uuid];
  if (typeof updateSelectAllState === 'function') updateSelectAllState();
}
function clearSelectedRows() {
  selectedRows = Object.create(null);
  if (typeof updateSelectAllState === 'function') updateSelectAllState();
}
function selectedRowCount() { return Object.keys(selectedRows).length; }
// 返回当前 gridData 中被选中的行索引（升序），仅含仍存在的 UUID
function getSelectedRowIndexes() {
  var idx = [];
  for (var r = 1; r < gridData.length; r++) {
    var u = getRowUuid(r);
    if (u && selectedRows[u]) idx.push(r);
  }
  return idx;
}
var cellActionTarget = null;
var linkDialogTarget = null;
var gridFocusMode = false;
var myRole = null;             // 'owner' | 'manager' | 'member' | 'root' | null
var myPermissions = {};        // { 'data.view': 1, ... }
var permissionKeys = [];       // 后端返回的全集
var permissionLabels = {};     // 权限中文名
var roleLabels = {};           // 角色中文名
var presetPacks = {};          // 预设包

/* ============================================================
 * ★ 表格筛选状态
 * ------------------------------------------------------------
 * columnFilters = {
 *   '列UUID': { '值1': true, '值2': true, ... }
 * }
 *   - 空对象 / 键值为空 = 该列无筛选
 *   - 值用对象当 set（兼容老浏览器，不用 Set）
 * ============================================================ */
var columnFilters = {};

var $ = function (id) { return document.getElementById(id); };
var ledgerListEl = $('ledgerList');
var emptyTipEl = $('emptyTip');
var searchInputEl = $('searchInput');
var placeholderEl = $('placeholder');
var editorWrapEl = $('editorWrap');
var gridEl = $('grid');
var nameEl = $('ledgerName');
var saveStateEl = $('saveState');
var btnTeamEl = $('btnTeam');
var btnViewersEl = $('btnViewers');
var dividerTeamEl = $('dividerTeam');
var pendingBadgeEl = $('pendingBadge');
var readonlyBadgeEl = $('readonlyBadge');
var showcaseWrapEl = $('showcaseWrap');
var showcaseBodyEl = $('showcaseBody');
var showcaseCountEl = $('showcaseCount');
var showcaseToggleEl = $('showcaseToggle');
var showcaseDragHandleEl = $('showcaseDragHandle');
var filterBarEl = $('filterBar');
var filterChipsEl = $('filterChips');
var filterCountEl = $('filterCount');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function truncateStr(s, max) {
  s = String(s || '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
function cleanFileName(s) {
  return String(s || '位置图').replace(/[\\/:*?"<>|]/g, '_').trim() || '位置图';
}
function uuidHex() {
  var s = '';
  for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
function isValidUuid(u) {
  return typeof u === 'string' && u.length === 32 && /^[0-9a-f]+$/i.test(u);
}
function parseNum(v) {
  var n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}
function nowStr() {
  var d = new Date();
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
         ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function normalizeData(raw) {
  var arr = [];
  if (Array.isArray(raw)) {
    raw.forEach(function (row) {
      arr.push(Array.isArray(row) ? row.slice() : []);
    });
  }
  if (!arr.length) return [[UUID_SENTINEL, '列1', '列2']];
  var maxCols = 0;
  arr.forEach(function (r) { if (r.length > maxCols) maxCols = r.length; });
  var out = arr.map(function (r) {
    var row = [];
    for (var i = 0; i < maxCols; i++) row.push(r[i] == null ? '' : String(r[i]));
    return row;
  });
  if (!out[0] || out[0][0] !== UUID_SENTINEL) {
    for (var k = 0; k < out.length; k++) out[k].unshift('');
    out[0][0] = UUID_SENTINEL;
  }
  for (var i = 1; i < out.length; i++) {
    if (!isValidUuid(out[i][0])) out[i][0] = uuidHex();
  }
  return out;
}

function findTimeColumn() {
  if (!gridData.length) return -1;
  var lastIdx = gridData[0].length - 1;
  if (lastIdx < 1) return -1;
  var h = String(gridData[0][lastIdx] || '').trim();
  return h === TIME_COL_HEADER ? lastIdx : -1;
}
function isTimeColumn(colIdx) { return colIdx >= 1 && colIdx === findTimeColumn(); }

function ensureTimeColumn() {
  ensureTable();
  var lastIdx = gridData[0].length - 1;
  var h = String(gridData[0][lastIdx] || '').trim();
  if (h === TIME_COL_HEADER) return false;
  if (currentLedger) ensureColumnIds();
  gridData[0].push(TIME_COL_HEADER);
  for (var r = 1; r < gridData.length; r++) {
    if (gridData[r]) gridData[r].push('');
  }
  if (currentLedger) getColumnIds().push(uuidHex());
  return true;
}

function touchRowTime(rowIdx) {
  var tCol = findTimeColumn();
  if (tCol < 0) return;
  var row = gridData[rowIdx];
  if (!row) return;
  row[tCol] = nowStr();
  var cell = gridEl.querySelector('.time-cell-text[data-row="' + rowIdx + '"][data-col="' + tCol + '"]');
  if (cell) cell.textContent = row[tCol];
}

function colCount() { return gridData.length ? gridData[0].length - 1 : 0; }
function ensureTable() { if (!gridData.length) gridData = [[UUID_SENTINEL, '列1', '列2']]; }

function getCell(r, c) {
  var row = gridData[r];
  if (!row || c < 0 || c >= row.length) return '';
  return row[c];
}
function setCell(r, c, v) {
  var row = gridData[r];
  if (!row || c < 0 || c >= row.length) return;
  row[c] = v;
}

function getCellLinks() { return (currentLedger && currentLedger.cell_links) || {}; }
function getColumnIds() {
  if (!currentLedger) return [];
  if (!Array.isArray(currentLedger.column_ids)) currentLedger.column_ids = [];
  return currentLedger.column_ids;
}
function ensureColumnIds() {
  if (!currentLedger) return;
  var ids = getColumnIds();
  var n = gridData.length ? gridData[0].length : 0;
  while (ids.length < n) ids.push(uuidHex());
  while (ids.length > n) ids.pop();
  if (ids.length > 0) ids[0] = UUID_SENTINEL;
}
function getColumnIdAt(colIdx) {
  var ids = getColumnIds();
  while (ids.length <= colIdx) ids.push(uuidHex());
  return ids[colIdx];
}
function getColIdxById(colId) {
  if (!colId || colId === UUID_SENTINEL) return -1;
  return getColumnIds().indexOf(colId);
}

function getColumnOptions() {
  if (!currentLedger) return {};
  if (!currentLedger.column_options || typeof currentLedger.column_options !== 'object') {
    currentLedger.column_options = {};
  }
  return currentLedger.column_options;
}
function getColumnOptionsForIdx(colIdx) {
  if (colIdx < 1 || colIdx >= (gridData[0] ? gridData[0].length : 0)) return [];
  var colId = getColumnIdAt(colIdx);
  if (!colId || colId === UUID_SENTINEL) return [];
  var opts = getColumnOptions()[colId];
  if (!Array.isArray(opts) || opts.length === 0) return [];
  return opts;
}
function isOptionColumn(colIdx) { return getColumnOptionsForIdx(colIdx).length > 0; }
function getCharts() {
  if (!currentLedger) return [];
  if (!Array.isArray(currentLedger.charts)) currentLedger.charts = [];
  return currentLedger.charts;
}
function getCellActions() {
  if (!currentLedger) return {};
  if (!currentLedger.cell_actions || typeof currentLedger.cell_actions !== 'object') {
    currentLedger.cell_actions = {};
  }
  return currentLedger.cell_actions;
}
function getCellAction(row, colId) {
  if (!colId) return null;
  return getCellActions()[row + ':' + colId] || null;
}

async function api(url, options) {
  options = options || {};
  options.headers = Object.assign(
    { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
    options.headers || {}
  );
  var res = await fetch(url, options);
  if (res.status === 401) { window.location.href = '/'; throw new Error('未登录'); }
  var data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    var err = new Error(data.msg || ('请求失败：' + res.status));
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

async function putLedger(payload) {
  if (!currentLedger || !currentCanEdit) return { ok: false };
  payload = Object.assign({}, payload);
  payload.expected_updated_at = currentLedger.updated_at;
  var res;
  try {
    res = await fetch('/api/ledgers/' + currentId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    alert('网络错误：' + e.message);
    return { ok: false };
  }
  if (res.status === 401) { window.location.href = '/'; return { ok: false }; }
  var data = {};
  try { data = await res.json(); } catch (e) {}

  if (res.status === 429) {
    alert(data.msg || '该台账正在保存，请稍后再试');
    return { ok: false, busy: true };
  }

  if (res.status === 409) {
    var reload = confirm(
      '该台账已被他人修改。\n\n' +
      '点击「确定」加载最新版本（会丢弃你未保存的改动）；\n' +
      '点击「取消」保留你的改动并强制覆盖对方修改。'
    );
    if (reload) {
      await openLedger(currentId, { force: true });
      return { ok: false, reloaded: true };
    }
    try {
      var res2 = await fetch('/api/ledgers/' + currentId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify(Object.assign({}, payload, { expected_updated_at: null }))
      });
      if (!res2.ok) {
        var d2 = {}; try { d2 = await res2.json(); } catch (e) {}
        alert(d2.msg || '强制保存失败');
        return { ok: false };
      }
      var data2 = await res2.json();
      currentLedger = data2.ledger;
      return { ok: true, ledger: data2.ledger, forced: true };
    } catch (e2) {
      alert('网络错误：' + e2.message);
      return { ok: false };
    }
  }
  if (!res.ok) {
    alert(data.msg || ('保存失败：' + res.status));
    return { ok: false };
  }
  currentLedger = data.ledger;
  return { ok: true, ledger: data.ledger };
}

function markDirty() { if (!currentCanEdit) return; dirty = true; setSaveState('● 有未保存的修改'); }
function setSaveState(text) { saveStateEl.textContent = text || ''; }

function showActionToast(msg, type) {
  var toast = $('actionToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = 'action-toast show' + (type ? ' ' + type : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function () {
    toast.className = 'action-toast';
  }, 2600);
}

/* ============================================================
 * ★ Undo / Redo（快照机制）
 * ============================================================ */
var undoStack = [];
var redoStack = [];
var MAX_UNDO = 50;

function _deepCopy(obj) { return obj == null ? obj : JSON.parse(JSON.stringify(obj)); }

function takeSnapshot() {
  return {
    data: _deepCopy(gridData),
    column_ids: _deepCopy(currentLedger ? (currentLedger.column_ids || []) : []),
    cell_links: _deepCopy(currentLedger ? (currentLedger.cell_links || {}) : {}),
    cell_actions: _deepCopy(currentLedger ? (currentLedger.cell_actions || {}) : {}),
    column_options: _deepCopy(currentLedger ? (currentLedger.column_options || {}) : {})
  };
}

function pushUndo() {
  if (!currentCanEdit || !currentLedger) return;
  undoStack.push(takeSnapshot());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
}

function applySnapshot(snap) {
  if (!currentLedger) return;
  gridData = _deepCopy(snap.data);
  currentLedger.column_ids = _deepCopy(snap.column_ids);
  currentLedger.cell_links = _deepCopy(snap.cell_links);
  currentLedger.cell_actions = _deepCopy(snap.cell_actions);
  currentLedger.column_options = _deepCopy(snap.column_options);
  selection = null;
  lastActiveCell = null;
  renderGrid();
  if (typeof renderShowcase === 'function') renderShowcase();
  dirty = true;
  setSaveState('● 有未保存的修改');
}

function performUndo() {
  if (!currentCanEdit || !undoStack.length) {
    showActionToast('没有可撤销的操作', 'error');
    return;
  }
  redoStack.push(takeSnapshot());
  var snap = undoStack.pop();
  applySnapshot(snap);
  setSaveState('● 已撤销（Ctrl+Y 重做）');
}

function performRedo() {
  if (!currentCanEdit || !redoStack.length) {
    showActionToast('没有可重做的操作', 'error');
    return;
  }
  undoStack.push(takeSnapshot());
  var snap = redoStack.pop();
  applySnapshot(snap);
  setSaveState('● 已重做');
}

function clearUndoHistory() {
  undoStack = [];
  redoStack = [];
}

/* ============================================================
 * ★ 表格筛选工具
 * ============================================================ */

function hasActiveFilters() {
  for (var colId in columnFilters) {
    var vals = columnFilters[colId];
    if (vals && Object.keys(vals).length > 0) return true;
  }
  return false;
}

function getActiveFilterColIds() {
  var out = [];
  for (var colId in columnFilters) {
    var vals = columnFilters[colId];
    if (vals && Object.keys(vals).length > 0) out.push(colId);
  }
  return out;
}

function setColumnFilter(colId, valueSet) {
  if (!colId) return;
  var keys = Object.keys(valueSet || {});
  if (keys.length === 0) {
    delete columnFilters[colId];
  } else {
    columnFilters[colId] = valueSet;
  }
}

function clearColumnFilter(colId) {
  delete columnFilters[colId];
}

function clearAllColumnFilters() {
  columnFilters = {};
}

function rowMatchesFilters(rowIdx) {
  var activeCols = getActiveFilterColIds();
  if (activeCols.length === 0) return true;
  for (var i = 0; i < activeCols.length; i++) {
    var colId = activeCols[i];
    var colIdx = getColIdxById(colId);
    if (colIdx < 1) continue;
    var cellVal = (getCell(rowIdx, colIdx) || '').trim();
    if (!columnFilters[colId][cellVal]) return false;
  }
  return true;
}

function rowMatchesFiltersExcluding(rowIdx, excludeColId) {
  var activeCols = getActiveFilterColIds();
  if (activeCols.length === 0) return true;
  for (var i = 0; i < activeCols.length; i++) {
    var colId = activeCols[i];
    if (excludeColId && colId === excludeColId) continue;
    var colIdx = getColIdxById(colId);
    if (colIdx < 1) continue;
    var cellVal = (getCell(rowIdx, colIdx) || '').trim();
    if (!columnFilters[colId][cellVal]) return false;
  }
  return true;
}

function getUniqueColumnValues(colIdx, limit) {
  var out = [];
  var seen = {};
  if (!gridData || colIdx < 1) return out;
  for (var r = 1; r < gridData.length; r++) {
    var v = (getCell(r, colIdx) || '').trim();
    if (v === '') continue;
    if (seen[v]) continue;
    seen[v] = true;
    out.push(v);
    if (limit && out.length >= limit) break;
  }
  out.sort();
  return out;
}

function countFilteredRows() {
  if (!gridData || gridData.length <= 1) return 0;
  var total = gridData.length - 1;
  if (!hasActiveFilters()) return total;
  var n = 0;
  for (var r = 1; r < gridData.length; r++) {
    if (rowMatchesFilters(r)) n++;
  }
  return n;
}