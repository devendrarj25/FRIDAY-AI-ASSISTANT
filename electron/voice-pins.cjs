/**
 * Voice weights FRIDAY downloads on demand, pinned by revision and SHA-256.
 *
 * Read from the Hugging Face model API (`?blobs=true`) on 2026-11-22: a large file carries its own
 * LFS digest, and a small file (config, tokenizer, vocabulary, voice style) was fetched at the pinned
 * revision and hashed here. Nothing is bundled in the EXE. The downloader fetches the pinned revision,
 * refuses a file whose digest or size differs, and a repair deletes only the file that failed.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * The licence record of every pin, read from each repository's own tag and card (the Hugging Face API at the pinned
 * revision) and from the official licence page, all re-read on 2026-11-27. `license` (the plain id string) stays as it
 * was; `licenseRecord` is the structured form the bundle gate reads:
 *   · id             the licence id (SPDX-like); the allowlist below is the only set a bundled tier may carry;
 *   · url            the official licence page (HTTP 200 on 2026-11-27);
 *   · redistribution permissive (MIT, Apache-2.0: keep the notices), attribution (credit and a copy of the agreement),
 *                    use-restricted (OpenRAIL-M: the use limits travel with the copy) or refused (never bundled).
 * No licence text body is kept in the repository: whether FRIDAY redistributes weights at all is the owner's decision,
 * and until then every weight is downloaded from the official repository on the owner's PC and never bundled.
 */
const LICENCES = {
  MIT: { url: "https://opensource.org/license/mit", redistribution: "permissive" },
  "Apache-2.0": {
    url: "https://www.apache.org/licenses/LICENSE-2.0",
    redistribution: "permissive",
  },
  // Smart Turn (pipecat-ai/smart-turn-v3): the pinned revision f766f81d's README front matter reads `license: bsd-2-clause`
  // and the upstream LICENSE reads "BSD 2-Clause License"; both re-read on 2026-11-27.
  "BSD-2-Clause": {
    url: "https://opensource.org/license/bsd-2-clause",
    redistribution: "permissive",
  },
  "CC-BY-4.0": {
    url: "https://creativecommons.org/licenses/by/4.0/",
    redistribution: "attribution",
  },
  "OpenRAIL-M": {
    url: "https://huggingface.co/Supertone/supertonic-3/blob/3cadd1ee6394adea1bd021217a0e650ede09a323/LICENSE",
    redistribution: "use-restricted",
  },
  "NVIDIA-Open-Model-License": {
    url: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/",
    redistribution: "attribution",
  },
  "OpenMDW-1.1": { url: "https://openmdw.ai/license/1-1/", redistribution: "attribution" },
};
const LICENCE_CHECKED_AT = "2026-11-27";
const REDISTRIBUTION_CLASSES = ["permissive", "attribution", "use-restricted", "refused"];

/** The licence the upstream NVIDIA card names for the streaming ear's base model (the pinned copy carries the older tag). */
const UPSTREAM_OPENMDW = {
  id: "OpenMDW-1.1",
  url: LICENCES["OpenMDW-1.1"].url,
  source: "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b",
  checkedAt: LICENCE_CHECKED_AT,
};

function licence(id) {
  const known = LICENCES[id];
  return {
    id,
    url: known.url,
    redistribution: known.redistribution,
    checkedAt: LICENCE_CHECKED_AT,
  };
}

/** True for a licence id that is copyleft (GPL, LGPL, AGPL), non-commercial (NC) or share-alike (SA), by its name. */
function isCopyleftOrRestricted(id) {
  const text = String(id || "").toUpperCase();
  return /(^|[^A-Z])[AL]?GPL/.test(text) || /(^|[^A-Z0-9])(NC|SA)([^A-Z0-9]|$)/.test(text);
}

/**
 * The bundle gate: may this pin ship inside the installer or a bundled tier? Pure. It refuses a pin with no record,
 * a licence id that is not on the allowlist (unknown), a copyleft, non-commercial or share-alike id, a class outside
 * the four, a `refused` class, and a record whose url is not https.
 */
function bundleAllowed(pin) {
  const rec = pin?.licenseRecord;
  if (!rec || typeof rec !== "object") return false;
  const id = String(rec.id || "");
  if (!id || isCopyleftOrRestricted(id)) return false;
  if (!Object.prototype.hasOwnProperty.call(LICENCES, id)) return false;
  if (!REDISTRIBUTION_CLASSES.includes(rec.redistribution) || rec.redistribution === "refused")
    return false;
  if (typeof rec.url !== "string" || !rec.url.startsWith("https://")) return false;
  return true;
}

