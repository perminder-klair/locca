import { createServer } from 'node:http';

export async function startInferenceFixture(port = 0) {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/health') { res.end('{}'); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'locca-test.gguf' }] })); return; }
    if (req.url === '/props') { res.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192 }, total_slots: 1 })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    const messages = input.messages || [];
    const last = messages.at(-1);
    const user = messages.filter((m) => m.role === 'user').at(-1)?.content || '';
    const userText = typeof user === 'string' ? user : JSON.stringify(user);
    let tool;
    if (last?.role !== 'tool' && userText.includes('WRITE_FIXTURE')) tool = { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'Created by Eve through local inference.\n' }) };
    if (last?.role !== 'tool' && userText.includes('BASH_FIXTURE')) tool = { name: 'bash', arguments: JSON.stringify({ command: 'printf approved > approved.txt', timeoutSeconds: 10 }) };
    const content = last?.role === 'tool' ? 'The tool completed successfully. Your workspace is ready.' : `Local reply: ${userText.slice(0, 150)}`;
    const id = `chatcmpl-${requests.length}`;
    if (!input.stream) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, message: { role: 'assistant', content, ...(tool ? { tool_calls: [{ id: 'call_1', type: 'function', function: tool }] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', content: '' });
    if (userText.includes('SLOW_FIXTURE')) {
      let i = 0;
      const timer = setInterval(() => { send({ content: 'working ' }); if (++i === 100) { clearInterval(timer); send({}, 'stop'); res.end('data: [DONE]\n\n'); } }, 200);
      res.on('close', () => clearInterval(timer)); return;
    }
    if (tool) send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: tool }] });
    else { send({ content: content.slice(0, 12) }); send({ content: content.slice(12) }); }
    send({}, tool ? 'tool_calls' : 'stop');
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, requests, port: server.address().port };
}

if (process.argv[1]?.endsWith('/inference.js')) {
  const fixture = await startInferenceFixture(Number(process.argv[2]) || 0);
  console.log(`Inference fixture: ${fixture.port}`);
}
