import { statfs } from "node:fs/promises";
import { win32 } from "node:path";

export class CapacityError extends Error {
  constructor(message, status = 503, code = "capacity_error", details = undefined) {
    super(message);
    this.name = "CapacityError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function assertDPath(value, name) {
  if (typeof value !== "string" || !win32.isAbsolute(value) || !/^d:[\\/]/i.test(value)) {
    throw new CapacityError(`${name} must be an absolute path on D: drive`, 500, "invalid_capacity_path");
  }
}

function byteCount(value, name) {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CapacityError(`${name} must be a non-negative safe integer`, 500, "invalid_capacity_value");
  }
  return BigInt(number);
}

export async function inspectCapacity(config, { statfsImpl = statfs } = {}) {
  assertDPath(config.modelRoot, "modelRoot");
  if (config.capacityDrive?.toUpperCase() !== "D:") {
    throw new CapacityError("capacityDrive must be D:; C: capacity is intentionally ignored", 500, "invalid_capacity_drive");
  }

  const reserveBytes = byteCount(config.minFreeBytes, "minFreeBytes");
  let stats;
  try {
    stats = await statfsImpl(config.modelRoot);
  } catch (error) {
    throw new CapacityError(`Could not inspect D-drive model capacity: ${error.message}`, 503, "capacity_unavailable");
  }

  const blockSize = byteCount(stats.bsize, "statfs.bsize");
  const availableBlocks = byteCount(stats.bavail, "statfs.bavail");
  const freeBlocks = byteCount(stats.bfree, "statfs.bfree");
  const totalBlocks = byteCount(stats.blocks, "statfs.blocks");
  const freeBytes = availableBlocks * blockSize;
  const totalBytes = totalBlocks * blockSize;
  const systemFreeBytes = freeBlocks * blockSize;

  for (const [name, value] of [
    ["freeBytes", freeBytes],
    ["totalBytes", totalBytes],
    ["systemFreeBytes", systemFreeBytes],
  ]) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CapacityError(`${name} exceeds the supported numeric range`, 500, "invalid_capacity_value");
    }
  }

  const availableBytes = freeBytes > reserveBytes ? freeBytes - reserveBytes : 0n;
  return {
    ok: freeBytes >= reserveBytes,
    drive: "D:",
    modelRoot: config.modelRoot,
    freeBytes: Number(freeBytes),
    systemFreeBytes: Number(systemFreeBytes),
    totalBytes: Number(totalBytes),
    reserveBytes: Number(reserveBytes),
    availableBytes: Number(availableBytes),
    checkedAt: new Date().toISOString(),
  };
}

function requiredBytes(model) {
  const value = model?.requiredBytes ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CapacityError("Model requiredBytes must be a non-negative safe integer", 500, "invalid_model_size");
  }
  return value;
}

export function filterModelsByCapacity(models, capacity) {
  return models.filter((model) => {
    const required = requiredBytes(model);
    if (required === 0) return true;
    return capacity?.ok === true && required <= capacity.availableBytes;
  });
}

export function assertModelAvailable(model, capacity) {
  const required = requiredBytes(model);
  if (required === 0 || (capacity?.ok === true && required <= capacity.availableBytes)) return;

  throw new CapacityError(
    `Model ${model.id} requires ${required} bytes of D-drive headroom; ${capacity?.availableBytes ?? 0} bytes are available`,
    409,
    "insufficient_capacity",
    {
      model: model.id,
      drive: "D:",
      requiredBytes: required,
      availableBytes: capacity?.availableBytes ?? 0,
      reserveBytes: capacity?.reserveBytes ?? null,
    },
  );
}
