# 项目契约 PROJECT_CONTRACT

> 适用：LedgerEditorV5 二次开发。
> 用法：每次让 AI 改代码前，先让它读本文件；新增能力或改了约定后同步更新这里，保持它始终是"唯一事实来源"。
> 目标：让 AI 每次生成的代码都长在同一套骨架上，不重新发明轮子、不破坏既有约定。

## 0. 项目一句话

单机部署的台账管理 Web 应用：Flask + SQLite（5 个库 / WAL）+ Waitress，前端原生 JS 无构建，PyInstaller 打包为桌面程序。当前处于 v5.x 功能迭代（细粒度权限 + 二维码 + 扫码终端）。

**登录后首屏是「台账编辑器」(`/editor`)**，不是观测台。观测台 `/dashboard` 是独立图表页，通过编辑器左侧功能菜单第一项"观测台"入口进入。编辑器左侧菜单：第一项"观测台"入口 + 可折叠的"台账列表"分组。

## 1. 技术栈（锁定，未经确认不得升级或引入新依赖）

- Python 3.8+；源码为 UTF-8；项目自带的两份 `.md` 说明文档是 **GBK 编码**（终端显示文件名为乱码），读取时必须指定 `encoding='gbk'`。
- 服务端：Flask（路由 / 模板 / Session）、Waitress（WSGI）、cryptography（自签 HTTPS）。
- 数据库：SQLite3 WAL 模式，5 个独立单文件库。
- 前端：原生 JS + XLSX.js + Chart.js + jsQR + qrcode-gen，**无 npm、无构建步骤**。
- 打包：PyInstaller（`LedgerEditorV5.spec`）。
- `requirements.txt` 仅：`flask>=2.0`、`waitress>=2.1`、`cryptography>=3.4`、`werkzeug>=2.0`。极简是刻意设计。

## 2. 代码结构与职责（新增代码必须落到对应位置）

| 文件 | 职责 | 约束 |
|---|---|---|
| `Main.py` | 入口，`create_app` / `service` 启动 | 不改启动流程除非明确要求 |
| `Service.py` | 全部 HTTP 路由与页面渲染（`create_app` 工厂） | 只做编排、校验、审计；不写复杂数据逻辑，不直接写 SQL |
| `UseSqlite.py` | 唯一数据访问层（约 3200 行）：建表 / 迁移 / CRUD / 权限 / 审计 / 附件 / 归档 | 所有 DB 操作必须经这里，不要在别处写 SQL |
| `Configuration.py` | IP / 端口交互配置、端口检测 | — |
| `path_helper.py` | `resource_path`（只读静态资源）/ `data_path`（可写数据，exe 同级） | 数据文件必须走 `data_path` |
| `scan_apps.py` | 扫码应用配置读写（`scan_apps/<app_id>.json`，每请求现读） | app_id 正则 `^[a-z0-9_]{1,50}$` |
| `backup_scheduler.py` | 数据库定期备份后台线程 | — |
| `cert_helper.py` / `CheckPlatform.py` | 自签证书 / 平台检查 | — |
| `static/*.js` | 前端按功能拆分：`editor-core`、`editor-grid`、`editor-cells`、`editor-ledger`、`editor-members`、`editor-chart`、`editor-qr`、`editor-scan-config`、`file-manager`、`dashboard`、`scan*` 等 | 新功能放对应模块，不要塞进一个巨文件 |
| `templates/*.html` | Jinja2 页面 | — |

命名：Python 用 `snake_case`；前端 JS 用 `camelCase`；路由统一 `/api/...`，返回 JSON。

## 3. 数据模型（5 个库，职责不可混用）

| 库 | 内容 |
|---|---|
| `LedgerEditor.db` | 用户、审计日志、成员、权限申请 |
| `Ledger.db` | 台账业务数据（`data` / `column_ids` / `column_options` / `charts` / `cell_actions` 等 JSON 列）、`ledger_members`、`permission_requests` |
| `Archive.db` | 被删行的归档（回收站） |
| `file.db` | 附件 BLOB（分块流式下载） |
| `Offline.db` | 离线扫码上传缓存 |

关键约定：
- 台账 `data` 是二维列表，首行是表头，第 0 列固定为 `UUID_SENTINEL = '__uuid__'`。
- 每行首列是 32 位 uuid hex（稳定行标识）；列也有 `column_ids`（uuid）。
- JSON 字段入库前必须经 `UseSqlite.py` 里的规范化 / `_safe_json` 清洗（参考 `Service.py` 的 `_normalize_*` 系列）。
- **禁止物理删除台账业务行**（删行走归档）；**禁止改动已有字段语义**。
- 确需改表结构：写迁移函数并在对应 `init_xxx_db()` 中调用，保证旧库可升级。

## 4. 权限模型（两套并存，必须复用，不得另起一套）

