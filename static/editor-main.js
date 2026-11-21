/* ============================================================
 * editor-main.js —— 事件绑定 + 启动
 * 必须在所有其它 editor-*.js 之后加载
 * ★ 新增 Excel 习惯快捷键：
 *   Ctrl+Z        撤销
 *   Ctrl+Y        重做
 *   Ctrl+Shift+Z  重做
 *   Ctrl+S        保存（原有）
 *   F2            进入编辑（原有，见 editor-grid.js）
 *   Ctrl+A        全选（见 editor-grid.js）
 *   Ctrl+X        剪切（见 editor-grid.js）
 *   Delete        清空选区（见 editor-grid.js）
 * ============================================================ */

/* ---------- 批量操作条（常驻显示） ---------- */
function updateBatchBar() {
  var bar = $('batchBar');
  if (!bar) return;
  var n = (typeof selectedRowCount === 'function') ? selectedRowCount() : 0;
  var cntEl = $('batchCount');
  if (cntEl) cntEl.textContent = n;
  // 无选中时禁用「开始 / 取消选择」，按钮始终可见
  var clearBtn = $('btnBatchClear');
  if (clearBtn) clearBtn.disabled = (n === 0);
  // 填充列下拉（排除哨兵列 / 更新时间列 / 选项列）
  var sel = $('batchColSel');
  if (sel && sel.dataset.ledger !== String(currentId)) {
    var prev = sel.value;
    sel.innerHTML = '';
    if (gridData.length) {
      var tcol = (typeof findTimeColumn === 'function') ? findTimeColumn() : -1;
      for (var c = 1; c < gridData[0].length; c++) {
        if (c === tcol) continue;
        if (typeof isOptionColumn === 'function' && isOptionColumn(c)) continue;
        var opt = document.createElement('option');
        opt.value = c;
        opt.textContent = gridData[0][c] || ('列' + c);
        sel.appendChild(opt);
      }
    }
    if (prev && sel.querySelector('option[value="' + prev + '"]')) sel.value = prev;
    sel.dataset.ledger = String(currentId);
  }
  syncBatchActionUI();
}

/* 根据所选操作切换「批量改值」输入区显示，并按权限启用/禁用「开始」按钮 */
function syncBatchActionUI() {
  var sel = $('batchAction');
  var start = $('btnBatchStart');
  var wrap = $('batchSetWrap');
  if (wrap && sel) wrap.classList.toggle('hidden', sel.value !== 'setvalue');
  if (!start || !sel) return;
  var n = (typeof selectedRowCount === 'function') ? selectedRowCount() : 0;
  // 打印二维码只需 data.view；删除/改值需要编辑权限
  var needEdit = (sel.value === 'delete' || sel.value === 'setvalue');
  if (n === 0) {
    start.disabled = true;
    start.title = '请先勾选要操作的数据行';
  } else if (needEdit && !currentCanEdit) {
    start.disabled = true;
    start.title = '只读用户不能修改数据';
  } else {
    start.disabled = false;
    start.title = '执行所选批量操作';
  }
}

if ($('btnBatchClear')) {
  $('btnBatchClear').addEventListener('click', function () { clearSelectedRows(); });
}
if ($('batchAction')) {
  $('batchAction').addEventListener('change', syncBatchActionUI);
}
if ($('btnBatchStart')) {
  $('btnBatchStart').addEventListener('click', function () {
    var sel = $('batchAction');
    var action = sel ? sel.value : 'print';
    if (action === 'delete') {
      batchDeleteRows();
    } else if (action === 'setvalue') {
      var colSel = $('batchColSel');
      var valEl = $('batchValue');
      if (!colSel || !colSel.value) { alert('请选择一个列'); return; }
      batchSetColumnValue(Number(colSel.value), valEl ? valEl.value : '');
    } else {
      // 打印二维码：editor-qr.js 稍后加载，通过全局延迟调用
      if (window.BatchPrint && typeof window.BatchPrint.open === 'function') {
        window.BatchPrint.open();
      } else {
        alert('二维码打印组件未加载，请刷新页面重试');
      }
    }
  });
}

