/**
 * Cloud speech requests (Sarvam and Azure Speech), made in the main process so a key never reaches the renderer.
 *
 * Request shapes follow the providers' own pages, read on 2026-11-07:
 *   Sarvam text to speech   POST https://api.sarvam.ai/text-to-speech, header `api-subscription-key`, JSON
 *                           { text, language_code, speaker?, model?, speech_sample_rate? } -> { audios: [base64 WAV] }
 *   Sarvam speech to text   POST https://api.sarvam.ai/speech-to-text, multipart { file, model?, mode?, language_code? }
 *                           (mode `codemix` keeps English words in Latin script); short audio, under 30 seconds
 *   Azure text to speech    POST https://<region>.tts.speech.microsoft.com/cognitiveservices/v1, headers
 *                           `Ocp-Apim-Subscription-Key`, `Content-Type: application/ssml+xml`,
 *                           `X-Microsoft-OutputFormat`, `User-Agent`; body SSML
 * Nothing here has been run against a live account. Gates (checked here, in this order): cloud voice switched on,
 * the provider allowed, privacy mode off, a key saved. Quotas are counted by the renderer's usage ledger before
 * the call. Only the two fixed hosts below are ever contacted; an error text is scrubbed of the key.
 */
const SARVAM_HOST = "api.sarvam.ai";
const REGION = /^[a-z0-9]{3,30}$/;
const VOICE = /^[A-Za-z0-9-]{3,64}$/;
const LANG = /^[a-z]{2,3}-[A-Z]{2}$/;
const MAX_TEXT = 2500;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

const SECRET_IDS = { sarvam: "voice-sarvam", "azure-speech": "voice-azure-speech" };

const escapeXml = (text) =>
  String(text).replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c],
  );

/**
 * Speakers whose gender the provider's page states (bulbul:v2). The v3 and v4-flash pages list names without
 * saying which are female, so a voice that must be female uses a v2 name. Anushka is the default.
 */
const SARVAM_V2_FEMALE = ["anushka", "manisha", "vidya", "arya"];
const SARVAM_V2_MALE = ["abhilash", "karun", "hitesh"];
const SARVAM_DEFAULT_SPEAKER = "anushka";

function sarvamModelFor(speaker) {
  if (SARVAM_V2_FEMALE.includes(speaker) || SARVAM_V2_MALE.includes(speaker)) return "bulbul:v2";
  // A v4 flash persona is name_lang_style: the language part is two letters (hi) or a mix such as enhi.
  return /^[a-z]+_[a-z]{2,5}_[a-z]+$/.test(speaker) ? "bulbul:v4-flash" : "bulbul:v3";
}

function buildSarvamTts({ text, language, speaker, model, rate, pace }) {
  const voice = speaker || SARVAM_DEFAULT_SPEAKER;
  const chosen = model || sarvamModelFor(voice);
  const body = {
    text,
    language_code: language,
    model: chosen,
    // 22050 Hz is the provider's default; the higher rates are listed for v3 and v4-flash.
    speech_sample_rate: rate ?? (chosen === "bulbul:v2" ? 22050 : 24000),
    speaker: voice,
  };
  // Pace is 0.5 to 2.0 on v3 and v4-flash and 0.3 to 3.0 on v2; 1.0 is left to the provider's default.
  if (typeof pace === "number" && Number.isFinite(pace) && Math.abs(pace - 1) > 0.01) {
    body.pace = Math.min(2, Math.max(0.5, Math.round(pace * 100) / 100));
  }
  return {
    url: `https://${SARVAM_HOST}/text-to-speech`,
    headers: { "Content-Type": "application/json" },
    keyHeader: "api-subscription-key",
    body: JSON.stringify(body),
  };
}

function parseSarvamTts(json) {
  const first = Array.isArray(json?.audios) ? json.audios[0] : null;
  return typeof first === "string" && first.length > 0
    ? { audioBase64: first, mime: "audio/wav" }
    : null;
}

function buildAzureTts({ region, voice, language, text }) {
  const body =
    `<speak version='1.0' xml:lang='${language}'><voice xml:lang='${language}' name='${voice}'>` +
    `${escapeXml(text)}</voice></speak>`;
  return {
    url: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    headers: {
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
      "User-Agent": "FRIDAY",
    },
    keyHeader: "Ocp-Apim-Subscription-Key",
    body,
  };
}

function parseSarvamStt(json) {
  if (!json || typeof json.transcript !== "string") return null;
  return {
    text: json.transcript,
    language: typeof json.language_code === "string" ? json.language_code : null,
    confidence: typeof json.language_probability === "number" ? json.language_probability : null,
  };
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   getSecret: (id: string) => string,
 *   prefs: () => any,
 * }} deps
 */
