/* ============================================================
 * editor-ledger.js —— 列表 / CRUD / 行操作 / 右键菜单 / 导入导出 / 保存
 * 【内嵌方案】data[r][0] 是 uuid，row_ids 字段已删除
 * ★ 与虚拟滚动配合：新增/插入/删除行后自动滚入视口
 * ★ 与 Undo/Redo 配合：所有改动入口在确认后 pushUndo()
 * ============================================================ */

async function loadLedgers(retry) {
  try {
    var data = await api('/api/ledgers?light=1');
    cachedLedgerList = data.ledgers || [];
    renderList(cachedLedgerList);
  } catch (e) {
    console.error('[loadLedgers 失败]', e);
    var box = document.getElementById('ledgerList');
    if (box) {
      box.innerHTML = '<li class="empty" style="color:#dc2626;">'
        + '加载台账失败：' + (e && e.message ? e.message : '未知错误')
        + (retry !== false ? '（500ms 后重试…）' : '（请刷新页面）')
        + '</li>';
    }
    if (retry !== false) setTimeout(function () { loadLedgers(false); }, 500);
  }
}

function buildEditorText(item) {
  var mates = Array.isArray(item.teammates) ? item.teammates : [];
  var views = Array.isArray(item.viewers) ? item.viewers : [];
  var s = '创建者：' + (item.owner || '');
  if (mates.length) s += '\n可编辑：' + mates.join('、');
  if (views.length) s += '\n只读：' + views.join('、');
  return s;
}

function buildSearchPattern(q) {
  q = String(q || '').trim();
  if (!q) return null;
  try {
    var escaped = q.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    var patternStr = escaped.indexOf('*') >= 0
      ? '^' + escaped.replace(/\*/g, '.*') + '$'
      : escaped;
    return new RegExp(patternStr, 'i');
  } catch (e) { return null; }
}

function renderList(list) {
  var pattern = buildSearchPattern(searchInputEl.value);
  ledgerListEl.innerHTML = '';
  if (!list.length) { emptyTipEl.classList.remove('hidden'); return; }
  emptyTipEl.classList.add('hidden');
  if (pattern) { renderSearchResults(list, pattern); return; }

  var ledgerById = {};
  list.forEach(function (L) { ledgerById[L.id] = L; });

  var linkedIds = {};
  list.forEach(function (L) {
    var cellLinks = L.cell_links || {};
    Object.keys(cellLinks).forEach(function (k) {
      var tid = cellLinks[k];
      if (tid && tid !== L.id) linkedIds[tid] = true;
    });
  });

  var groupsBySource = {};
  list.forEach(function (L) {
    var cellLinks = L.cell_links || {};
    var cols = L.columns || [];
    var colIds = L.column_ids || [];
    var byCol = {};
    Object.keys(cellLinks).forEach(function (key) {
      var parts = key.split(':');
      if (parts.length !== 2) return;
      var colId = parts[1];
      var childId = cellLinks[key];
      if (!childId || childId === L.id) return;
      if (!byCol[colId]) byCol[colId] = [];
      if (byCol[colId].indexOf(childId) === -1) byCol[colId].push(childId);
    });
    var arr = [];
    Object.keys(byCol).forEach(function (colId) {
      var ci = colIds.indexOf(colId);
      var cn = ci >= 1
        ? ((cols[ci - 1] || '').trim() || ('列' + ci))
        : ('列 ' + colId.slice(0, 6));
      arr.push({ colId: colId, colName: cn, children: byCol[colId] });
    });
    if (arr.length > 0) groupsBySource[L.id] = arr;
  });

  var renderedIds = {};
  var hiddenIds = {};
  function markHidden(id) {
    if (!id) return;
    if (renderedIds[id] || hiddenIds[id]) return;
    hiddenIds[id] = true;
    var groups = groupsBySource[id] || [];
    groups.forEach(function (grp) {
      grp.children.forEach(function (cid) { markHidden(cid); });
    });
  }

  function renderNode(ledger, indent) {
    if (!ledger || renderedIds[ledger.id]) return;
    renderedIds[ledger.id] = true;
    delete hiddenIds[ledger.id];

    var li = document.createElement('li');
    li.className = 'ledger-item' + (ledger.id === currentId ? ' active' : '');
    li.dataset.id = ledger.id;
    if (indent) li.style.marginLeft = indent + 'px';

    var arrowPh = document.createElement('span');
    arrowPh.className = 'ledger-arrow-placeholder';
    li.appendChild(arrowPh);

    var nameSpan = document.createElement('span');
    nameSpan.className = 'ledger-item-name';
    nameSpan.textContent = ledger.name;
    nameSpan.title = ledger.name +
      '\n创建：' + (ledger.created_at || '') +
      '\n更新：' + (ledger.updated_at || '') +
      '\n' + buildEditorText(ledger);
    nameSpan.addEventListener('click', function () { openLedger(ledger.id); });
    li.appendChild(nameSpan);

    if (ledger.owner === CURRENT_USER || IS_ROOT) {
      var delSpan = document.createElement('span');
      delSpan.className = 'ledger-item-del';
      delSpan.textContent = '×';
      delSpan.title = '删除台账';
      delSpan.addEventListener('click', function (ev) {
        ev.stopPropagation(); removeLedger(ledger.id, ledger.name);
      });
      li.appendChild(delSpan);
    }
    ledgerListEl.appendChild(li);

    var groups = groupsBySource[ledger.id] || [];
    groups.forEach(function (grp) {
      var groupKey = ledger.id + ':' + grp.colId;
      var isExpanded = !!expandedGroups[groupKey];

      var gLi = document.createElement('li');
      gLi.className = 'ledger-group-header';
      gLi.dataset.key = groupKey;
      gLi.style.marginLeft = (indent + 16) + 'px';
      gLi.title = '表头「' + grp.colName + '」下关联了 ' + grp.children.length +
                  ' 个台账，点击' + (isExpanded ? '收起' : '展开');
      var arrow = document.createElement('span');
      arrow.className = 'ledger-arrow';
      arrow.textContent = isExpanded ? '▾' : '▸';
      var titleSpan = document.createElement('span');
      titleSpan.className = 'ledger-item-name';
      titleSpan.textContent = grp.colName;
      gLi.appendChild(arrow);
      gLi.appendChild(titleSpan);
      gLi.addEventListener('click', function (ev) {
        ev.stopPropagation();
        expandedGroups[groupKey] = !expandedGroups[groupKey];
        renderList(cachedLedgerList);
      });
      ledgerListEl.appendChild(gLi);

      if (isExpanded) {
        grp.children.forEach(function (cid) {
          var child = ledgerById[cid];
          if (child) renderNode(child, indent + 32);
        });
      } else {
        grp.children.forEach(function (cid) { markHidden(cid); });
      }
    });
  }

  list.forEach(function (L) { if (!linkedIds[L.id]) renderNode(L, 0); });
  list.forEach(function (L) { if (!renderedIds[L.id] && !hiddenIds[L.id]) renderNode(L, 0); });
}