const PINS = {
  "Systran/faster-whisper-base": {
    revision: "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
    license: "MIT",
    licenseRecord: licence("MIT"),
    files: {
      "config.json": {
        sha256: "56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a",
        bytes: 2309,
      },
      "model.bin": {
        sha256: "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9",
        bytes: 145217532,
      },
      "tokenizer.json": {
        sha256: "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab",
        bytes: 2203239,
      },
      "vocabulary.txt": {
        sha256: "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913",
        bytes: 459861,
      },
    },
  },
  "Systran/faster-whisper-large-v3": {
    revision: "edaa852ec7e145841d8ffdb056a99866b5f0a478",
    license: "MIT",
    licenseRecord: licence("MIT"),
    files: {
      "config.json": {
        sha256: "a9306624f5ec14270a014b647e5c316b6e03a662c369758d1b90697a7b0655b9",
        bytes: 2394,
      },
      "model.bin": {
        sha256: "69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1",
        bytes: 3087284237,
      },
      "preprocessor_config.json": {
        sha256: "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
        bytes: 340,
      },
      "tokenizer.json": {
        sha256: "6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca",
        bytes: 2480617,
      },
      "vocabulary.json": {
        sha256: "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1",
        bytes: 1068114,
      },
    },
  },
  "Systran/faster-whisper-medium": {
    revision: "08e178d48790749d25932bbc082711ddcfdfbc4f",
    license: "MIT",
    licenseRecord: licence("MIT"),
    files: {
      "config.json": {
        sha256: "3622a2ddc41ec0e0fd4e68c13c6830f03b90c38d89aaad184de02c8c642cf807",
        bytes: 2257,
      },
      "model.bin": {
        sha256: "9b45e1009dcc4ab601eff815b61d80e60ce3fd8c74c1a14f4a282258286b51ae",
        bytes: 1527906378,
      },
      "tokenizer.json": {
        sha256: "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab",
        bytes: 2203239,
      },
      "vocabulary.txt": {
        sha256: "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913",
        bytes: 459861,
      },
    },
  },
  "Systran/faster-whisper-small": {
    revision: "536b0662742c02347bc0e980a01041f333bce120",
    license: "MIT",
    licenseRecord: licence("MIT"),
    files: {
      "config.json": {
        sha256: "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828",
        bytes: 2370,
      },
      "model.bin": {
        sha256: "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
        bytes: 483546902,
      },
      "tokenizer.json": {
        sha256: "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab",
        bytes: 2203239,
      },
      "vocabulary.txt": {
        sha256: "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913",
        bytes: 459861,
      },
    },
  },
  "Systran/faster-whisper-tiny": {
    revision: "d90ca5fe260221311c53c58e660288d3deb8d356",
    license: "MIT",
    licenseRecord: licence("MIT"),
    files: {
      "config.json": {
        sha256: "a73a28cdfe1c43ccc7202fa333d1f89c202477271407ae9a7f19afa52039cac8",
        bytes: 2249,
      },
      "model.bin": {
        sha256: "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1",
        bytes: 75538270,
      },
      "tokenizer.json": {
        sha256: "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab",
        bytes: 2203239,
      },
      "vocabulary.txt": {
        sha256: "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913",
        bytes: 459861,
      },
    },
  },
  "dropbox-dash/faster-whisper-large-v3-turbo": {
    revision: "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
    license: "MIT",
    licenseRecord: licence("MIT"),
    files: {
      "config.json": {
        sha256: "b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e",
        bytes: 2263,
      },
      "model.bin": {
        sha256: "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da",
        bytes: 1617884929,
      },
      "preprocessor_config.json": {
        sha256: "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
        bytes: 340,
      },
      "tokenizer.json": {
        sha256: "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd",
        bytes: 2710337,
      },
      "vocabulary.json": {
        sha256: "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1",
        bytes: 1068114,
      },
    },
  },
  "OpenVoiceOS/ai4bharat-indicconformer-hi-onnx": {
    revision: "8960b8611af5b8c375d442d52907360176410c8b",
    license: "MIT",
    licenseRecord: licence("MIT"),
    files: {
      "config.json": {
        sha256: "4bfb1d53736f8b675b784d6ece61f5b8e7ae73ca2c0ed4c232e9135ac44ab909",
        bytes: 119,
      },
      "model.int8.onnx": {
        sha256: "c2044177b6d44494fe40be755466845a4c7bd1b5a5d1f6a15b33b2b4ba6011cd",
        bytes: 137677313,
      },
      "vocab.txt": {
        sha256: "152e58dc9469feb8f74fb006245616ad7cd91b3f7a5ace72ec53f970db10c981",
        bytes: 2700,
      },
    },
  },
  // The Hinglish ear: a Whisper-base fine-tune (Oriserve) converted to CTranslate2 int8, 78 MB, Apache-2.0.
  // It writes Hindi speech in Roman letters, so it is used only in the explicit Hinglish (Roman) listening mode.
  "MSpider3/whisper-hindi2hinglish-swift-ct2": {
    revision: "484362f23d657c07c2762ce1c52d7b4a7ab49d25",
    license: "Apache-2.0",
    licenseRecord: licence("Apache-2.0"),
    files: {
      "config.json": {
        sha256: "7dcc85f06f98312a1146df7f28959c358c87ab3d01c369eacd4b22f1ec2c43e4",
        bytes: 2789,
      },
      "model.bin": {
        sha256: "223a6e80ea056a01a7bf748a44e7a1c11ab79601ce5f84720365aac38565b87f",
        bytes: 76396677,
      },
      "preprocessor_config.json": {
        sha256: "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d",
        bytes: 339,
      },
      "tokenizer.json": {
        sha256: "7e146198186d5e3b9ce7d9d7f131b69b44569eaed9ad64a5516629a6c6a865c4",
        bytes: 3930462,
      },
      "vocabulary.json": {
        sha256: "22f3cb2fc2be1545b9a7db8e993ddd59aeccadfbc7d7b00ca517ca8960864766",
        bytes: 1068101,
      },
    },
  },
  // The Hindi fallback: Collabora's Whisper-small Hindi fine-tune, CTranslate2. CC-BY-4.0. Used instead of generic small only when Hindi is chosen and the Hindi ear is missing.
  "collabora/faster-whisper-small-hindi": {
    revision: "92e09a8982af971cf2033ed592d4ef8b249baad2",
    license: "CC-BY-4.0",
    licenseRecord: licence("CC-BY-4.0"),
    files: {
      "config.json": {
        sha256: "a009751ea519c21514a766f08b33784c0ce0aef4f3fafdc3687f56e33ef35b1a",
        bytes: 1512,
      },
      "model.bin": {
        sha256: "0ad00358a5dd71fc8e094a768caa1f67dad9dbb107641cc6323502a0bf7c2ef7",
        bytes: 483546977,
      },
      "preprocessor_config.json": {
        sha256: "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d",
        bytes: 339,
      },
      "tokenizer.json": {
        sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566",
        bytes: 2480466,
      },
      "vocabulary.json": {
        sha256: "5ad28279db5e546349708b9a74736e2c018737ac5a600f1048f1f26c99b85b47",
        bytes: 1068103,
      },
    },
  },
  // The optional Hindi punctuation model (kernel/hindi_punct.py): an ONNX graph and its SentencePiece model, 234 MB,
  // Apache-2.0. Run by onnxruntime and sentencepiece directly; the `punctuators` package needs torch and is not used.
  "1-800-BAD-CODE/punct_cap_seg_47_language": {
    revision: "1b9d51fc7989ebc61e844d407d9dadd08ff4ba28",
    license: "Apache-2.0",
    licenseRecord: licence("Apache-2.0"),
    files: {
      "config.yaml": {
        sha256: "30eb8e05fcea3865828ab73f41fbba21dd7faf127a61950a706af9156f5b84f2",
        bytes: 516,
      },
      "punct_cap_seg_47lang.onnx": {
        sha256: "640d91c06b7cc5b3e065c12a7097188378aad3bc11568ff1d72c4c0a2acb0df4",
        bytes: 232986305,
      },
      "spe_unigram_64k_lowercase_47lang.model": {
        sha256: "1bc15b6e5fd80dfac9999582ce3efcad2ac1f7cf4e0e9769b329f5de9ca5af47",
        bytes: 1186519,
      },
    },
  },
  // The optional light Hindi voice (kernel/tts_hindi_light.py): three ONNX graphs, 91 MB. The model files are
  // CC-BY-4.0: the licence text is kept next to the weights. The package code in the repository is not downloaded; FRIDAY's own
  // thin Devanagari frontend replaces it.
  "sulabhkatiyar/indic-tiny-tts-hindi": {
    revision: "1fb1b108ee6ffb73ee74bd68b283ec13eb39e957",
    license: "CC-BY-4.0",
    licenseRecord: licence("CC-BY-4.0"),
    files: {
      "LICENSE.md": {
        sha256: "64fa648284b590c9e62a0d40521ba8c40728ec16cfb485245ef620436f0579ed",
        bytes: 2976,
      },
      "config.json": {
        sha256: "4078fd217dc171808b58f05b5ed78f85d78126bf7bf46351186fcf039411f66d",
        bytes: 3443,
      },
      "onnx/flow_decoder.onnx": {
        sha256: "923a0472ec4d4c05c43bfc8ea512f8f762cf447b9f6ce1f01043144e1f6d1252",
        bytes: 19169253,
      },
      "onnx/onnx_manifest.json": {
        sha256: "30ce6bb339f2d27b0aada791c57f4197b2dd9ddd7d710dbcb36eb095bd5f762f",
        bytes: 3117,
      },
      "onnx/text_encoder.onnx": {
        sha256: "38df505ea822800d91a13bdc4a670f81ee964e9e0fe24a705590859fe7cfd08f",
        bytes: 17695838,
      },
      "onnx/vocoder.onnx": {
        sha256: "44d36238a761750447038895ab194e2378f6f4ba2c2d089a4766fa52810ef353",
        bytes: 54150036,
      },
    },
  },
  "Supertone/supertonic-3": {
    revision: "3cadd1ee6394adea1bd021217a0e650ede09a323",
    license: "OpenRAIL-M",
    licenseRecord: licence("OpenRAIL-M"),
    files: {
      "config.json": {
        sha256: "4099082b107a9d4029849ac76b89eca65e03732660969c2babe5bf308c7357f2",
        bytes: 174,
      },
      "onnx/duration_predictor.onnx": {
        sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db",
        bytes: 3700147,
      },
      "onnx/text_encoder.onnx": {
        sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff",
        bytes: 36416150,
      },
      "onnx/tts.json": {
        sha256: "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09",
        bytes: 8253,
      },
      "onnx/unicode_indexer.json": {
        sha256: "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f",
        bytes: 277676,
      },
      "onnx/vector_estimator.onnx": {
        sha256: "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c",
        bytes: 256534781,
      },
      "onnx/vocoder.onnx": {
        sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba",
        bytes: 101424195,
      },
      "voice_styles/F1.json": {
        sha256: "bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2",
        bytes: 292046,
      },
      "voice_styles/F2.json": {
        sha256: "7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6",
        bytes: 292423,
      },
      "voice_styles/F3.json": {
        sha256: "12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab",
        bytes: 290794,
      },
      "voice_styles/F4.json": {
        sha256: "c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b",
        bytes: 291808,
      },
      "voice_styles/F5.json": {
        sha256: "45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d",
        bytes: 291479,
      },
      "voice_styles/M1.json": {
        sha256: "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b",
        bytes: 291748,
      },
      "voice_styles/M2.json": {
        sha256: "b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50",
        bytes: 292055,
      },
      "voice_styles/M3.json": {
        sha256: "ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b",
        bytes: 290198,
      },
      "voice_styles/M4.json": {
        sha256: "ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303",
        bytes: 291522,
      },
      "voice_styles/M5.json": {
        sha256: "dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2",
        bytes: 291469,
      },
    },
  },
  // Optional, off by default, never fetched on its own. Read from the Hugging Face API (`?blobs=true`, lfs.sha256) on
  // 2026-11-26 and the pinned file downloaded and hashed here. Only the one 16 kHz ONNX graph, `dpdfnet2` (the smallest
  // of the 16 kHz family, 10.2 MB), is pinned: the repository also holds dpdfnet4 and dpdfnet8, 8 kHz and 48 kHz graphs,
  // TFLite and checkpoint files, none of which FRIDAY uses. A streaming speech-enhancement model (Apache-2.0, Ceva-IP):
  // one 10 ms spectrum frame in, one frame out, with a flat state vector. `kernel/denoise_onnx.py` runs it (A/B tool
  // only; no live path or setting connects it yet).
  "Ceva-IP/DPDFNet": {
    revision: "dd6818d00f50c836fed43a6243ebe49116de5964",
    license: "Apache-2.0",
    licenseRecord: licence("Apache-2.0"),
    files: {
      "onnx/dpdfnet2.onnx": {
        sha256: "4f0ee28935b4a32abecc717d745416976565834d839601acf43031094b4dc94c",
        bytes: 10178747,
      },
    },
  },
  // Optional, off by default, never fetched on its own: GTCRN, an ultra-light 16 kHz streaming denoiser (MIT, upstream
  // Xiaobin-Rong/gtcrn). This copy (TigreGotico/audiosronnx-gtcrn, MIT) holds the same bytes as bitsydarel/gtcrn-onnx
  // (the sha256 is identical); the graph carries three cache tensors, so it is the streaming export (read with
  // onnxruntime 1.32 on 2026-11-26: `mix [1,257,1,2]` plus conv, tra and inter caches). Read from the Hugging Face API
  // on 2026-11-26 and the file downloaded and hashed here. `kernel/denoise_onnx.py` runs it.
  "TigreGotico/audiosronnx-gtcrn": {
    revision: "eeba5e9636e7e0aad93b25fad17471a9646d2640",
    license: "MIT",
    licenseRecord: licence("MIT"),
    files: {
      "gtcrn_simple.onnx": {
        sha256: "e77603ac0c23dac3227dd2d7135b3a585cbee2679048aecfa886657d3ae1b534",
        bytes: 535638,
      },
    },
  },
  // Optional speaker-verification candidate (CC-BY-4.0): WeSpeaker ResNet34-LM, int8,
  // 80-bin Kaldi filterbank in, one 256-number voice embedding out. Only the int8 graph and its two small configs are pinned.
  "onnx-community/wespeaker-voxceleb-resnet34-LM": {
    revision: "6a61a1833ff2583aabeba044f5c8221f00b67ceb",
    license: "CC-BY-4.0",
    licenseRecord: licence("CC-BY-4.0"),
    files: {
      "config.json": {
        sha256: "4a65a1544d2085d7819632f130583d83f6815f49ef6c8ba6c8eb460bd4085041",
        bytes: 38,
      },
      "onnx/model_int8.onnx": {
        sha256: "6416fae0599c33bdaf7188e99695edc5fafde190a102c511c881245a109de4c3",
        bytes: 6685123,
      },
      "preprocessor_config.json": {
        sha256: "a81bbded0530b1bf5c3d395d2c5c7c266686e348be5989171290ace960f24ec2",
        bytes: 371,
      },
    },
  },
  // A Hindi Whisper large-v3 fine-tune (ARTPARK-IISc Vaani, Apache-2.0) converted to CTranslate2 by a community account.
  // A CANDIDATE, never a default: the publisher's own WER table is in the registry, FRIDAY has not measured it. The
  // repository carries no `tokenizer.json`, and faster-whisper then asks the network for one, so it stays unusable until
  // the large-v3 `tokenizer.json` pinned under Systran/faster-whisper-large-v3 is put beside it (see voice-engine-registry.ts).
  "bjollans/whisper-large-v3-vaani-hindi-ct2": {
    revision: "27e81d52186393a5e7ee6f3a64ebd5c627dc25ed",
    license: "Apache-2.0",
    licenseRecord: licence("Apache-2.0"),
    files: {
      "config.json": {
        sha256: "a9306624f5ec14270a014b647e5c316b6e03a662c369758d1b90697a7b0655b9",
        bytes: 2394,
      },
      "model.bin": {
        sha256: "34c0d6c1c80fabd91af9d8c91c5089c2f3f314bda9ee3169b3e844c7ad2d011b",
        bytes: 3087284237,
      },
      "preprocessor_config.json": {
        sha256: "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
        bytes: 340,
      },
      "vocabulary.json": {
        sha256: "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1",
        bytes: 1068114,
      },
    },
  },
  // The Hinglish mixed-script ear: Trelis Research's Whisper large-v3 fine-tune (Apache-2.0, trained from ARTPARK-IISc
  // Vaani) converted to CTranslate2 int8 by a community account (`int8/` folder, weights unchanged). It answers Hindi in
  // Devanagari and English words in Latin letters in one line (the card's `<|mixedcode|>` marker, token 51866, put after
  // the language token). A CANDIDATE, never a default, on demand only: the publisher's WER table is a lead, FRIDAY's own
  // measurement is in the registry (voice-engine-table.ts). The parent is Trelis/whisper-hinglish-preview at
  // eab1188fd2d0e91f2584229b32b3bfe1901c896c; every file below was fetched at the pinned revision and hashed here, and
  // the 1,556,723,863-byte model.bin matches the SHA-256 Hugging Face lists. The repository's own LICENSE (Apache-2.0
  // text) is pinned beside the weights so the licence travels with them. Its `tokenizer.json` stops at id 51865 (it does not hold the marker),
  // while `vocabulary.json` and the model hold id 51866: the marker is written as that id, never encoded from text.
  "nikh360pro/capsbro-hinglish-ct2": {
    revision: "87a1f963adb6e7902a766a3d20217fa63d7f018b",
    license: "Apache-2.0",
    licenseRecord: licence("Apache-2.0"),
    files: {
      LICENSE: {
        sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
        bytes: 11358,
      },
      "int8/config.json": {
        sha256: "f277d9390e65adc1630b349151eca38aaf7420c41c814271928854edcfd6ffbe",
        bytes: 2634,
      },
      "int8/model.bin": {
        sha256: "624bae081b85f4ac433edb73bf64bd5277bb7a4c03fe305d572fe2fd1a89a7d3",
        bytes: 1556723863,
      },
      "int8/preprocessor_config.json": {
        sha256: "654cf18d3e163b948ceaf9766da56ce0b52de265d58673cf61c9376f126bd499",
        bytes: 357,
      },
      "int8/tokenizer.json": {
        sha256: "6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca",
        bytes: 2480617,
      },
      "int8/vocabulary.json": {
        sha256: "e2125783966ea6f3aad20a065a9b2ae5c9c8532438aa80e62e84f7e635adbbda",
        bytes: 1120001,
      },
    },
  },
  // Optional streaming ear candidate, never a default; setup fetches it only when the voice plan says this PC can carry
  // it (electron/voice-weights.cjs streamEarDecision), each file checked against the digest below. NVIDIA Nemotron 3.5 ASR
  // Streaming 0.6B (cache-aware FastConformer RNN-T, 128 language prompt slots incl. hi-IN and en-US), exported to ONNX
  // by soniqo with an INT8 encoder and FP32 decoder and joint: a fixed 320 ms chunk, 32 mel frames per pass. Read from the
  // Hugging Face tree API on 2026-11-26: each large file carries its LFS SHA-256, the three small files were fetched at the
  // pinned revision and hashed here, and every digest and size was re-checked against the downloaded bytes. The card names
  // an `encoder.onnx.data` that this revision does not hold: the 657,558,932-byte encoder.onnx carries its weights inline.
  // The weights are the NVIDIA Open Model License: the repository's own tag and card text, re-read on 2026-11-27 (the
  // API at the pinned revision gives license_name nvidia-open-model-license). The upstream model nvidia/nemotron-3.5-asr-
  // streaming-0.6b now says OpenMDW-1.1 ("Governing Terms: Use of the model is governed by the OpenMDW-1.1 license"),
  // kept as `licenseRecord.upstream`; the int4 repository of another publisher is tagged MIT. Both agreements ask for a
  // copy of the agreement with a redistributed copy; neither is NC, SA or copyleft. The conflict is also recorded in
  // docs/FRIDAY_VOICE_ENGINE.md. FRIDAY never bundles or redistributes the files: the owner's PC fetches them from the
  // official repository. Run by FRIDAY's own onnxruntime loop (kernel/transducer_loop.py), no torch.
  "soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8": {
    revision: "1ce4daedd303e01d4e603634a72c28562f1a6855",
    license: "NVIDIA-Open-Model-License",
    licenseRecord: {
      ...licence("NVIDIA-Open-Model-License"),
      upstream: UPSTREAM_OPENMDW,
    },
    files: {
      "config.json": {
        sha256: "0592a224f30670e00f5e0f1f106f0171428b0abde0fd4cbc64237b02c2241502",
        bytes: 602,
      },
      "decoder.onnx": {
        sha256: "68e7c40e673e94b364476303d687478ed7726bfb984e3496d0234d8e368b0894",
        bytes: 4345,
      },
      "decoder.onnx.data": {
        sha256: "4f2ced2289e1a62f7576ae9b42a97b972bdbc001eca8b41c4cc4c2421c0982eb",
        bytes: 59760640,
      },
      "encoder.onnx": {
        sha256: "faba6d952270255f1f9c4c22a44fbc60439638d808cb9feee51bba6a8daf0f87",
        bytes: 657558932,
      },
      "joint.onnx": {
        sha256: "c2839f49ac23e353c60b82ad325afcabee38e5ee6f8238fe575799908f877fc4",
        bytes: 2023,
      },
      "joint.onnx.data": {
        sha256: "5e96c9d54ee68a924f58fd734cd64ddf6fa0dd0f81c981ceb1a5bac5e860d74c",
        bytes: 37822592,
      },
      "languages.json": {
        sha256: "a1efe863e1057d4658bce8175c978020ac35a63a3c9a65ae899f324a32c8e4f6",
        bytes: 2020,
      },
      "vocab.json": {
        sha256: "fd726dc25cc0c0b46403675127e831bab56ca56b8c7ae3ee7781f5c6d7692f4f",
        bytes: 236127,
      },
    },
  },
  // Optional English final-pass ear (FRIDAY Ear English), a candidate that becomes a default only after its own evaluation.
  // Four files at one revision: the int8 encoder, the fused decoder and joint graph, the vocabulary and the config.
  // `kernel/nemo_ear.py` runs them unchanged (TDT greedy, onnxruntime and numpy, no torch). Each large file carries the
  // SHA-256 the Hugging Face API lists at this revision; the two small files were fetched at it and hashed (2026-11-27).
  "istupakov/parakeet-tdt-0.6b-v2-onnx": {
    revision: "0bbb45a3365852604aef28b538a8f066f4ccaa85",
    license: "CC-BY-4.0",
    licenseRecord: licence("CC-BY-4.0"),
    files: {
      "config.json": {
        sha256: "666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466",
        bytes: 97,
      },
      "decoder_joint-model.int8.onnx": {
        sha256: "a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3",
        bytes: 8998286,
      },
      "encoder-model.int8.onnx": {
        sha256: "3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155",
        bytes: 652184014,
      },
      "vocab.txt": {
        sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
        bytes: 9384,
      },
    },
  },
  // Optional small Hindi, Hinglish and Indian-English final-pass ear (FRIDAY Ear Swift), a candidate, never a default.
  // Only the Hindi folders are pinned: `hi/onnx` (4-bit weights) and `hi/onnx-int8` (the low-memory set), each with its
  // frontend, encoder, decoder and `shruti.json`, plus the licence and notice files that travel with the weights. The
  // other languages in the repository are not used. `kernel/shruti_ear.py` runs the graphs (onnxruntime and numpy).
  // Digests as for the other pins: LFS SHA-256 from the API at this revision, small files fetched and hashed (2026-11-27).
  "udgamlabs/Shruti-ONNX": {
    revision: "a464a502cc732e4335313869e1ccf393ff8ba56b",
    license: "Apache-2.0",
    licenseRecord: licence("Apache-2.0"),
    files: {
      LICENSE: {
        sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
        bytes: 11358,
      },
      NOTICE: {
        sha256: "4e2e035dfd9a58c597cb81e5d644635ce8fd2ebbd51e44cc22b8bc5bf4da8110",
        bytes: 1031,
      },
      "hi/onnx-int8/decoder.onnx": {
        sha256: "777870e340af2c5a9513f8bef14ecf0c2d57ba7dbfe8682a99674ec58dbd6f70",
        bytes: 32293075,
      },
      "hi/onnx-int8/encoder.onnx": {
        sha256: "b26a33cedf74ce11f13ad3854f3c0a34e7272c4e2dfd0d5cd2818185b029b996",
        bytes: 19633861,
      },
      "hi/onnx-int8/frontend.onnx": {
        sha256: "0457d948c74b62e12b5d652d275269331092e13b22a2cdf64d2773c639a2b276",
        bytes: 911143,
      },
      "hi/onnx-int8/shruti.json": {
        sha256: "82aa655fef9ace280b626f5cfbbbe9a9e417c5c997a2708480e65d33ec3bdc45",
        bytes: 94153,
      },
      "hi/onnx/decoder.onnx": {
        sha256: "d6ad12693b4289fe5d8f23af5c87dffae9597aa5a585fffaea82fe54a3f27cc3",
        bytes: 20480122,
      },
      "hi/onnx/encoder.onnx": {
        sha256: "8935017652b2fec8932d9eb220a4ae1d5287b8b05904820eadabdc64c0de63d0",
        bytes: 10604825,
      },
      "hi/onnx/frontend.onnx": {
        sha256: "0457d948c74b62e12b5d652d275269331092e13b22a2cdf64d2773c639a2b276",
        bytes: 911143,
      },
      "hi/onnx/shruti.json": {
        sha256: "82aa655fef9ace280b626f5cfbbbe9a9e417c5c997a2708480e65d33ec3bdc45",
        bytes: 94153,
      },
    },
  },
  // Optional fast English final-pass ear (FRIDAY Ear Quick), a candidate, never a default: the tiny merged-cache int8
  // encoder and decoder. The repository was renamed (the old organisation name answers with a redirect), so the new name
  // is pinned. Its vocabulary is a separate repository, pinned next. `kernel/ear_quick.py` runs it (onnxruntime and numpy).
  "moonshine-ai/moonshine": {
    revision: "48b4e427b587bcf67797a5be706d6ddc4a298149",
    license: "MIT",
    licenseRecord: licence("MIT"),
    files: {
      "onnx/merged/tiny/quantized/decoder_model_merged.onnx": {
        sha256: "eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367",
        bytes: 20243286,
      },
      "onnx/merged/tiny/quantized/encoder_model.onnx": {
        sha256: "c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a",
        bytes: 7937661,
      },
    },
  },
  // The vocabulary of FRIDAY Ear Quick: one 2 MB file from its own repository, kept as a second pin because a pin holds
  // one repository. It is a helper row of the same ear, not a model of its own.
  "moonshine-ai/moonshine-tiny": {
    revision: "390624ed33d594443aa4aa221f5b9f283b545b5a",
    license: "MIT",
    licenseRecord: licence("MIT"),
    files: {
      "tokenizer.json": {
        sha256: "6579793438bc4fbafffacf699169ff53e3769c5a0a0f5e71cdee8853e8130deb",
        bytes: 1985530,
      },
    },
  },
  // The Hinglish Pro ear (FRIDAY Ear Hinglish Pro): Oriserve's Whisper-Hindi2Hinglish-Apex, a fine-tune of Whisper
  // large-v3-turbo (4 decoder layers, 808,878,080 parameters, BF16), card licence apache-2.0. This pin is the SOURCE
  // checkpoint, not a runnable folder: `scripts/build-friday-models.cjs` converts it with the `ct2-int8` recipe
  // (`kernel/voice_merge.py convert`, numpy only, no torch) into a CTranslate2 int8 folder, and the pack pins that
  // folder's hashes. Revision and sizes read from the Hugging Face API (`?blobs=true`) on 2026-11-27; the LFS
  // SHA-256 of model.safetensors equals the digest of the downloaded bytes, and the seven small files (the API lists no
  // digest for them) were fetched at the pinned revision and hashed here. The repository holds no LICENSE file, so its
  // README (the card, with the licence front matter) is pinned beside the weights. Decode it with the language token
  // `en` for Hinglish, the card's own setting; it writes Hindi in Roman letters, so the Devanagari policy keeps it an
  // explicit mode, never the default. A CANDIDATE, on demand only.
  "Oriserve/Whisper-Hindi2Hinglish-Apex": {
    revision: "f3214eed20b4e4d4144e739982d911f87b9cb223",
    license: "Apache-2.0",
    licenseRecord: licence("Apache-2.0"),
    files: {
      "README.md": {
        sha256: "841ae75f5c5915e87d15698021a73c600b4ac0be29ce1f9643a9ef498026b31c",
        bytes: 12439,
      },
      "added_tokens.json": {
        sha256: "3c51f66c4c21f9e126970078f11ae77a78c74aee8df606ee9daba86e467108e0",
        bytes: 34648,
      },
      "config.json": {
        sha256: "14209b98fb68fc127201bbfebd57cc9f834b0f1a0d0d463a561c8051800af9f4",
        bytes: 1194,
      },
      "generation_config.json": {
        sha256: "ab32c08bdb83e3ce745c1dc72700b1d7d990aed2b7180a861177d826881061b1",
        bytes: 3584,
      },
      "model.safetensors": {
        sha256: "5560830fe8fa09b8cdf1b5926d0cc39a2586eadaad685d809e156432c4ebca80",
        bytes: 1617825448,
      },
      "preprocessor_config.json": {
        sha256: "654cf18d3e163b948ceaf9766da56ce0b52de265d58673cf61c9376f126bd499",
        bytes: 357,
      },
      "tokenizer.json": {
        sha256: "5c1bf30c9e716e1477bedef846b01be0013daecb89e9e3ef7ab89b23c178df1b",
        bytes: 3930645,
      },
      "vocab.json": {
        sha256: "6788c80b082e9b0d1393147d3a3e62ba19285ac0c82ace8e5ef00f37ead58971",
        bytes: 835528,
      },
    },
  },
};