function createVoiceCloud({ fetchImpl = globalThis.fetch, getSecret, prefs }) {
  function gate(provider) {
    const secretId = SECRET_IDS[provider];
    if (!secretId) return { ok: false, error: "that provider has no speech connection here" };
    const voice = prefs() || {};
    const cloud = voice.cloudVoice || {};
    if (cloud.cloudEnabled !== true) return { ok: false, error: "cloud voice is switched off" };
    if (!Array.isArray(cloud.allowedProviders) || !cloud.allowedProviders.includes(provider))
      return { ok: false, error: "that provider is not on the allowed list" };
    if (voice.privacyMode === true) return { ok: false, error: "Keep speech on this PC is on" };
    const key = getSecret(secretId);
    if (!key) return { ok: false, error: "no key is saved for that provider" };
    return { ok: true, key, cloud };
  }

  async function call(spec, key, provider) {
    if (typeof fetchImpl !== "function")
      return { ok: false, error: "this runtime has no network client" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(spec.url, {
        method: "POST",
        headers: { ...spec.headers, [spec.keyHeader]: key },
        body: spec.body,
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        const reason =
          response.status === 401 || response.status === 403
            ? "the key was refused"
            : response.status === 429
              ? "the provider's rate or quota limit was reached"
              : `the provider answered ${response.status}`;
        return { ok: false, error: reason, status: response.status, provider };
      }
      return { ok: true, response };
    } catch (error) {
      const text = String(error?.message || error)
        .split(key)
        .join("[key]");
      return {
        ok: false,
        error: error?.name === "AbortError" ? "the provider did not answer in time" : text,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** @returns {Promise<{ok: boolean, error?: string, audioBase64?: string, mime?: string, provider?: string}>} */
  async function speak(provider, request) {
    const text = String(request?.text ?? "").trim();
    if (!text) return { ok: false, error: "there is no text to speak" };
    if (text.length > MAX_TEXT)
      return { ok: false, error: `speak at most ${MAX_TEXT} characters at a time` };
    const language = String(request?.language ?? "");
    if (!LANG.test(language)) return { ok: false, error: "name the language as hi-IN or en-IN" };
    const allowed = gate(provider);
    if (!allowed.ok) return allowed;
    let spec;
    if (provider === "sarvam") {
      const speaker = request.speaker ? String(request.speaker) : "";
      if (speaker && !/^[a-z0-9_]{2,40}$/.test(speaker))
        return { ok: false, error: "that voice name is not valid" };
      const limit =
        sarvamModelFor(speaker || SARVAM_DEFAULT_SPEAKER) === "bulbul:v2" ? 1500 : MAX_TEXT;
      if (text.length > limit)
        return { ok: false, error: `that voice speaks at most ${limit} characters at a time` };
      const pace = Number(request.pace);
      spec = buildSarvamTts({
        text,
        language,
        speaker,
        ...(Number.isFinite(pace) ? { pace } : {}),
      });
    } else {
      const region = String(allowed.cloud.azureRegion || "");
      const voice = String(allowed.cloud.azureVoice || "");
      if (!REGION.test(region))
        return { ok: false, error: "set the Azure region first (for example centralindia)" };
      if (!VOICE.test(voice)) return { ok: false, error: "set the Azure voice name first" };
      spec = buildAzureTts({ region, voice, language, text });
    }
    const out = await call(spec, allowed.key, provider);
    if (!out.ok) return out;
    try {
      if (provider === "sarvam") {
        const parsed = parseSarvamTts(await out.response.json());
        if (!parsed) return { ok: false, error: "the provider returned no audio" };
        if (parsed.audioBase64.length > MAX_AUDIO_BYTES * 1.4)
          return { ok: false, error: "the audio was too large" };
        return { ok: true, provider, ...parsed };
      }
      const buffer = Buffer.from(await out.response.arrayBuffer());
      if (buffer.length === 0) return { ok: false, error: "the provider returned no audio" };
      if (buffer.length > MAX_AUDIO_BYTES) return { ok: false, error: "the audio was too large" };
      return { ok: true, provider, audioBase64: buffer.toString("base64"), mime: "audio/wav" };
    } catch (error) {
      return {
        ok: false,
        error: `could not read the audio (${String(error?.message || error)
          .split(allowed.key)
          .join("[key]")})`,
      };
    }
  }

  /** Sarvam only: short audio (under 30 seconds) as a WAV, base64. Hinglish uses the codemix mode. */
  async function transcribe(provider, request) {
    if (provider !== "sarvam")
      return { ok: false, error: "that provider has no speech-to-text connection here" };
    const audio = Buffer.from(String(request?.audioBase64 ?? ""), "base64");
    if (audio.length === 0) return { ok: false, error: "there is no audio" };
    if (audio.length > MAX_UPLOAD_BYTES)
      return { ok: false, error: "that audio is too long; send under 30 seconds" };
    const language = String(request?.language ?? "unknown");
    if (language !== "unknown" && !LANG.test(language))
      return { ok: false, error: "name the language as hi-IN, or unknown" };
    const allowed = gate(provider);
    if (!allowed.ok) return allowed;
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
    form.append("language_code", language);
    form.append("mode", request?.hinglish === false ? "transcribe" : "codemix");
    const out = await call(
      {
        url: `https://${SARVAM_HOST}/speech-to-text`,
        headers: {},
        keyHeader: "api-subscription-key",
        body: form,
      },
      allowed.key,
      provider,
    );
    if (!out.ok) return out;
    const parsed = parseSarvamStt(await out.response.json().catch(() => null));
    return parsed
      ? { ok: true, provider, ...parsed }
      : { ok: false, error: "the provider returned no transcript" };
  }

  return { speak, transcribe, gate };
}

module.exports = {
  createVoiceCloud,
  buildSarvamTts,
  sarvamModelFor,
  SARVAM_V2_FEMALE,
  parseSarvamTts,
  buildAzureTts,
  parseSarvamStt,
  escapeXml,
  SECRET_IDS,
};
