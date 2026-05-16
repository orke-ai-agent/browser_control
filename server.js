const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { createLogger } = require("./src/atlas/logger");
const { createThreadStore } = require("./src/agent/store");
const { createAgentService } = require("./src/agent/service");
const { createActionController } = require("./src/agent/action-controller");
const { loadEnv } = require("./src/agent/env");
const { createShortcutMemory } = require("./src/agent/shortcut-memory");
const { createMediaStore } = require("./src/media/store");

function createNoopOrchestratorSocketClient() {
  return {
    activateEntity() {},
    deactivateEntity() {},
    isEntityActive() {
      return false;
    },
    sendEvent() {},
    shutdown() {},
  };
}

function loadOrchestratorSocketClient() {
  try {
    return require("../shared/orchestrator_socket_client").createOrchestratorSocketClient;
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      return createNoopOrchestratorSocketClient;
    }
    throw error;
  }
}

const createOrchestratorSocketClient = loadOrchestratorSocketClient();

const env = loadEnv(path.join(process.cwd(), ".env"));
const PORT = Number(process.env.PORT || env.PORT || 2112);
const HOST = process.env.HOST || env.HOST || "127.0.0.1";
const WEB_ROOT = path.join(process.cwd(), "atlas_ui", "build", "web");
const SETTINGS_PATH = path.join(process.cwd(), "runtime", "settings.json");
const TICKETS_PATH = path.join(process.cwd(), "runtime", "tickets.json");
const TICKET_FILES_ROOT = path.join(process.cwd(), "runtime", "ticket-files");
const DASHBOARD_URL = `http://${HOST}:${PORT}/`;
const TICKET_SCHEDULER_INTERVAL_MS = 10_000;
const DEFAULT_SETTINGS = {
  selectedModel: env.GEMINI_MODEL || "gemini-3-flash-preview",
  stepLimit: Number(env.AGENT_STEP_LIMIT || 5),
};

const logger = createLogger({
  rootDir: path.join(process.cwd(), "logs"),
  sessionName: "atlas-server",
  shouldWrite(entry) {
    if (entry.level !== "info") {
      return true;
    }

    const scope = String(entry.scope || "").trim();
    const event = String(entry.event || "").trim();
    return (
      (scope === "agent.store" && event === "thread_created") ||
      (scope === "agent.action_api" && event === "submit_received") ||
      (scope === "media.store" && event === "media_saved")
    );
  },
});
const store = createThreadStore({
  rootDir: path.join(process.cwd(), "runtime", "threads"),
  logger,
});
const shortcutMemory = createShortcutMemory({
  filePath: path.join(process.cwd(), "runtime", "shortcuts.json"),
  logger,
});
const mediaStore = createMediaStore({
  rootDir: path.join(process.cwd(), "runtime", "media"),
  logger,
});
const agent = createAgentService({
  env,
  logger,
  store,
  loadSettings,
  shortcutMemory,
  dashboardUrl: DASHBOARD_URL,
});
const actionController = createActionController({
  logger,
  store,
  agent,
  loadSettings,
  mediaStore,
});
const orchestratorSocket = createOrchestratorSocketClient({
  logger,
  agentType: "browser_agent",
  instanceId: `${HOST}:${PORT}`,
  host:
    process.env.ORCHESTRATOR_SOCKET_HOST ||
    env.ORCHESTRATOR_SOCKET_HOST ||
    "",
  port:
    process.env.ORCHESTRATOR_SOCKET_PORT ||
    env.ORCHESTRATOR_SOCKET_PORT ||
    "",
});

function summarizeThreadForOrchestrator(thread) {
  return {
    id: thread?.id || "",
    title: thread?.title || "",
    status: thread?.status || "",
    updatedAt: thread?.updatedAt || "",
    cycleCount: Number(thread?.meta?.cycleCount || 0),
    selectedModel: thread?.meta?.selectedModel || "",
    stepLimit: Number(thread?.meta?.stepLimit || 0),
    lastKnownUrl: thread?.meta?.lastKnownUrl || "",
    lastKnownTitle: thread?.meta?.lastKnownTitle || "",
  };
}

store.onStatusChange(({ threadId, status, thread }) => {
  if (status === "running" || status === "stopping") {
    orchestratorSocket.activateEntity("thread", threadId, {
      status,
      thread: summarizeThreadForOrchestrator(thread),
    });
  }

  orchestratorSocket.sendEvent(
    "thread_status",
    {
      threadId,
      status,
      thread: summarizeThreadForOrchestrator(thread),
    },
    {
      force: status === "idle",
    },
  );

  if (status === "idle") {
    orchestratorSocket.deactivateEntity("thread", threadId, {
      status,
      thread: summarizeThreadForOrchestrator(thread),
    });
  }
});

