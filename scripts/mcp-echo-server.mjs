// Minimal MCP echo server over stdio (JSON-RPC 2.0, newline-delimited).
// Implements the handshake + tools/list + tools/call so the cockpit's
// "Load echo template" probe works out of the box and agents can call `echo`.
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'inventory-echo', version: '1.0.0' };
const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes back the provided message',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Text to echo back' } },
      required: ['message'],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const message = params?.arguments?.message ?? '';
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${message}` }] } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
// notifications (no id) like notifications/initialized need no reply.
