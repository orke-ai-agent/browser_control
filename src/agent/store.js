const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function createThreadStore({ rootDir, logger }) {
  ensureDirectory(rootDir);
  const events = new EventEmitter();

  function filePathFor(threadId) {
    return path.join(rootDir, `${threadId}.json`);
  }

  function persist(thread) {
    thread.updatedAt = new Date().toISOString();
    writeJson(filePathFor(thread.id), thread);
  }

  function createThread({ title }) {
    const now = new Date().toISOString();
    const thread = {
      id: randomId(),
      title: title.slice(0, 72),
      status: "idle",
      createdAt: now,
      updatedAt: now,
      messages: [],
      meta: {
        cycleCount: 0,
        geminiRequestCount: 0,
        responseLanguage: "en",
        totalPromptTokens: 0,
        totalCandidateTokens: 0,
        totalTokens: 0,
        selectedModel: "",
        stepLimit: 5,
        lastKnownUrl: "",
        lastKnownTitle: "",
        lastRunError: "",
        lastActionSignature: "",
        threadMemory: [],
        sessionMemory: [],
        executionJournal: [],
      },
    };

    persist(thread);
    logger.event("agent.store", "thread_created", {
      threadId: thread.id,
      title: thread.title,
    });
    events.emit("thread_created", {
      threadId: thread.id,
      thread,
    });
    return thread;
  }

  function getThread(threadId) {
    const filePath = filePathFor(threadId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return readJson(filePath, null);
  }

  function listThreads() {
    return fs
      .readdirSync(rootDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readJson(path.join(rootDir, entry), null))
      .filter(Boolean)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        status: thread.status,
        updatedAt: thread.updatedAt,
        geminiRequestCount: thread.meta?.geminiRequestCount || 0,
        totalTokens: thread.meta?.totalTokens || 0,
        lastMessagePreview: thread.messages.length
          ? thread.messages[thread.messages.length - 1].text.slice(0, 120)
          : "",
      }));
  }

  function appendMessage(threadId, message) {
    const thread = getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found.`);
    }

    const nextMessage = {
      id: randomId(),
      timestamp: new Date().toISOString(),
      ...message,
    };

    thread.messages.push(nextMessage);
    persist(thread);
    events.emit("message_appended", {
      threadId,
      message: nextMessage,
      thread,
    });
    return nextMessage;
  }

  function setStatus(threadId, status) {
    const thread = getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found.`);
    }

    thread.status = status;
    persist(thread);
    events.emit("status_changed", {
      threadId,
      status,
      thread,
    });
  }

  function updateMeta(threadId, metaPatch) {
    const thread = getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found.`);
    }

    thread.meta = {
      ...thread.meta,
      ...metaPatch,
    };
    persist(thread);
    events.emit("meta_updated", {
      threadId,
      metaPatch,
      thread,
    });
  }

  return {
    appendMessage,
    createThread,
    getThread,
    listThreads,
    onMessage(listener) {
      events.on("message_appended", listener);
      return () => events.off("message_appended", listener);
    },
    onStatusChange(listener) {
      events.on("status_changed", listener);
      return () => events.off("status_changed", listener);
    },
    onThreadCreated(listener) {
      events.on("thread_created", listener);
      return () => events.off("thread_created", listener);
    },
    setStatus,
    updateMeta,
  };
}

module.exports = {
  createThreadStore,
};