/**
 * A repository that was renamed answers on both names with the same revision and files. The key is the name the pin
 * is filed under, the value the other name it is also reached by: `AudioSRonnx/gtcrn` is the new home of
 * `TigreGotico/audiosronnx-gtcrn` (the old name redirects to it); the revision `eeba5e96...`, the file
 * `gtcrn_simple.onnx`, its 535,638 bytes and its SHA-256 were read from the Hugging Face API under the new name on
 * 2026-11-28 and equal this pin, and the pinned-revision file url answers 200 under it.
 */
const ALIASES = {
  "mobiuslabsgmbh/faster-whisper-large-v3-turbo": "dropbox-dash/faster-whisper-large-v3-turbo",
  "AudioSRonnx/gtcrn": "TigreGotico/audiosronnx-gtcrn",
};

/**
 * A second official repository of a pinned model: the same files and SHA-256 at the revision of its own. It is a source,
 * not a model: it has no pin row, no facts and no registry entry of its own, and a folder fetched from it is certified
 * as the pinned model itself (see `canonicalRepo` and `canonicalRevision`).
 * `supertone-oss-archive/supertonic-3` is the publisher's one-commit duplicate of `Supertone/supertonic-3` (linked from
 * the Supertonic code repository); all 17 files were compared with the pin on 2026-11-24 (13 by SHA-256 of the bytes,
 * the 4 ONNX files by the SHA-256 Hugging Face lists).
 */
