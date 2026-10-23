"""Bark 推送测试台：本地 FastAPI 后端，负责转发、加密和静态页。"""

import base64
import json
import os
import secrets
import string
from pathlib import Path
from urllib import error, request as urlrequest

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

BASE = Path(__file__).resolve().parent
KEYS_FILE = BASE / "crypto_keys.json"
ALGOS = {"aes-128": 16, "aes-192": 24, "aes-256": 32}
MODES = ("cbc", "ecb", "gcm")


def _load_env() -> None:
    path = BASE / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[7:].strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env()
BARK_KEY = os.environ.get("BARK_KEY", "")
BARK_SERVER = os.environ.get("BARK_SERVER", "https://api.day.app").rstrip("/")


def _gen_key(length: int) -> str:
    return "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(length))


def _load_keys() -> dict[str, str]:
    keys = {name: _gen_key(length) for name, length in ALGOS.items()}
    try:
        saved = json.loads(KEYS_FILE.read_text(encoding="utf-8"))
        for name, length in ALGOS.items():
            if isinstance(saved.get(name), str) and len(saved[name]) == length:
                keys[name] = saved[name]
    except (OSError, ValueError):
        pass
    _save_keys(keys)
    return keys


def _save_keys(keys: dict[str, str]) -> None:
    KEYS_FILE.write_text(json.dumps(keys, indent=2), encoding="utf-8")


KEYS = _load_keys()


def _encrypt_bytes(data: bytes, key: bytes, mode: str, iv: str = "") -> tuple[str, str]:
    """返回 (base64 密文, iv)。GCM 的鉴别标签按 Bark App 约定拼在密文尾部。"""
    if mode == "gcm":
        iv = iv or "".join(secrets.choice("0123456789abcdef") for _ in range(12))
        ciphertext = AESGCM(key).encrypt(iv.encode(), data, None)
        return base64.b64encode(ciphertext).decode(), iv

    if mode == "cbc":
        iv = iv or "".join(secrets.choice("0123456789abcdef") for _ in range(16))
        encryptor = Cipher(algorithms.AES(key), modes.CBC(iv.encode())).encryptor()
    elif mode == "ecb":
        encryptor = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    else:
        raise ValueError(f"不支持的加密模式: {mode}")

    padder = padding.PKCS7(128).padder()
    padded = padder.update(data) + padder.finalize()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(ciphertext).decode(), iv


def _encrypt_json(payload: dict, algorithm: str, mode: str) -> tuple[str, str]:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    return _encrypt_bytes(raw, KEYS[algorithm].encode(), mode)


class PushRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    title: str | None = None
    subtitle: str | None = None
    body: str | None = None
    markdown: str | None = None
    device_key: str | None = None
    device_keys: list[str] | None = None
    group: str | None = None
    icon: str | None = None
    image: str | None = None
    badge: int | None = None
    level: str | None = None
    volume: int | None = None
    call: str | None = None
    sound: str | None = None
    copy_text: str | None = Field(default=None, alias="copy")
    automaticallycopy: str | None = None
    url: str | None = None
    action: str | None = None
    isArchive: str | None = None
    ttl: int | None = None
    id: str | None = None
    delete: str | None = None
    encrypt: bool = False
    algorithm: str = "aes-128"
    mode: str = "cbc"


class RegenRequest(BaseModel):
    algorithm: str


def _payload(req: PushRequest) -> dict:
    data = req.model_dump(by_alias=True)
    for name in ("encrypt", "algorithm", "mode", "device_key", "device_keys"):
        data.pop(name)
    return {k: v for k, v in data.items() if v is not None and v != ""}


def _mask(value: str) -> str:
    return f"{value[:4]}…{value[-4:]}" if len(value) > 8 else "已隐藏"


def _mask_body(body: dict) -> dict:
    masked = dict(body)
    if isinstance(masked.get("device_key"), str):
        masked["device_key"] = _mask(masked["device_key"])
    if isinstance(masked.get("device_keys"), list):
        masked["device_keys"] = [_mask(k) for k in masked["device_keys"]]
    return masked


def _call_bark(body: dict) -> tuple[dict | str | None, str]:
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urlrequest.Request(
        f"{BARK_SERVER}/push",
        data=data,
        method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urlrequest.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
    except error.URLError as exc:
        return None, f"连接 Bark 服务器失败: {exc.reason}"
    try:
        return json.loads(raw), raw
    except ValueError:
        return raw, raw


app = FastAPI(title="Bark 推送测试台")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(BASE / "static" / "index.html")


@app.get("/api/config")
def config() -> dict:
    return {
        "server": BARK_SERVER,
        "device_key_set": bool(BARK_KEY),
        "device_key_masked": _mask(BARK_KEY) if BARK_KEY else "",
        "keys": KEYS,
        "algorithms": list(ALGOS),
        "modes": list(MODES),
    }


@app.post("/api/crypto/regenerate")
def regenerate(req: RegenRequest) -> dict:
    if req.algorithm not in ALGOS:
        raise HTTPException(400, "未知算法")
    KEYS[req.algorithm] = _gen_key(ALGOS[req.algorithm])
    _save_keys(KEYS)
    return {"algorithm": req.algorithm, "key": KEYS[req.algorithm]}


@app.post("/api/push")
def push(req: PushRequest) -> dict:
    if req.encrypt and req.algorithm not in ALGOS:
        raise HTTPException(400, "未知算法")
    if req.encrypt and req.mode not in MODES:
        raise HTTPException(400, "未知加密模式")

    payload = _payload(req)
    keys = [k.strip() for k in (req.device_keys or []) if k.strip()]
    if not keys:
        key = (req.device_key or BARK_KEY).strip()
        if not key:
            raise HTTPException(400, "没有可用的 device_key，请在 .env 或表单中填写")
        keys = [key]

    out: dict = {"device_keys": keys} if len(keys) > 1 else {"device_key": keys[0]}
    ciphertext = iv = None
    if req.encrypt:
        ciphertext, iv = _encrypt_json(payload, req.algorithm, req.mode)
        out["ciphertext"] = ciphertext
        if iv:
            out["iv"] = iv
        # id/delete 由主 App 在 APNs 明文里读取（静默删除不经过解密扩展），需额外透传
        if isinstance(payload.get("id"), str):
            out["id"] = payload["id"]
        if payload.get("delete") == "1":
            out["delete"] = "1"
    else:
        out.update(payload)

    bark, raw = _call_bark(out)
    ok = False
    if isinstance(bark, dict):
        ok = (
            bark.get("code") == 200
            if "code" in bark
            else all(item.get("code") == 200 for item in bark.get("data", []))
        )

    return {
        "ok": ok,
        "encrypted": req.encrypt,
        "algorithm": req.algorithm if req.encrypt else None,
        "mode": req.mode if req.encrypt else None,
        "plain": payload,
        "ciphertext": ciphertext,
        "iv": iv,
        "request": _mask_body(out),
        "bark": bark,
        "raw": raw,
    }


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


if __name__ == "__main__":
    # 已知向量自检：Bark 官方文档的 AES-128-CBC 示例
    expected = "+aPt5cwN9GbTLLSFri60l3h1X00u/9j1FENfWiTxhNHVLGU+XoJ15JJG5W/d/yf0"
    got, _ = _encrypt_bytes(
        b'{"body": "test", "sound": "birdsong"}',
        b"1234567890123456",
        "cbc",
        iv="1234567890123456",
    )
    assert got == expected, f"加密自检失败:\n{got}\n{expected}"
    print("加密自检通过")