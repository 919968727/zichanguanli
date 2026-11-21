/* ============================================================
 * editor-cells.js —— 单元格关联 / 选项列 / 单元格交互操作
 * 【内嵌方案】data[r][0] 是 uuid，列索引 1-based
 * ============================================================ */

async function openLinkDialog(target) {
  if (!currentLedger) return;
  if (!currentCanEdit) { alert('只读用户不能设置关联'); return; }
  if (target.col < 1) { alert('该列不支持设置关联'); return; }
  if (isTimeColumn(target.col)) { alert('更新时间列不支持设置关联'); return; }
  if (isOptionColumn(target.col)) { alert('选项列不支持设置单元格关联'); return; }
  ensureColumnIds();
  linkDialogTarget = target;
  var colName = gridData[0][target.col] || ('列' + target.col);
  $('linkTargetName').textContent = '第 ' + target.row + ' 行「' + colName + '」单元格';
  var sel = $('linkSelect');
  sel.innerHTML = '<option value="">— 不关联 —</option>';
  try {
    var data = await api('/api/ledgers?light=1');
    (data.ledgers || []).forEach(function (item) {
      if (item.id === currentId) return;
      var opt = document.createElement('option');
      opt.value = String(item.id);
      opt.textContent = item.name + '  (#' + item.id + ')';
      sel.appendChild(opt);
    });
  } catch (e) {}
  var colId = getColumnIdAt(target.col);
  var curLinked = getCellLinks()[target.row + ':' + colId];
  sel.value = curLinked ? String(curLinked) : '';
  $('linkModal').classList.remove('hidden');
}
async function saveLink() {
  if (!linkDialogTarget || !currentLedger) return;
  if (linkDialogTarget.col < 1 ||
      isTimeColumn(linkDialogTarget.col) ||
      isOptionColumn(linkDialogTarget.col)) {
    alert('该列不支持设置关联'); return;
  }
  ensureColumnIds();
  var colId = getColumnIdAt(linkDialogTarget.col);
  var val = $('linkSelect').value;
  var newId = val ? parseInt(val, 10) : null;
  var cellLinks = Object.assign({}, getCellLinks());
  var ck = linkDialogTarget.row + ':' + colId;
  if (newId) cellLinks[ck] = newId; else delete cellLinks[ck];
  var r = await putLedger({ cell_links: cellLinks });
  if (r.ok) {
    dirty = false;
    renderGrid();
    renderShowcase();
    loadLedgers();
    setSaveState('● 单元格关联已更新');
    $('linkModal').classList.add('hidden');
  }
  linkDialogTarget = null;
}

function openOptionEditor(colIdx) {
  if (!currentCanEdit) { alert('只读用户不能编辑'); return; }
  if (colIdx < 1) { alert('该列不支持选项设置'); return; }
  if (isTimeColumn(colIdx)) { alert('更新时间列不支持选项设置'); return; }
  if (colIdx >= (gridData[0] ? gridData[0].length : 0)) return;
  ensureColumnIds();
  var colId = getColumnIdAt(colIdx);
  var opts = getColumnOptions()[colId] || [];
  $('optionEditorColName').textContent = gridData[0][colIdx] || ('列' + colIdx);
  $('optionEditorText').value = opts.join('\n');
  var modal = $('optionEditorModal');
  modal.dataset.colId = colId;
  modal.dataset.colIdx = String(colIdx);
  modal.classList.remove('hidden');
}
async function saveOptionEditor() {
  var modal = $('optionEditorModal');
  var colId = modal.dataset.colId;
  if (!colId) return;
  var raw = $('optionEditorText').value;
  var lines = raw.split(/\r?\n|[,，;；]/);
  var seen = {}, opts = [];
  for (var i = 0; i < lines.length; i++) {
    var s = String(lines[i] || '').trim();
    if (!s) continue;
    if (s.length > 100) s = s.slice(0, 100);
    if (seen[s]) continue;
    seen[s] = true;
    opts.push(s);
    if (opts.length >= 100) break;
  }
  if (opts.length === 0) { alert('至少填写一个选项'); return; }
  var current = Object.assign({}, getColumnOptions());
  current[colId] = opts;
  var r = await putLedger({ column_options: current });
  if (r.ok) {
    currentLedger = r.ledger;
    setSaveState('● 选项列已更新');
    modal.classList.add('hidden');
    renderGrid();
  }
}
async function disableOptionColumn(colIdx) {
  if (!currentCanEdit) return;
  if (colIdx < 1) return;
  if (!confirm('确定关闭该选项列吗？关闭后该列恢复自由填写。')) return;
  var colId = getColumnIdAt(colIdx);
  if (!colId) return;
  var current = Object.assign({}, getColumnOptions());
  if (!current[colId]) { alert('该列未启用选项'); return; }
  delete current[colId];
  var r = await putLedger({ column_options: current });
  if (r.ok) {
    currentLedger = r.ledger;
    setSaveState('● 选项列已关闭');
    renderGrid();
  }
}
function hideOptionMenu() {
  var menu = $('optionMenu');
  if (menu) menu.classList.add('hidden');
}
function showOptionPicker(cellEl, options, currentValue, onPick) {
  var menu = $('optionMenu');
  if (!menu) return;
  menu.innerHTML = '';
  var cur = document.createElement('div');
  cur.className = 'option-menu-cur';
  cur.textContent = currentValue ? ('当前：' + currentValue) : '（空）';
  menu.appendChild(cur);
  options.forEach(function (opt) {
    var item = document.createElement('div');
    item.className = 'option-menu-item' + (opt === currentValue ? ' active' : '');
    item.textContent = opt;
    item.addEventListener('click', function (e) {
      e.stopPropagation(); hideOptionMenu(); onPick(opt);
    });
    menu.appendChild(item);
  });
  var clear = document.createElement('div');
  clear.className = 'option-menu-item clear';
  clear.textContent = '— 清空 —';
  clear.addEventListener('click', function (e) {
    e.stopPropagation(); hideOptionMenu(); onPick('');
  });
  menu.appendChild(clear);
  var rect = cellEl.getBoundingClientRect();
  var left = rect.left, top = rect.bottom + 4;
  menu.classList.add('hidden');
  menu.style.left = '0px'; menu.style.top = '0px';
  menu.classList.remove('hidden');
  var mrect = menu.getBoundingClientRect();
  if (left + mrect.width > window.innerWidth - 8) left = window.innerWidth - mrect.width - 8;
  if (top + mrect.height > window.innerHeight - 8) top = rect.top - mrect.height - 4;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
}

