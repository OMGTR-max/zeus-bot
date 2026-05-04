// Atomic JSON persistence with serialized writes per file.
//
// Crash-safe writes: write to <path>.tmp, fsync, rename → atomic on POSIX.
// Per-file write queue: serializes async callers so concurrent
// load→mutate→save sequences don't drop updates.
const fs = require('fs');
const path = require('path');

const writeQueues = new Map();

function safeReadJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.log(`[persistence] read error ${path.basename(filePath)}: ${e.message}`);
    return fallback;
  }
}

function atomicWriteJSONSync(filePath, data) {
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

// Async serialized write — returns a promise that resolves once
// this caller's write hits disk. Subsequent callers for the same
// file wait their turn.
function queuedWriteJSON(filePath, dataFn) {
  const prev = writeQueues.get(filePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => {
    const data = typeof dataFn === 'function' ? dataFn() : dataFn;
    atomicWriteJSONSync(filePath, data);
  });
  writeQueues.set(filePath, next);
  next.finally(() => {
    if (writeQueues.get(filePath) === next) writeQueues.delete(filePath);
  });
  return next;
}

module.exports = {
  safeReadJSON,
  atomicWriteJSONSync,
  queuedWriteJSON,
};