const MIRROR_REPOS = {
  "supertone-oss-archive/supertonic-3": {
    of: "Supertone/supertonic-3",
    revision: "aafc6e32416a594460b32413efc49d7fe4ce6d46",
  },
};

/** The pinned repository a name stands for: a rename and a second official repository both resolve to it. */
function canonicalRepo(repo) {
  return MIRROR_REPOS[repo]?.of || ALIASES[repo] || repo;
}

/** The revision a folder is certified at: the pinned model's own, whichever official repository supplied the bytes. */
function canonicalRevision(pin) {
  return pin?.canonicalRevision || pin?.revision;
}

/**
 * What each pinned model needs from the machine, for the hardware budget (`voice-weights.cjs` `budgetFor`) and the
 * Models page. Keyed by repository, merged with the pin by `manifestFor`; `diskBytes` is never typed here, it is the sum
 * of the pinned bytes. The numbers are the model's own working set while loaded, not the PC's RAM:
 *   · minRamGb          peak resident memory (RSS) the loaded model needs, rounded up to 0.1 GB;
 *   · recommendedRamGb  free memory to have before loading it (about 1.5 times the peak, for a long utterance);
 *   · minVramGb         video memory a GPU run needs, 0 when the CPU is enough;
 *   · cpuOk             keeps up with live speech on a typical CPU (an estimate, not a benchmark of one PC);
 *   · gpuOk             FRIDAY runs it on a GPU (CTranslate2 float16); the ONNX models ship the CPU provider only;
 *   · basis             "measured": peak RSS read on a Linux x86-64 box (4 cores, CPU int8, onnxruntime 1.32,
 *                       faster-whisper 1.2.1) while loading and decoding 8 s of audio, 2026-11-23; "estimated":
 *                       not run here, taken from the measured model of the same architecture or the publisher's size.
 * Windows adds its own overhead, so these are floors; a measured value is a floor too (real speech decodes a little more).
 */
