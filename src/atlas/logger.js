const fs = require("fs");
const path = require("path");

function formatStamp(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
  return directoryPath;
}

function summariseDetails(details) {
  if (details === undefined) {
    return "";
  }

  if (typeof details === "string") {
    return details;
  }

  try {
    return JSON.stringify(details);
  } catch (error) {
    return `[unserializable:${error instanceof Error ? error.message : String(error)}]`;
  }
}

function serialiseError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "NonError",
    message: String(error),
  };
}

function createLogger(options = {}) {
  const {
    rootDir = path.join(process.cwd(), "logs"),
    sessionName = "atlas-session",
    mirrorToConsole = true,
    filePath: explicitFilePath = "",
    bindings = {},
    shouldWrite = null,
  } = options;

  const filePath = explicitFilePath
    ? path.resolve(explicitFilePath)
    : path.join(ensureDirectory(rootDir), `${sessionName}-${formatStamp()}.jsonl`);
  ensureDirectory(path.dirname(filePath));

  function colorForLevel(level) {
    if (level === "error") return "\u001b[31m";
    if (level === "warn") return "\u001b[33m";
    return "\u001b[36m";
  }

  function colorForScope(scope) {
    if (scope.startsWith("http")) return "\u001b[35m";
    if (scope.startsWith("agent.gemini")) return "\u001b[34m";
    if (scope.startsWith("agent.executor")) return "\u001b[93m";
    if (scope.startsWith("agent.service")) return "\u001b[95m";
    if (scope.startsWith("atlas.worker")) return "\u001b[92m";
    if (scope.startsWith("browser.")) return "\u001b[90m";
    return "\u001b[37m";
  }

  function write(level, scope, event, details) {
    const mergedDetails =
      details &&
      typeof details === "object" &&
      !Array.isArray(details) &&
      !(details instanceof Error)
        ? { ...bindings, ...details }
        : Object.keys(bindings).length
          ? { bindings, details }
          : details;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      event,
      details: mergedDetails,
    };

    if (typeof shouldWrite === "function" && !shouldWrite(entry)) {
      return;
    }

    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");

    if (mirrorToConsole) {
      const summary = summariseDetails(details);
      const reset = "\u001b[0m";
      const levelColor = colorForLevel(level);
      const scopeColor = colorForScope(scope);
      console.log(
        `[${entry.timestamp}] ${levelColor}[${level}]${reset} ${scopeColor}[${scope}]${reset} ${event}${summary ? ` ${summary}` : ""}`,
      );
    }
  }

  return {
    filePath,
    event(scope, event, details = {}) {
      write("info", scope, event, details);
    },
    warn(scope, event, details = {}) {
      write("warn", scope, event, details);
    },
    error(scope, event, error, details = {}) {
      write("error", scope, event, {
        ...details,
        error: serialiseError(error),
      });
    },
    child(scope) {
      return {
        filePath,
        event(event, details = {}) {
          write("info", scope, event, details);
        },
        warn(event, details = {}) {
          write("warn", scope, event, details);
        },
        error(event, error, details = {}) {
          write("error", scope, event, {
            ...details,
            error: serialiseError(error),
          });
        },
      };
    },
    fork(forkOptions = {}) {
      return createLogger({
        rootDir,
        sessionName,
        mirrorToConsole:
          forkOptions.mirrorToConsole === undefined ? mirrorToConsole : forkOptions.mirrorToConsole,
        filePath: forkOptions.filePath || "",
        bindings: {
          ...bindings,
          ...(forkOptions.bindings || {}),
        },
        shouldWrite: forkOptions.shouldWrite || shouldWrite,
      });
    },
  };
}

module.exports = {
  createLogger,
  serialiseError,
};