function renderSearchResults(list, pattern) {
  var matched = [];
  list.forEach(function (L) { if (pattern.test(L.name)) matched.push(L); });
  if (!matched.length) {
    var li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '没有匹配的台账';
    ledgerListEl.appendChild(li);
    return;
  }
  matched.forEach(function (L) {
    var li = document.createElement('li');
    li.className = 'ledger-item' + (L.id === currentId ? ' active' : '');
    li.dataset.id = L.id;
    var arrowPh = document.createElement('span');
    arrowPh.className = 'ledger-arrow-placeholder';
    li.appendChild(arrowPh);
    var nameSpan = document.createElement('span');
    nameSpan.className = 'ledger-item-name';
    nameSpan.textContent = L.name;
    nameSpan.title = '打开「' + L.name + '」\n' + buildEditorText(L);
    nameSpan.addEventListener('click', function () { openLedger(L.id); });
    li.appendChild(nameSpan);
    if (L.owner === CURRENT_USER || IS_ROOT) {
      var delSpan = document.createElement('span');
      delSpan.className = 'ledger-item-del';
      delSpan.textContent = '×';
      delSpan.title = '删除台账';
      delSpan.addEventListener('click', function (ev) {
        ev.stopPropagation(); removeLedger(L.id, L.name);
      });
      li.appendChild(delSpan);
    }
    ledgerListEl.appendChild(li);
  });
}

function highlightActive() {
  Array.prototype.forEach.call(ledgerListEl.querySelectorAll('.ledger-item'), function (li) {
    li.classList.toggle('active', Number(li.dataset.id) === currentId);
  });
}

function setManageVisible(visible) {
  if (btnTeamEl) btnTeamEl.classList.toggle('hidden', !visible);
  if (dividerTeamEl) dividerTeamEl.classList.toggle('hidden', !visible);
}

function applyEditPermission() {
  var canEdit = currentCanEdit;                                    // data.edit
  var canDelete = !!myPermissions['data.delete'];                  // data.delete
  var canManage = !!myPermissions['member.manage'] || IS_ROOT;     // 重命名
  ['btnAddRow', 'btnAddCol', 'btnSave', 'btnImport'].forEach(function (id) {
    var el = $(id);
    if (el) el.disabled = !canEdit;
  });
  ['btnDelRow', 'btnDelCol'].forEach(function (id) {
    var el = $(id);
    if (el) el.disabled = !canDelete;
  });
  nameEl.disabled = !canManage;
  readonlyBadgeEl.classList.toggle('hidden', canEdit);
}

async function openLedger(id, opts) {
  opts = opts || {};
  if (!opts.force && dirty && !confirm('当前台账有未保存的修改，确定要切换吗？')) return;
  try {
    var data = await api('/api/ledgers/' + id);
    var ledger = data.ledger;
    currentId = ledger.id;
    currentLedger = ledger;
    currentCanEdit = !!ledger.can_edit;
    currentCanManage = !!ledger.can_manage;
    myRole = ledger.role || null;
    myPermissions = ledger.permissions || {};
    if (myRole === 'owner' || IS_ROOT) currentCanManage = true;
    nameEl.value = ledger.name;
    gridData = normalizeData(ledger.data);
    ensureColumnIds();
    dirty = false;
    selection = null;
    lastActiveCell = null;
    clearSelectedRows(); // ★ 切换台账 → 清空批量勾选
    // ★ 切换台账 → 清空撤销/重做栈
    if (typeof clearUndoHistory === 'function') clearUndoHistory();
    // ★ 切换台账 → 清空筛选
    if (typeof clearAllColumnFilters === 'function') clearAllColumnFilters();
    var addedTimeCol = false;
    if (currentCanEdit) addedTimeCol = ensureTimeColumn();
    placeholderEl.classList.add('hidden');
    editorWrapEl.classList.remove('hidden');
    applyEditPermission();
    // 成员与权限入口对所有台账成员可见（面板内按角色区分内容）
    setManageVisible(!!myPermissions['data.view']);
    if (gridEl.parentElement) gridEl.parentElement.scrollTop = 0;
    renderGrid();
    if (window.scrollToRowIfEnabled) window.scrollToRowIfEnabled(1);
    renderShowcase();
    highlightActive();
    setSaveState('');
    if (addedTimeCol) {
      try {
        await putLedger({ data: gridData, column_ids: getColumnIds(), cell_links: getCellLinks() });
        loadLedgers();
      } catch (e) {}
    }
    if (window.FileManager && typeof window.FileManager.open === 'function') {
      try {
        var p = window.FileManager.open(id);
        if (p && typeof p.catch === 'function') {
          p.catch(function (err) {
            console.warn('[FileManager.open] 附件模块加载失败：', err);
          });
        }
      } catch (e) {
        console.warn('[FileManager.open] 同步异常：', e);
      }
    }
  } catch (e) {}
}

