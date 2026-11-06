import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const models = JSON.parse(fs.readFileSync(new URL("../../models.json", import.meta.url), "utf8"));
const packages = JSON.parse(
  fs.readFileSync(new URL("../../model-packages.json", import.meta.url), "utf8")
);

test("Transcribe is a distinct offline ASR model with opt-in timestamp and speaker labels", () => {
  const found = models.filter((x) => x.id === "nemotron_transcribe");
  assert.equal(found.length, 1);
  const model = found[0];
  assert.equal(model.family, "nemotron_transcribe");
  assert.equal(model.category, "asr");
  assert.equal(model.serverTask, "asr");
  assert.deepEqual(model.modes, ["offline"]);
  assert.equal(model.inputs.audio, "required");
  assert.equal(model.inputs.text, "optional");
  assert.equal(model.paramSchema.diarization.type, "boolean");
  assert.equal(model.paramSchema.diarization.default, false);
  assert.equal(model.paramSchema.return_timestamps.default, false);
  assert.deepEqual(model.paramSchema.template_name.values, [
    "default",
    "translation",
    "audio_qa",
    "language_id"
  ]);
});

test("each pinned model package contains a hashed expert file and the required encoder", () => {
  const family = packages.nemotron_transcribe;
  assert.equal(family.status, "experimental");
  assert.equal(family.packages.length, 4);
  assert.deepEqual(
    family.packages.filter((p) => p.default).map((p) => p.id),
    ["nemotron_transcribe_iq4_nl"]
  );
  for (const pkg of family.packages) {
    assert.equal(pkg.repo, "Jmica/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-GGUF");
    assert.equal(pkg.revision, "304032f14e1e9e4042f5491d2d0194c044710bb7");
    assert.equal(pkg.files.length, 2);
    assert.match(pkg.files[0].local, /^nemotron-transcribe-30b-a4b-experts-.+\.gguf$/);
    assert.equal(
      pkg.files[1].local,
      "mmproj-NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-Encoder-F16.gguf"
    );
    for (const f of pkg.files) {
      assert.equal(f.local, f.remote);
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
    }
  }
});
