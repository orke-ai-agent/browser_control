const fs = require("fs");

function loadEnv(filePath) {
  const loaded = {};

  if (fs.existsSync(filePath)) {
    const rows = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

    for (const row of rows) {
      const line = row.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");

      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      loaded[key] = value;
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  return loaded;
}

module.exports = {
  loadEnv,
};