async function refreshLedger() {
  if (currentId === null) { alert('请先打开或新建一本台账'); return; }
  if (dirty && !confirm('当前台账有未保存的修改，刷新将丢失这些修改，确定要刷新吗？')) return;

  // 先探一次，避免 openLedger 静默吞掉「已删除/权限变更」的失败
  try {
    var probe = await api('/api/ledgers/' + currentId);
    if (!probe || !probe.ledger) throw new Error('empty');
  } catch (e) {
    alert('刷新失败：无法获取该台账（可能已被删除或权限变更），已重新加载台账列表');
    loadLedgers();
    return;
  }

  var scrollEl = gridEl.parentElement;
  var st = scrollEl ? scrollEl.scrollTop : 0;
  await openLedger(currentId, { force: true });
  if (scrollEl && typeof scrollEl.scrollTop === 'number') scrollEl.scrollTop = st;
  loadLedgers();
  setSaveState('✓ 台账已刷新');
}

async function newLedger() {
  var name = prompt('请输入台账名称：', '未命名台账');
  if (name === null) return;
  name = name.trim() || '未命名台账';
  try {
    var data = await api('/api/ledgers', { method: 'POST', body: JSON.stringify({ name: name }) });
    await loadLedgers();
    await openLedger(data.ledger.id, { force: true });
  } catch (e) {}
}

async function removeLedger(id, name) {
  if (!confirm('确定删除台账「' + name + '」吗？\n\n' +
      '删除后台账数据将被移除，已删除的行快照仍保留在回收站可查询。\n' +
      '该台账已经贴出的唯一标识将失效。')) return;
  try {
    await api('/api/ledgers/' + id, { method: 'DELETE' });
    Object.keys(expandedGroups).forEach(function (k) {
      if (k.indexOf(id + ':') === 0) delete expandedGroups[k];
    });
    if (currentId === id) {
      currentId = null; currentLedger = null; currentCanEdit = false; currentCanManage = false;
      dirty = false; gridData = []; selection = null; lastActiveCell = null;
      if (typeof clearUndoHistory === 'function') clearUndoHistory();
      editorWrapEl.classList.add('hidden');
      placeholderEl.classList.remove('hidden');
      setManageVisible(false);
      destroyShowcaseCharts();
      showcaseWrapEl.classList.add('hidden');
      if (window.FileManager && typeof window.FileManager.close === 'function') {
        try { window.FileManager.close(); } catch (e) {}
      }
    }
    loadLedgers();
  } catch (e) {}
}

function editTeammates() { if (typeof openMembersModal === 'function') openMembersModal(); }
function editViewers()   { if (typeof openMembersModal === 'function') openMembersModal(); }

function hideCtxMenu() {
  var el = $('ctxMenu');
  if (el) el.classList.add('hidden');
}
function showCtxMenu(x, y, items) {
  var el = $('ctxMenu');
  if (!el) return;
  el.innerHTML = '';
  items.forEach(function (item) {
    if (item.type === 'divider') {
      var d = document.createElement('div');
      d.className = 'ctx-menu-divider'; el.appendChild(d); return;
    }
    if (item.type === 'header') {
      var h = document.createElement('div');
      h.className = 'ctx-menu-header'; h.textContent = item.label; el.appendChild(h); return;
    }
    var mi = document.createElement('div');
    mi.className = 'ctx-menu-item' +
                   (item.danger ? ' danger' : '') +
                   (item.disabled ? ' disabled' : '');
    mi.textContent = item.label;
    if (!item.disabled && item.onClick) {
      mi.addEventListener('click', function (e) {
        e.stopPropagation(); hideCtxMenu(); item.onClick();
      });
    }
    el.appendChild(mi);
  });
  el.classList.add('hidden');
  el.style.left = '0px'; el.style.top = '0px';
  el.classList.remove('hidden');
  var rect = el.getBoundingClientRect();
  var vw = window.innerWidth; var vh = window.innerHeight;
  if (x + rect.width > vw - 8) x = vw - rect.width - 8;
  if (y + rect.height > vh - 8) y = vh - rect.height - 8;
  if (x < 8) x = 8;
  if (y < 8) y = 8;
  el.style.left = x + 'px'; el.style.top = y + 'px';
}

