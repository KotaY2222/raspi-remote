"""赤外線の送信部分。

今はダミー実装(ログを出すだけ)。実機が届いたら IRSender を継承した
クラスを作り、server.py の SENDER を差し替える。
"""
import time
from collections import deque


class IRSender:
    dummy = False

    def send(self, device: str, command: str, params: dict) -> bool:
        raise NotImplementedError

    def recent(self) -> list:
        return []


class DummyIR(IRSender):
    """実際には送信せず、送ったはずの内容を記録する(デモ用)。"""

    dummy = True

    def __init__(self, keep: int = 20):
        self._log = deque(maxlen=keep)

    def send(self, device: str, command: str, params: dict) -> bool:
        print(f"[IR:dummy] {device} {command} {params}")
        time.sleep(0.05)  # 送信にかかる時間の疑似
        self._log.append({"at": int(time.time()), "device": device, "params": dict(params)})
        return True

    def recent(self) -> list:
        return list(reversed(self._log))  # 新しい順
