"""ラズパイ家電リモコン: Web API と画面の配信(標準ライブラリのみ)。

起動: python server.py [--port 8080]
"""
import argparse
import json
import mimetypes
import os
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import ai
from ir import DummyIR

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
STATE_FILE = ROOT / "data" / "state.json"

SENDER = DummyIR()
LOCK = threading.Lock()

AC_MODES = ["cool", "heat", "dry", "fan", "auto"]
AC_FANS = ["auto", "low", "mid", "high"]
TV_INPUTS = ["HDMI1", "HDMI2", "TV"]
TEMP_MIN, TEMP_MAX = 16, 30

DEFAULT_STATE = {
    "aircon": {"power": False, "mode": "cool", "temp": 26, "fan": "auto", "sentAt": None},
    "light": {"power": False, "level": 100, "sentAt": None},
    "tv": {"power": False, "input": "HDMI1", "sentAt": None},
}

SCENES = {
    "night": {
        "name": "おやすみ",
        "steps": [
            ("light", {"power": False}),
            ("tv", {"power": False}),
            ("aircon", {"power": True, "mode": "cool", "temp": 27, "fan": "low"}),
        ],
    },
    "out": {
        "name": "いってきます",
        "steps": [
            ("light", {"power": False}),
            ("tv", {"power": False}),
            ("aircon", {"power": False}),
        ],
    },
}


def load_state():
    try:
        saved = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    state = json.loads(json.dumps(DEFAULT_STATE))
    for dev, vals in saved.items():
        if dev in state and isinstance(vals, dict):
            state[dev].update({k: v for k, v in vals.items() if k in state[dev]})
    return state


def save_state(state):
    STATE_FILE.parent.mkdir(exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, STATE_FILE)  # 書き込み途中の停電でも壊れにくい


STATE = load_state()


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def validate(device, changes):
    """changes を検証して返す。範囲外・未知の値は ApiError。"""
    if device not in STATE:
        raise ApiError(f"未知の機器: {device}", 404)
    allowed = set(DEFAULT_STATE[device]) - {"sentAt"}
    out = {}
    for key, val in changes.items():
        if key not in allowed:
            raise ApiError(f"{device} に {key} はありません")
        if key == "power":
            if not isinstance(val, bool):
                raise ApiError("power は true/false")
        elif key == "temp":
            if not isinstance(val, int) or isinstance(val, bool) or not TEMP_MIN <= val <= TEMP_MAX:
                raise ApiError(f"温度は {TEMP_MIN}〜{TEMP_MAX}℃")
        elif key == "mode" and val not in AC_MODES:
            raise ApiError("運転モードが不正です")
        elif key == "fan" and val not in AC_FANS:
            raise ApiError("風量が不正です")
        elif key == "input" and val not in TV_INPUTS:
            raise ApiError("入力が不正です")
        elif key == "level":
            if not isinstance(val, int) or isinstance(val, bool) or not 10 <= val <= 100:
                raise ApiError("明るさは 10〜100")
        out[key] = val
    return out


def apply(device, changes):
    """赤外線を送り、成功したら状態を保存する(呼び出し側で LOCK 済み)。"""
    changes = validate(device, changes)
    merged = {**STATE[device], **changes}
    params = {k: v for k, v in merged.items() if k != "sentAt"}
    if not SENDER.send(device, "set", params):
        raise ApiError("赤外線の送信に失敗しました", 502)
    merged["sentAt"] = int(time.time())
    STATE[device] = merged


def run_command(body):
    device = body.get("device")
    action = body.get("action", "set")
    with LOCK:
        if action == "resend":  # 保存済みの状態をそのまま実機へ送り直す
            apply(device, {})
            message = "いまの設定を再送しました"
        elif action == "set":
            apply(device, body.get("values") or {})
            message = "送信しました"
        else:
            raise ApiError("action が不正です")
        save_state(STATE)
        return message


def run_scene(scene_id):
    scene = SCENES.get(scene_id)
    if not scene:
        raise ApiError("シーンがありません", 404)
    with LOCK:
        for device, values in scene["steps"]:
            apply(device, values)
        save_state(STATE)
    return f"「{scene['name']}」を実行しました"


# --- 外の気温・湿度(Open-Meteo、APIキー不要) ---------------------------
# 場所は環境変数で指定する。未設定の間は東京駅付近の仮の値(自宅の位置は送らない)。
WEATHER_LAT = float(os.environ.get("WEATHER_LAT", "35.68"))
WEATHER_LON = float(os.environ.get("WEATHER_LON", "139.76"))
WEATHER_PLACE = os.environ.get("WEATHER_PLACE", "東京")
WEATHER_TTL = 600  # 10分ごとに取り直す(天気データの更新間隔は15分)
_weather = {"at": 0.0, "data": None}


def get_weather():
    """キャッシュを返す。取得に失敗しても、古い値があればそれを返す。"""
    now = time.time()
    with LOCK:
        if _weather["data"] and now - _weather["at"] < WEATHER_TTL:
            return _weather["data"]
        if now - _weather["at"] < 60:  # 失敗直後に連続で取りに行かない
            return _weather["data"]
        _weather["at"] = now
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={WEATHER_LAT}&longitude={WEATHER_LON}"
        "&current=temperature_2m,relative_humidity_2m&timezone=Asia%2FTokyo"
    )
    try:
        with urllib.request.urlopen(url, timeout=5) as res:
            cur = json.loads(res.read())["current"]
        data = {
            "place": WEATHER_PLACE,
            "temp": cur["temperature_2m"],
            "humidity": cur["relative_humidity_2m"],
            "observedAt": cur["time"],
            "fetchedAt": int(now),
        }
    except Exception as e:  # 通信断・形式変更など。画面側は「取得できません」と表示する
        print(f"[weather] 取得失敗: {e}")
        return _weather["data"]
    with LOCK:
        _weather["data"] = data
    return data