const FACTS = {
  "Systran/faster-whisper-tiny": {
    minRamGb: 0.3,
    recommendedRamGb: 0.5,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: true,
    quantization: "int8 (CTranslate2, from float16)",
    fallbackPriority: "lightweight",
    basis: "measured",
    peakRssMb: 256,
  },
  "Systran/faster-whisper-base": {
    minRamGb: 0.4,
    recommendedRamGb: 0.6,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: true,
    quantization: "int8 (CTranslate2, from float16)",
    fallbackPriority: "lightweight",
    basis: "measured",
    peakRssMb: 347,
  },
  "Systran/faster-whisper-small": {
    minRamGb: 0.8,
    recommendedRamGb: 1.2,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: true,
    quantization: "int8 (CTranslate2, from float16)",
    fallbackPriority: "primary",
    basis: "measured",
    peakRssMb: 736,
  },
  "Systran/faster-whisper-medium": {
    minRamGb: 2,
    recommendedRamGb: 3,
    minVramGb: 3,
    cpuOk: false,
    gpuOk: true,
    quantization: "int8 on CPU, float16 on GPU (CTranslate2)",
    fallbackPriority: "accuracy",
    basis: "estimated",
  },
  "dropbox-dash/faster-whisper-large-v3-turbo": {
    minRamGb: 2.2,
    recommendedRamGb: 3.3,
    minVramGb: 3,
    cpuOk: false,
    gpuOk: true,
    quantization: "int8 on CPU, float16 on GPU (CTranslate2)",
    fallbackPriority: "accuracy",
    basis: "estimated",
  },
  "Systran/faster-whisper-large-v3": {
    minRamGb: 3.8,
    recommendedRamGb: 5.7,
    minVramGb: 5,
    cpuOk: false,
    gpuOk: true,
    quantization: "int8 on CPU, float16 on GPU (CTranslate2)",
    fallbackPriority: "accuracy",
    basis: "estimated",
  },
  "OpenVoiceOS/ai4bharat-indicconformer-hi-onnx": {
    minRamGb: 0.4,
    recommendedRamGb: 0.6,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "int8 (ONNX)",
    fallbackPriority: "primary",
    basis: "measured",
    peakRssMb: 394,
  },
  "MSpider3/whisper-hindi2hinglish-swift-ct2": {
    minRamGb: 0.3,
    recommendedRamGb: 0.5,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: true,
    quantization: "int8 (CTranslate2, from float16)",
    fallbackPriority: "experimental",
    basis: "estimated",
  },
  "collabora/faster-whisper-small-hindi": {
    minRamGb: 0.8,
    recommendedRamGb: 1.2,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: true,
    quantization: "int8 (CTranslate2, from float16)",
    fallbackPriority: "accuracy",
    basis: "estimated",
  },
  "1-800-BAD-CODE/punct_cap_seg_47_language": {
    minRamGb: 0.5,
    recommendedRamGb: 0.7,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "fp32 (ONNX)",
    fallbackPriority: "accuracy",
    basis: "measured",
    peakRssMb: 416,
  },
  "sulabhkatiyar/indic-tiny-tts-hindi": {
    minRamGb: 0.2,
    recommendedRamGb: 0.4,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "fp32 (ONNX)",
    fallbackPriority: "experimental",
    basis: "measured",
    peakRssMb: 196,
  },
  "Supertone/supertonic-3": {
    minRamGb: 0.5,
    recommendedRamGb: 0.8,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "fp32 (ONNX)",
    fallbackPriority: "primary",
    basis: "measured",
    peakRssMb: 489,
  },
  // Peak resident memory 81 MB (dpdfnet2) and 64 MB (gtcrn) over a 15 s Python process that had already loaded numpy and
  // onnxruntime (45 MB of it), 8 s of speech through `kernel/denoise_onnx.py` on a Linux x86-64 CPU (2026-11-26); real-time
  // factor 0.16 and 0.06 there (one thread), so both keep up with live speech on that machine; Windows is unmeasured.
  "Ceva-IP/DPDFNet": {
    minRamGb: 0.1,
    recommendedRamGb: 0.2,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "fp32 (ONNX)",
    fallbackPriority: "experimental",
    basis: "measured",
    peakRssMb: 81,
  },
  "TigreGotico/audiosronnx-gtcrn": {
    minRamGb: 0.1,
    recommendedRamGb: 0.2,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "fp32 (ONNX)",
    fallbackPriority: "experimental",
    basis: "measured",
    peakRssMb: 64,
  },
  "onnx-community/wespeaker-voxceleb-resnet34-LM": {
    minRamGb: 0.2,
    recommendedRamGb: 0.3,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "int8 (ONNX)",
    fallbackPriority: "experimental",
    basis: "measured",
    peakRssMb: 110,
  },
  "bjollans/whisper-large-v3-vaani-hindi-ct2": {
    minRamGb: 3.8,
    recommendedRamGb: 5.7,
    minVramGb: 5,
    cpuOk: false,
    gpuOk: true,
    quantization: "int8 on CPU, float16 on GPU (CTranslate2)",
    fallbackPriority: "experimental",
    basis: "estimated",
  },
  // Peak resident memory 3,042 MB after loading the int8 folder with faster-whisper 1.2.1 and decoding one 15 s clip, on a
  // Linux x86-64 CPU (2026-11-26); a clip decodes in about 5 to 10 s on 4 threads, slower than speech, so `cpuOk` is false.
  "nikh360pro/capsbro-hinglish-ct2": {
    minRamGb: 3.2,
    recommendedRamGb: 4.5,
    minVramGb: 4,
    cpuOk: false,
    gpuOk: true,
    quantization:
      "int8 on CPU, int8 or float16 on GPU (CTranslate2, community conversion of the parent)",
    fallbackPriority: "experimental",
    basis: "measured",
    peakRssMb: 3042,
  },
  "soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8": {
    minRamGb: 1.2,
    recommendedRamGb: 1.8,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "int8 encoder, fp32 decoder and joint (ONNX)",
    fallbackPriority: "experimental",
    basis: "measured",
    peakRssMb: 1161,
  },
  // Peak resident memory 1,163 MB (int8, 4 threads, 2026-11-27); a clip decodes at about 0.12 of its length on a Linux CPU.
  "istupakov/parakeet-tdt-0.6b-v2-onnx": {
    minRamGb: 1.2,
    recommendedRamGb: 1.8,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "int8 (ONNX)",
    fallbackPriority: "experimental",
    basis: "measured",
    peakRssMb: 1163,
  },
  // Peak resident memory 728 MB for the 4-bit set and 348 MB for the int8 set (5-beam search, 2026-11-27).
  "udgamlabs/Shruti-ONNX": {
    minRamGb: 0.8,
    recommendedRamGb: 1.2,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "4-bit weights (ONNX), int8 set optional",
    fallbackPriority: "experimental",
    basis: "measured",
    peakRssMb: 728,
  },
  // Not measured for memory: the pair is 28 MB on disk and the working set is estimated from its size.
  "moonshine-ai/moonshine": {
    minRamGb: 0.3,
    recommendedRamGb: 0.5,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "int8 (ONNX)",
    fallbackPriority: "experimental",
    basis: "estimated",
  },
  "moonshine-ai/moonshine-tiny": {
    minRamGb: 0.1,
    recommendedRamGb: 0.2,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "vocabulary (text)",
    fallbackPriority: "experimental",
    basis: "estimated",
  },
  // The pin is the BF16 source (1.6 GB); the ear that runs is its CTranslate2 int8 conversion (820 MB, recipe `ct2-int8`
  // of the voice pack). Not measured for memory: estimated from the 4-layer turbo decoder at int8. A clip decoded at about
  // 1.2 to 1.6 of its length on a loaded 4-core Linux CPU (2026-11-27), slower than speech, so `cpuOk` is false.
  // `decodeLanguage` is the language token the ear is decoded with for Hinglish: `en`, the card's own setting.
  "Oriserve/Whisper-Hindi2Hinglish-Apex": {
    minRamGb: 2,
    recommendedRamGb: 3,
    minVramGb: 3,
    cpuOk: false,
    gpuOk: true,
    quantization:
      "int8 on CPU, int8 or float16 on GPU (CTranslate2, converted from the BF16 source)",
    fallbackPriority: "experimental",
    basis: "estimated",
    decodeLanguage: "en",
  },
};