store.onMessage(({ threadId, message, thread }) => {
  if (!orchestratorSocket.isEntityActive("thread", threadId)) {
    return;
  }

  orchestratorSocket.sendEvent("thread_message", {
    threadId,
    thread: summarizeThreadForOrchestrator(thread),
    message: {
      id: message?.id || "",
      role: message?.role || "",
      kind: message?.kind || "",
      text: message?.text || "",
      timestamp: message?.timestamp || "",
      meta: message?.meta || {},
  },
});
let ticketSchedulerInterval = null;
});

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function loadSettings() {
  ensureDirectory(path.dirname(SETTINGS_PATH));
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf8");
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  ensureDirectory(path.dirname(SETTINGS_PATH));
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

function normalizeTicket(ticket) {
  if (!ticket || typeof ticket !== "object") {
    return null;
  }

  const id = String(ticket.id || "").trim();
  const title = String(ticket.title || "").trim() || "Untitled Ticket";
  const rawSteps = Array.isArray(ticket.steps) ? ticket.steps : [];
  const steps = rawSteps
    .map((step) => String(step || "").trim())
    .filter(Boolean);
  const frequency = ["once", "daily", "weekly", "hourly"].includes(ticket.frequency)
    ? ticket.frequency
    : "once";
  const time = String(ticket.time || (frequency === "hourly" ? "00" : "09:00")).trim();

  if (!id) {
    return null;
  }

  return {
    id,
    title,
    steps: steps.length ? steps : ["No task description yet."],
    frequency,
    time,
    createdAt: String(ticket.createdAt || new Date().toISOString()),
    updatedAt: String(ticket.updatedAt || new Date().toISOString()),
    lastRunKey: String(ticket.lastRunKey || ""),
    lastRunAt: String(ticket.lastRunAt || ""),
    lastRunStatus: String(ticket.lastRunStatus || ""),
    lastThreadId: String(ticket.lastThreadId || ""),
    runHistory: normalizeTicketRunHistory(ticket),
    fileCount: listTicketFiles(id).length,
  };
}

function normalizeTicketRunHistory(ticket) {
  const source = Array.isArray(ticket?.runHistory) ? ticket.runHistory : [];
  const history = source
    .map((run) => ({
      threadId: String(run?.threadId || "").trim(),
      runKey: String(run?.runKey || "").trim(),
      runAt: String(run?.runAt || "").trim(),
      status: String(run?.status || "").trim() || "submitted",
      source: String(run?.source || "").trim() || "manual",
    }))
    .filter((run) => run.threadId);

  if (!history.length && ticket?.lastThreadId) {
    history.push({
      threadId: String(ticket.lastThreadId || "").trim(),
      runKey: String(ticket.lastRunKey || "").trim(),
      runAt: String(ticket.lastRunAt || "").trim(),
      status: String(ticket.lastRunStatus || "").trim() || "submitted",
      source: "legacy",
    });
  }

  const ticketTitlePrefix = `Execute scheduled ticket: ${String(ticket?.title || "").trim()}`;
  if (ticketTitlePrefix.trim()) {
    for (const thread of store.listThreads()) {
      const title = String(thread.title || "");
      if (!title.startsWith(ticketTitlePrefix)) {
        continue;
      }
      history.push({
        threadId: thread.id,
        runKey: "",
        runAt: thread.updatedAt || "",
        status: thread.status || "submitted",
        source: "thread_store",
      });
    }
  }

  const byThread = new Map();
  for (const run of history) {
    byThread.set(run.threadId, run);
  }

  return [...byThread.values()]
    .sort((left, right) => String(right.runAt || "").localeCompare(String(left.runAt || "")))
    .slice(0, 30);
}

function appendTicketRunHistory(ticket, run) {
  return normalizeTicketRunHistory({
    ...ticket,
    runHistory: [
      {
        threadId: run.threadId,
        runKey: run.runKey,
        runAt: run.runAt,
        status: run.status || "submitted",
        source: run.source || "manual",
      },
      ...(Array.isArray(ticket?.runHistory) ? ticket.runHistory : []),
    ],
  });
}

function loadTickets() {
  ensureDirectory(path.dirname(TICKETS_PATH));
  if (!fs.existsSync(TICKETS_PATH)) {
    fs.writeFileSync(TICKETS_PATH, JSON.stringify([], null, 2), "utf8");
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TICKETS_PATH, "utf8"));
    const source = Array.isArray(parsed) ? parsed : [];
    return source.map(normalizeTicket).filter(Boolean);
  } catch (error) {
    logger.error("tickets.store", "load_failed", error, {
      filePath: TICKETS_PATH,
    });
    return [];
  }
}

