# -*- mode: python ; coding: utf-8 -*-
# ============================================================
# LedgerEditorV5 —— PyInstaller 打包配置
#   - 入口 Main.py（Flask + Waitress 本地服务）
#   - templates / static 整体打入（含 dashboard 态势大屏、二维码、扫描页面）
#   - backup_scheduler.py 等本地模块随 import 自动收集，无需额外声明
#   - 打包命令：pyinstaller LedgerEditorV5.spec
# ============================================================


a = Analysis(
    ['Main.py'],
    pathex=[],
    binaries=[],
    datas=[('templates', 'templates'), ('static', 'static')],
    hiddenimports=['waitress', 'waitress.server', 'waitress.task', 'waitress.channel', 'waitress.trigger', 'waitress.wasyncore', 'cryptography', 'cryptography.hazmat.bindings._rust', 'cryptography.hazmat.primitives.asymmetric.rsa', 'cryptography.hazmat.primitives.hashes', 'cryptography.hazmat.primitives.serialization', 'cryptography.x509'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['matplotlib', 'numpy', 'pandas', 'scipy', 'tkinter', 'PIL'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='LedgerEditorV5',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='LedgerEditorV5',
)
