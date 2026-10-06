# dsh-better-mimo

> 让 **mimo 模型在 DSH 里具备完整的多模态能力** —— 纯配置接入 Anthropic 协议面，**零代码补丁**。

DSH 的 MiMo 适配器（`@mimo-codex/dsh-llm-mimo`）原生支持两套协议：OpenAI Chat（默认）与
Anthropic Messages。默认的 chat 面在「工具读图」和「长会话 + 图片」两个场景下是坏的；
换到 anthropic 面即全部打通——这正是 Claude Code 走 anthropic 协议能直接发图的原因。

---

## 30 秒接入

前置：DSH 已装 `@mimo-codex/dsh-llm-mimo`（**上游原版即可，不需要任何 pnpm patch**），凭据
`XIAOMI_TOKEN_PLAN_CN_API_KEY` 已存（token-plan 网关的 key）。

1. 把 [config/cordis.patch.yml.snippet](config/cordis.patch.yml.snippet) 的 `llm-mimo` 段
   合并进你的 profile `~/.dsh/profiles/<你的profile>/cordis.patch.yml`
2. 预飞 + 重启：

   ```bash
   dsh --profile web --dump-config | grep -A8 'id: llm-mimo'   # 应看到 apiFormat: anthropic
   kill -9 $(systemctl show dsh-web.service -p MainPID --value) # systemd Restart=on-failure 3 秒拉起
   ```

3. 验收：粘一张截图问「图里写了什么」→ 模型应逐字读出；再用一次 `read_image`
   → 工具回传的图模型也应能看见。

---

## 为什么必须换面：三个实测的坑

### 坑 1｜上游 chat 面丢工具图（`read_image` 永远看不了）

`serializeChat` 序列化 `role: "tool"` 消息时只取 text 块，image 块被静默丢弃：

```js
// 上游 dsh-llm-mimo（OpenAI 面）
if (message.role === "tool") {
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  messages.push({ role: "tool", tool_call_id, content: text });   // ← image 块没了
}
```