/* ---------- 顶栏工具栏 ---------- */
$('btnNew').addEventListener('click', newLedger);
$('btnSave').addEventListener('click', saveLedger);
$('btnRefresh').addEventListener('click', refreshLedger);
$('btnLogout').addEventListener('click', logout);
$('btnAddRow').addEventListener('click', addRow);
$('btnAddCol').addEventListener('click', addCol);
$('btnDelRow').addEventListener('click', delRow);
$('btnDelCol').addEventListener('click', delCol);
$('btnChart').addEventListener('click', openChartDialog);
$('btnFocusChart').addEventListener('click', enterFocusChartMode);
$('showcaseExitFocus').addEventListener('click', exitFocusChartMode);

$('chartClose').addEventListener('click', closeChart);
$('chartModal').addEventListener('click', function (e) {
  if (e.target === $('chartModal')) closeChart();
});
$('btnExport').addEventListener('click', exportExcel);
$('btnImport').addEventListener('click', function () {
  if (currentId === null) { alert('请先打开或新建一本台账'); return; }
  if (!currentCanEdit) { alert('只读用户不能导入'); return; }
  var fi = $('fileInput'); fi.value = ''; fi.click();
});
$('fileInput').addEventListener('change', function (e) {
  var f = e.target.files && e.target.files[0];
  if (f) importExcel(f);
});
if (btnTeamEl) btnTeamEl.addEventListener('click', function () {
  if (typeof openMembersModal === 'function') openMembersModal();
});
if ($('btnMyPendingBadge')) {
  $('btnMyPendingBadge').addEventListener('click', function () {
    if (typeof openMembersModal === 'function') openMembersModal();
    // 自动切到待审批 tab
    setTimeout(function () {
      var tab = document.querySelector('.members-tab[data-tab="requests"]');
      if (tab) tab.click();
    }, 100);
  });
}
nameEl.addEventListener('input', markDirty);
searchInputEl.addEventListener('input', function () { renderList(cachedLedgerList); });

/* ---------- 图表弹窗事件 ---------- */
Array.prototype.forEach.call(document.querySelectorAll('.chart-tab'), function (t) {
  t.addEventListener('click', function () { switchChartTab(t.dataset.tab); });
});
$('chartCat').addEventListener('change', renderChart);
$('chartVal').addEventListener('change', renderChart);
$('chartAggregate').addEventListener('change', renderChart);
$('chartTopN').addEventListener('input', renderChart);
$('scatterX').addEventListener('change', renderScatterChart);
$('scatterY').addEventListener('change', renderScatterChart);
$('chartAddToShowcase').addEventListener('click', addChartFromModal);
$('locRender').addEventListener('click', renderLocationGrid);
$('locDlSvg').addEventListener('click', downloadLocSVG);
$('locDlPng').addEventListener('click', downloadLocPNG);
['locRows', 'locCols', 'locRowStart', 'locColStart', 'locSep'].forEach(function (id) {
  var el = $(id);
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') renderLocationGrid();
  });
});

/* ---------- 图表展示区折叠/拖拽 ---------- */
showcaseToggleEl.addEventListener('click', function () {
  showcaseCollapsed = !showcaseCollapsed;
  saveShowcasePrefs();
  applyShowcaseLayout();
  if (!showcaseCollapsed) {
    setTimeout(function () {
      Object.keys(showcaseChartInstances).forEach(function (k) {
        try { showcaseChartInstances[k].resize(); } catch (e) {}
      });
    }, 50);
  }
  applyFocusLayout();
});
setupShowcaseDrag();

