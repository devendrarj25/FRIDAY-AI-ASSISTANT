// FRIDAY · tools/media/comfyui-generate
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run(input = {}) {
  try {
    const comfy = require(path.join(ELECTRON, "comfyui-client.cjs"));
    const paths = require(path.join(ELECTRON, "friday-paths.cjs"));
    const outDir = input.outDir || path.join(paths.ensureDir("assets"), "comfyui");
    if (input.workflow) {
      const workflow =
        typeof input.workflow === "string" ? JSON.parse(input.workflow) : input.workflow;
      return await comfy.run(workflow, { outDir });
    }
    const prompt = String(input.prompt || "").trim();
    if (!prompt) return { ok: false, files: [], reason: "Say what the image should show." };
    const live = await comfy.status();
    if (!live.online) return { ok: false, files: [], reason: live.reason };
    const available = await comfy.checkpoints();
    const checkpoint = input.checkpoint
      ? available.find((name) => name === input.checkpoint) || ""
      : available[0] || "";
    if (!checkpoint) {
      return {
        ok: false,
        files: [],
        reason: input.checkpoint
          ? `ComfyUI has no checkpoint named ${input.checkpoint}.`
          : "ComfyUI has no checkpoint installed. Put a model in ComfyUI's models/checkpoints folder.",
      };
    }
    const result = await comfy.run(comfy.textToImageWorkflow({ ...input, prompt, checkpoint }), {
      outDir,
    });
    return { ...result, checkpoint };
  } catch (error) {
    return { ok: false, files: [], reason: String(error.message || error) };
  }
}

module.exports = { run };
