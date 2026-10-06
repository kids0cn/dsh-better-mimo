#!/usr/bin/env python3
"""mimo-media —— 读图片 / 音频 / 视频的内容，绕过 Claude Code `Read` 的二进制限制。

为什么存在
----------
Claude Code 的 `Read` 只放行图片 / PDF / Notebook，`.mp3` `.mp4` 一律
`cannot read binary`；本机也没有 whisper。但 MiMo V2.6 本身支持图片、音频、
视频理解，所以直接调 API 就能用。

关键坑（务必保留这行注释）
--------------------------
**Anthropic 协议端点（`…/anthropic/v1/messages`）吃不下音视频**，塞
`{"type":"input_audio"}` 不报错（HTTP 200），而是让模型回答「我没有看到您上传的
音频文件」—— 输入被静默吞掉。所以本脚本**只走 OpenAI 协议**（`…/v1/chat/completions`），
它对图片 / 音频 / 视频三种模态都实测通过。

用法
----
  mimo-media.py <文件>                      # 按类型自动选模式
  mimo-media.py <音频> --mode transcribe    # 语音转文字（ASR，失败自动降级）
  mimo-media.py <视频> --mode describe --fps 2
  mimo-media.py <任意> --ask "回答这个问题"
  mimo-media.py <文件> --json               # 连 usage 一起打 JSON

key 顺序：$MIMO_MEDIA_KEY → $MIMO_API_KEY（仅当以 tp- 开头）→ ~/.config/xiaomimimo/token-plan.key
"""
import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.request

DEFAULT_BASE = os.environ.get(
    "MIMO_MEDIA_BASE", "https://token-plan-cn.xiaomimimo.com/v1"
)
KEY_FILE = os.path.expanduser("~/.config/xiaomimimo/token-plan.key")

# 优先用 V2.6（不受 2026-10-21 V2.5 下线影响）；ASR 专用模型排后面，失败自动降级
MODELS_V26 = ["mimo-v2.6-flash", "mimo-v2.6-pro"]
MODEL_ASR = "mimo-v2.5-asr"   # 页面未标下线，但挂 V2.5 名下，故必须能降级

IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
AUD_EXT = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac"}
VID_EXT = {".mp4", ".mov", ".avi", ".wmv", ".mkv", ".webm"}
ASR_EXT = {".wav", ".mp3"}          # ASR 只收这两种
ASR_MAX_B64 = 10 * 1024 * 1024      # 文档：base64 ≤ 10MB
MEDIA_MAX_B64 = 50 * 1024 * 1024    # 文档：音视频 base64 ≤ 50MB


def die(msg, code=2):
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(code)


def load_key():
    for src, val in (
        ("$MIMO_MEDIA_KEY", os.environ.get("MIMO_MEDIA_KEY", "")),
        ("$MIMO_API_KEY", os.environ.get("MIMO_API_KEY", "")),
        (KEY_FILE, ""),
    ):
        if not val and src == KEY_FILE:
            try:
                val = open(KEY_FILE).read().strip()
            except OSError:
                continue
        if not val:
            continue
        # MIMO_API_KEY 在本机 .zshrc 里是 sk-… 占位符，直接用只会 401
        if src == "$MIMO_API_KEY" and not val.startswith("tp-"):
            continue
        return val, src
    die(f"找不到可用 key。设 $MIMO_MEDIA_KEY，或写入 {KEY_FILE}（0600）")


