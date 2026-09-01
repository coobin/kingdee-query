const crypto = require("crypto");

function identityKey(identity) {
  return String(identity?.kingdeeUsername || identity?.userId || identity?.adminUsername || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function compactResult(result, maxRows) {
  const sourceRows = Array.isArray(result.rows) ? result.rows : [];
  const storedTruncated = Boolean(result.truncated || sourceRows.length > maxRows || Number(result.count) > maxRows);
  return {
    tool: result.tool,
    label: result.label,
    query: result.query || {},
    columns: Array.isArray(result.columns) ? result.columns : [],
    rows: sourceRows.slice(0, maxRows),
    count: Number(result.count) || sourceRows.length,
    truncated: storedTruncated,
    partial: Boolean(result.partial || result.statistics?.partial || storedTruncated),
    statistics: result.statistics || null,
    summary: String(result.summary || ""),
  };
}

class AnalysisContextStore {
  constructor({ ttlMs = 600000, maxEntries = 100, maxRows = 5000, now = () => Date.now() } = {}) {
    this.ttlMs = Math.min(Math.max(Number(ttlMs) || 600000, 60000), 3600000);
    this.maxEntries = Math.min(Math.max(Number(maxEntries) || 100, 10), 1000);
    this.maxRows = Math.min(Math.max(Number(maxRows) || 5000, 100), 10000);
    this.now = now;
    this.entries = new Map();
  }

  cleanup() {
    const current = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= current) this.entries.delete(id);
    }
  }

  create({ identity, tool, plan, result }) {
    this.cleanup();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest == null) break;
      this.entries.delete(oldest);
    }
    const id = crypto.randomBytes(24).toString("base64url");
    const createdAt = this.now();
    const entry = {
      id,
      userKey: identityKey(identity),
      tool: String(tool || result?.tool || ""),
      plan: {
        tool: String(plan?.tool || tool || result?.tool || ""),
        arguments: { ...(plan?.arguments || {}) },
      },
      result: compactResult(result || {}, this.maxRows),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      cache: new Map(),
    };
    this.entries.set(id, entry);
    return { id, createdAt, expiresAt: entry.expiresAt };
  }

  get(id, identity) {
    this.cleanup();
    const entry = this.entries.get(String(id || ""));
    if (!entry) throw Object.assign(new Error("查询结果已过期，请重新查询后再分析。"), { statusCode: 410, code: "context_expired" });
    const currentUserKey = identityKey(identity);
    if (!entry.userKey || !currentUserKey || !safeEqual(entry.userKey, currentUserKey)) {
      throw Object.assign(new Error("不能分析其他用户的查询结果。"), { statusCode: 403, code: "context_forbidden" });
    }
    return entry;
  }

  getCached(entry, key) {
    const value = entry.cache.get(String(key || ""));
    if (!value || value.expiresAt <= this.now()) {
      if (value) entry.cache.delete(String(key || ""));
      return null;
    }
    return value.value;
  }

  setCached(entry, key, value, ttlMs) {
    entry.cache.set(String(key || ""), { value, expiresAt: this.now() + Math.min(Math.max(Number(ttlMs) || 600000, 30000), 3600000) });
    return value;
  }
}

module.exports = {
  AnalysisContextStore,
  identityKey,
};