function saveTickets(tickets) {
  ensureDirectory(path.dirname(TICKETS_PATH));
  const existingById = new Map(loadTickets().map((ticket) => [ticket.id, ticket]));
  const now = new Date();
  const normalized = (Array.isArray(tickets) ? tickets : [])
    .map((ticket) => {
      const normalizedTicket = normalizeTicket(ticket);
      if (!normalizedTicket) {
        return null;
      }

      const existing = existingById.get(normalizedTicket.id);
      const scheduleChanged = existing
        ? existing.frequency !== normalizedTicket.frequency || existing.time !== normalizedTicket.time
        : true;
      const mergedTicket = {
        ...normalizedTicket,
        lastRunKey: normalizedTicket.lastRunKey || existing?.lastRunKey || "",
        lastRunAt: normalizedTicket.lastRunAt || existing?.lastRunAt || "",
        lastRunStatus: normalizedTicket.lastRunStatus || existing?.lastRunStatus || "",
        lastThreadId: normalizedTicket.lastThreadId || existing?.lastThreadId || "",
        runHistory: normalizeTicketRunHistory({
          ...normalizedTicket,
          runHistory: normalizedTicket.runHistory?.length
            ? normalizedTicket.runHistory
            : existing?.runHistory || [],
        }),
      };

      if (scheduleChanged && isTicketDue(mergedTicket, now)) {
        return {
          ...mergedTicket,
          lastRunKey: runKeyForTicket(mergedTicket, now),
          lastRunStatus: "scheduled_skipped",
        };
      }

      return mergedTicket;
    })
    .filter(Boolean);
  fs.writeFileSync(TICKETS_PATH, JSON.stringify(normalized, null, 2), "utf8");
  logger.event("tickets.store", "saved", {
    count: normalized.length,
    filePath: TICKETS_PATH,
  });
  return normalized;
}