/** The two helpers that are single files, not repositories (see `voice-weights.cjs` PINNED); they carry facts too. */
const FILE_FACTS = {
  "silero-vad": {
    minRamGb: 0.1,
    recommendedRamGb: 0.2,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "fp32 (ONNX)",
    fallbackPriority: "primary",
    basis: "estimated",
  },
  "smart-turn": {
    minRamGb: 0.2,
    recommendedRamGb: 0.3,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "int8 (ONNX)",
    fallbackPriority: "primary",
    basis: "estimated",
  },
  "wake-embed": {
    minRamGb: 0.1,
    recommendedRamGb: 0.2,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "fp32 (ONNX)",
    fallbackPriority: "primary",
    basis: "estimated",
  },
};

/**
 * What each optional pin must do before it may be called usable: the engine's own self-test, run by
 * `kernel/voice_pin_selftest.py` on the owner's PC (Doctor row `selftest-<catalogId>`), keyed by repository.
 * `onnx-signature`: onnxruntime opens `file`, the graph declares exactly these inputs and outputs, and one pass over
 * zeros of `run` (or the declared shape) returns the declared output shape. Signatures were read from the pinned files
 * with onnxruntime 1.29 on 2026-11-23; a dimension written as a string ("B", "T") is dynamic. `ct2-folder`: the
 * CTranslate2 folder is whole and carries `needs`; a `companion` file that is absent (one this pin cannot hold) is
 * reported "blocked" with its reason, not as a failure. `wrapper` is the repository file that runs the engine in the live
 * path, or null when none does yet: while it is null the engine is downloadable and verifiable but never "usable"
 * (`voice-engine-registry.ts` reads it). A pin that is not listed here has no self-test and is never "usable".
 */
const SELF_TESTS = {
  "Ceva-IP/DPDFNet": {
    kind: "onnx-signature",
    wrapper: null,
    file: "onnx/dpdfnet2.onnx",
    inputs: [
      { name: "spec", shape: [1, 1, 161, 2], type: "float32" },
      { name: "state_in", shape: [45424], type: "float32" },
    ],
    outputs: [
      { name: "spec_e", shape: [1, 1, 161, 2] },
      { name: "state_out", shape: [45424] },
    ],
  },
  "TigreGotico/audiosronnx-gtcrn": {
    kind: "onnx-signature",
    wrapper: null,
    file: "gtcrn_simple.onnx",
    inputs: [
      { name: "mix", shape: [1, 257, 1, 2], type: "float32" },
      { name: "conv_cache", shape: [2, 1, 16, 16, 33], type: "float32" },
      { name: "tra_cache", shape: [2, 3, 1, 1, 16], type: "float32" },
      { name: "inter_cache", shape: [2, 1, 33, 16], type: "float32" },
    ],
    outputs: [
      { name: "enh", shape: [1, 257, 1, 2] },
      { name: "conv_cache_out", shape: [2, 1, 16, 16, 33] },
      { name: "tra_cache_out", shape: [2, 3, 1, 1, 16] },
      { name: "inter_cache_out", shape: [2, 1, 33, 16] },
    ],
  },
  "onnx-community/wespeaker-voxceleb-resnet34-LM": {
    kind: "onnx-signature",
    wrapper: null,
    file: "onnx/model_int8.onnx",
    inputs: [{ name: "input_features", shape: ["B", "T", 80], type: "float32", run: [1, 200, 80] }],
    outputs: [{ name: "last_hidden_state", shape: ["B", 256] }],
  },
  "bjollans/whisper-large-v3-vaani-hindi-ct2": {
    kind: "ct2-folder",
    wrapper: null,
    needs: ["config.json", "model.bin", "vocabulary.json"],
    // The repository holds no tokenizer.json and the installer fetches one repository per pin, so the file is named here
    // as a companion: the large-v3 tokenizer already pinned under Systran/faster-whisper-large-v3 (this repository's
    // vocabulary.json is byte-identical to that one). Until it sits beside the model the self-test says "blocked" with
    // this reason, not "failed", and the Doctor offers no repair that could not help.
    companion: {
      file: "tokenizer.json",
      sourceRepo: "Systran/faster-whisper-large-v3",
      reason:
        "needs the large-v3 tokenizer.json (pinned under Systran/faster-whisper-large-v3) beside the model; without it faster-whisper would fetch one from the network",
    },
  },
  "nikh360pro/capsbro-hinglish-ct2": {
    kind: "ct2-folder",
    wrapper: null,
    // The model folder is the pinned `int8/` subfolder. The repository's tokenizer.json is whole (no companion needed);
    // it lacks the `<|mixedcode|>` marker, which the decoder prompt writes as the id 51866 held by vocabulary.json.
    needs: [
      "int8/config.json",
      "int8/model.bin",
      "int8/tokenizer.json",
      "int8/vocabulary.json",
      "LICENSE",
    ],
  },
  "soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8": {
    kind: "onnx-signature",
    wrapper: null,
    file: "encoder.onnx",
    inputs: [
      { name: "audio_signal", shape: [1, 128, 32], type: "float32" },
      { name: "audio_length", shape: [1], type: "int32" },
      { name: "language_mask", shape: [1, 128], type: "float32" },
      { name: "pre_cache", shape: [1, 128, 9], type: "float32" },
      { name: "cache_last_channel", shape: [24, 1, 56, 1024], type: "float32" },
      { name: "cache_last_time", shape: [24, 1, 1024, 8], type: "float32" },
      { name: "cache_last_channel_len", shape: [1], type: "int32" },
    ],
    outputs: [
      { name: "encoded_output", shape: [1, 4, 1024] },
      { name: "encoded_length", shape: [1] },
      { name: "new_pre_cache", shape: [1, 128, 9] },
      { name: "new_cache_last_channel", shape: [24, 1, 56, 1024] },
      { name: "new_cache_last_time", shape: [24, 1, 1024, 8] },
      { name: "new_cache_last_channel_len", shape: [1] },
    ],
  },
};

