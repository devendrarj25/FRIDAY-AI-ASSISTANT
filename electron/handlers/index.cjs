/**
 * Registers one handler per provider. A new provider is a new file listed here.
 */
"use strict";

const { registerHandler } = require("../provider-handler.cjs");

const CLOUD = {
  openai: require("./openai.cjs"),
  anthropic: require("./anthropic.cjs"),
  gemini: require("./gemini.cjs"),
  groq: require("./groq.cjs"),
  mistral: require("./mistral.cjs"),
  cohere: require("./cohere.cjs"),
  deepseek: require("./deepseek.cjs"),
  nvidia: require("./nvidia.cjs"),
  fireworks: require("./fireworks.cjs"),
  deepinfra: require("./deepinfra.cjs"),
  cerebras: require("./cerebras.cjs"),
  sambanova: require("./sambanova.cjs"),
  moonshot: require("./moonshot.cjs"),
  zhipu: require("./zhipu.cjs"),
  huggingface: require("./huggingface.cjs"),
  together: require("./together.cjs"),
  xai: require("./xai.cjs"),
  perplexity: require("./perplexity.cjs"),
  nebius: require("./nebius.cjs"),
  openrouter: require("./openrouter.cjs"),
};

const LOCAL = {
  ollama: require("./ollama.cjs"),
  lmstudio: require("./lmstudio.cjs"),
  llamacpp: require("./llamacpp.cjs"),
  vllm: require("./vllm.cjs"),
  localai: require("./localai.cjs"),
  jan: require("./jan.cjs"),
  koboldcpp: require("./koboldcpp.cjs"),
  transformers: require("./transformers.cjs"),
  gpt4all: require("./gpt4all.cjs"),
  mlx: require("./mlx.cjs"),
  local: require("./local.cjs"),
};

const CLOUD_IDS = Object.keys(CLOUD);
const LOCAL_IDS = Object.keys(LOCAL);

function registerAll() {
  for (const handler of [...Object.values(CLOUD), ...Object.values(LOCAL)]) {
    registerHandler(handler);
  }
  return { cloud: CLOUD_IDS, local: LOCAL_IDS };
}

module.exports = { CLOUD_IDS, LOCAL_IDS, registerAll };
