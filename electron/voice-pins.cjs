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

const PINS = {
  "Systran/faster-whisper-base": {
    revision: "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
    license: "MIT",
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
  // The Hindi fallback: Collabora's Whisper-small Hindi fine-tune, CTranslate2. CC-BY-4.0: the credit is
  // shown on the Models page. Used instead of generic small only when Hindi is chosen and the Hindi ear is missing.
  "collabora/faster-whisper-small-hindi": {
    revision: "92e09a8982af971cf2033ed592d4ef8b249baad2",
    license: "CC-BY-4.0",
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
  // CC-BY-4.0 (credit: Sulabh Katiyar, trained on AI4Bharat Rasa): the credit is shown in the Models page row and the
  // licence text is kept next to the weights. The package code in the repository is not downloaded; FRIDAY's own
  // thin Devanagari frontend replaces it.
  "sulabhkatiyar/indic-tiny-tts-hindi": {
    revision: "1fb1b108ee6ffb73ee74bd68b283ec13eb39e957",
    license: "CC-BY-4.0",
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
  // Optional, off by default, never fetched on its own. Read from the Hugging Face API on 2026-11-23 and the small files
  // fetched at the pinned revision and hashed here. Only the one 16 kHz ONNX graph is pinned (the repository also holds
  // 8 kHz, 48 kHz, TFLite and checkpoint files, none of which FRIDAY uses). A streaming speech-enhancement model
  // (Apache-2.0, Ceva-IP): one 10 ms frame in, one frame out, with a state vector. No wrapper in FRIDAY runs it yet.
  "Ceva-IP/DPDFNet": {
    revision: "dd6818d00f50c836fed43a6243ebe49116de5964",
    license: "Apache-2.0",
    files: {
      "onnx/dpdfnet8.onnx": {
        sha256: "899d4f23f3ff86edbffa8c537e4bcbdc49da1b4e84e0ef390611e0604a3b26cb",
        bytes: 14542517,
      },
    },
  },
  // Optional speaker-verification candidate (CC-BY-4.0, credit shown in the Models row): WeSpeaker ResNet34-LM, int8,
  // 80-bin Kaldi filterbank in, one 256-number voice embedding out. Only the int8 graph and its two small configs are pinned.
  "onnx-community/wespeaker-voxceleb-resnet34-LM": {
    revision: "6a61a1833ff2583aabeba044f5c8221f00b67ceb",
    license: "CC-BY-4.0",
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
  // Optional streaming ear candidate, never a default; setup fetches it only when the voice plan says this PC can carry
  // it (electron/voice-weights.cjs streamEarDecision), each file checked against the digest below. NVIDIA Nemotron 3.5 ASR
  // Streaming 0.6B (cache-aware FastConformer RNN-T, 128 language prompt slots incl. hi-IN and en-US), exported to ONNX
  // by soniqo with an INT8 encoder and FP32 decoder and joint: a fixed 320 ms chunk, 32 mel frames per pass. Read from the
  // Hugging Face tree API on 2026-11-26: each large file carries its LFS SHA-256, the three small files were fetched at the
  // pinned revision and hashed here, and every digest and size was re-checked against the downloaded bytes. The card names
  // an `encoder.onnx.data` that this revision does not hold: the 657,558,932-byte encoder.onnx carries its weights inline.
  // The weights are the NVIDIA Open Model License (the repository's own tag); the upstream model has since moved to
  // OpenMDW-1.1 and the int4 repository of another publisher is tagged MIT: that conflict is recorded in
  // docs/FRIDAY_VOICE_ENGINE.md. FRIDAY never bundles or redistributes the files: the owner's PC fetches them from the
  // official repository. Run by FRIDAY's own onnxruntime loop (kernel/transducer_loop.py), no torch.
  "soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8": {
    revision: "1ce4daedd303e01d4e603634a72c28562f1a6855",
    license: "NVIDIA-Open-Model-License",
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
};

/** The turbo repository was renamed; the old name redirects to the same revision and files. */
const ALIASES = {
  "mobiuslabsgmbh/faster-whisper-large-v3-turbo": "dropbox-dash/faster-whisper-large-v3-turbo",
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
  "Ceva-IP/DPDFNet": {
    minRamGb: 0.1,
    recommendedRamGb: 0.2,
    minVramGb: 0,
    cpuOk: true,
    gpuOk: false,
    quantization: "fp32 (ONNX)",
    fallbackPriority: "experimental",
    basis: "measured",
    peakRssMb: 85,
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
    file: "onnx/dpdfnet8.onnx",
    inputs: [
      { name: "spec", shape: [1, 1, 161, 2], type: "float32" },
      { name: "state_in", shape: [66928], type: "float32" },
    ],
    outputs: [
      { name: "spec_e", shape: [1, 1, 161, 2] },
      { name: "state_out", shape: [66928] },
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
  FACTS,
  FILE_FACTS,
  SELF_TESTS,
  MARKER,
  DISK_FACTOR,
  manifestFor,
  stateOf,
  diskPreflight,
  unexpectedFiles,
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