function remapCellLinksRowInsert(cellLinks, insertAt) {
  var out = {};
  Object.keys(cellLinks).forEach(function (k) {
    var parts = String(k).split(':');
    var ri = Number(parts[0]);
    if (isNaN(ri) || parts.length !== 2) return;
    if (ri >= insertAt) out[(ri + 1) + ':' + parts[1]] = cellLinks[k];
    else out[k] = cellLinks[k];
  });
  return out;
}
function remapCellLinksRowDelete(cellLinks, deleteAt) {
  var out = {};
  Object.keys(cellLinks).forEach(function (k) {
    var parts = String(k).split(':');
    var ri = Number(parts[0]);
    if (isNaN(ri) || parts.length !== 2) return;
    if (ri === deleteAt) return;
    if (ri > deleteAt) out[(ri - 1) + ':' + parts[1]] = cellLinks[k];
    else out[k] = cellLinks[k];
  });
  return out;
}
function remapCellActionsRowInsert(actions, insertAt) {
  var out = {};
  Object.keys(actions).forEach(function (k) {
    var parts = String(k).split(':');
    var ri = Number(parts[0]);
    if (isNaN(ri) || parts.length !== 2) return;
    if (ri >= insertAt) out[(ri + 1) + ':' + parts[1]] = actions[k];
    else out[k] = actions[k];
  });
  return out;
}
function remapCellActionsRowDelete(actions, deleteAt) {
  var out = {};
  Object.keys(actions).forEach(function (k) {
    var parts = String(k).split(':');
    var ri = Number(parts[0]);
    if (isNaN(ri) || parts.length !== 2) return;
    if (ri === deleteAt) return;
    if (ri > deleteAt) out[(ri - 1) + ':' + parts[1]] = actions[k];
    else out[k] = actions[k];
  });
  return out;
}
function cleanupCellActionsByColId(actions, colId) {
  var out = {};
  Object.keys(actions).forEach(function (k) {
    var parts = String(k).split(':');
    if (parts.length !== 2) return;
    if (parts[1] === colId) return;
    var def = actions[k];
    if (def && Array.isArray(def.fields)) {
      def = { name: def.name, fields: def.fields.filter(function (f) { return f !== colId; }) };
    }
    out[k] = def;
  });
  return out;
}

/* ---------- 行操作 ---------- */
async function insertRowAt(pos) {
  if (!currentCanEdit) return;
  if (pos < 1) pos = 1;
  if (pos > gridData.length) pos = gridData.length;
  // ★ 拍快照
  if (typeof pushUndo === 'function') pushUndo();
  var cols = colCount();
  var newRow = [uuidHex()];
  for (var i = 0; i < cols; i++) newRow.push('');
  gridData.splice(pos, 0, newRow);
  currentLedger.cell_links = remapCellLinksRowInsert(getCellLinks(), pos);
  currentLedger.cell_actions = remapCellActionsRowInsert(getCellActions(), pos);
  selection = null; lastActiveCell = null;
  renderGrid();
  if (window.scrollToRowIfEnabled) window.scrollToRowIfEnabled(pos);
  markDirty();
  try {
    var r = await putLedger({
      data: gridData,
      cell_links: currentLedger.cell_links,
      cell_actions: currentLedger.cell_actions
    });
    if (r.ok) {
      dirty = false;
      setSaveState('● 已插入第 ' + pos + ' 行（已保存）');
      loadLedgers();
    }
  } catch (e) {}
}

async function deleteRowAt(pos) {
  if (!currentCanEdit) {
    alert('只读用户不能删除行');
    return;
  }
  if (pos < 1 || pos >= gridData.length) return;
  if (gridData.length <= 1) {
    alert('已经没有数据行了');
    return;
  }

  var onlyOneDataRow = (gridData.length === 2);
  var rowObj = gridData[pos];
  var rowGid = (rowObj && rowObj[0]) ? 'L' + currentId + '_' + rowObj[0] : '(无 ID)';

  var tip = '确定删除第 ' + pos + ' 行吗？\n\n' +
            '该行唯一标识：\n  ' + rowGid + '\n\n' +
            '删除后该行数据会封存到回收站，唯一标识依然可扫描到"已封存"状态，管理员可恢复。';
  if (onlyOneDataRow) {
    tip += '\n\n⚠ 这是最后一行数据，删除后台账将只保留表头。';
  }
  if (!confirm(tip)) return;

  // ★ 用户确认后才拍快照
  if (typeof pushUndo === 'function') pushUndo();

  gridData.splice(pos, 1);
  currentLedger.cell_links = remapCellLinksRowDelete(getCellLinks(), pos);
  currentLedger.cell_actions = remapCellActionsRowDelete(getCellActions(), pos);
  selection = null; lastActiveCell = null;
  renderGrid(); renderShowcase();
  if (window.scrollToRowIfEnabled) {
    window.scrollToRowIfEnabled(Math.min(pos, gridData.length - 1));
  }
  markDirty();
  try {
    var r = await putLedger({
      data: gridData,
      cell_links: currentLedger.cell_links,
      cell_actions: currentLedger.cell_actions
    });
    if (r.ok) {
      dirty = false;
      var extra = r.ledger && r.ledger.archived_count
        ? '；已封存 ' + r.ledger.archived_count + ' 行'
        : '';
      setSaveState('● 已删除第 ' + pos + ' 行（已保存' + extra + '）');
      loadLedgers();
    }
  } catch (e) {}
}

