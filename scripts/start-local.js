const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function loadEnvFiles(filePaths) {
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function log(message, meta) {
  if (meta === undefined) {
    console.log(`[browser-start] ${message}`);
    return;
  }
  console.log(`[browser-start] ${message}`, meta);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        ...options.env,
      },
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });

    child.on("error", reject);
  });
}

async function main() {
  const projectRoot = process.cwd();
  const workspaceRoot = path.join(projectRoot, "..");
  loadEnvFiles([
    path.join(workspaceRoot, ".env"),
    path.join(projectRoot, ".env"),
  ]);

  const webIndexPath = path.join(projectRoot, "atlas_ui", "build", "web", "index.html");
  const host = process.env.HOST || "127.0.0.1";
  const port = String(process.env.PORT || "2112");

  if (!fs.existsSync(webIndexPath)) {
    throw new Error(`Static UI was not found at ${webIndexPath}`);
  }

  log(`Starting browser agent on ${host}:${port}`);
  log(`Dashboard URL: http://127.0.0.1:${port}`);

  const server = spawn("node", ["server.js"], {
    stdio: "inherit",
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: host,
      PORT: port,
    },
  });

  const shutdown = () => {
    server.kill("SIGTERM");
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.on("exit", (code) => {
    process.exit(code || 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