function safeTicketId(ticketId) {
  return String(ticketId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
}

function safeFileName(fileName) {
  const baseName = path.basename(String(fileName || "file").trim() || "file");
  return baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function ticketFilesDirectory(ticketId) {
  const safeId = safeTicketId(ticketId);
  if (!safeId) {
    throw new Error("Ticket id is required.");
  }
  return path.join(TICKET_FILES_ROOT, safeId);
}

function ticketFilePath(ticketId, fileName) {
  const directory = ticketFilesDirectory(ticketId);
  const safeName = safeFileName(fileName);
  const filePath = path.join(directory, safeName);
  if (!filePath.startsWith(directory + path.sep)) {
    throw new Error("Invalid file name.");
  }
  return filePath;
}

function listTicketFiles(ticketId) {
  const directory = ticketFilesDirectory(ticketId);
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      const stats = fs.statSync(filePath);
      return {
        name: entry.name,
        size: stats.size,
        updatedAt: stats.mtime.toISOString(),
        url: `/api/tickets/${safeTicketId(ticketId)}/files/${encodeURIComponent(entry.name)}`,
        path: filePath,
        mimeType: contentTypeFor(filePath),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function ticketFilesAsMedia(ticketId) {
  return listTicketFiles(ticketId).map((file) => ({
    fileName: file.name,
    mimeType: file.mimeType,
    buffer: fs.readFileSync(file.path),
  }));
}

async function uploadTicketFiles(request, ticketId) {
  const { media } = await readMultipartActionRequest(request);
  const directory = ticketFilesDirectory(ticketId);
  ensureDirectory(directory);

  for (const item of media) {
    const filePath = ticketFilePath(ticketId, item.fileName);
    fs.writeFileSync(filePath, item.buffer);
    logger.event("tickets.files", "uploaded", {
      ticketId: safeTicketId(ticketId),
      fileName: path.basename(filePath),
      size: item.buffer.length,
    });
  }

  return listTicketFiles(ticketId);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localMinuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function parseTicketMinuteOfDay(ticket) {
  if (ticket.frequency === "hourly") {
    const minute = Math.max(0, Math.min(59, Number(ticket.time) || 0));
    return {
      hour: null,
      minute,
      minuteOfDay: minute,
    };
  }

  const parts = String(ticket.time || "09:00").split(":");
  const hour = Math.max(0, Math.min(23, Number(parts[0]) || 0));
  const minute = Math.max(0, Math.min(59, Number(parts[1]) || 0));
  return {
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
  };
}

function weekKey(date) {
  const firstDay = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date - firstDay) / 86400000);
  const week = Math.floor((days + firstDay.getDay()) / 7) + 1;
  return `${date.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function runKeyForTicket(ticket, now = new Date()) {
  const dateKey = localDateKey(now);
  const schedule = parseTicketMinuteOfDay(ticket);

  if (ticket.frequency === "hourly") {
    return `${dateKey}T${String(now.getHours()).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  }

  if (ticket.frequency === "weekly") {
    return `${weekKey(now)}-${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  }

  return `${dateKey}-${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
}

function isTicketDue(ticket, now = new Date()) {
  const schedule = parseTicketMinuteOfDay(ticket);
  const currentMinute = localMinuteOfDay(now);
  const runKey = runKeyForTicket(ticket, now);

  if (ticket.lastRunKey === runKey) {
    return false;
  }

  if (ticket.frequency === "hourly") {
    return now.getMinutes() === schedule.minute;
  }

  if (ticket.frequency === "weekly") {
    const created = new Date(ticket.createdAt);
    const weekday = Number.isNaN(created.getTime()) ? now.getDay() : created.getDay();
    return now.getDay() === weekday && currentMinute >= schedule.minuteOfDay;
  }

  if (ticket.frequency === "daily") {
    return currentMinute >= schedule.minuteOfDay;
  }

  return !ticket.lastRunAt && currentMinute >= schedule.minuteOfDay;
}

function isTicketInScheduleWindow(ticket, now = new Date()) {
  const schedule = parseTicketMinuteOfDay(ticket);
  const currentMinute = localMinuteOfDay(now);

  if (ticket.frequency === "hourly") {
    return now.getMinutes() === schedule.minute;
  }

  if (ticket.frequency === "weekly") {
    const created = new Date(ticket.createdAt);
    const weekday = Number.isNaN(created.getTime()) ? now.getDay() : created.getDay();
    return now.getDay() === weekday && currentMinute >= schedule.minuteOfDay;
  }

  if (ticket.frequency === "daily") {
    return currentMinute >= schedule.minuteOfDay;
  }

  return currentMinute >= schedule.minuteOfDay;
}

function buildTicketPrompt(ticket) {
  const steps = ticket.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  const files = listTicketFiles(ticket.id);
  const fileLines = files.length
    ? files.map((file, index) => `${index + 1}. ${file.name} (${file.mimeType}, ${file.size} bytes)`).join("\n")
    : "No files in this ticket asset box.";
  const attachmentRequirements = files.length
    ? [
        "Attachment execution requirements:",
        files.length > 1
          ? "- The task asset box contains multiple files. If the user asks to post, upload, attach, publish, or share these assets, use mediaRef all_media unless the page visibly rejects multiple attachments."
          : "- The task asset box contains one file. If the user asks to post, upload, attach, publish, or share it, use that attached media through upload_media.",
        "- Do not treat the file list as informational text only; it is the payload for upload_media when the task asks for files/media.",
        "",
      ]
    : [];
  return [
    `Execute scheduled ticket: ${ticket.title}`,
    "",
    "Ticket asset box files:",
    fileLines,
    "",
    ...attachmentRequirements,
    "Tasks:",
    steps,
  ].join("\n");
}

const runningScheduledTickets = new Set();
const pendingManualTicketRuns = new Map();
const activeTicketRuns = new Map();

function isActiveThread(thread) {
  return ["running", "stopping", "submitted"].includes(String(thread?.status || ""));
}

function activeTicketRun(ticketId) {
  const active = activeTicketRuns.get(ticketId);
  if (!active) {
    return null;
  }

  if (!active.threadId) {
    return active;
  }

  const thread = store.getThread(active.threadId);
  if (isActiveThread(thread)) {
    return {
      ...active,
      thread,
    };
  }

  activeTicketRuns.delete(ticketId);
  return null;
}

function releaseTicketRunWhenIdle(ticketId, threadId) {
  const startedAt = Date.now();
  const poll = () => {
    const active = activeTicketRuns.get(ticketId);
    if (!active || active.threadId !== threadId) {
      return;
    }

    const thread = store.getThread(threadId);
    const timedOut = Date.now() - startedAt > 2 * 60 * 60 * 1000;
    if (!isActiveThread(thread) || timedOut) {
      activeTicketRuns.delete(ticketId);
      logger.event("tickets.run_lock", "released", {
        ticketId,
        threadId,
        status: thread?.status || "",
        timedOut,
      });
      return;
    }

    setTimeout(poll, 2000);
  };

  setTimeout(poll, 2000);
}

function setActiveTicketRun(ticketId, record) {
  activeTicketRuns.set(ticketId, {
    ticketId,
    startedAt: new Date().toISOString(),
    ...record,
  });
}

async function runScheduledTicket(ticket, runKey) {
  const active = activeTicketRun(ticket.id);
  if (runningScheduledTickets.has(ticket.id) || active) {
    logger.event("tickets.scheduler", "ticket_due_skipped_active_run", {
      ticketId: ticket.id,
      runKey,
      activeThreadId: active?.threadId || "",
      activeSource: active?.source || "",
    });
    return;
  }

  const latestTickets = loadTickets();
  const latestTicket = latestTickets.find((item) => item.id === ticket.id) || ticket;
  const lastThread = latestTicket.lastThreadId ? store.getThread(latestTicket.lastThreadId) : null;
  if (isActiveThread(lastThread)) {
    logger.event("tickets.scheduler", "ticket_due_skipped_running_thread", {
      ticketId: ticket.id,
      runKey,
      threadId: lastThread.id,
      status: lastThread.status,
    });
    return;
  }

  runningScheduledTickets.add(ticket.id);
  setActiveTicketRun(ticket.id, {
    source: "scheduler",
    runKey,
    promise: null,
  });
  logger.event("tickets.scheduler", "ticket_due", {
    ticketId: ticket.id,
    title: ticket.title,
    frequency: ticket.frequency,
    time: ticket.time,
    runKey,
  });

  try {
    const result = await actionController.submit({
      prompt: buildTicketPrompt(ticket),
      media: ticketFilesAsMedia(ticket.id),
      forceNewThread: true,
      source: "ticket_scheduler",
      userMeta: {
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        runKey,
        runSource: "scheduler",
      },
    });
    const threadId = result.thread?.id || "";
    setActiveTicketRun(ticket.id, {
      source: "scheduler",
      runKey,
      threadId,
      promise: Promise.resolve({
        ticket: null,
        thread: result.thread,
      }),
    });

    const tickets = loadTickets();
    const index = tickets.findIndex((item) => item.id === ticket.id);
    if (index >= 0) {
      const runAt = new Date().toISOString();
      tickets[index] = {
        ...tickets[index],
        lastRunKey: runKey,
        lastRunAt: runAt,
        lastRunStatus: "submitted",
        lastThreadId: threadId,
        runHistory: appendTicketRunHistory(tickets[index], {
          threadId,
          runKey,
          runAt,
          status: result.thread?.status || "submitted",
          source: "scheduler",
        }),
      };
      saveTickets(tickets);
    }

    logger.event("tickets.scheduler", "ticket_submitted", {
      ticketId: ticket.id,
      threadId,
      runKey,
    });
    if (threadId) {
      releaseTicketRunWhenIdle(ticket.id, threadId);
    } else {
      activeTicketRuns.delete(ticket.id);
    }
  } catch (error) {
    activeTicketRuns.delete(ticket.id);
    logger.error("tickets.scheduler", "ticket_submit_failed", error, {
      ticketId: ticket.id,
      runKey,
    });
  } finally {
    runningScheduledTickets.delete(ticket.id);
  }
}

async function runTicketNow(ticketId) {
  const active = activeTicketRun(ticketId);
  if (active) {
    logger.event("tickets.manual", "ticket_run_reused_active_lock", {
      ticketId,
      threadId: active.threadId || "",
      source: active.source || "",
    });
    if (active.promise) {
      return active.promise;
    }
    const thread = active.threadId ? store.getThread(active.threadId) : null;
    if (thread) {
      const tickets = loadTickets();
      const ticket = tickets.find((item) => item.id === ticketId) || null;
      return {
        ticket: ticket
          ? {
              ...ticket,
              lastRunStatus: thread.status,
            }
          : null,
        thread,
        reused: true,
      };
    }
  }

  if (pendingManualTicketRuns.has(ticketId)) {
    return pendingManualTicketRuns.get(ticketId);
  }

  const runPromise = runTicketNowOnce(ticketId).finally(() => {
    pendingManualTicketRuns.delete(ticketId);
  });
  pendingManualTicketRuns.set(ticketId, runPromise);
  return runPromise;
}

async function runTicketNowOnce(ticketId) {
  const tickets = loadTickets();
  const index = tickets.findIndex((item) => item.id === ticketId);

  if (index === -1) {
    return null;
  }

  const ticket = tickets[index];
  const lastThread = ticket.lastThreadId ? store.getThread(ticket.lastThreadId) : null;
  if (lastThread && ["running", "stopping"].includes(String(lastThread.status || ""))) {
    logger.event("tickets.manual", "ticket_run_reused_active_thread", {
      ticketId: ticket.id,
      threadId: lastThread.id,
      status: lastThread.status,
    });
    return {
      ticket: {
        ...ticket,
        lastRunStatus: lastThread.status,
      },
      thread: lastThread,
      reused: true,
    };
  }

  const now = new Date();
  const scheduledRunKey = runKeyForTicket(ticket, now);
  const runKey = isTicketInScheduleWindow(ticket, now) ? scheduledRunKey : `manual-${now.toISOString()}`;
  logger.event("tickets.manual", "ticket_run_requested", {
    ticketId: ticket.id,
    title: ticket.title,
    runKey,
  });

  setActiveTicketRun(ticket.id, {
    source: "manual",
    runKey,
    promise: null,
  });

  let result;
  try {
    result = await actionController.submit({
      prompt: buildTicketPrompt(ticket),
      media: ticketFilesAsMedia(ticket.id),
      forceNewThread: true,
      source: "ticket_manual",
      userMeta: {
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        runKey,
        runSource: "manual",
      },
    });
  } catch (error) {
    activeTicketRuns.delete(ticket.id);
    throw error;
  }
  const threadId = result.thread?.id || "";
  setActiveTicketRun(ticket.id, {
    source: "manual",
    runKey,
    threadId,
    promise: null,
  });

  const responsePromise = Promise.resolve().then(() => {
    const latestTickets = loadTickets();
    const latestTicket = latestTickets.find((item) => item.id === ticket.id) || null;
    return {
      ticket: latestTicket,
      thread: result.thread,
    };
  });
  setActiveTicketRun(ticket.id, {
    source: "manual",
    runKey,
    threadId,
    promise: responsePromise,
  });

  const runAt = new Date().toISOString();

  tickets[index] = {
    ...tickets[index],
    lastRunKey: runKey,
    lastRunAt: runAt,
    lastRunStatus: "submitted",
    lastThreadId: threadId,
    runHistory: appendTicketRunHistory(tickets[index], {
      threadId,
      runKey,
      runAt,
      status: result.thread?.status || "submitted",
      source: "manual",
    }),
  };
  const savedTickets = saveTickets(tickets);

  logger.event("tickets.manual", "ticket_submitted", {
    ticketId: ticket.id,
    threadId,
    runKey,
  });

  if (threadId) {
    releaseTicketRunWhenIdle(ticket.id, threadId);
  } else {
    activeTicketRuns.delete(ticket.id);
  }

  return {
    ticket: savedTickets[index],
    thread: result.thread,
  };
}

function checkScheduledTickets() {
  const now = new Date();
  const tickets = loadTickets();

  for (const ticket of tickets) {
    if (!isTicketDue(ticket, now)) {
      continue;
    }

    const runKey = runKeyForTicket(ticket, now);
    runScheduledTicket(ticket, runKey);
  }
}

function startTicketScheduler() {
  logger.event("tickets.scheduler", "started", {
    intervalMs: TICKET_SCHEDULER_INTERVAL_MS,
  });
  setTimeout(checkScheduledTickets, 1000);
  return setInterval(checkScheduledTickets, TICKET_SCHEDULER_INTERVAL_MS);
}

function serializeSettingsForClient(settings) {
  return {
    selectedModel: settings.selectedModel,
    stepLimit: settings.stepLimit,
  };
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function readRawRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

async function readJsonBody(request) {
  const raw = await readRawRequestBody(request);
  if (!raw.length) {
    return {};
  }
  return JSON.parse(raw.toString("utf8"));
}

function appendFieldValue(target, key, value) {
  if (!(key in target)) {
    target[key] = value;
    return;
  }

  if (Array.isArray(target[key])) {
    target[key].push(value);
    return;
  }

  target[key] = [target[key], value];
}

function firstFieldValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseBooleanValue(value) {
  const normalized = String(firstFieldValue(value) || "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

async function readMultipartActionRequest(request) {
  const raw = await readRawRequestBody(request);
  const contentType = String(request.headers["content-type"] || "");
  const formData = await new Response(raw, {
    headers: {
      "Content-Type": contentType,
    },
  }).formData();
  const body = {};
  const media = [];

  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      appendFieldValue(body, key, value);
      continue;
    }

    if (!value || typeof value.arrayBuffer !== "function") {
      continue;
    }

    media.push({
      fileName: value.name || key || "media",
      mimeType: value.type || "application/octet-stream",
      buffer: Buffer.from(await value.arrayBuffer()),
    });
  }

  return {
    body,
    media,
  };
}

async function readActionRequest(request) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    return readMultipartActionRequest(request);
  }

  const body = await readJsonBody(request);
  return {
    body,
    media: await normalizeMediaItems(body),
  };
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".gif")) return "image/gif";
  if (filePath.endsWith(".mp4")) return "video/mp4";
  if (filePath.endsWith(".mov")) return "video/quicktime";
  if (filePath.endsWith(".webm")) return "video/webm";
  if (filePath.endsWith(".pdf")) return "application/pdf";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  if (filePath.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function serveFile(response, filePath) {
  const buffer = fs.readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": buffer.length,
  });
  response.end(buffer);
}

async function readMediaItem(item) {
  if (item == null || typeof item !== "object") {
    throw new Error("Each media item must be an object.");
  }

  const fileName = String(item.fileName || item.name || "").trim() || "media";
  const mimeType = String(item.mimeType || item.type || "").trim() || "application/octet-stream";

  if (item.base64) {
    return {
      fileName,
      mimeType,
      buffer: Buffer.from(String(item.base64), "base64"),
    };
  }

  if (item.path) {
    const absolutePath = path.resolve(String(item.path));
    return {
      fileName: fileName || path.basename(absolutePath),
      mimeType,
      buffer: fs.readFileSync(absolutePath),
    };
  }

  if (item.url) {
    const result = await fetch(String(item.url));
    if (!result.ok) {
      throw new Error(`Failed to fetch media url: ${item.url}`);
    }
    return {
      fileName,
      mimeType: mimeType || result.headers.get("content-type") || "application/octet-stream",
      buffer: Buffer.from(await result.arrayBuffer()),
    };
  }

  throw new Error("Media item must contain base64, path, or url.");
}

async function normalizeMediaItems(body) {
  const items = Array.isArray(body.media) ? body.media : [];
  const normalized = [];

  for (const item of items) {
    normalized.push(await readMediaItem(item));
  }

  return normalized;
}

function safeJoinStatic(urlPath) {
  const normalized = urlPath === "/" ? "/index.html" : urlPath;
  const cleanPath = path.normalize(normalized).replace(/^(\.\.[/\\])+/, "");
  return path.join(WEB_ROOT, cleanPath);
}

function shouldLogHttpTransaction(method, pathname) {
  const normalizedMethod = String(method || "").toUpperCase();
  const normalizedPath = String(pathname || "");

  if (normalizedMethod !== "GET") {
    return true;
  }

  if (
    normalizedPath === "/api/health" ||
    normalizedPath === "/api/settings" ||
    normalizedPath === "/api/recipes" ||
    normalizedPath === "/api/threads" ||
    /^\/api\/threads\/[^/]+$/.test(normalizedPath)
  ) {
    return false;
  }

  return true;
}

async function handleApi(request, response, parsedUrl) {
  if (request.method === "GET" && parsedUrl.pathname === "/api/health") {
    const settings = loadSettings();
    sendJson(response, 200, {
      ok: true,
      port: PORT,
      model: settings.selectedModel,
      stepLimit: settings.stepLimit,
    });
    return true;
  }

  if (request.method === "GET" && parsedUrl.pathname === "/api/settings") {
    sendJson(response, 200, {
      settings: serializeSettingsForClient(loadSettings()),
    });
    return true;
  }

  if (request.method === "GET" && parsedUrl.pathname === "/api/recipes") {
    sendJson(response, 200, {
      recipes: shortcutMemory.listForClient(),
    });
    return true;
  }

  if (request.method === "GET" && parsedUrl.pathname === "/api/tickets") {
    sendJson(response, 200, {
      tickets: loadTickets(),
    });
    return true;
  }

  if (request.method === "POST" && parsedUrl.pathname === "/api/tickets") {
    const body = await readJsonBody(request);
    const tickets = saveTickets(body.tickets);
    sendJson(response, 200, {
      tickets,
    });
    return true;
  }

  if (request.method === "POST" && parsedUrl.pathname.startsWith("/api/tickets/") && parsedUrl.pathname.endsWith("/run")) {
    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    const ticketId = parts[2];
    const result = await runTicketNow(ticketId);

    if (!result) {
      sendJson(response, 404, { error: "Ticket not found." });
      return true;
    }

    sendJson(response, 202, result);
    return true;
  }

  if (parsedUrl.pathname.startsWith("/api/tickets/") && parsedUrl.pathname.includes("/files")) {
    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    const ticketId = parts[2];
    const fileName = parts.slice(4).join("/");

    if (request.method === "GET" && parts.length === 4) {
      sendJson(response, 200, {
        files: listTicketFiles(ticketId).map((file) => ({
          name: file.name,
          size: file.size,
          updatedAt: file.updatedAt,
          url: file.url,
          mimeType: file.mimeType,
        })),
      });
      return true;
    }

    if (request.method === "POST" && parts.length === 4) {
      const files = await uploadTicketFiles(request, ticketId);
      sendJson(response, 201, {
        files: files.map((file) => ({
          name: file.name,
          size: file.size,
          updatedAt: file.updatedAt,
          url: file.url,
          mimeType: file.mimeType,
        })),
      });
      return true;
    }

    if (request.method === "GET" && parts.length >= 5) {
      const filePath = ticketFilePath(ticketId, decodeURIComponent(fileName));
      if (!fs.existsSync(filePath)) {
        sendJson(response, 404, { error: "File not found." });
        return true;
      }

      const buffer = fs.readFileSync(filePath);
      response.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Content-Length": buffer.length,
        "Cache-Control": "no-store",
      });
      response.end(buffer);
      return true;
    }
  }

  if (request.method === "GET" && parsedUrl.pathname.startsWith("/api/media/")) {
    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    const mediaId = parts[2];
    const record = mediaStore.getMedia(mediaId);

    if (!record || !record.filePath || !fs.existsSync(record.filePath)) {
      sendJson(response, 404, { error: "Media not found." });
      return true;
    }

    const buffer = fs.readFileSync(record.filePath);
    response.writeHead(200, {
      "Content-Type": record.mimeType || contentTypeFor(record.filePath),
      "Content-Length": buffer.length,
      "Cache-Control": "no-store",
    });
    response.end(buffer);
    return true;
  }

  if (request.method === "POST" && parsedUrl.pathname === "/api/settings") {
    const body = await readJsonBody(request);
    const nextSettings = {
      ...loadSettings(),
      selectedModel: String(body.selectedModel || DEFAULT_SETTINGS.selectedModel).trim() || DEFAULT_SETTINGS.selectedModel,
      stepLimit: Math.max(1, Math.min(12, Number(body.stepLimit || DEFAULT_SETTINGS.stepLimit))),
    };
    saveSettings(nextSettings);
    sendJson(response, 200, {
      settings: serializeSettingsForClient(nextSettings),
    });
    return true;
  }

  if (request.method === "GET" && parsedUrl.pathname === "/api/threads") {
    sendJson(response, 200, {
      threads: store.listThreads(),
    });
    return true;
  }

  if (request.method === "POST" && parsedUrl.pathname === "/api/threads") {
    const { body, media } = await readActionRequest(request);
    const prompt = String(firstFieldValue(body.prompt) || firstFieldValue(body.text) || "").trim();

    if (!prompt && !media.length) {
      sendJson(response, 400, { error: "Prompt or media is required." });
      return true;
    }

    const result = await actionController.submit({
      prompt,
      media,
      forceNewThread: true,
      source: "api_threads_create",
    });
    sendJson(response, 201, {
      thread: result.thread,
      media: result.media,
    });
    return true;
  }

  if (request.method === "POST" && parsedUrl.pathname === "/api/actions") {
    const { body, media } = await readActionRequest(request);
    const prompt = String(firstFieldValue(body.prompt) || firstFieldValue(body.text) || "").trim();
    const result = await actionController.submit({
      threadId: String(firstFieldValue(body.threadId) || "").trim(),
      prompt,
      media,
      forceNewThread: parseBooleanValue(body.newThread),
      source: "api_actions",
    });
    sendJson(response, 202, {
      thread: result.thread,
      media: result.media,
    });
    return true;
  }

  if (request.method === "GET" && parsedUrl.pathname.startsWith("/api/threads/")) {
    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    const threadId = parts[2];
    const thread = store.getThread(threadId);

    if (!thread) {
      sendJson(response, 404, { error: "Thread not found." });
      return true;
    }

    sendJson(response, 200, { thread });
    return true;
  }

  if (
    request.method === "POST" &&
    parsedUrl.pathname.startsWith("/api/threads/") &&
    parsedUrl.pathname.endsWith("/stop")
  ) {
    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    const threadId = parts[2];
    const thread = store.getThread(threadId);

    if (!thread) {
      sendJson(response, 404, { error: "Thread not found." });
      return true;
    }

    const stopped = agent.stopThread(threadId);
    sendJson(response, 200, {
      ok: stopped,
      thread: store.getThread(threadId),
    });
    return true;
  }

  if (
    request.method === "POST" &&
    parsedUrl.pathname.startsWith("/api/threads/") &&
    parsedUrl.pathname.endsWith("/messages")
  ) {
    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    const threadId = parts[2];
    const { body, media } = await readActionRequest(request);
    const prompt = String(firstFieldValue(body.text) || firstFieldValue(body.prompt) || "").trim();

    if (!prompt && !media.length) {
      sendJson(response, 400, { error: "Message text or media is required." });
      return true;
    }

    const thread = store.getThread(threadId);
    if (!thread) {
      sendJson(response, 404, { error: "Thread not found." });
      return true;
    }

    const result = await actionController.submit({
      threadId,
      prompt,
      media,
      forceNewThread: false,
      source: "api_thread_message",
    });
    sendJson(response, 202, {
      thread: result.thread,
      media: result.media,
    });
    return true;
  }

  return false;
}

