const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function rotate(filePath, maxFiles) {
  if (maxFiles < 1) return;
  for (let index = maxFiles; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const target = `${filePath}.${index}`;
    if (!fs.existsSync(source)) continue;
    if (index === maxFiles && fs.existsSync(target)) fs.unlinkSync(target);
    fs.renameSync(source, target);
  }
}

function createAuditLogger(filePath, { maxBytes = 10 * 1024 * 1024, maxFiles = 10 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return function audit(event) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), eventId: event.eventId || crypto.randomUUID(), ...event })}\n`;
    try {
      const currentBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      if (currentBytes > 0 && currentBytes + Buffer.byteLength(line) > maxBytes) rotate(filePath, maxFiles);
      fs.appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "audit.write_failed", error: error.message }));
    }
  };
}

function readTail(filePath, maximumBytes = 2 * 1024 * 1024) {
  if (!fs.existsSync(filePath)) return [];
  const size = fs.statSync(filePath).size;
  if (!size) return [];
  const bytes = Math.min(size, maximumBytes);
  const buffer = Buffer.alloc(bytes);
  const handle = fs.openSync(filePath, "r");
  try {
    fs.readSync(handle, buffer, 0, bytes, size - bytes);
  } finally {
    fs.closeSync(handle);
  }
  let text = buffer.toString("utf8");
  if (bytes < size) text = text.slice(text.indexOf("\n") + 1);
  return text.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function readAuditEvents(filePath, { limit = 200, maxFiles = 10 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const events = [];
  for (let index = 0; index <= maxFiles && events.length < safeLimit; index += 1) {
    const source = index === 0 ? filePath : `${filePath}.${index}`;
    const rows = readTail(source).reverse();
    events.push(...rows.slice(0, safeLimit - events.length));
  }
  return events.map((event) => (!event.action && event.tool ? { ...event, action: "query" } : event));
}

module.exports = { createAuditLogger, readAuditEvents };
