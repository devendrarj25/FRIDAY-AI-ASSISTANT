/**
 * A tiny WebSocket server for tests, using only node:http and node:crypto: it accepts one upgrade, sends text
 * frames to the client and hands the client's (masked) text frames to a callback. Payloads under 64 KB only.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";

export type FakeWs = {
  url: string;
  received: string[];
  send: (text: string) => void;
  close: () => Promise<void>;
  waitFor: (count: number, ms?: number) => Promise<void>;
};

function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const head =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : Buffer.from([0x81, 126, (body.length >> 8) & 255, body.length & 255]);
  return Buffer.concat([head, body]);
}

function parse(buffer: Buffer): string[] {
  const out: string[] = [];
  let at = 0;
  while (at + 2 <= buffer.length) {
    const opcode = buffer[at]! & 0x0f;
    let length = buffer[at + 1]! & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      length = buffer.readUInt16BE(offset);
      offset += 2;
    }
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!;
    if (opcode === 1) out.push(payload.toString("utf8"));
    at = offset + length;
  }
  return out;
}

export async function startFakeWs(
  onOpen?: (send: (text: string) => void) => void,
): Promise<FakeWs> {
  const received: string[] = [];
  let client: Socket | null = null;
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    client = socket as unknown as Socket;
    socket.on("data", (chunk) => received.push(...parse(chunk as Buffer)));
    socket.on("error", () => undefined);
    onOpen?.((text) => socket.write(frame(text)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/v1/realtime`,
    received,
    send: (text) => client?.write(frame(text)),
    close: () =>
      new Promise<void>((resolve) => {
        client?.destroy();
        server.close(() => resolve());
      }),
    waitFor: async (count, ms = 2000) => {
      const end = Date.now() + ms;
      while (received.length < count && Date.now() < end)
        await new Promise((r) => setTimeout(r, 10));
    },
  };
}
