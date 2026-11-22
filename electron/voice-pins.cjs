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
};

/** The turbo repository was renamed; the old name redirects to the same revision and files. */
const ALIASES = {
  "mobiuslabsgmbh/faster-whisper-large-v3-turbo": "dropbox-dash/faster-whisper-large-v3-turbo",
};

function pinForRepo(repo) {
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

module.exports = {
  PINS,
  pinForRepo,
  pinnedRepos,
  pinnedBytes,
  selectPinned,
  auditDir,
  removeBad,
};