function addRow() {
  if (!currentCanEdit) return;
  ensureTable();
  if (typeof pushUndo === 'function') pushUndo();
  var cols = colCount();
  var newRow = [uuidHex()];
  for (var i = 0; i < cols; i++) newRow.push('');
  gridData.push(newRow);
  renderGrid();
  if (window.scrollToRowIfEnabled) window.scrollToRowIfEnabled(gridData.length - 1);
  markDirty();
}

function delRow() {
  if (!currentCanEdit) {
    alert('只读用户不能删除行');
    return;
  }
  if (gridData.length <= 1) {
    alert('已经没有数据行了');
    return;
  }

  var lastRow = gridData.length - 1;
  var rowObj = gridData[lastRow];
  var rowGid = (rowObj && rowObj[0]) ? 'L' + currentId + '_' + rowObj[0] : '(无 ID)';

  var tip = '确定删除最后一行吗？\n\n' +
            '该行唯一标识：\n  ' + rowGid + '\n\n' +
            '删除后该行数据会封存到回收站，管理员可恢复。';
  if (gridData.length === 2) {
    tip += '\n\n⚠ 这是最后一行数据，删除后台账将只保留表头。';
  }
  if (!confirm(tip)) return;

  if (typeof pushUndo === 'function') pushUndo();

  gridData.pop();
  var cellLinks = Object.assign({}, getCellLinks());
  var changedLinks = false;
  Object.keys(cellLinks).forEach(function (k) {
    if (k.split(':')[0] === String(lastRow)) {
      delete cellLinks[k]; changedLinks = true;
    }
  });
  currentLedger.cell_links = cellLinks;
  var actions = Object.assign({}, getCellActions());
  var changedActions = false;
  Object.keys(actions).forEach(function (k) {
    if (k.split(':')[0] === String(lastRow)) {
      delete actions[k]; changedActions = true;
    }
  });
  currentLedger.cell_actions = actions;
  renderGrid(); renderShowcase();
  if (window.scrollToRowIfEnabled) {
    window.scrollToRowIfEnabled(Math.min(lastRow - 1, gridData.length - 1));
  }
  putLedger({
    data: gridData,
    cell_links: cellLinks, cell_actions: actions
  }).then(function (r) {
    if (r.ok) {
      dirty = false;
      var extra = r.ledger && r.ledger.archived_count
        ? '，已封存 ' + r.ledger.archived_count + ' 行'
        : '';
      setSaveState('● 已删除最后一行' + extra);
      loadLedgers();
    }
  });
}

/* ---------- 批量操作（复选框选中行） ---------- */
// 批量修改：把选中行的某一列统一设为新值
async function batchSetColumnValue(colIdx, value) {
  if (!currentCanEdit) { alert('只读用户不能修改数据'); return; }
  var indexes = getSelectedRowIndexes();
  if (!indexes.length) { alert('请先勾选要修改的行'); return; }
  if (isNaN(colIdx) || colIdx < 1 || colIdx >= (gridData[0] ? gridData[0].length : 0)) {
    alert('请选择要修改的列'); return;
  }
  if (colIdx === findTimeColumn()) { alert('更新时间列由系统自动维护，不能批量修改'); return; }
  if (typeof isOptionColumn === 'function' && isOptionColumn(colIdx)) {
    alert('选项列请逐行选择，不支持批量修改'); return;
  }

  var tip = '确定把选中的 ' + indexes.length + ' 行的「' +
            (gridData[0][colIdx] || ('列' + colIdx)) + '」列统一改为：\n\n  ' +
            (value === '' ? '（空）' : value) + '\n\n此操作可撤销。';
  if (!confirm(tip)) return;

  if (typeof pushUndo === 'function') pushUndo();
  indexes.forEach(function (r) { setCell(r, colIdx, value); touchRowTime(r); });
  var keepSelected = indexes.map(function (r) { return getRowUuid(r); });
  renderGrid(); markDirty();
  setSaveState('● 已批量修改 ' + indexes.length + ' 行');

  try {
    var res = await putLedger({ data: gridData });
    if (res.ok) {
      dirty = false;
      keepSelected.forEach(function (u) { setRowSelected(u, true); });
      renderGrid();
      setSaveState('● 已批量修改 ' + indexes.length + ' 行（已保存）');
      loadLedgers();
    }
  } catch (e) {}
}

// 批量删除：删除所有勾选的行，自动重映射关联并归档
async function batchDeleteRows() {
  if (!currentCanEdit) { alert('只读用户不能删除行'); return; }
  var indexes = getSelectedRowIndexes();
  if (!indexes.length) { alert('请先勾选要删除的行'); return; }

  var gidSample = (function () {
    var u = getRowUuid(indexes[0]);
    return u ? 'L' + currentId + '_' + u : '(无 ID)';
  })();
  var tip = '确定删除选中的 ' + indexes.length + ' 行吗？\n\n' +
            '例如首行唯一标识：\n  ' + gidSample + '\n\n' +
            '删除后这些行会封存到回收站，唯一标识依然可扫描到"已封存"状态，管理员可恢复。';
  if (!confirm(tip)) return;

  if (typeof pushUndo === 'function') pushUndo();

  // 按行号降序删除，避免 splice 造成索引漂移
  var desc = indexes.slice().sort(function (a, b) { return b - a; });
  var links = getCellLinks();
  var actions = getCellActions();
  desc.forEach(function (pos) {
    gridData.splice(pos, 1);
    links = remapCellLinksRowDelete(links, pos);
    actions = remapCellActionsRowDelete(actions, pos);
  });
  currentLedger.cell_links = links;
  currentLedger.cell_actions = actions;
  clearSelectedRows();
  selection = null; lastActiveCell = null;
  renderGrid();
  if (typeof renderShowcase === 'function') renderShowcase();
  markDirty();

  try {
    var r = await putLedger({
      data: gridData,
      cell_links: links,
      cell_actions: actions
    });
    if (r.ok) {
      dirty = false;
      var extra = r.ledger && r.ledger.archived_count
        ? '；已封存 ' + r.ledger.archived_count + ' 行'
        : '';
      setSaveState('● 已批量删除 ' + desc.length + ' 行（已保存' + extra + '）');
      loadLedgers();
    }
  } catch (e) {}
}

