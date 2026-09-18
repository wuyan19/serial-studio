#!/usr/bin/env python3
"""ss-board-bridge 协议一致性冒烟（CI 用，python3 标准库零依赖）。

流程：PTY 模拟串口 → 拉起 bridge 子进程 → 手写 WS 客户端按 docs/device-protocol.md
走全链路：握手(version)/列表(list)/打开(acquired)/写(write→PTY 主端实测)/
RX 数据帧(主端注入→Binary 帧)/关闭(close)/断开重连。所有 JSON 应答必须通过
json.loads——任何序列化截断类 bug（0.13.x 曾因 sb_fmt 固定缓冲把 acquired 截成
半截 JSON，表现为 hub 侧"远端打开超时"）都会在此暴露。

用法: board_bridge_smoke.py <bridge 二进制路径>
"""

import base64
import hashlib
import json
import os
import pty
import select
import socket
import struct
import subprocess
import sys
import tempfile
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HOST, PORT = "127.0.0.1", 18799
PORT_NAME = "ttyS1"


class WS:
    """极简 WebSocket 客户端（RFC6455：客户端帧必掩码，服务端帧不掩码）。"""

    def __init__(self, host: str, port: int):
        self.s = socket.create_connection((host, port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(
            (
                f"GET /ws HTTP/1.1\r\nHost: {host}:{port}\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.s.recv(4096)
            if not chunk:
                raise AssertionError("WS 握手阶段连接关闭")
            buf += chunk
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n")[0]
        assert b"101" in status, f"握手未返回 101: {status!r}"
        want = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest())
        assert want in head, "Sec-WebSocket-Accept 不符"

    def _read(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.s.recv(4096)
            if not chunk:
                raise AssertionError("连接中断")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        """返回 (opcode, payload bytes)。"""
        h = self._read(2)
        op = h[0] & 0x0F
        ln = h[1] & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", self._read(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", self._read(8))[0]
        return op, self._read(ln)

    def expect_text(self, want_type: str) -> dict:
        """收文本帧直到指定 type；途中其余推送快照记录后跳过（幂等，无需保序）。"""
        deadline = time.time() + 5
        while time.time() < deadline:
            op, payload = self.recv()
            assert op == 0x1, f"期待文本帧,得到 opcode={op}"
            msg = json.loads(payload)  # 截断/畸形 JSON 在此抛错——本脚本的核心断言
            if msg.get("type") == want_type:
                return msg
            print(f"  (跳过推送快照 type={msg.get('type')})")
        raise AssertionError(f"5s 内未等到 type={want_type}")

    def recv_binary(self, timeout: float = 5.0) -> bytes:
        deadline = time.time() + timeout
        while time.time() < deadline:
            op, payload = self.recv()
            if op == 0x2:
                return payload
            assert op == 0x1, f"期待二进制帧,得到 opcode={op}"
        raise AssertionError("5s 内未等到二进制数据帧")

    def send(self, obj: dict):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        h = bytearray([0x81])
        if len(data) < 126:
            h.append(0x80 | len(data))
        elif len(data) < 65536:
            h.append(0x80 | 126)
            h += struct.pack(">H", len(data))
        else:
            h.append(0x80 | 127)
            h += struct.pack(">Q", len(data))
        h += mask
        self.s.sendall(bytes(h) + bytes(b ^ mask[i & 3] for i, b in enumerate(data)))

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def wait_listen(host: str, port: int, seconds: float = 5.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            socket.create_connection((host, port), timeout=0.5).close()
            return
        except OSError:
            time.sleep(0.1)
    raise AssertionError("bridge 未在 5s 内开始监听")


def main() -> int:
    bridge = sys.argv[1]
    mfd, sfd = pty.openpty()
    slave = os.ttyname(sfd)
    with tempfile.TemporaryDirectory() as tmp:
        logf = open(os.path.join(tmp, "bridge.log"), "w+b")
        proc = subprocess.Popen(
            [bridge, "--listen", f"{HOST}:{PORT}", "--port", f"{PORT_NAME}={slave}",
             "--id-file", os.path.join(tmp, "bridge.id")],
            stdout=logf, stderr=subprocess.STDOUT)
        try:
            wait_listen(HOST, PORT)
            ws = WS(HOST, PORT)

            # 1) 握手：身份交换（instance_id 是 hub 侧复合键前缀，必须存在）
            ws.send({"action": "version", "instance_id": "11111111-2222-3333-4444-555555555555"})
            v = ws.expect_text("version")
            iid = v.get("instance_id", "")
            assert len(iid) == 36 and iid.count("-") == 4, f"instance_id 形态异常: {iid!r}"
            print(f"1. version 握手 ok (identity={iid})")

            # 2) 列表
            ws.send({"action": "list"})
            p = ws.expect_text("ports")
            entry = next((x for x in p["ports"] if x["name"] == PORT_NAME), None)
            assert entry and entry["opened"] is False, f"端口表异常: {p}"
            print(f"2. list ok ({len(p['ports'])} port(s), {PORT_NAME} closed)")

            # 3) 打开 → acquired（历史 bug 位：此应答曾被截断）
            ws.send({"action": "open", "port": PORT_NAME, "req": 7,
                     "config": {"baud_rate": 9600, "data_bits": "eight"}})
            a = ws.expect_text("acquired")
            assert a["opened"] is True and a["resolved"] == PORT_NAME, f"acquired 异常: {a}"
            assert a["req"] == 7 and a["config"]["baud_rate"] == 9600, f"回执/配置异常: {a}"
            print("3. open → acquired ok (opened/resolved/req/config 全对)")

            # 4) 写 text → PTY 主端实测字节
            ws.send({"action": "write", "port": PORT_NAME, "data": "AT\r\n",
                     "encoding": "text", "req": 8})
            assert ws.expect_text("ok").get("req") == 8, "write 未回 ok/req 不配对"
            r, _, _ = select.select([mfd], [], [], 2)
            assert r, "2s 内 PTY 主端未见写入数据"
            got = os.read(mfd, 256)
            assert got == b"AT\r\n", f"PTY 收到 {got!r},期望 b'AT\\r\\n'"
            print("4. write(text) → PTY 字节 ok")

            # 5) RX：主端注入 → Binary 数据帧 [端口名长度][端口名][数据]
            os.write(mfd, b"OK\r\n")
            frame = ws.recv_binary()
            plen = frame[0]
            assert frame[1:1 + plen].decode() == PORT_NAME and frame[1 + plen:] == b"OK\r\n", \
                f"数据帧异常: {frame!r}"
            print("5. RX binary 数据帧 ok")

            # 6) 关闭
            ws.send({"action": "close", "port": PORT_NAME, "req": 9})
            assert ws.expect_text("ok").get("req") == 9, "close 未回 ok"
            print("6. close ok")

            # 7) 断开重连（会话清理路径）
            ws.close()
            ws = WS(HOST, PORT)
            ws.send({"action": "version", "instance_id": "11111111-2222-3333-4444-555555555555"})
            assert len(ws.expect_text("version").get("instance_id", "")) == 36, "重连后握手失败"
            ws.close()
            print("7. 断开重连 ok")

            print("SMOKE PASS")
            return 0
        except Exception:
            logf.flush()
            logf.seek(0)
            print("---- bridge log ----")
            print(logf.read().decode(errors="replace"))
            raise
        finally:
            proc.terminate()
            try:
                proc.wait(3)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    sys.exit(main())