/* ---------- 关联/选项列/交互弹窗 ---------- */
$('linkClose').addEventListener('click', function () { $('linkModal').classList.add('hidden'); });
$('linkCancel').addEventListener('click', function () { $('linkModal').classList.add('hidden'); });
$('linkSave').addEventListener('click', saveLink);
$('linkModal').addEventListener('click', function (e) {
  if (e.target === $('linkModal')) $('linkModal').classList.add('hidden');
});
$('optionEditorClose').addEventListener('click', function () { $('optionEditorModal').classList.add('hidden'); });
$('optionEditorCancel').addEventListener('click', function () { $('optionEditorModal').classList.add('hidden'); });
$('optionEditorSave').addEventListener('click', saveOptionEditor);
$('optionEditorModal').addEventListener('click', function (e) {
  if (e.target === $('optionEditorModal')) $('optionEditorModal').classList.add('hidden');
});
$('cellActionClose').addEventListener('click', function () { $('cellActionModal').classList.add('hidden'); cellActionTarget = null; });
$('cellActionCancel').addEventListener('click', function () { $('cellActionModal').classList.add('hidden'); cellActionTarget = null; });
$('cellActionSave').addEventListener('click', saveCellActionForm);
$('cellActionDeleteBtn').addEventListener('click', deleteCellAction);
$('cellActionModal').addEventListener('click', function (e) {
  if (e.target === $('cellActionModal')) { $('cellActionModal').classList.add('hidden'); cellActionTarget = null; }
});

/* ============================================================
 * ★ 全局快捷键（Excel 习惯）
 * ------------------------------------------------------------
 * 注意执行顺序：
 *   1) editor-grid.js 已对表格内部的单元格级快捷键做了处理
 *      （方向键、Tab、Delete、Ctrl+A、Ctrl+X、F2、Enter）
 *   2) editor-grid.js 会在 document 上用 capture:true 处理 copy/paste
 *   3) 这里只处理「整页级」的撤销/重做/保存，冲突少的 Ctrl 组合
 * ============================================================ */
document.addEventListener('keydown', function (e) {
  var key = String(e.key || '').toLowerCase();
  var mod = e.ctrlKey || e.metaKey;

  // Ctrl+S 保存
  if (mod && key === 's') {
    e.preventDefault();
    saveLedger();
    return;
  }

  // Ctrl+Z 撤销 / Ctrl+Shift+Z 重做
  if (mod && key === 'z') {
    // 若焦点在弹窗输入框里，让浏览器原生撤销生效（避免误伤）
    var ae = document.activeElement;
    if (ae && ae !== document.body && !(gridEl && gridEl.contains(ae))) {
      // 弹窗、侧边栏搜索框等非表格区域的文本编辑，交给浏览器
      var isTextInput = (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
                         ae.isContentEditable);
      if (isTextInput) return;
    }
    e.preventDefault();
    if (e.shiftKey) performRedo();
    else performUndo();
    return;
  }

  // Ctrl+Y 重做
  if (mod && key === 'y') {
    e.preventDefault();
    performRedo();
    return;
  }

  // Ctrl+B 加粗（Excel 习惯：给选中单元格包 ** **）——只在表格内生效
  if (mod && key === 'b') {
    var aeB = document.activeElement;
    if (aeB && gridEl && gridEl.contains(aeB)) {
      // 单元格内部已经在编辑时，让浏览器原生 contenteditable 处理
      return;
    }
    if (!hasSelection || !hasSelection()) return;
    if (!currentCanEdit) return;
    e.preventDefault();
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
        var v = getCell(r, c);
        if (v == null) v = '';
        v = String(v);
        if (/^\*\*.*\*\*$/.test(v)) {
          setCell(r, c, v.slice(2, -2));
        } else {
          setCell(r, c, '**' + v + '**');
        }
      }
      if (tcol > 0) touchRowTime(r);
    }
    renderGrid();
    markDirty();
    setSaveState('● 已切换加粗（** 标记）');
    return;
  }

  // Esc 关闭弹窗
  if (e.key === 'Escape') {
    if (!$('chartModal').classList.contains('hidden')) closeChart();
    if (!$('linkModal').classList.contains('hidden')) $('linkModal').classList.add('hidden');
    if (!$('optionEditorModal').classList.contains('hidden')) $('optionEditorModal').classList.add('hidden');
    if (!$('cellActionModal').classList.contains('hidden')) {
      $('cellActionModal').classList.add('hidden'); cellActionTarget = null;
    }
    hideCtxMenu();
    hideOptionMenu();
  }
});

