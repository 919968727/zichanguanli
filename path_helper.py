# path_helper.py
import sys
import os
from pathlib import Path


def resource_path(relative_path: str) -> str:
    """获取打包后静态资源的真实路径（只读）。"""
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        base = sys._MEIPASS
    else:
        base = os.path.abspath(".")
    return os.path.join(base, relative_path)


def data_path(filename: str) -> str:
    """获取可写数据文件（数据库等）的路径：始终放在 exe 同级目录，重启不丢数据。"""
    if getattr(sys, 'frozen', False):
        # exe 所在目录，不是临时解压目录
        base = Path(sys.executable).resolve().parent
    else:
        base = Path(__file__).resolve().parent
    return str(base / filename)