/* ---------- 列操作 ---------- */
async function insertColAt(pos) {
  if (!currentCanEdit) return;
  ensureTable(); ensureColumnIds();
  var timeColIdx = findTimeColumn();
  if (pos < 1) pos = 1;
  var totalCols = gridData[0].length;
  if (pos > totalCols) pos = totalCols;
  if (timeColIdx >= 0 && pos > timeColIdx) {
    alert('更新时间列必须在最后一列，不能在其后插入新列');
    return;
  }
  // ★ 拍快照
  if (typeof pushUndo === 'function') pushUndo();
  var newIdx = totalCols;
  gridData[0].splice(pos, 0, '列' + newIdx);
  for (var r = 1; r < gridData.length; r++) {
    if (gridData[r]) gridData[r].splice(pos, 0, '');
  }
  getColumnIds().splice(pos, 0, uuidHex());
  selection = null; lastActiveCell = null;
  renderGrid(); markDirty();
  try {
    var r2 = await putLedger({ data: gridData, column_ids: getColumnIds() });
    if (r2.ok) {
      dirty = false;
      setSaveState('● 已插入第 ' + (pos) + ' 列（已保存）');
      loadLedgers();
    }
  } catch (e) {}
}

async function deleteColAt(pos) {
  if (!currentCanEdit) return;
  if (pos < 1 || pos >= (gridData[0] ? gridData[0].length : 0)) return;
  var timeColIdx = findTimeColumn();
  if (pos === timeColIdx) { alert('更新时间列不可删除'); return; }
  var dataCols = colCount() - (timeColIdx >= 0 ? 1 : 0);
  if (dataCols <= 1) { alert('至少保留一列数据列'); return; }

  // ★ 拍快照（无二次确认，直接在删除前 push）
  if (typeof pushUndo === 'function') pushUndo();

  var colIds = getColumnIds();
  var targetColId = colIds[pos];
  gridData[0].splice(pos, 1);
  for (var r = 1; r < gridData.length; r++) {
    if (gridData[r]) gridData[r].splice(pos, 1);
  }
  if (targetColId) {
    var idx = colIds.indexOf(targetColId);
    if (idx >= 0) colIds.splice(idx, 1);
  }
  var cellLinks = Object.assign({}, getCellLinks());
  if (targetColId) {
    Object.keys(cellLinks).forEach(function (k) {
      if (String(k).split(':')[1] === targetColId) delete cellLinks[k];
    });
  }
  currentLedger.cell_links = cellLinks;
  var opts = getColumnOptions();
  if (targetColId && opts[targetColId]) delete opts[targetColId];
  var actions = cleanupCellActionsByColId(getCellActions(), targetColId);
  var charts = getCharts().filter(function (ch) {
    var c = ch.config || {};
    if (c.catColId === targetColId) return false;
    if (c.valColId === targetColId) return false;
    if (c.xColId === targetColId) return false;
    if (c.yColId === targetColId) return false;
    if (c.locColId === targetColId) return false;
    if (c.locLabelColId === targetColId) return false;
    return true;
  });
  selection = null; lastActiveCell = null;
  renderGrid(); renderShowcase(); markDirty();
  try {
    var r2 = await putLedger({
      data: gridData, column_ids: colIds,
      cell_links: cellLinks, column_options: opts,
      charts: charts, cell_actions: actions
    });
    if (r2.ok) {
      dirty = false;
      setSaveState('● 已删除第 ' + (pos) + ' 列（已保存）');
      loadLedgers();
    }
  } catch (e) {}
}

function addCol() {
  if (!currentCanEdit) return;
  ensureTable(); ensureColumnIds();
  if (typeof pushUndo === 'function') pushUndo();
  var timeColIdx = findTimeColumn();
  var newIdx = gridData[0].length;
  if (timeColIdx >= 0) {
    gridData[0].splice(timeColIdx, 0, '列' + newIdx);
    for (var r = 1; r < gridData.length; r++) {
      if (gridData[r]) gridData[r].splice(timeColIdx, 0, '');
    }
    getColumnIds().splice(timeColIdx, 0, uuidHex());
  } else {
    gridData[0].push('列' + newIdx);
    for (var r = 1; r < gridData.length; r++) {
      if (gridData[r]) gridData[r].push('');
    }
    getColumnIds().push(uuidHex());
  }
  renderGrid(); markDirty();
}

