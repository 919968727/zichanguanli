import socket, errno, ipaddress, os


def check_port_available(ip, port):
    """
    尝试绑定 (ip, port) 检测端口是否可用。
    返回 (是否可用, 提示信息)；提示信息为空表示无额外说明。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((ip, port))
        return True, ''
    except OSError as e:
        code = e.errno
        # 端口被占用（Windows 映射后同样为 EADDRINUSE）
        if code in (errno.EADDRINUSE, getattr(errno, 'WSAEADDRINUSE', 10048)):
            return False, f'端口 {port} 已被占用'
        # IP 不属于本机，无法做占用检测，放行
        if code in (errno.EADDRNOTAVAIL, getattr(errno, 'WSAEADDRNOTAVAIL', 10049)):
            return False, f'{ip} 不是本机可用地址，请检查 IP 是否填错（如误填了网关地址）'
        # 权限不足（Linux 下 1024 以下端口需要 root）
        if code in (errno.EACCES, errno.EPERM, getattr(errno, 'WSAEACCES', 10013)):
            return False, f'端口 {port} 无权限绑定（Linux 下 1024 以下端口需 root）'
        return False, f'端口 {port} 检查失败：{e}'
    finally:
        sock.close()


def get_valid_ip():
    """循环读取并校验 IPv4 地址，直到合法为止"""
    while True:
        raw = input('请输入本设备IP: ').strip()
        if not raw:
            print('  IP 不能为空，请重新输入')
            continue
        try:
            addr = ipaddress.ip_address(raw)
        except ValueError:
            print(f'  IP 格式错误：{raw}，请重新输入')
            continue
        if addr.version != 4:
            print('  请填写 IPv4 地址，例如 192.168.1.100')
            continue
        return str(addr)


def get_valid_port(ip):
    """循环读取并校验端口，直到合法且可用为止"""
    while True:
        raw = input('请输入用于访问的端口: ').strip()
        try:
            port = int(raw)
        except ValueError:
            print('  端口必须为数字，请重新输入')
            continue
        if not (1 <= port <= 65535):
            print('  端口号必须在 1-65535 之间，请重新输入')
            continue
        if port < 1024 and os.name == 'posix':
            print('  提示：Linux 下 1024 以下端口需要 root 权限，可能启动失败')
        ok, msg = check_port_available(ip, port)
        if msg:
            print(f'  {msg}')
        if not ok:
            continue
        return port


def settings():
    print('请配置IP地址和端口')
    ip = get_valid_ip()
    port = get_valid_port(ip)
    print(f'配置完成\nIP: {ip}  端口: {port}\n')
    return ip, port


if __name__ == '__main__':
    ip, port = settings()