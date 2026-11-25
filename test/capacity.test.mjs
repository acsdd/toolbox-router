import assert from "node:assert/strict";
import test from "node:test";

import {
  CapacityError,
  assertModelAvailable,
  filterModelsByCapacity,
  inspectCapacity,
} from "../src/capacity.mjs";

function capacity(overrides = {}) {
  return {
    ok: true,
    drive: "D:",
    modelRoot: "D:/LMStudio_Downloads",
    freeBytes: 1_000,
    reserveBytes: 300,
    availableBytes: 700,
    ...overrides,
  };
}

test("capacity inspection uses D-drive available blocks and preserves the configured reserve", async () => {
  const calls = [];
  const result = await inspectCapacity(
    {
      modelRoot: "D:/LMStudio_Downloads",
      capacityDrive: "D:",
      minFreeBytes: 300,
    },
    {
      statfsImpl: async (path) => {
        calls.push(path);
        return { bsize: 10, bavail: 100, bfree: 150, blocks: 1_000 };
      },
    },
  );

  assert.deepEqual(calls, ["D:/LMStudio_Downloads"]);
  assert.equal(result.drive, "D:");
  assert.equal(result.freeBytes, 1_000);
  assert.equal(result.reserveBytes, 300);
  assert.equal(result.availableBytes, 700);
  assert.equal(result.ok, true);
});

test("capacity inspection clamps negative headroom to zero", async () => {
  const result = await inspectCapacity(
    { modelRoot: "D:/Models", capacityDrive: "D:", minFreeBytes: 300 },
    { statfsImpl: async () => ({ bsize: 10, bavail: 20, bfree: 25, blocks: 1_000 }) },
  );

  assert.equal(result.freeBytes, 200);
  assert.equal(result.availableBytes, 0);
  assert.equal(result.ok, false);
});

test("capacity inspection rejects C-drive paths before touching the filesystem", async () => {
  let called = false;
  const statfsImpl = async () => {
    called = true;
    return { bsize: 1, bavail: 1, bfree: 1, blocks: 1 };
  };

  await assert.rejects(
    () => inspectCapacity({ modelRoot: "C:/Models", capacityDrive: "D:", minFreeBytes: 0 }, { statfsImpl }),
    (error) => error instanceof CapacityError && error.code === "invalid_capacity_path",
  );
  await assert.rejects(
    () => inspectCapacity({ modelRoot: "D:/Models", capacityDrive: "C:", minFreeBytes: 0 }, { statfsImpl }),
    (error) => error instanceof CapacityError && error.code === "invalid_capacity_drive",
  );
  assert.equal(called, false);
});

test("capacity inspection reports filesystem failures without falling back to C drive", async () => {
  await assert.rejects(
    () =>
      inspectCapacity(
        { modelRoot: "D:/Missing", capacityDrive: "D:", minFreeBytes: 0 },
        {
          statfsImpl: async () => {
            throw new Error("D drive is unavailable");
          },
        },
      ),
    (error) => error instanceof CapacityError && error.code === "capacity_unavailable" && /D drive/.test(error.message),
  );
});

test("model filtering admits exact fits and zero-space aliases but rejects models above headroom", () => {
  const models = [
    { id: "toolbox-spike", upstreamModel: "grok-4.7", requiredBytes: 0 },
    { id: "exact-fit", upstreamModel: "local-a", requiredBytes: 700 },
    { id: "too-large", upstreamModel: "local-b", requiredBytes: 701 },
  ];

  assert.deepEqual(filterModelsByCapacity(models, capacity()).map((model) => model.id), [
    "toolbox-spike",
    "exact-fit",
  ]);
});

test("model filtering fails closed for space-requiring models when capacity is unknown", () => {
  const models = [
    { id: "toolbox-spike", upstreamModel: "grok-4.7", requiredBytes: 0 },
    { id: "local-model", upstreamModel: "local-a", requiredBytes: 1 },
  ];

  assert.deepEqual(filterModelsByCapacity(models, null).map((model) => model.id), ["toolbox-spike"]);
  assert.deepEqual(filterModelsByCapacity(models, capacity({ ok: false, availableBytes: 0 })).map((model) => model.id), [
    "toolbox-spike",
  ]);
});

test("assertModelAvailable returns a structured capacity error for direct requests", () => {
  assert.doesNotThrow(() => assertModelAvailable({ id: "exact-fit", requiredBytes: 700 }, capacity()));
  assert.throws(
    () => assertModelAvailable({ id: "too-large", requiredBytes: 701 }, capacity()),
    (error) =>
      error instanceof CapacityError &&
      error.status === 409 &&
      error.code === "insufficient_capacity" &&
      error.details.requiredBytes === 701 &&
      error.details.availableBytes === 700,
  );
});
