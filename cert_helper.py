# cert_helper.py
"""
纯 Python 自签名证书生成。
依赖 cryptography 库（自带 SSL 实现，无需系统 openssl 命令）：
    pip install cryptography
"""
import os
import datetime
import ipaddress
import socket

try:
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    _HAS_CRYPTO = True
except ImportError:
    _HAS_CRYPTO = False


CERT_DIR_NAME = '.flask_dev_certs'
CERT_FILE = 'dev.crt'
KEY_FILE = 'dev.key'


def _cert_dir():
    # 放在 cert_helper.py 所在目录的 certs 子目录下
    base = os.path.dirname(os.path.abspath(__file__))
    d = os.path.join(base, 'certs')
    os.makedirs(d, exist_ok=True)
    return d


def _cert_paths():
    d = _cert_dir()
    return os.path.join(d, CERT_FILE), os.path.join(d, KEY_FILE)


def _gather_ipv4():
    """收集本机 IPv4（用于 SAN），至少包含 127.0.0.1"""
    ips = {'127.0.0.1'}
    try:
        _, _, addrs = socket.gethostbyname_ex(socket.gethostname())
        for a in addrs:
            try:
                ipaddress.IPv4Address(a)
                ips.add(a)
            except ValueError:
                pass
    except Exception:
        pass
    return ips


def _cert_still_valid(cert_path, days_ahead=7):
    if not os.path.exists(cert_path):
        return False
    try:
        with open(cert_path, 'rb') as f:
            c = x509.load_pem_x509_certificate(f.read())
        # 兼容 cryptography 42+ 与老版本
        try:
            exp = c.not_valid_after_utc
            now = datetime.datetime.now(datetime.timezone.utc)
        except AttributeError:
            exp = c.not_valid_after
            now = datetime.datetime.utcnow()
        return exp > now + datetime.timedelta(days=days_ahead)
    except Exception:
        return False


def ensure_cert(extra_ips=None, days=3650, force=False):
    """
    确保证书存在；返回 (cert_path, key_path)。
    - 首次调用会生成 RSA 2048 自签名证书；
    - 之后只要未临近过期就复用；
    - SAN 中包含 localhost、127.0.0.1、本机全部 IPv4 以及 extra_ips。
    """
    if not _HAS_CRYPTO:
        raise RuntimeError(
            '缺少 cryptography 库，请先安装：pip install cryptography\n'
            '（cryptography 自带所需的 SSL 实现，无需系统 openssl 命令）'
        )

    cert_path, key_path = _cert_paths()

    if not force and _cert_still_valid(cert_path) and os.path.exists(key_path):
        return cert_path, key_path

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, 'CN'),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Self-Signed Dev Cert'),
        x509.NameAttribute(NameOID.COMMON_NAME, 'dev.local'),
    ])

    ip_set = _gather_ipv4()
    if extra_ips:
        for x in extra_ips:
            if not x:
                continue
            try:
                ipaddress.IPv4Address(x)
                ip_set.add(x)
            except ValueError:
                pass

    san = [x509.DNSName('localhost'), x509.DNSName('dev.local')]
    for ip in sorted(ip_set):
        san.append(x509.IPAddress(ipaddress.ip_address(ip)))

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=days))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    with open(key_path, 'wb') as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    with open(cert_path, 'wb') as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass

    return cert_path, key_path