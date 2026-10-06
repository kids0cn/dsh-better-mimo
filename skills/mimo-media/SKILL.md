---
name: mimo-media
description: 读取/理解图片、音频、视频文件的内容（转写语音、描述视频画面、看图）。当需要分析 .mp3/.wav/.m4a/.mp4/.mov 等 Claude Code Read 打不开的二进制媒体文件，需要"听懂这段音频""转写这段录音""看这个视频在演什么""识别图片里的文字"时使用。
---

# mimo-media — 读图片 / 音频 / 视频

## 什么时候用

`Read` 只放行图片 / PDF / Notebook。遇到 `.mp3` `.wav` `.m4a` `.mp4` `.mov` 会直接报
`cannot read binary`，**不要据此认为模型读不了** —— 模型支持，是工具通道挡住了。
本机也没有 whisper，所以音频转写只能走这条路。

图片其实 `Read` 就能看（原生视觉）。**只有音频和视频必须用本 skill。**

## 用法

```bash
python3 ~/.claude/skills/mimo-media/bin/mimo-media.py <文件>                  # 自动判类型
python3 ~/.claude/skills/mimo-media/bin/mimo-media.py <音频> --mode transcribe # 转文字
python3 ~/.claude/skills/mimo-media/bin/mimo-media.py <视频> --fps 2           # 描述画面
python3 ~/.claude/skills/mimo-media/bin/mimo-media.py <文件> --ask "回答这个问题"
python3 ~/.claude/skills/mimo-media/bin/mimo-media.py <文件> --json            # 带 usage
```

| 输入 | 默认行为 | 可用 `--mode` |
|---|---|---|
| 图片 png/jpg/gif/webp/bmp | 描述内容与文字 | describe |
| 音频 mp3/wav/flac/m4a/ogg | 描述声音，有人声则转写 | **transcribe**（纯转写，见下方实测） |
| 视频 mp4/mov/avi/wmv | 描述场景与动作，含镜头变化 | describe（`--fps` 0.1–10，默认 2） |

## transcribe 的实际行为（2026-10-06 实测）

1. 先按文档试 `mimo-v2.5-asr` —— **该网关上它 HTTP 200 但返回全空**
   （`content:""` / `audio:null` / `audio_tokens:[]`），拿不到文字。
2. 脚本随即**自动降级到 `mimo-v2.6-flash`**，用音频理解直接转写 —— **这条是真正生效的路径**。
3. 质量实测：
   - 中文人声（TTS 造的「…三百二十箱，差异为零…」）→ `…320箱，差异为0…`，**零错**
   - 纯电子提示音 → `无人声`，**不编造**
   - ⚠️ 但**降级提示词里没有"无人声就直说"时模型会幻觉**：同样那段提示音，
     `mimo-v2.6-pro` 曾凭空答出 `Please stand clear of the doors.`
     —— **不要删掉脚本里那句防幻觉提示词**。
4. ASR 请求**只能有 `input_audio`，不能带 text**，否则 400
   （`ASR request must not include text parts; text prompt is injected by the gateway`）。
   网关自己注入 prompt，别自作聪明加提问。

## 必须知道的坑

1. **只走 OpenAI 协议端点**（脚本已固定）。Anthropic 端点 `…/anthropic/v1/messages`
   **收不下音频/视频，但不报错** —— HTTP 200、`stop_reason: end_turn`、有完整正常回复，
   实际是把 `input_audio` block 丢掉了。**判据看 `usage.input_tokens`**：
   同一段音频 Anthropic 路径只有 **13**（纯文本量），OpenAI 路径是 `28 / audio_tokens 13`。
   ⚠️ **后果有两种，第二种更危险**：
   - 有时模型诚实说「我没有看到您上传的音频文件」
   - **有时直接幻觉**：2026-10-06 实测同一段 PX4 电子提示音，它编出「火车/地铁轨道上
     行驶的声音」，**看起来完全像正常回答**，不对照原音频根本发现不了
   → **别用 Anthropic 端点发媒体，也别把它的回复当转写结果。**
   （图片在 Anthropic 路径是正常的：`input_tokens 301`，确实被接收。
   另注意该路径 `max_tokens` 要留够 —— thinking 会先吃掉配额，实测 `max_tokens:150`
   导致 `stop_reason: max_tokens`、正文为空。）
2. **`mimo-v2.5-asr` 实测返回空**（见上节），脚本自动降级 `mimo-v2.6-flash`；
   V2.5 系列 **2026-10-21 10:00 下线**，降级路径不受影响。
3. **大小上限**：音视频 base64 ≤50MB（ASR ≤10MB）。超了先压：
   `ffmpeg -i in.mp4 -c:v libx264 -crf 28 -an out.mp4`
   `ffmpeg -i in.m4a -ac 1 -ar 16000 out.wav`（ASR 只收 wav/mp3）
4. **不支持本地路径直传** —— 必须 base64 或公网 URL，脚本已封装 base64。

## key

按顺序取：`$MIMO_MEDIA_KEY` → `$MIMO_API_KEY`（**仅当以 `tp-` 开头**，
因为 `.zshrc` 里那个 `MIMO_API_KEY` 是 `sk-…` 占位符，用了必 401）→
`~/.config/xiaomimimo/token-plan.key`。

端点：`$MIMO_MEDIA_BASE`（默认 `https://token-plan-cn.xiaomimimo.com/v1`）。

## 输出

stdout 是纯文本回复，直接读。`--json` 才带 `usage` / 耗时 / 实际模型。
失败时退出码非 0 并把 HTTP 错误打到 stderr（文件不存在 → 2）。

**超时**：脚本内置 240s，但**服务端偶发会慢到 100s 以上**（2026-10-06 实测同一条
`--ask` 第一次 shell 120s timeout 杀掉、重跑 8.7s 就成功）。
**别给这条命令套太短的 shell `timeout`**，也别因为一次超时就判定功能坏了，重试一次。