const server = http.createServer(async (request, response) => {
  const parsedUrl = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const isApiRequest = parsedUrl.pathname.startsWith("/api/");
  const shouldLogApiRequest = isApiRequest && shouldLogHttpTransaction(request.method, parsedUrl.pathname);
  if (shouldLogApiRequest) {
    logger.event("http", "request", {
      method: request.method,
      url: parsedUrl.pathname,
      contentType: String(request.headers["content-type"] || ""),
      contentLength: Number(request.headers["content-length"] || 0) || 0,
    });
  }

  try {
    const apiHandled = await handleApi(request, response, parsedUrl);

    if (apiHandled) {
      if (shouldLogApiRequest) {
        logger.event("http", "response", {
          method: request.method,
          url: parsedUrl.pathname,
          statusCode: response.statusCode,
        });
      }
      return;
    }

    if (!fs.existsSync(WEB_ROOT)) {
      sendJson(response, 503, {
        error: "Static web UI was not found. Make sure atlas_ui/build/web exists.",
      });
      return;
    }

    let targetPath = safeJoinStatic(parsedUrl.pathname);

    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
      targetPath = path.join(WEB_ROOT, "index.html");
    }

    serveFile(response, targetPath);
  } catch (error) {
    logger.error("http", "request_failed", error, {
      method: request.method,
      url: parsedUrl.pathname,
    });
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  logger.event("http", "server_started", {
    port: PORT,
    host: HOST,
    webRoot: WEB_ROOT,
  });

  agent.warmup().catch((error) => {
    logger.error("agent.service", "startup_warmup_failed", error, {
      port: PORT,
      host: HOST,
    });
  });

  ticketSchedulerInterval = startTicketScheduler();
});

function shutdown() {
  if (ticketSchedulerInterval) {
    clearInterval(ticketSchedulerInterval);
    ticketSchedulerInterval = null;
  }
  orchestratorSocket.shutdown();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