/** Pinned facts of one repository, with `diskBytes` summed from the pin; null for a repository that is not pinned. */
function manifestFor(repo) {
  const key = ALIASES[repo] || repo;
  if (!Object.prototype.hasOwnProperty.call(PINS, key) || !FACTS[key]) return null;
  const pin = PINS[key];
  return {
    repo: key,
    revision: pin.revision,
    license: pin.license,
    diskBytes: pinnedBytes(pin),
    ...FACTS[key],
  };
}

function pinForRepo(repo) {
  const mirror = Object.prototype.hasOwnProperty.call(MIRROR_REPOS, repo)
    ? MIRROR_REPOS[repo]
    : null;
  if (mirror) {
    const base = PINS[mirror.of];
    return { ...base, revision: mirror.revision, canonicalRevision: base.revision };
  }
  const key = ALIASES[repo] || repo;
  return Object.prototype.hasOwnProperty.call(PINS, key) ? PINS[key] : null;
}

function pinnedRepos() {
  return Object.keys(PINS);
}

function pinnedBytes(pin) {
  return Object.values(pin.files).reduce((sum, row) => sum + row.bytes, 0);
}

/**
 * Choose what to download from a repository listing, against a pin.
 * Every pinned file must be listed, and a digest the publisher lists must equal the pin: a different one
 * means the listing is not the pinned revision. Returns the pinned names and the digest and size to enforce.
 */
function selectPinned(listing, pin) {
  const listed = new Set(listing.files || []);
  const files = Object.keys(pin.files);
  const meta = {};
  for (const name of files) {
    if (!listed.has(name)) return { ok: false, error: `${name} is not in the pinned revision` };
    const row = pin.files[name];
    const seen = listing.meta?.[name]?.sha256 || "";
    if (seen && seen !== row.sha256) {
      return { ok: false, error: `${name}: the listed SHA-256 differs from the pinned one` };
    }
    meta[name] = { sha256: row.sha256, size: row.bytes };
  }
  return { ok: true, files, meta };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Check a folder against a pin. The size of every file is always checked (cheap); with `hash` the SHA-256
 * is too (a 3 GB file takes seconds). Reports missing, wrong-size and wrong-digest files separately so a
 * repair removes only the files that failed and downloads only those again.
 */
async function auditDir(dir, pin, options = {}) {
  recoverSwap(dir);
  const stat = options.stat || ((file) => fs.statSync(file, { throwIfNoEntry: false }));
  const hashOf = options.hashFile || sha256File;
  const missing = [];
  const wrongSize = [];
  const wrongDigest = [];
  for (const [name, row] of Object.entries(pin.files)) {
    const file = path.join(dir, ...name.split("/"));
    const info = stat(file);
    if (!info || !info.isFile()) {
      missing.push(name);
      continue;
    }
    if (info.size !== row.bytes) {
      wrongSize.push(name);
      continue;
    }
    if (options.hash) {
      let got = "";
      try {
        got = await hashOf(file);
      } catch {
        got = "";
      }
      if (got !== row.sha256) wrongDigest.push(name);
    }
  }
  return {
    ok: !missing.length && !wrongSize.length && !wrongDigest.length,
    checked: Object.keys(pin.files).length,
    hashed: Boolean(options.hash),
    missing,
    wrongSize,
    wrongDigest,
  };
}

/** Delete the files an audit found wrong (never a missing or good one), so the next download fetches them. */
function removeBad(dir, audit, remove) {
  const rm = remove || ((file) => fs.rmSync(file, { force: true }));
  const bad = [...audit.wrongSize, ...audit.wrongDigest];
  for (const name of bad) rm(path.join(dir, ...name.split("/")));
  return bad;
}

/* ------------------------------------------------------------------ folder safety
 * What keeps a pinned model folder trustworthy on disk: derived states, the disk preflight, the unexpected-file
 * quarantine, the verified move, and the `<folder>.prev` revision swap with its rollback. Every function takes its
 * file-system calls through `deps`, so a test needs no weights and no second volume.
 */

/** FRIDAY's own record inside a verified model folder: which revision and which files were checked. */
const MARKER = ".friday-pin.json";
/** Free space needed before a download starts, as a multiple of its bytes (room for the part files and the swap). */
const DISK_FACTOR = 1.3;

/** Files FRIDAY and its downloaders write into a model folder themselves; never "unexpected". */
function isOwnFile(rel) {
  return (
    rel === MARKER ||
    rel === ".friday-complete" ||
    rel === ".cache" ||
    rel.startsWith(".cache/") ||
    /\.part(?:\.json)?$/.test(rel)
  );
}

function walkFiles(dir, base = "") {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(dir, ...(base ? base.split("/") : [])), {
      withFileTypes: true,
    });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walkFiles(dir, rel));
    else found.push(rel);
  }
  return found;
}

/** Installed and verified state, derived from the folder every time: nothing about it is stored. */
async function stateOf(dir, pin, options = {}) {
  const audit = await auditDir(dir, pin, options);
  const total = Object.keys(pin.files).length;
  if (audit.missing.length === total) return { installState: "missing", verifyState: "unverified" };
  if (audit.missing.length) return { installState: "partial", verifyState: "unverified" };
  return { installState: "installed", verifyState: audit.ok ? "ok" : "damaged" };
}

/** The room a download needs, measured on the nearest folder that exists. An unreadable volume is not called full. */
function diskPreflight(dir, needBytes, options = {}) {
  const need = Math.max(0, Math.floor(Number(needBytes) || 0));
  const requiredBytes = Math.ceil((need * 13) / 10);
  if (!need) return { ok: true, requiredBytes: 0, freeBytes: null, error: "" };
  const statfs = options.statfs || ((where) => fs.statfsSync(where));
  let where = path.resolve(dir);
  const exists = options.exists || ((file) => fs.existsSync(file));
  while (!exists(where) && path.dirname(where) !== where) where = path.dirname(where);
  let free = null;
  try {
    const stat = statfs(where);
    free = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return { ok: true, requiredBytes, freeBytes: null, error: "" };
  }
  if (free >= requiredBytes) return { ok: true, requiredBytes, freeBytes: free, error: "" };
  return {
    ok: false,
    requiredBytes,
    freeBytes: free,
    error: `not enough disk space: ${requiredBytes} bytes are needed (1.3 times the ${need}-byte download), ${free} bytes are free`,
  };
}

/** Files in a pinned model folder that the pin does not list (README, a stray weight, a dropped program). */
function unexpectedFiles(dir, pin, options = {}) {
  const list = options.list || walkFiles;
  return list(dir)
    .filter((rel) => !isOwnFile(rel) && !Object.prototype.hasOwnProperty.call(pin.files, rel))
    .sort();
}

