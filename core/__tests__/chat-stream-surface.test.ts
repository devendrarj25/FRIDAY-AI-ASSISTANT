/**
 * The routing surface of a turn (voice or chat) travels to the kernel with chat.stream, so the kernel recalls memory
 * on the short voice budget and does not repeat its persona for a spoken turn. Anything else is not forwarded.
 */
import { describe, expect, it } from "vitest";
import { streamHarness } from "./helpers/main-stream";

const model = { id: "local:test", type: "local", label: "Test", meta: {} };

async function sentParams(request: Record<string, unknown>) {
  const harness = streamHarness();
  const done = harness.run({ requestId: "r1", request, prompt: "hello there", model });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = harness.socket();
  socket.ready();
  const params = socket.params;
  socket.delta("ok");
  socket.result();
  await done;
  return params;
}

describe("chat.stream forwards the routing surface", () => {
  it.each(["voice", "chat"])("forwards %s", async (surface) => {
    expect((await sentParams({ routingSurface: surface }))["routingSurface"]).toBe(surface);
  });

  it("forwards nothing for an unknown or missing surface", async () => {
    expect(await sentParams({ routingSurface: "other" })).not.toHaveProperty("routingSurface");
    expect(await sentParams({})).not.toHaveProperty("routingSurface");
  });
});