你自己粘的图（user 角色）一直是好的；坏的是**工具读回来的图**。上游 issue：
[dalizi2333/dsh-llm-mimo#1](https://github.com/dalizi2333/dsh-llm-mimo/issues/1)。

anthropic 面没有这个 bug：`tool_result.content` 生来就是块数组，`input()` 会把 image 转成
`{type:"image", source:{type:"base64", ...}}`。

### 坑 2｜chat 面「长历史 + 任意图片」= 网关静默挂死

HTTP 200、响应头正常，之后 **0 字节直到客户端超时**。复现脚本 [probes/probe-longimg.mjs](probes/probe-longimg.mjs)：

| 请求体 | 结果 |
|---|---|
| 777 条消息、589KB、**无图** | ✅ 13.2s 完整流 |
| 777 条消息、**1 张图（在最新一条 user）** | ❌ hdr 5.6s 后 **95s 零字节** |
| 777 条消息、**1 张图（在 tool 结果里）** | ❌ 同上 |
| 100 条消息 + 4 张图（真实会话体） | ✅ 74s |

关键结论：**图片放在哪都不行**——只要历史够长，最新一条带图也挂。所以「只保留最近 N 条
图片」这类窗口策略救不了它，**换面是唯一出路**。（阈值二分脚本：
[probes/probe-bracket.mjs](probes/probe-bracket.mjs)）

同一份真实请求体（595 条消息 / 69 工具 / 带图，928KB）换到 anthropic 面：
**hdr 5.5s → 首包 28.5s → 36s 完整流** ✅

### 坑 3｜anthropic 面默认开思考（慢 + 400 约束）

官方文档（[深度思考](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/deep-thinking)）：
**所有 mimo 模型 `thinking.type` 默认 enabled**，上游插件硬编码跟随默认。同体量真 body A/B：

| | `thinking: enabled` | `thinking: disabled` |
|---|---|---|
| 总耗时 | **62.7s** | **25.3s** |
| 可见文本 | 0 字（只出思考） | 直接出答案 |

且官方硬约束：**开思考 + 历史有工具调用 → assistant 必须完整回传 `reasoning_content`，否则 400**。
DSH 这类重度 agent 会话随时可能裁剪/压缩历史，撞上就是全线 400。

- 追求稳定快：`thinking: disabled`（推荐日常）
- 追求官方默认推理：`thinking: enabled`（改一行；大回合首字 60s+ 属正常，别中途切走）

> 注意：开思考时 `temperature`/`top_p` 会被强制为 1.0/0.95，传了也没用。

### 附带坑｜anthropic 面静默吞 audio/video

音频视频在 anthropic 面会被静默丢弃（不报错）。所以配置里把 `modelsJson` 的
`inputModalities` 收紧成 `["text","image"]` —— 让 DSH **显式拒绝**而不是静默丢数据。
音视频请走下面的 `mimo-media` skill（OpenAI 面）。

---

## 最终配置

见 [config/cordis.patch.yml.snippet](config/cordis.patch.yml.snippet)，四行是关键：

```yaml
apiFormat: anthropic      # 换面：解决坑1、坑2
baseURL: https://token-plan-cn.xiaomimimo.com/anthropic
thinking: disabled        # 解决坑3（要官方默认开思考就改成 enabled）
modelsJson: '...inputModalities:["text","image"]...'   # 音视频显式拦截（坑4）
```

---

## 音视频配套：`skills/mimo-media`

Anthropic 面不能传音视频 → [skills/mimo-media](skills/mimo-media/SKILL.md) 这个 skill 直接
打 **OpenAI 面** 完成转写 / 合成 / 问答：

```bash
python3 bin/mimo-media.py transcribe 音频.m4a      # ASR（失败自动回落 v2.6-flash）
python3 bin/mimo-media.py chat 问题 音频.m4a       # 听懂它并回答
```

- Key 顺序：`$MIMO_MEDIA_KEY` → `$MIMO_API_KEY`（**仅当 `tp-` 开头**）→ `~/.config/xiaomimimo/token-plan.key`
- 支持 MP3/WAV/FLAC/M4A/OGG（与官方容器集一致）
- 把 `mimo-media/` 放进任一技能目录即可（Claude Code: `~/.claude/skills/`）

---

## 探针脚本（可复现全部结论）

| 脚本 | 验证什么 |
|---|---|
| [probes/probe-longimg.mjs](probes/probe-longimg.mjs) | 长历史 + 图挂死复现（chat 面） |
| [probes/probe-bracket.mjs](probes/probe-bracket.mjs) | 挂死阈值二分（150 / 300 条） |
| [probes/realbody-anthropic.mjs](probes/realbody-anthropic.mjs) | 真实请求体转 anthropic、thinking A/B |

```bash
# 都是裸 fetch 探针，改头部的 KEY 来源即可
node probes/probe-longimg.mjs
```

---

## 已知边界

- **audio/video** 只能走 OpenAI 面（`mimo-media` skill），anthropic 面不可用
- **chat 面丢图** 是上游 bug，等 [issue #1](https://github.com/dalizi2333/dsh-llm-mimo/issues/1) 修复；
  本仓库的方案（换面）绕开它，不依赖上游
- **开思考的延迟与 `reasoning_content` 回传约束** 是官方行为，见坑 3
- GUI 的模型配置页不暴露 `apiFormat`，只能改 profile 的 `cordis.patch.yml`（改完需重启）

## 验收记录（2026-10-06）

- 盲测：anthropic 面读出图内数字 `3042`、`6121`（与真值一致）
- 端到端：DSH 内发商品详情页截图 → 逐行读出 Arduino 代码与串口数值
- 速度：626KB 真 body，关思考 25.3s / 开思考 62.7s；anthropic 面长历史带图 36s 完整流
