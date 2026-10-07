# Model lifecycle and local installation

## Lifecycle states

`discovered → validated → available → preferred → degraded → deprecated → migration-pending → retired`

Local artifact states:

`planned → resolving → downloading → paused → verifying → installing → registering → loading → warm → ready → unloading → removed → corrupt`

## Download/install pipeline

1. Resolve exact artifact/version.
2. Check hardware and storage budget.
3. Verify license/usage policy metadata.
4. Download to temporary location.
5. Support resumable chunks where source/runtime supports it.
6. Verify checksum or runtime-provided integrity.
7. Atomically move into managed store.
8. Register with runtime.
9. Load a minimal test.
10. Probe capabilities.
11. Persist model card and health state.
12. Mark ready only after successful verification.

## Runtime-specific rules

### Ollama

Use native pull/show/list operations. Do not scrape the UI or assume a filesystem layout.

### LM Studio

Use its documented local server/model-management API. Keep downloaded state and loaded state separate.

### llama.cpp

Treat GGUF artifact, quantization, context and server configuration as separate resources.

### vLLM/SGLang

A served model is a deployment. FRIDAY should not assume every local server exposes the same model list semantics as a model registry.

### LocalAI/Jan/MLX-LM

Use runtime-specific adapter metadata and normalize only after evidence is collected.
