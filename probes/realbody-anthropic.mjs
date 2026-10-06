// 用真实 dsh 请求体（chat 格式）转 anthropic，A/B：thinking enabled vs disabled
import fs from 'node:fs';

const KEY = fs.readFileSync(process.env.HOME + '/.config/xiaomimimo/token-plan.key', 'utf8').trim();
const URL = 'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages';
const src = JSON.parse(fs.readFileSync('/tmp/mimo-last-body.json', 'utf8'));

const parseDataUrl = (u) => {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(u);
  return m ? { media_type: m[1], data: m[2] } : null;
};
const part = (p) => {
  if (typeof p === 'string') return p ? [{ type: 'text', text: p }] : [];
  if (p.type === 'text') return p.text ? [{ type: 'text', text: p.text }] : [];
  if (p.type === 'image_url') {
    const u = typeof p.image_url === 'string' ? p.image_url : (p.image_url?.url ?? '');
    const d = parseDataUrl(u);
    return d ? [{ type: 'image', source: { type: 'base64', media_type: d.media_type, data: d.data } }] : [];
  }
  return [];
};
const contentOf = (c) => (typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : (c ?? []).flatMap(part));

const msgs = [];
let system = '';
for (const m of src.messages) {
  if (m.role === 'system') { system += (system ? '\n\n' : '') + (typeof m.content === 'string' ? m.content : contentOf(m.content).map(b => b.text).join('')); continue; }
  let role, blocks;
  if (m.role === 'assistant') {
    blocks = contentOf(m.content);
    for (const tc of m.tool_calls ?? []) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
    }
    if (blocks.length === 0) continue;
    role = 'assistant';
  } else if (m.role === 'tool') {
    role = 'user';
    blocks = [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: contentOf(m.content) }];
  } else { role = 'user'; blocks = contentOf(m.content); }
  if (role === 'user' && blocks.length === 0) continue;
  const prev = msgs.at(-1);
  if (prev && prev.role === role) prev.content.push(...blocks);
  else msgs.push({ role, content: blocks });
}
const tools = (src.tools ?? []).map(t => ({ name: t.function?.name ?? t.name, description: t.function?.description ?? t.description, input_schema: t.function?.parameters ?? t.input_schema ?? { type: 'object', properties: {} } }));

const raw = JSON.stringify(src);
console.log('[原body] image_url 出现次数=' + (raw.match(/image_url/g)||[]).length + ', base64 载荷=' + (raw.match(/base64,/g)||[]).length);
const kinds = {};
for (const m of msgs) for (const b of m.content) kinds[b.type] = (kinds[b.type] ?? 0) + 1;
const body = { model: src.model, stream: true, messages: msgs, max_tokens: src.max_tokens, tools, ...(system ? { system } : {}) };
console.log(`[转换] msgs=${msgs.length} tools=${tools.length} 块=${JSON.stringify(kinds)} 体积=${Math.round(JSON.stringify(body).length / 1024)}KB`);

async function probe(label, thinking, capMs) {
  const payload = { ...body, thinking: { type: thinking } };
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), capMs);
  let hdr = null, firstText = null, kinds = {}, textLen = 0, thinkLen = 0, err = null;
  try {
    const res = await fetch(URL, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload)
    });
    hdr = Date.now() - t0;
    if (!res.ok) { console.log(`[${label}] HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); clearTimeout(timer); return; }
    const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const j = line.slice(5).trim(); if (!j || j === '[DONE]') continue;
        let ev; try { ev = JSON.parse(j); } catch { continue; }
        kinds[ev.type] = (kinds[ev.type] ?? 0) + 1;
        if (ev.type === 'content_block_delta') {
          const d = ev.delta ?? {};
          if (d.type === 'text_delta') { textLen += (d.text ?? '').length; if (firstText === null) firstText = Date.now() - t0; }
          if (d.type === 'thinking_delta') thinkLen += (d.thinking ?? '').length;
        }
      }
    }
  } catch (e) { err = e.name === 'AbortError' ? 'TIMEOUT' : e.message; }
  clearTimeout(timer);
  console.log(`[${label}] thinking=${thinking} hdr=${hdr ? (hdr / 1000).toFixed(1) + 's' : '-'} 首文本=${firstText !== null ? (firstText / 1000).toFixed(1) + 's' : '无'} 总=${((Date.now() - t0) / 1000).toFixed(1)}s 文本字数=${textLen} 思考字数=${thinkLen} ${err ? 'err=' + err : ''} kinds=${JSON.stringify(kinds)}`);
}

await probe('A', 'enabled', 150000);
await new Promise(r => setTimeout(r, 3000));
await probe('B', 'disabled', 150000);