### 4.1 系统级角色（管账号 / 组织 / 功能开关）
- 三类（`SYS_ROLES`）：`super_admin`（超级管理员，管全部）/ `admin`（管理员，管本组织及所有下级组织的人）/ `user`（普通用户）。root 恒为 super_admin。
- 存 `users.role`；组织存 `orgs` 表（树形，`parent_id`，`descendant_org_ids()` 求所有后代）；用户属组织存 `users.org_id`。
- 管理员作用域：`users_in_org_scope(org_id)` 返回本组织及后代的用户；`_managed_usernames()` / `_can_manage_user()` 做越权拦截（超管返回 None=全部）。
- 分级鉴权：`_require_root()`（仅超管）/ `_require_admin()`（超管+管理员）；`/admin` 页与 `/api/admin/*` 按此分级。组织 CRUD 与角色/组织设置仅超管可操作。
- 功能开关：`FEATURE_KEYS`（export/observatory/scan/offline_scan/file_upload）存 `user_features` 表，默认全开；`_feature_allowed()` 在观测台/扫码/离线上传路由拦截，超管管理员恒允许。
- 页面：`/users` 用户管理页（`templates/users.html` + `static/users.js`），侧栏入口按 sys_role 显示（super_admin/admin 可见，普通用户不可见）。
- **登录**：`login_check` 返回 dict（status/role/org_id），写入 session 的 `sys_role`/`org_id`。
- **台账权限代管**：超管/管理员在 `/users` 页用「台账权限」按钮代管用户权限（`/api/admin/users/<u>/ledger-permissions`），管理员限本组织成员；角色只设 manager/member + 10 键逐项勾选。
- **建台账 owner**：`create_ledger()` 直接 INSERT owner 到 ledger_members（不能调 set_ledger_member，它拒绝 owner），否则新建者本人会 403。

### 4.2 台账级权限（管数据）
- 10 个权限键（`PERMISSION_KEYS`）：`data.view`、`data.edit`、`data.delete`、`file.upload`、`file.download`、`qr.generate`、`export`、`member.manage`、`member.approve`、`log.view`。
- 台账角色：`owner` / `manager` / `member`；root/super_admin 绕过所有台账权限。
- `Service.py` 用 `_perm` / `_can_access` / `_can_edit` / `_is_owner` / `_is_manager_or_above` / `_grant_check` 校验。
- 两套权限**互不干扰**：系统角色决定"能不能管账号/用功能"，台账权限决定"能不能看改某本台账的数据"。
- 新增接口的固定顺序：`登录校验` → `get_ledger_by_id` → `对应权限校验` → `业务操作`；失败返回 `{'msg':...}` + 401/403/404/400。
- 每次写操作后调用 `_audit(...)` 留审计。

## 5. 核心机制（改相关代码前必须理解）

- **CSRF**：`before_request` 校验请求头 `X-CSRF-Token`；前端从模板变量 `csrf_token` 取。
- **Session**：`SECRET_KEY` 存 `secret.key`（exe 同级）；`SESSION_COOKIE_SECURE` 由是否 HTTPS 决定。
- **乐观锁**：保存带 `expected_updated_at`，冲突返回 409 + `current_updated_at`。
- **写队列**：`update_ledger` 走后台 writer 线程；繁忙返回 `status='busy'` → HTTP 429 + `Retry-After: 2`。
- **审计异步**：`_audit_writer_loop` 异步落库，避免阻塞请求。
- **备份**：`backup_scheduler` 后台线程，5 档快照。
- **扫码**：gid 格式 `L<ledger_id>_<32位uuid>`，由 `_resolve_scan_gid` 校验权限与行；动作目前仅支持 `set_value`；追加日志目标必须是关联子台账（`is_child_ledger`）。
- **离线上传**：单批最多 5000 条，`check_offline_exists` 去重。

## 6. 已有能力清单（先复用，不要重复实现）

- 用户注册 / 审批：`register_user` / `approve_user`
- 权限申请审批：`create_permission_request` / `review_permission_request`
- Excel 导入导出：前端 XLSX.js（`static/xlsx.full.min.js`）
- 图表：Chart.js（`static/chart.umd.min.js`），类型 `bar/line/area/pie/doughnut/radar/scatter/loc`
- 二维码：`qrcode-gen.js` / `jsQR.js`
- 附件上传下载：`add_file` / `iter_file_chunks`
- 归档回收站：`list_archived_rows` / `restore_archived_row`
- 态势大屏：`dashboard.html` + `dashboard.js`

## 7. 二次开发硬性约束

1. 不破坏现有 API 的入参 / 出参结构（前端强依赖）。
2. 不修改 5 个库的已有表结构语义；变更必须走迁移函数。
3. 不在 `Service.py` 写 SQL，不在 `UseSqlite.py` 写路由。
4. 新依赖必须先确认（保持 requirements 极简）。
5. 涉及写操作必须留审计。
6. 每次改动结束必须列出：改动文件清单、影响的路由 / 前端调用、实际验证方式与结果。
7. 数据文件写入 `data_path`，不要用 `resource_path` 写。
8. 小步改动，每步可运行；一次只做一件事。

## 8. 上下文文档

项目自带两份 GBK 编码文档（终端文件名为乱码）：
- 技术说明（13 章：架构 / 数据模型 / 权限 / 认证安全 / 核心机制 / API / 前端架构 / 部署打包 / 运维备份 / 性能 / 已知限制 / 故障排查）
- 使用说明（19 章：快速开始 / 登录 / 编辑器 / 台账操作 / 成员权限 / 表格进阶 / 图表 / 二维码 / 大屏 / Excel / 附件 / 回收站 / 扫码等）

遇到不确定的设计意图时，让 AI 用 `encoding='gbk'` 读取它们，不要用 UTF-8 猜测。
