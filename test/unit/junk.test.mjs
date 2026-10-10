import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEsModule } from "./helpers/vm.mjs";

function load() {
  return loadEsModule("modules/junk.js", {});
}

test("junk labels cover probes and leave real model ids alone", () => {
  const j = load();
  for (const name of [
    "nonexistent",
    "nonexistent_model",
    "testmodel",
    "test_model",
    "test-model",
    "race",
    "Race",
    "race1",
    "race-2",
    "race_3",
    "race 4",
    "probe",
    "probe-x",
    "bench",
    "benchmark",
    "bench-1",
    "benchmark_2",
    "dummy",
    "dummy-model",
    "tmp",
    "tmp1"
  ]) {
    assert.equal(j.isJunkLabel(name), true, name);
  }
  for (const name of ["", "breeze", "racer", "benchpress", "testing", "voice"]) {
    assert.equal(j.isJunkLabel(name), false, name);
  }
  assert.equal(j.isJunkStatsModel({ modelId: "" }), true);
  assert.equal(j.isJunkStatsModel({}), true);
  assert.equal(j.isJunkStatsModel(null), true);
  assert.equal(j.isJunkStatsModel({ modelId: "nonexistent_model" }), true);
  assert.equal(j.isJunkStatsModel({ modelId: "test_model" }), true);
  assert.equal(j.isJunkStatsModel({ modelId: "race" }), true);
  assert.equal(j.isJunkStatsModel({ modelId: "breeze" }), false);
});

test("activity junk checks both names and the catalog", () => {
  const j = load();
  const inst = [{ id: "i1", instanceName: "voice", modelId: "breeze" }];
  const models = [{ id: "breeze" }, { id: "music" }];
  assert.equal(
    j.isJunkActivityRow({ modelId: "breeze", instanceName: "" }, { instances: inst }),
    false
  );
  assert.equal(
    j.isJunkActivityRow({ modelId: "breeze", instanceName: "probe" }, { instances: inst }),
    true
  );
  assert.equal(
    j.isJunkActivityRow({ modelId: "race", instanceName: "voice" }, { instances: inst }),
    true
  );
  assert.equal(j.isJunkActivityRow({ taskId: "t" }, {}), true);
  assert.equal(
    j.isJunkActivityRow({ instanceId: "i1", modelId: "nope" }, { instances: inst, models }),
    false
  );
  assert.equal(
    j.isJunkActivityRow({ modelId: "music", instanceId: "gone" }, { instances: inst, models }),
    false
  );
  assert.equal(
    j.isJunkActivityRow(
      { modelId: "other", instanceId: "gone", instanceName: "ghost" },
      { instances: inst, models }
    ),
    true
  );
  assert.equal(
    j.isJunkActivityRow({ modelId: "other", instanceId: "gone" }, { instances: inst, models: [] }),
    false
  );
  assert.equal(
    j.isJunkActivityRow({ modelId: "other", instanceId: "gone" }, { instances: inst }),
    false
  );
});
