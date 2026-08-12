const fs = require("fs");
const path = require("path");

function createAuditLogger(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return function audit(event) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    fs.appendFile(filePath, line, (error) => {
      if (error) console.error(JSON.stringify({ level: "error", message: "audit.write_failed", error: error.message }));
    });
  };
}

module.exports = { createAuditLogger };