# --- AI(話しかけて操作) ---------------------------------------------------
AI_DAILY_LIMIT = int(os.environ.get("AI_DAILY_LIMIT", "50"))   # 1日の利用回数の上限(費用の歯止め)
AI_LOG = ROOT / "data" / "ai_log.jsonl"
_ai_count = {"day": "", "n": 0}


def ai_available():
    return ai.available()


def _ai_take_slot():
    """1日の上限を数える。Claude を呼ぶときだけ消費する。"""
    today = time.strftime("%Y-%m-%d")
    with LOCK:
        if _ai_count["day"] != today:
            _ai_count.update(day=today, n=0)
        if _ai_count["n"] >= AI_DAILY_LIMIT:
            return False
        _ai_count["n"] += 1
        return True


def _ai_log(entry):
    try:
        AI_LOG.parent.mkdir(exist_ok=True)
        with AI_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as e:
        print(f"[ai] 記録に失敗: {e}")


def run_ai(body):
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ApiError("話しかける内容を入力してください")
    text = text.strip()
    if len(text) > 200:
        raise ApiError("200文字以内で入力してください")

    with LOCK:
        state = json.loads(json.dumps(STATE))
    weather = get_weather()
    use_claude = ai_available()
    if use_claude and not _ai_take_slot():
        use_claude = False  # 上限に達したら、簡易解釈に切り替える
        limited = True
    else:
        limited = False
    result = ai.interpret(text, state, weather) if use_claude else ai.interpret_rules(text, state, weather)
    if limited:
        result["note"] = f"AIの1日の上限({AI_DAILY_LIMIT}回)に達したため、簡易解釈で処理しました"

    # AIの返答は「案」。実行前に全部検査し、1つでも不正なら何も送らない
    steps = []
    for a in result["actions"]:
        if "scene" in a:
            scene = SCENES.get(a["scene"])
            if not scene:
                raise ApiError("AIが未知のシーンを指定しました")
            steps += [(d, dict(v)) for d, v in scene["steps"]]
        else:
            steps.append((a.get("device"), a.get("values") or {}))
    with LOCK:
        for device, values in steps:
            validate(device, values)
        for device, values in steps:
            apply(device, values)
        if steps:
            save_state(STATE)

    done = [ai.describe(d, v) for d, v in steps]
    if steps:
        names = [f"「{ai.SCENE_JA[a['scene']]}」" for a in result["actions"] if "scene" in a]
        message = "実行しました: " + " / ".join(names or done)
    else:
        message = result["message"]
    _ai_log({"at": int(time.time()), "text": text, "engine": result["engine"], "actions": result["actions"],
             "done": done, "note": result.get("note")})
    return {"message": message, "engine": result["engine"], "executed": bool(steps), "note": result.get("note"), "detail": done}


def snapshot():
    with LOCK:
        return {
            "devices": json.loads(json.dumps(STATE)),
            "scenes": [{"id": k, "name": v["name"]} for k, v in SCENES.items()],
            "limits": {"tempMin": TEMP_MIN, "tempMax": TEMP_MAX},
            "dummy": SENDER.dummy,
            "log": SENDER.recent()[:8],
            "ai": {"engine": "claude" if ai_available() else "rules", "model": ai.MODEL if ai_available() else None},
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "RaspiRemote/0.1"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _static(self, rel):
        path = (STATIC / rel).resolve()
        if STATIC.resolve() not in path.parents or not path.is_file():
            return self._json({"ok": False, "error": "見つかりません"}, 404)
        data = path.read_bytes()
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".webmanifest":
            ctype = "application/manifest+json"
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8" if ctype.startswith("text/") or "javascript" in ctype else ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/api/state":
            return self._json(snapshot())
        if route == "/api/weather":
            return self._json({"ok": True, "weather": get_weather()})
        if route.startswith("/api/"):
            return self._json({"ok": False, "error": "見つかりません"}, 404)
        self._static("index.html" if route == "/" else route.lstrip("/"))

    def do_POST(self):
        route = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ApiError("JSON オブジェクトを送ってください")
            if route == "/api/command":
                message = run_command(body)
            elif route.startswith("/api/scenes/") and route.endswith("/run"):
                message = run_scene(route.split("/")[3])
            elif route == "/api/ai":
                extra = run_ai(body)
                return self._json({"ok": True, **extra, **snapshot()})
            else:
                raise ApiError("見つかりません", 404)
            self._json({"ok": True, "message": message, **snapshot()})
        except ApiError as e:
            self._json({"ok": False, "error": str(e)}, e.status)
        except ValueError:
            self._json({"ok": False, "error": "JSON が読めません"}, 400)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")  # 自宅Wi-Fi内の端末から開けるように
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()
    print(f"http://{args.host}:{args.port}  (赤外線はダミー送信)")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