function delCol() {
  if (!currentCanEdit) return;
  if (!colCount()) return;
  var timeColIdx = findTimeColumn();
  var targetCol = gridData[0].length - 1;
  if (timeColIdx >= 0) {
    if (gridData[0].length <= 2) { alert('至少保留一列数据列'); return; }
    targetCol = timeColIdx - 1;
  }
  if (targetCol < 1) return;
  if (!confirm('确定删除最后一列数据列吗？')) return;

  if (typeof pushUndo === 'function') pushUndo();

  var colIds = getColumnIds();
  var targetColId = colIds[targetCol];
  gridData[0].splice(targetCol, 1);
  for (var r = 1; r < gridData.length; r++) {
    if (gridData[r]) gridData[r].splice(targetCol, 1);
  }
  if (targetColId) {
    var idx = colIds.indexOf(targetColId);
    if (idx >= 0) colIds.splice(idx, 1);
  }
  var cellLinks = Object.assign({}, getCellLinks());
  if (targetColId) {
    Object.keys(cellLinks).forEach(function (k) {
      if (String(k).split(':')[1] === targetColId) delete cellLinks[k];
    });
  }
  currentLedger.cell_links = cellLinks;
  var opts = getColumnOptions();
  if (targetColId && opts[targetColId]) delete opts[targetColId];
  var actions = cleanupCellActionsByColId(getCellActions(), targetColId);
  var charts = getCharts().filter(function (ch) {
    var c = ch.config || {};
    if (c.catColId === targetColId) return false;
    if (c.valColId === targetColId) return false;
    if (c.xColId === targetColId) return false;
    if (c.yColId === targetColId) return false;
    if (c.locColId === targetColId) return false;
    if (c.locLabelColId === targetColId) return false;
    return true;
  });
  currentLedger.charts = charts;
  selection = null;
  lastActiveCell = null;
  renderGrid();
  renderShowcase();
  markDirty();
  setSaveState('● 已删除最后一列（未保存）');
}

/* ============================================================
 * 行 / 列右键菜单
 * ============================================================ */
function showRowCtxMenu(x, y, row) {
  if (!currentLedger) return;
  var items = [{ type: 'header', label: '第 ' + row + ' 行' }];
  if (currentCanEdit) {
    items.push({
      label: '在上方插入行',
      onClick: function () { insertRowAt(row); }
    });
    items.push({
      label: '在下方插入行',
      onClick: function () { insertRowAt(row + 1); }
    });
    items.push({
      label: '清空所有数据行',
      danger: true,
      disabled: gridData.length <= 1,
      onClick: function () { clearAllRows(); }
    });
    items.push({ type: 'divider' });
    items.push({
      label: '删除本行',
      danger: true,
      disabled: gridData.length <= 1,
      onClick: function () { deleteRowAt(row); }
    });
  } else {
    items.push({ label: '只读模式', disabled: true });
  }
  showCtxMenu(x, y, items);
}

function showColCtxMenu(x, y, colIdx) {
  if (!currentLedger) return;
  var isTime = isTimeColumn(colIdx);
  var isOpt = isOptionColumn(colIdx);
  var colName = (gridData[0] && gridData[0][colIdx]) || ('列' + colIdx);
  var items = [{
    type: 'header',
    label: '第 ' + colIdx + ' 列「' + colName + '」'
  }];
  if (isTime) {
    items.push({ label: '更新时间列（系统保留）', disabled: true });
    showCtxMenu(x, y, items);
    return;
  }
  if (!currentCanEdit) {
    items.push({ label: '只读模式', disabled: true });
    showCtxMenu(x, y, items);
    return;
  }
  var timeColIdx = findTimeColumn();
  var canInsertAfter = (timeColIdx < 0) || (colIdx < timeColIdx);
  items.push({
    label: '在左侧插入列',
    onClick: function () { insertColAt(colIdx); }
  });
  items.push({
    label: '在右侧插入列',
    disabled: !canInsertAfter,
    onClick: function () { insertColAt(colIdx + 1); }
  });
  items.push({ type: 'divider' });
  if (isOpt) {
    items.push({
      label: '编辑选项列表…',
      onClick: function () { openOptionEditor(colIdx); }
    });
    items.push({
      label: '关闭选项列',
      danger: true,
      onClick: function () { disableOptionColumn(colIdx); }
    });
  } else {
    items.push({
      label: '设为选项列…',
      onClick: function () { openOptionEditor(colIdx); }
    });
  }
  items.push({ type: 'divider' });
  items.push({
    label: '删除本列',
    danger: true,
    disabled: colCount() <= 1,
    onClick: function () { deleteColAt(colIdx); }
  });
  showCtxMenu(x, y, items);
}

async function clearAllRows() {
  if (!currentCanEdit) { alert('只读用户不能修改'); return; }
  if (gridData.length <= 1) { alert('当前没有数据行'); return; }
  var n = gridData.length - 1;
  if (!confirm(
      '确定清空本台账所有数据行吗？\n\n' +
      '共 ' + n + ' 行将被封存到回收站，管理员可逐行恢复。\n' +
      '表头会保留。'
  )) return;

  if (typeof pushUndo === 'function') pushUndo();

  gridData = [gridData[0]];
  currentLedger.cell_links = {};
  currentLedger.cell_actions = {};
  selection = null; lastActiveCell = null;
  renderGrid(); renderShowcase(); markDirty();
  try {
    var r = await putLedger({
      data: gridData,
      cell_links: {},
      cell_actions: {}
    });
    if (r.ok) {
      dirty = false;
      var extra = r.ledger && r.ledger.archived_count
        ? '；已封存 ' + r.ledger.archived_count + ' 行'
        : '';
      setSaveState('● 已清空所有数据行（已保存' + extra + '）');
      loadLedgers();
    }
  } catch (e) {}
}