document.addEventListener('click', function (e) {
  var menu = $('ctxMenu');
  if (menu && !menu.classList.contains('hidden') && !e.target.closest('#ctxMenu')) {
    hideCtxMenu();
  }
  var omenu = $('optionMenu');
  if (omenu && !omenu.classList.contains('hidden') && !e.target.closest('#optionMenu')) {
    hideOptionMenu();
  }
});
window.addEventListener('scroll', function () { hideCtxMenu(); hideOptionMenu(); }, true);
window.addEventListener('resize', function () {
  hideCtxMenu(); hideOptionMenu();
  Object.keys(showcaseChartInstances).forEach(function (k) {
    try { showcaseChartInstances[k].resize(); } catch (e) {}
  });
  if (typeof virtualState !== 'undefined' && virtualState.enabled
      && typeof updateVirtualRows === 'function') {
    updateVirtualRows();
  }
});
window.addEventListener('beforeunload', function (e) {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- 左侧台账栏：收起 / 展开 ---------- */
var SIDEBAR_KEY = 'ledgerSidebarCollapsed';
function applySidebarCollapsed(collapsed) {
  var layout = document.querySelector('.layout');
  if (!layout) return;
  layout.classList.toggle('sidebar-collapsed', collapsed);
  var rail = $('sidebarExpandRail');
  if (rail) rail.classList.toggle('hidden', !collapsed);
  var ph = $('placeholder');
  if (ph) {
    var p = ph.querySelector('p');
    if (p) p.textContent = collapsed
      ? '点击左侧边缘的 › 或顶栏菜单按钮展开台账列表，也可直接点击「新建台账」'
      : '请从左侧选择一个台账，或点击「新建台账」';
  }
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (e) {}
  // flex 宽度有过渡动画，动画结束后让图表/虚拟表格按新宽度重排
  setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 220);
}
function initSidebarCollapse() {
  var collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_KEY) === '1'; } catch (e) {}
  applySidebarCollapsed(collapsed);

  var toggle = $('btnSidebarToggle');
  var collapseBtn = $('btnSidebarCollapse');
  var rail = $('sidebarExpandRail');
  function doToggle() {
    var layout = document.querySelector('.layout');
    var now = layout ? layout.classList.contains('sidebar-collapsed') : false;
    applySidebarCollapsed(!now);
  }
  if (toggle) toggle.addEventListener('click', doToggle);
  if (collapseBtn) collapseBtn.addEventListener('click', doToggle);
  if (rail) rail.addEventListener('click', doToggle);
}

/* ---------- 侧栏功能菜单：台账列表分组展开 / 收起 ---------- */
var LEDGER_GROUP_KEY = 'ledgerMenuGroupCollapsed';
function applyLedgerGroupCollapsed(collapsed) {
  var group = $('groupLedgers');
  if (!group) return;
  group.classList.toggle('collapsed', collapsed);
  var btn = $('groupLedgersToggle');
  if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  try { localStorage.setItem(LEDGER_GROUP_KEY, collapsed ? '1' : '0'); } catch (e) {}
  setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 60);
}
function initLedgerMenuGroup() {
  var collapsed = false;
  try { collapsed = localStorage.getItem(LEDGER_GROUP_KEY) === '1'; } catch (e) {}
  applyLedgerGroupCollapsed(collapsed);
  var btn = $('groupLedgersToggle');
  if (btn) {
    btn.addEventListener('click', function () {
      var group = $('groupLedgers');
      var now = group ? group.classList.contains('collapsed') : false;
      applyLedgerGroupCollapsed(!now);
    });
  }
}

/* ---------- 启动 ---------- */
initSidebarCollapse();
initLedgerMenuGroup();
updateBatchBar();
loadShowcasePrefs();
try {
  if (localStorage.getItem('gridFocusMode') === '1') {
    gridFocusMode = true;
  }
} catch (e) {}
applyFocusLayout();
loadLedgers();
if (IS_ROOT) {
  refreshPendingBadge();
  setInterval(refreshPendingBadge, 15000);
}