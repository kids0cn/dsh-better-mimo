// 探针：长历史(597条, ~600KB) + 图片只在最新位置 —— chat 面挂不挂？
import fs from 'node:fs';
const KEY = fs.readFileSync(process.env.HOME + '/.config/xiaomimimo/token-plan.key', 'utf8').trim();
const URL = 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions';
const imgB64 = fs.readFileSync('/home/developer/test_mimo/blind3.png').toString('base64');
const imgPart = { type: 'image_url', image_url: { url: `data:image/png;base64,${imgB64}` } };

// 合成 ~600KB 长历史
const msgs = [{ role: 'system', content: 'You are MiMo, an AI assistant developed by Xiaomi.' }];
let i = 0;
while (JSON.stringify(msgs).length < 580 * 1024) {
  i++;
  msgs.push({ role: 'user', content: `第${i}轮问题：请解释下面这段日志的含义并给出修复建议。` + 'x'.repeat(700) });
  msgs.push({ role: 'assistant', content: `第${i}轮回答：` + '分析如下：这个问题通常由配置漂移引起，建议先核对版本，再逐项回放差异。' + 'y'.repeat(700) });
}
const tools = Array.from({ length: 20 }, (_, n) => ({
  type: 'function',
  function: { name: `tool_${n}`, description: `工具${n}：执行一次检查并返回结构化结果。` + 'd'.repeat(200),
    parameters: { type: 'object', properties: { query: { type: 'string', description: '查询串' }, limit: { type: 'number' } }, required: ['query'] } }
}));

function withLastImage() {
  const m = JSON.parse(JSON.stringify(msgs));
  const last = m[m.length - 1];
  last.content = [{ type: 'text', text: '看这张图里写了什么数字？' }, imgPart];
  return m;
}
function withToolImage() {
  const m = JSON.parse(JSON.stringify(msgs));
  // 倒数第二组：assistant 带 tool_calls，tool 结果里带图
  const pos = m.length - 3;
  m[pos] = { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_image', arguments: '{"path":"a.png"}' } }] };
  m[pos + 1] = { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: '图片内容如下' }, imgPart] };
  m.push({ role: 'user', content: '图里写了什么数字？只答数字。' });
  return m;
}

async function probe(label, messages) {
  const body = { model: 'mimo-v2.6-flash', messages, tools, stream: true, max_tokens: 64 };
  const size = JSON.stringify(body).length;
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 95000);
  let hdr = null, chunks = 0, text = '', err = null, http = null;
  try {
    const res = await fetch(URL, { method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
    http = res.status; hdr = Date.now() - t0;
    if (!res.ok) { console.log(`[${label}] HTTP ${res.status} ${(await res.text()).slice(0, 300)}`); clearTimeout(timer); return; }
    const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const j = line.slice(5).trim(); if (!j || j === '[DONE]') continue;
        let ev; try { ev = JSON.parse(j); } catch { continue; }
        chunks++;
        const d = ev.choices?.[0]?.delta;
        if (d?.content) text += d.content;
      }
    }
  } catch (e) { err = e.name === 'AbortError' ? 'TIMEOUT(95s)' : e.message; }
  clearTimeout(timer);
  console.log(`[${label}] msgs=${messages.length} 体积=${Math.round(size / 1024)}KB hdr=${hdr ? (hdr / 1000).toFixed(1) + 's' : '-'} chunks=${chunks} 总=${((Date.now() - t0) / 1000).toFixed(1)}s 答="${text.slice(0, 60)}" ${err ? 'err=' + err : ''}`);
}

await probe('C-对照无图', JSON.parse(JSON.stringify(msgs)));
await new Promise(r => setTimeout(r, 5000));
await probe('A-图在最新user', withLastImage());
await new Promise(r => setTimeout(r, 5000));
await probe('B-图在tool结果', withToolImage());