function sha256FileSync(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Move a file and never lose it: a rename inside one volume, and when the rename crosses volumes (EXDEV, a folder
 * junction on Windows) copy beside the target, compare size and SHA-256 with the source, rename the copy into place and
 * only then delete the source. A failed or unequal copy is removed and the source stays where it was.
 */
function moveVerified(src, dest, options = {}) {
  const rename = options.rename || fs.renameSync;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    rename(src, dest);
    return { ok: true, via: "rename" };
  } catch (err) {
    if (err?.code !== "EXDEV")
      return { ok: false, via: "rename", error: String(err?.message || err) };
  }
  const copy = options.copy || fs.copyFileSync;
  const staged = `${dest}.moving`;
  try {
    copy(src, staged);
    if (fs.statSync(staged).size !== fs.statSync(src).size)
      throw new Error("the copy has a different size");
    if (sha256FileSync(staged) !== sha256FileSync(src))
      throw new Error("the copy fails its SHA-256");
    fs.renameSync(staged, dest);
    fs.rmSync(src, { force: true });
    return { ok: true, via: "copy" };
  } catch (err) {
    fs.rmSync(staged, { force: true });
    return { ok: false, via: "copy", error: String(err?.message || err) };
  }
}

/** A relative name that stays inside its folder (no `..`, no drive, no absolute path). */
function insideFolder(rel) {
  const text = String(rel || "");
  if (!text || path.isAbsolute(text) || /^[a-zA-Z]:/.test(text)) return false;
  return !text.split(/[\\/]+/).includes("..");
}

/**
 * Move the files a pin does not list out of the model folder into `to` (kept, reversible, nothing is deleted),
 * keeping their relative paths, then remove the folders that this left empty.
 */
function quarantineFiles(dir, names, to, options = {}) {
  const moved = [];
  const failed = [];
  for (const rel of names) {
    if (!insideFolder(rel)) {
      failed.push(rel);
      continue;
    }
    const parts = rel.split("/");
    const result = moveVerified(path.join(dir, ...parts), path.join(to, ...parts), options);
    (result.ok ? moved : failed).push(rel);
    if (!result.ok) continue;
    for (let depth = parts.length - 1; depth > 0; depth -= 1) {
      const folder = path.join(dir, ...parts.slice(0, depth));
      try {
        if (fs.readdirSync(folder).length) break;
        fs.rmdirSync(folder);
      } catch {
        break;
      }
    }
  }
  return { moved, failed, to };
}

/** Record that this folder was checked against this pin (written only after the size and SHA-256 checks pass). */
function writeMarker(dir, repo, pin, options = {}) {
  try {
    const record = {
      schema: 1,
      repo: canonicalRepo(repo),
      revision: canonicalRevision(pin),
      verifiedAt: (options.now ? options.now() : new Date()).toISOString(),
      files: Object.fromEntries(
        Object.entries(pin.files).map(([name, row]) => [
          name,
          { bytes: row.bytes, sha256: row.sha256 },
        ]),
      ),
    };
    const file = path.join(dir, MARKER);
    fs.writeFileSync(`${file}.part`, JSON.stringify(record, null, 2));
    fs.renameSync(`${file}.part`, file);
    return true;
  } catch {
    return false;
  }
}

function readMarker(dir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8"));
    if (
      typeof record?.repo === "string" &&
      typeof record?.revision === "string" &&
      record.files &&
      typeof record.files === "object"
    ) {
      return record;
    }
  } catch {
    /* no marker, or one that cannot be read: the folder is simply not certified */
  }
  return null;
}

const prevOf = (dir) => `${dir}.prev`;

/** The kept previous revision of a model folder, if any: its revision and the bytes it takes. */
function previousInfo(dir) {
  const marker = readMarker(prevOf(dir));
  if (!fs.existsSync(prevOf(dir))) return { exists: false, revision: "", bytes: 0 };
  const bytes = marker
    ? Object.values(marker.files).reduce((sum, row) => sum + (Number(row?.bytes) || 0), 0)
    : 0;
  return { exists: true, revision: marker?.revision || "", bytes };
}

function discardPrevious(dir) {
  if (!fs.existsSync(prevOf(dir))) return false;
  fs.rmSync(prevOf(dir), { recursive: true, force: true });
  return true;
}

/**
 * A kill between the steps of a swap leaves the verified copy only as `<folder>.swap`, with the folder itself gone.
 * Put it back (the folder missing and `.swap` present is the whole test); called at the start of every swap and audit,
 * so the copy is never left aside and never deleted while it is the only one.
 */
function recoverSwap(dir, rename = fs.renameSync) {
  const aside = `${dir}.swap`;
  try {
    if (fs.existsSync(dir) || !fs.existsSync(aside)) return { recovered: false };
    rename(aside, dir);
    return { recovered: true };
  } catch {
    return { recovered: false };
  }
}

/**
 * The pinned revision changed and the folder on disk is a complete, verified copy of an older one: keep it whole as
 * `<folder>.prev` (one generation; an older `.prev` is dropped) and start the new revision in a fresh folder, seeded with
 * the files whose pinned SHA-256 did not change (a hard link, or a copy where links are not allowed). A folder with no
 * marker, the same revision, or an incomplete old copy is left to the ordinary repair, which only replaces bad files.
 */
function beginRevisionSwap(dir, repo, pin, options = {}) {
  const rename = options.rename || fs.renameSync;
  const none = (reason) => ({ swapped: false, prev: prevOf(dir), seeded: [], reason });
  recoverSwap(dir);
  const marker = readMarker(dir);
  if (!marker) return none("the folder has no verification marker");
  if (marker.repo !== canonicalRepo(repo)) return none("the marker belongs to another repository");
  if (marker.revision === canonicalRevision(pin)) return none("the pinned revision did not change");
  for (const [name, row] of Object.entries(marker.files)) {
    const info = fs.statSync(path.join(dir, ...name.split("/")), { throwIfNoEntry: false });
    if (!info || !info.isFile() || info.size !== row.bytes)
      return none("the old copy is not complete");
  }
  const prev = prevOf(dir);
  const aside = `${dir}.swap`;
  try {
    // The folder moves aside first: if that fails (a file is open on Windows) nothing has been lost, not even an older .prev.
    // A leftover `.swap` is only removed here because the folder beside it is certified and complete (checked above).
    fs.rmSync(aside, { recursive: true, force: true });
    rename(dir, aside);
  } catch (err) {
    return none(`the folder could not be moved (${String(err?.message || err)})`);
  }
  try {
    fs.rmSync(prev, { recursive: true, force: true });
    rename(aside, prev);
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    try {
      if (!fs.existsSync(dir)) rename(fs.existsSync(aside) ? aside : prev, dir);
    } catch {
      /* the error below says where the folder is */
    }
    return none(`the folder could not be kept (${String(err?.message || err)})`);
  }
  const seeded = [];
  for (const [name, row] of Object.entries(pin.files)) {
    const old = marker.files[name];
    if (!old || old.sha256 !== row.sha256 || old.bytes !== row.bytes) continue;
    const from = path.join(prev, ...name.split("/"));
    const to = path.join(dir, ...name.split("/"));
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      try {
        fs.linkSync(from, to);
      } catch {
        fs.copyFileSync(from, to);
      }
      seeded.push(name);
    } catch {
      /* a file that could not be seeded is simply downloaded again */
    }
  }
  return { swapped: true, prev, seeded, reason: "" };
}

/** Put the previous verified revision back in place of a new one that failed to verify or to load. */
function rollbackToPrevious(dir) {
  const prev = prevOf(dir);
  if (!fs.existsSync(prev)) {
    return { ok: false, revision: "", error: "no previous revision is kept for this model" };
  }
  const revision = readMarker(prev)?.revision || "";
  const failed = `${dir}.failed`;
  try {
    fs.rmSync(failed, { recursive: true, force: true });
    if (fs.existsSync(dir)) fs.renameSync(dir, failed);
    fs.renameSync(prev, dir);
    fs.rmSync(failed, { recursive: true, force: true });
  } catch (err) {
    if (!fs.existsSync(dir) && fs.existsSync(failed)) {
      try {
        fs.renameSync(failed, dir);
      } catch {
        /* the folder stays where it is; the error below says why */
      }
    }
    return { ok: false, revision, error: String(err?.message || err) };
  }
  return { ok: true, revision, error: "" };
}

module.exports = {
  PINS,
  LICENCES,
  LICENCE_CHECKED_AT,
  bundleAllowed,
  FACTS,
  FILE_FACTS,
  SELF_TESTS,
  MARKER,
  DISK_FACTOR,
  manifestFor,
  stateOf,
  diskPreflight,
  unexpectedFiles,
  isOwnFile,
  quarantineFiles,
  moveVerified,
  insideFolder,
  writeMarker,
  readMarker,
  previousInfo,
  discardPrevious,
  beginRevisionSwap,
  recoverSwap,
  rollbackToPrevious,
  sha256FileSync,
  pinForRepo,
  pinnedRepos,
  pinnedBytes,
  selectPinned,
  auditDir,
  removeBad,
};