function openCellActionEditor(row, col) {
  if (!currentLedger) return;
  var colId = getColumnIdAt(col);
  if (!colId || colId === UUID_SENTINEL) { alert('列异常，请刷新'); return; }

  cellActionTarget = { row: row, col: col, colId: colId };
  var existing = getCellAction(row, colId) || { name: '', fields: [] };

  var cellValue = getCell(row, col);
  cellValue = cellValue == null ? '' : String(cellValue);
  $('cellActionRowInfo').textContent =
    '第 ' + row + ' 行「' + (gridData[0][col] || ('列' + col)) + '」' +
    (cellValue ? ' — 值：' + cellValue : '');
  $('cellActionName').value = existing.name || '';

  var box = $('cellActionFields');
  box.innerHTML = '';
  var headers = gridData[0] || [];
  var colIds = getColumnIds();
  var timeColIdx = findTimeColumn();
  var fields = Array.isArray(existing.fields) ? existing.fields : [];

  for (var i = 1; i < headers.length; i++) {
    if (i === col) continue;
    if (i === timeColIdx) continue;
    var cid = colIds[i];
    if (!cid || cid === UUID_SENTINEL) continue;
    var label = document.createElement('label');
    label.className = 'cell-action-field';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = cid;
    cb.disabled = !currentCanEdit;
    if (fields.indexOf(cid) >= 0) cb.checked = true;
    label.appendChild(cb);
    var span = document.createElement('span');
    span.textContent = headers[i] || ('列' + i);
    label.appendChild(span);
    box.appendChild(label);
  }

  $('cellActionDeleteBtn').style.display = existing.name ? '' : 'none';
  $('cellActionName').disabled = !currentCanEdit;
  $('cellActionModal').classList.remove('hidden');
}
async function saveCellActionForm() {
  if (!cellActionTarget) return;
  if (!currentCanEdit) { alert('只读用户不能修改'); return; }
  var name = ($('cellActionName').value || '').trim();
  if (!name) { alert('请填写操作名称'); return; }
  if (name.length > 100) name = name.slice(0, 100);

  var fields = [];
  Array.prototype.forEach.call($('cellActionFields').querySelectorAll('input[type="checkbox"]'), function (cb) {
    if (cb.checked) fields.push(cb.value);
  });

  var actions = Object.assign({}, getCellActions());
  actions[cellActionTarget.row + ':' + cellActionTarget.colId] = { name: name, fields: fields };

  var r = await putLedger({ cell_actions: actions });
  if (r.ok) {
    currentLedger = r.ledger;
    renderGrid();
    setSaveState('● 交互操作已保存');
    $('cellActionModal').classList.add('hidden');
    cellActionTarget = null;
  }
}
async function deleteCellAction() {
  if (!cellActionTarget) return;
  if (!currentCanEdit) { alert('只读用户不能修改'); return; }
  if (!confirm('确定删除此单元格的交互操作配置？')) return;
  var actions = Object.assign({}, getCellActions());
  delete actions[cellActionTarget.row + ':' + cellActionTarget.colId];
  var r = await putLedger({ cell_actions: actions });
  if (r.ok) {
    currentLedger = r.ledger;
    renderGrid();
    setSaveState('● 交互操作已删除');
    $('cellActionModal').classList.add('hidden');
    cellActionTarget = null;
  }
}
async function triggerInteractAction(row, col) {
  if (!currentLedger) return;
  var colId = getColumnIdAt(col);
  if (!colId || colId === UUID_SENTINEL) return;
  var actionDef = getCellAction(row, colId);
  if (!actionDef || !actionDef.name) {
    openCellActionEditor(row, col);
    return;
  }
  if (!currentCanEdit) { alert('只读用户不能执行交互操作'); return; }

  var cellValue = getCell(row, col);
  cellValue = cellValue == null ? '' : String(cellValue);
  var rowData = {};
  var fields = Array.isArray(actionDef.fields) ? actionDef.fields : [];
  if (fields.length > 0) {
    var colIds = getColumnIds();
    for (var i = 1; i < colIds.length; i++) {
      if (fields.indexOf(colIds[i]) >= 0) {
        var v = getCell(row, i);
        rowData[colIds[i]] = v == null ? '' : String(v);
      }
    }
  }

  var payload = {
    action_name: actionDef.name,
    row: row,
    col_id: colId,
    cell_value: cellValue,
    row_data: rowData
  };

  try {
    var res = await fetch('/api/ledgers/' + currentId + '/interact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify(payload)
    });
    if (res.status === 401) { window.location.href = '/'; return; }
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      showActionToast(data.msg || '操作失败', 'error');
      return;
    }
    showActionToast(data.msg || '操作已发送', 'success');
  } catch (e) {
    showActionToast('网络错误：' + e.message, 'error');
  }
}