/* ============================================================
 * 保存 / 登出 / 待审批红点
 * ============================================================ */
async function saveLedger() {
  if (!currentLedger) { alert('请先打开或新建一本台账'); return; }
  if (!currentCanEdit) { alert('只读用户不能保存'); return; }
  var newName = (nameEl.value || '').trim() || '未命名台账';
  var payload = {
    name: newName,
    data: gridData,
    column_ids: getColumnIds()
  };
  var r = await putLedger(payload);
  if (r.ok) {
    dirty = false;
    setSaveState('● 已保存 ' + nowStr());
    highlightActive();
    loadLedgers();
    if (window.FileManager && typeof window.FileManager.open === 'function' && currentId) {
      try {
        var p = window.FileManager.open(currentId);
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {}
    }
  }
}

async function logout() {
  if (dirty && !confirm('当前台账有未保存的修改，确定退出登录吗？')) return;
  try { await api('/logout', { method: 'POST' }); } catch (e) {}
  window.location.href = '/';
}

async function refreshPendingBadge() {
  if (!IS_ROOT) return;
  try {
    var data = await api('/api/admin/pending-count');
    var n = data.count || 0;
    if (!pendingBadgeEl) return;
    if (n > 0) {
      pendingBadgeEl.textContent = n > 99 ? '99+' : String(n);
      pendingBadgeEl.classList.remove('hidden');
    } else {
      pendingBadgeEl.classList.add('hidden');
    }
  } catch (e) {
    if (pendingBadgeEl) pendingBadgeEl.classList.add('hidden');
  }
}

/* ============================================================
 * 导入 / 导出 Excel
 * ============================================================ */
function exportExcel() {
  if (!currentLedger) { alert('请先打开或新建一本台账'); return; }
  if (typeof XLSX === 'undefined') { alert('Excel 库未加载'); return; }
  try {
    var aoa = [];
    aoa.push(gridData[0].slice(1));
    for (var r = 1; r < gridData.length; r++) {
      aoa.push(gridData[r].slice(1));
    }
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    var baseName = currentLedger.name || '未命名台账';
    var safeName = String(baseName).replace(/[\\/:*?"<>|]/g, '_').trim() || '台账';
    XLSX.writeFile(wb, safeName + '.xlsx');
    setSaveState('● 已导出 ' + safeName + '.xlsx');
  } catch (e) {
    alert('导出失败：' + (e && e.message ? e.message : e));
  }
}

function importExcel(file) {
  if (!file) return;
  if (!currentLedger) { alert('请先打开或新建一本台账'); return; }
  if (!currentCanEdit) { alert('只读用户不能导入'); return; }
  if (typeof XLSX === 'undefined') { alert('Excel 库未加载'); return; }
  if (dirty && !confirm('当前台账有未保存的修改，导入会覆盖表格内容，确定继续吗？')) return;
  if (!confirm(
      '导入将重建台账的列结构（每列会生成新的列标识）。\n\n' +
      '后果：\n' +
      '• 原「选项列」「单元格关联」「单元格交互」「图表展示」配置将被清空\n' +
      '• 回收站中待恢复的旧行将按「表头名」尝试对齐恢复\n' +
      '  （表头名一致时数据能完整恢复；不一致时按位置兜底）\n\n' +
      '确定导入并覆盖吗？'
  )) return;

  var reader = new FileReader();
  reader.onload = function (ev) {
    try {
      var data = new Uint8Array(ev.target.result);
      var wb = XLSX.read(data, { type: 'array' });
      if (!wb.SheetNames || !wb.SheetNames.length) {
        alert('文件中没有工作表'); return;
      }
      var ws = wb.Sheets[wb.SheetNames[0]];
      var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
      if (!aoa.length) { alert('工作表为空'); return; }

      var firstRow = aoa[0] || [];
      var headers = [];
      for (var i = 0; i < firstRow.length; i++) {
        var h = String(firstRow[i] == null ? '' : firstRow[i]).trim();
        if (!h) h = '列' + (i + 1);
        headers.push(h);
      }
      if (!headers.length) { alert('首行没有任何列'); return; }

      if (typeof pushUndo === 'function') pushUndo();

      var newData = [[UUID_SENTINEL].concat(headers)];
      for (var r = 1; r < aoa.length; r++) {
        var src = aoa[r] || [];
        var row = [uuidHex()];
        for (var c = 0; c < headers.length; c++) {
          row.push(String(src[c] == null ? '' : src[c]));
        }
        newData.push(row);
      }

      gridData = newData;
      var newColIds = [UUID_SENTINEL];
      for (var k = 1; k <= headers.length; k++) newColIds.push(uuidHex());
      currentLedger.column_ids = newColIds;
      currentLedger.cell_links = {};
      currentLedger.cell_actions = {};
      currentLedger.column_options = {};
      currentLedger.charts = [];
      selection = null;
      lastActiveCell = null;

      ensureTimeColumn();
      renderGrid();
      if (window.scrollToRowIfEnabled) window.scrollToRowIfEnabled(1);
      renderShowcase();
      markDirty();
      setSaveState('● 已导入 ' + file.name + '（请点击保存）');
    } catch (err) {
      alert('导入失败：' + (err && err.message ? err.message : err));
    }
  };
  reader.onerror = function () { alert('文件读取失败'); };
  reader.readAsArrayBuffer(file);
}