def kind_of(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in IMG_EXT:
        return "image"
    if ext in AUD_EXT:
        return "audio"
    if ext in VID_EXT:
        return "video"
    mime = mimetypes.guess_type(path)[0] or ""
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("audio/"):
        return "audio"
    if mime.startswith("video/"):
        return "video"
    die(f"不认识的文件类型：{path}（扩展名 {ext or '无'}）")


def b64_data_url(path, mime):
    size = os.path.getsize(path)
    if int(size * 4 / 3) > MEDIA_MAX_B64:
        die(
            f"文件 {size/1024/1024:.1f}MB，base64 超 50MB 上限。"
            f"先压缩：ffmpeg -i <in> -c:v libx264 -crf 28 -an <out>.mp4"
        )
    data = base64.b64encode(open(path, "rb").read()).decode()
    return f"data:{mime or 'application/octet-stream'};base64,{data}"


def call(payload, key, timeout=240):
    req = urllib.request.Request(
        DEFAULT_BASE + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return time.time() - t, 200, json.loads(r.read())
    except Exception as e:
        body = e.read().decode()[:500] if hasattr(e, "read") else str(e)
        return time.time() - t, getattr(e, "code", "ERR"), {"error": body}


def reply_text(d):
    if not isinstance(d, dict):
        return str(d)
    if d.get("choices"):
        return d["choices"][0].get("message", {}).get("content", "")
    if d.get("error"):
        return ""
    return json.dumps(d, ensure_ascii=False)


def build(kind, path, mode, ask, fps, language):
    """返回 (payload, 说明标签)。"""
    url = b64_data_url(path, mimetypes.guess_type(path)[0])
    if kind == "image":
        block = {"type": "image_url", "image_url": {"url": url}}
        model = MODELS_V26[0]
        text = ask or "描述这张图片：内容、文字、配色、布局。"
        return model, block, text

    if kind == "audio":
        if mode == "transcribe":
            ext = os.path.splitext(path)[1].lower()
            if ext not in ASR_EXT:
                # ASR 只收 wav/mp3 —— 转码后重试由调用方决定，这里如实报错
                die(f"ASR 只支持 wav/mp3，当前是 {ext}。"
                    f"先转码：ffmpeg -i <in> -ac 1 -ar 16000 out.wav")
            if len(url) > ASR_MAX_B64:
                die("ASR base64 上限 10MB，先分段或转码压缩")
            return MODEL_ASR, {"type": "input_audio", "input_audio": {"data": url}}, None
        block = {"type": "input_audio", "input_audio": {"data": url}}
        model = MODELS_V26[0]
        text = ask or "描述这段音频：是什么声音？有人说话就转写全部内容；无人声就说明音色、节奏、环境音。"
        return model, block, text

    # video
    block = {
        "type": "video_url",
        "video_url": {"url": url},
        "fps": fps,
        "media_resolution": "default",
    }
    model = MODELS_V26[0]
    text = ask or (
        "描述这段视频：什么场景、有哪些物体、发生了什么动作，"
        "按时间顺序说清镜头和画面变化。"
    )
    return model, block, text


def main():
    ap = argparse.ArgumentParser(description="读图片/音频/视频内容（MiMo 多模态）")
    ap.add_argument("path")
    ap.add_argument("--mode", choices=["auto", "describe", "transcribe"], default="auto")
    ap.add_argument("--ask", help="自定义问题")
    ap.add_argument("--fps", type=float, default=2.0, help="视频抽帧率 0.1-10，默认 2")
    ap.add_argument("--language", default="zh", help="ASR 语言 auto/zh/en")
    ap.add_argument("--model", help="覆盖默认模型")
    ap.add_argument("--json", action="store_true", help="输出 JSON（含 usage）")
    a = ap.parse_args()

    if not os.path.isfile(a.path):
        die(f"文件不存在：{a.path}")
    key, key_src = load_key()
    kind = kind_of(a.path)
    mode = a.mode
    if mode == "auto":
        mode = "transcribe" if kind == "audio" else "describe"

    model, block, text = build(kind, a.path, mode, a.ask, a.fps, a.language)
    if a.model:
        model = a.model

    content = [block]
    if mode == "transcribe":
        # 网关硬性要求：ASR 请求里不许出现 text，prompt 由网关自己注入
        #   400 "ASR request must not include text parts; text prompt is injected
        #        by the gateway"
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": [block]}],
            "asr_options": {"language": a.language},
        }
    else:
        content.append({"type": "text", "text": text})
        payload = {"model": model, "max_completion_tokens": 2000,
                   "messages": [{"role": "user", "content": content}]}

    dt, code, d = call(payload, key)
    out = reply_text(d)

    # ASR 模型若返回空（实测 mimo-v2.5-asr 在 Token Plan 网关上就是空输出），
    # 自动降级到 V2.6，让音频理解直接给文字。
    # 提示词必须包含"无人声就直说" —— 否则模型会**编造**转写内容：
    # 2026-10-06 实测给一段纯电子提示音，mimo-v2.6-pro 凭空答出
    # "Please stand clear of the doors."（幻觉）。
    if mode == "transcribe" and not out:
        for m in MODELS_V26:
            payload["model"] = m
            payload.pop("asr_options", None)
            payload["max_completion_tokens"] = 2000
            payload["messages"][0]["content"].append(
                {"type": "text",
                 "text": "把这段音频里人说的每一句话原样转写出来，保留标点和分段。"
                         "如果音频里没有任何人说话，只回答「无人声」，"
                         "不要描述音效，更不要编造任何句子。"}
            )
            dt, code, d = call(payload, key)
            out = reply_text(d)
            if out:
                model = m
                break

    if not out:
        die(f"HTTP {code}: {d.get('error', d)}", 1)

    if a.json:
        print(json.dumps({
            "file": a.path, "kind": kind, "mode": mode, "model": model,
            "seconds": round(dt, 1), "http": code, "usage": d.get("usage"),
            "text": out,
        }, ensure_ascii=False, indent=2))
    else:
        print(out)


if __name__ == "__main__":
    main()
