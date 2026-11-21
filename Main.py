# -*- coding: utf-8 -*-
import sys, CheckPlatform

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except AttributeError:
    pass

from Configuration import settings
from Service import create_app, service

# ============================================================
# 供 WSGI 服务器（Waitress / Gunicorn）导入的 app 对象
#   - Waitress  : waitress-serve --listen=127.0.0.1:8000 Main:app
#   - Gunicorn  : gunicorn -w 4 -b 127.0.0.1:8000 Main:app   (仅 Linux)
#
# secure_cookie=False：WSGI 服务器默认跑 HTTP，必须关掉 Secure cookie，
# 否则浏览器不会保存 session，登录后立刻又回到登录页。
# 若在 Nginx / Caddy 后面终止 HTTPS，这里可以改回 True。
# WSGI的配置在UseSqlite.py的_serve_waitress里
# ============================================================
app = create_app(secure_cookie=False)


if __name__ == '__main__':
    ip, port = settings()
    CheckPlatform.check()
    service(ip, port, backend='waitress', use_https=False)
