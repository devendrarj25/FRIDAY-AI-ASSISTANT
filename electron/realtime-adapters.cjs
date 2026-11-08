/**
 * Wire translators for realtime providers whose messages are not the OpenAI style.
 *
 * FRIDAY's session code (`realtime-protocol.ts`) speaks one vocabulary. An adapter turns those client events into the
 * provider's own messages and the provider's messages back into that vocabulary, so the session code never learns
 * a second protocol. `encode` returns the wire messages to send now; `decode` returns the events to hand on and any
 * wire messages to send in reply (queued audio is released the moment the provider says it is ready).
 *
 * Gemini Live, from Google's own SDK source (googleapis/js-genai, read 2026-11-07) and the Live API reference:
 *   address  wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<key>
 *   first    { setup: { model: "models/<model>", generationConfig: { responseModalities, speechConfig? }, systemInstruction } }
 *   audio in { realtimeInput: { audio: { data, mimeType } } }, PCM16 little-endian at 16 kHz
 *   server   { setupComplete } and { serverContent: { modelTurn.parts[].inlineData, interrupted, turnComplete,
 *            inputTranscription, outputTranscription } }, audio out PCM16 at 24 kHz
 * Confirmed: the SDK accepts any audio mimeType that starts with `audio/` (`tAudioBlob`), and a Blob is { data, mimeType }.
 * Not confirmed: that the `;rate=16000` parameter is what the service wants (it is the documented convention) and the
 * shape of speechConfig, which is only sent when the owner sets a voice and is not set by the app. Neither has been
 * run against a live account.
 */
const MAX_QUEUED_AUDIO = 64;

function createGeminiAdapter({ model, inputRate = 16000 }) {
  let setupSent = false;
  let ready = false;
  let turnOpen = false;
  let heard = "";
  /** Audio that arrived before the provider said it was ready; bounded, newest kept. */
  const queued = [];

  const audioMessage = (data) => ({
    realtimeInput: { audio: { data, mimeType: `audio/pcm;rate=${inputRate}` } },
  });

  function encode(event) {
    switch (event?.type) {
      case "session.update": {
        if (setupSent) return [];
        setupSent = true;
        const session = event.session || {};
        const generationConfig = { responseModalities: ["AUDIO"] };
        if (session.voice) {
          generationConfig.speechConfig = {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: String(session.voice) } },
          };
        }
        const setup = {
          model: `models/${model}`,
          generationConfig,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        };
        if (session.instructions)
          setup.systemInstruction = { parts: [{ text: String(session.instructions) }] };
        return [{ setup }];
      }
      case "input_audio_buffer.append": {
        const message = audioMessage(String(event.audio || ""));
        if (ready) return [message];
        queued.push(message);
        if (queued.length > MAX_QUEUED_AUDIO) queued.shift();
        return [];
      }
      // Gemini ends a turn on its own voice detection and stops itself when new audio arrives; there is no
      // commit, response request, cancel or truncate message to send.
      default:
        return [];
    }
  }

  function decode(message) {
    const events = [];
    const replies = [];
    if (!message || typeof message !== "object") return { events, replies };
    if (message.setupComplete !== undefined && !ready) {
      ready = true;
      events.push({ type: "session.created" });
      replies.push(...queued.splice(0));
    }
    const content = message.serverContent;
    if (content && typeof content === "object") {
      if (content.interrupted === true) {
        turnOpen = false;
        events.push({ type: "input_audio_buffer.speech_started" });
      }
      const parts = Array.isArray(content.modelTurn?.parts) ? content.modelTurn.parts : [];
      for (const part of parts) {
        const data = part?.inlineData?.data;
        if (typeof data !== "string" || !data) continue;
        if (!turnOpen) {
          turnOpen = true;
          events.push({ type: "response.created" });
        }
        events.push({ type: "response.audio.delta", delta: data });
      }
      const said = content.outputTranscription?.text;
      if (typeof said === "string" && said)
        events.push({ type: "response.audio_transcript.delta", delta: said });
      const heardNow = content.inputTranscription?.text;
      if (typeof heardNow === "string" && heardNow) {
        heard = `${heard}${heardNow}`.slice(-2000);
        events.push({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: heard,
        });
      }
      if (content.turnComplete === true) {
        turnOpen = false;
        heard = "";
        events.push({ type: "response.done" });
      }
    }
    if (message.error && typeof message.error === "object") {
      events.push({
        type: "error",
        error: { message: String(message.error.message || "the provider reported an error") },
      });
    }
    return { events, replies };
  }

  return { encode, decode, inputRate };
}

module.exports = { createGeminiAdapter, MAX_QUEUED_AUDIO };
