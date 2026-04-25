const fs = require("fs");
const path = require("path");

const TELEGRAM_API_ROOT = "https://api.telegram.org";
const NEW_THREAD_BUTTON = "🆕 New Thread";
const MAX_MESSAGE_LENGTH = 3900;

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTelegramLongPoll(method, payload) {
  return method === "getUpdates" && Number(payload?.timeout || 0) > 0;
}

function shouldLogTelegramRequest(method, payload) {
  return !isTelegramLongPoll(method, payload);
}

function shouldLogTelegramResponse(method, payload, responseMeta) {
  if (!isTelegramLongPoll(method, payload)) {
    return true;
  }

  if (!responseMeta.ok || Number(responseMeta.status || 0) >= 400) {
    return true;
  }

  return Number(responseMeta.resultCount || 0) > 0;
}

function isPollingConflictError(error) {
  const message = compact(error?.message).toLowerCase();
  return message.includes("terminated by other getupdates request");
}

function compact(value) {
  return String(value || "").trim();
}

function truncate(text, limit = MAX_MESSAGE_LENGTH) {
  const normalized = compact(text);
  if (!normalized) {
    return "";
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function threadLabel(threadId) {
  const normalized = compact(threadId);
  return normalized ? `#${normalized.slice(0, 8)}` : "#unknown";
}

function replyKeyboard() {
  return {
    keyboard: [[{ text: NEW_THREAD_BUTTON }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Send a browser task for the agent",
  };
}

function actionTypeEmoji(type) {
  const normalized = compact(type).toLowerCase();

  if (["open_url", "open_search"].includes(normalized)) return "🌐";
  if (normalized === "search_site") return "🔎";
  if (["insert", "type_element", "press_key"].includes(normalized)) return "⌨️";
  if (["click_element", "click_by_text"].includes(normalized)) return "🖱️";
  if (normalized === "scroll") return "↕️";
  if (normalized === "read_page") return "📄";
  if (normalized === "upload_media") return "📎";
  return "•";
}

function actionStatusEmoji(status) {
  const normalized = compact(status).toLowerCase();
  if (normalized === "failed") return "❌";
  if (normalized === "skipped") return "⏭️";
  return "✅";
}

function blockStatusEmoji(status) {
  const normalized = compact(status).toLowerCase();
  if (normalized === "failed") return "❌";
  if (normalized === "running") return "⏳";
  return "🧠";
}

function collectBlockLines(message) {
  const meta = message.meta || {};
  const lines = [];
  const statusEmoji = blockStatusEmoji(meta.status);
  const title = compact(message.text) || "Block update";

  lines.push(`${statusEmoji} Block ${meta.cycle || "?"}`);
  lines.push(title);

  if (compact(meta.blockGoal)) {
    lines.push("");
    lines.push(`🎯 Goal: ${compact(meta.blockGoal)}`);
  }

  const actions = Array.isArray(meta.actions) ? meta.actions : [];
  if (actions.length) {
    lines.push("");
    lines.push("🪜 Steps");
    for (const action of actions) {
      const actionTitle =
        compact(action.label) ||
        compact(action.type) ||
        "Action";
      lines.push(
        `${actionStatusEmoji(action.status)} ${actionTypeEmoji(action.type)} ${actionTitle}`,
      );
      if (compact(action.error)) {
        lines.push(`   ↳ ${compact(action.error)}`);
      }
      if (compact(action.shortcutKey)) {
        lines.push(`   ↳ shortcut: ${compact(action.shortcutKey)}`);
      }
      const usedMedia = Array.isArray(action.usedMedia) ? action.usedMedia : [];
      if (usedMedia.length) {
        lines.push(
          `   ↳ media: ${usedMedia.map((item) => compact(item.fileName || item.id)).filter(Boolean).join(", ")}`,
        );
      }
    }
  }

  if (compact(meta.analysisComment)) {
    lines.push("");
    lines.push(`🧾 Analysis: ${compact(meta.analysisComment)}`);
  }

  if (compact(meta.nextFocus)) {
    lines.push(`➡️ Next: ${compact(meta.nextFocus)}`);
  }

  if (compact(meta.errorReason)) {
    lines.push(`⚠️ Issue: ${compact(meta.errorReason)}`);
  }

  const usedShortcuts = Array.isArray(meta.usedShortcuts) ? meta.usedShortcuts : [];
  if (usedShortcuts.length) {
    const shortcutLabels = usedShortcuts
      .map((shortcut) => compact(shortcut.key))
      .filter(Boolean);
    if (shortcutLabels.length) {
      lines.push(`🧩 Shortcuts: ${shortcutLabels.join(", ")}`);
    }
  }

  const usage = meta.usage?.total || {};
  if (Number(usage.totalTokens || 0) > 0) {
    lines.push(
      `📊 Tokens: ${Number(usage.totalTokens || 0)} total / ${Number(usage.promptTokens || 0)} in / ${Number(usage.candidateTokens || 0)} out`,
    );
  }

  return lines;
}

function formatAssistantMessage(thread, message) {
  const threadRef = threadLabel(thread?.id);
  const kind = compact(message.kind).toLowerCase();
  const body = compact(message.text);

  if (kind === "block") {
    return truncate([`${threadRef}`, ...collectBlockLines(message)].join("\n"));
  }

  if (kind === "error") {
    return truncate(`${threadRef}\n❌ ${body || "Execution failed."}`);
  }

  if (kind === "report") {
    return truncate(`${threadRef}\nℹ️ ${body || "Status update."}`);
  }

  return truncate(`${threadRef}\n💬 ${body || "Update received."}`);
}

function summarizeThread(thread) {
  const status = compact(thread?.status) || "idle";
  const meta = thread?.meta || {};
  return truncate(
    [
      `🆕 Thread ${threadLabel(thread?.id)}`,
      compact(thread?.title) || "Untitled",
      `status: ${status}`,
      `model: ${compact(meta.selectedModel) || "default"}`,
      `step limit: ${Number(meta.stepLimit || 0) || 0}`,
    ].join("\n"),
  );
}

function normalizeAllowedChatIds(rawValue) {
  return new Set(
    compact(rawValue)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function createTelegramBot({
  token,
  logger,
  store,
  actionController,
  mediaStore,
  env = {},
  statePath = path.join(process.cwd(), "runtime", "telegram-state.json"),
}) {
  if (!compact(token)) {
    throw new Error("Telegram bot token is required.");
  }

  const botLogger = logger.child("telegram.bot");
  const apiLogger = logger.child("telegram.api");
  const state = readJson(statePath, {
    pollingOffset: 0,
    chats: {},
  });
  const allowedChatIds = normalizeAllowedChatIds(
    env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_ALLOWED_CHAT_IDS || "",
  );
  const threadOwners = new Map();
  const deliveredMediaKeys = new Set();
  let running = false;
  let pollConflictLogged = false;

  for (const [chatId, chatState] of Object.entries(state.chats || {})) {
    for (const threadId of chatState.ownedThreadIds || []) {
      if (!threadOwners.has(threadId)) {
        threadOwners.set(threadId, new Set());
      }
      threadOwners.get(threadId).add(chatId);
    }
  }

  function persistState() {
    writeJson(statePath, state);
  }

  function getChatState(chatId) {
    const key = String(chatId);
    if (!state.chats[key]) {
      state.chats[key] = {
        currentThreadId: "",
        ownedThreadIds: [],
      };
      persistState();
    }
    return state.chats[key];
  }

  function ownThread(chatId, threadId) {
    const chatState = getChatState(chatId);
    if (!chatState.ownedThreadIds.includes(threadId)) {
      chatState.ownedThreadIds.push(threadId);
    }
    chatState.currentThreadId = threadId;
    if (!threadOwners.has(threadId)) {
      threadOwners.set(threadId, new Set());
    }
    threadOwners.get(threadId).add(String(chatId));
    persistState();
  }

  function setCurrentThread(chatId, threadId) {
    const chatState = getChatState(chatId);
    chatState.currentThreadId = compact(threadId);
    persistState();
  }

  function shouldAllowChat(chatId) {
    if (!allowedChatIds.size) {
      return true;
    }
    return allowedChatIds.has(String(chatId));
  }

  async function callTelegram(method, payload) {
    const url = `${TELEGRAM_API_ROOT}/bot${token}/${method}`;
    if (shouldLogTelegramRequest(method, payload)) {
      apiLogger.event("request", {
        method,
        payload,
      });
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    const responseMeta = {
      method,
      status: response.status,
      ok: data.ok === true,
      resultType: Array.isArray(data.result) ? "array" : typeof data.result,
      resultCount: Array.isArray(data.result) ? data.result.length : undefined,
      description: data.description || "",
    };

    if (shouldLogTelegramResponse(method, payload, responseMeta)) {
      apiLogger.event("response", responseMeta);
    }

    if (!response.ok || !data.ok) {
      const error = new Error(data.description || `Telegram API ${method} failed.`);
      error.status = response.status;
      error.payload = payload;
      error.response = data;
      throw error;
    }

    return data.result;
  }

  async function callTelegramMultipart(method, formData, summary = {}) {
    const url = `${TELEGRAM_API_ROOT}/bot${token}/${method}`;
    apiLogger.event("request", {
      method,
      payload: {
        ...summary,
        multipart: true,
      },
    });

    const response = await fetch(url, {
      method: "POST",
      body: formData,
    });
    const data = await response.json();
    apiLogger.event("response", {
      method,
      status: response.status,
      ok: data.ok === true,
      resultType: Array.isArray(data.result) ? "array" : typeof data.result,
      resultCount: Array.isArray(data.result) ? data.result.length : undefined,
      description: data.description || "",
    });

    if (!response.ok || !data.ok) {
      const error = new Error(data.description || `Telegram API ${method} failed.`);
      error.status = response.status;
      error.response = data;
      throw error;
    }

    return data.result;
  }

  async function sendChatMessage(chatId, text, extra = {}) {
    return callTelegram("sendMessage", {
      chat_id: chatId,
      text: truncate(text),
      disable_web_page_preview: true,
      reply_markup: replyKeyboard(),
      ...extra,
    });
  }

  function collectMessageMedia(thread, message) {
    const actions = Array.isArray(message?.meta?.actions) ? message.meta.actions : [];
    const referencedIds = new Set();
    const threadMedia = Array.isArray(thread?.meta?.mediaAttachments)
      ? thread.meta.mediaAttachments
      : [];
    const results = [];

    for (const action of actions) {
      const usedMedia = Array.isArray(action?.usedMedia) ? action.usedMedia : [];
      for (const item of usedMedia) {
        const mediaId = compact(item?.id);
        if (!mediaId || referencedIds.has(mediaId)) {
          continue;
        }
        referencedIds.add(mediaId);
        const match =
          threadMedia.find((entry) => entry?.id === mediaId) ||
          mediaStore?.getMedia(mediaId);
        if (match?.filePath && fs.existsSync(match.filePath)) {
          results.push(match);
        }
      }
    }

    return results;
  }

  async function sendMediaPreview(chatId, threadId, mediaRecord) {
    const mediaKey = `${chatId}:${threadId}:${mediaRecord.id}`;
    if (deliveredMediaKeys.has(mediaKey)) {
      return;
    }

    const buffer = fs.readFileSync(mediaRecord.filePath);
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append(
      "caption",
      truncate(`📎 Media used in ${threadLabel(threadId)}\n${mediaRecord.fileName}`, 900),
    );

    const blob = new Blob([buffer], {
      type: mediaRecord.mimeType || "application/octet-stream",
    });
    const isImage = compact(mediaRecord.kind) === "image";
    const isVideo = compact(mediaRecord.kind) === "video";
    const method = isImage ? "sendPhoto" : isVideo ? "sendVideo" : "sendDocument";
    const fieldName = isImage ? "photo" : isVideo ? "video" : "document";
    formData.append(fieldName, blob, mediaRecord.fileName || "media");

    await callTelegramMultipart(
      method,
      formData,
      {
        chatId,
        threadId,
        mediaId: mediaRecord.id,
        fileName: mediaRecord.fileName,
      },
    );
    deliveredMediaKeys.add(mediaKey);
  }

  async function setCommands() {
    await callTelegram("setMyCommands", {
      commands: [
        { command: "start", description: "Open the browser agent console" },
        { command: "new", description: "Start a new thread with the next message" },
      ],
    });
  }

  async function downloadTelegramFile(fileId) {
    const fileResult = await callTelegram("getFile", {
      file_id: fileId,
    });
    const fileUrl = `${TELEGRAM_API_ROOT}/file/bot${token}/${fileResult.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file ${fileId}.`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async function extractTelegramMedia(message) {
    const items = [];

    if (Array.isArray(message.photo) && message.photo.length) {
      const photo = message.photo[message.photo.length - 1];
      items.push({
        fileName: `telegram-photo-${photo.file_unique_id || photo.file_id}.jpg`,
        mimeType: "image/jpeg",
        buffer: await downloadTelegramFile(photo.file_id),
      });
    }

    if (message.video?.file_id) {
      items.push({
        fileName:
          compact(message.video.file_name) ||
          `telegram-video-${message.video.file_unique_id || message.video.file_id}.mp4`,
        mimeType: compact(message.video.mime_type) || "video/mp4",
        buffer: await downloadTelegramFile(message.video.file_id),
      });
    }

    if (message.document?.file_id) {
      items.push({
        fileName:
          compact(message.document.file_name) ||
          `telegram-file-${message.document.file_unique_id || message.document.file_id}`,
        mimeType: compact(message.document.mime_type) || "application/octet-stream",
        buffer: await downloadTelegramFile(message.document.file_id),
      });
    }

    return items;
  }

  async function createThreadFromChat(chatId, prompt, media = []) {
    const result = await actionController.submit({
      prompt,
      media,
      forceNewThread: true,
      source: "telegram",
    });
    const thread = result.thread;
    ownThread(chatId, thread.id);
    botLogger.event("thread_started", {
      chatId,
      threadId: thread.id,
      title: thread.title,
      mediaCount: result.media.length,
    });
    await sendChatMessage(chatId, summarizeThread(thread));
    if (result.media.length && !prompt) {
      await sendChatMessage(
        chatId,
        `📎 Attached ${result.media.length} media item(s) to ${threadLabel(thread.id)}. Send the instruction when ready.`,
      );
    }
  }

  async function sendPromptToCurrentThread(chatId, prompt, media = []) {
    const chatState = getChatState(chatId);
    const threadId = compact(chatState.currentThreadId);

    if (!threadId) {
      await createThreadFromChat(chatId, prompt, media);
      return;
    }

    const thread = store.getThread(threadId);
    if (!thread) {
      botLogger.warn("current_thread_missing", {
        chatId,
        threadId,
      });
      setCurrentThread(chatId, "");
      await createThreadFromChat(chatId, prompt, media);
      return;
    }

    const result = await actionController.submit({
      threadId,
      prompt,
      media,
      forceNewThread: false,
      source: "telegram",
    });
    botLogger.event("thread_message_submitted", {
      chatId,
      threadId,
      text: prompt,
      mediaCount: result.media.length,
    });
    await sendChatMessage(
      chatId,
      truncate(
        [
          `💬 Sent to ${threadLabel(threadId)}`,
          prompt || "Media attached",
          result.media.length
            ? `📎 media: ${result.media.map((item) => item.fileName).join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  }

  async function handleStart(chatId) {
    const chatState = getChatState(chatId);
    const currentThreadId = compact(chatState.currentThreadId);
    const intro = [
      "🤖 Browser agent console is connected.",
      "Send a browser goal and I will run it in the shared browser window.",
      currentThreadId
        ? `Current thread: ${threadLabel(currentThreadId)}`
        : "No active thread yet. Your next message will start one.",
      `Use ${NEW_THREAD_BUTTON} or /new to start a separate thread.`,
    ].join("\n");
    await sendChatMessage(chatId, intro);
  }

  async function handleNewThread(chatId) {
    setCurrentThread(chatId, "");
    botLogger.event("new_thread_requested", {
      chatId,
    });
    await sendChatMessage(
      chatId,
      "🆕 Next message will start a new thread. Existing running threads will keep sending updates here.",
    );
  }

  async function handleMessage(update) {
    const message = update.message;
    const chatId = String(message.chat.id);
    const text = compact(message.text || message.caption);
    const media = await extractTelegramMedia(message);

    botLogger.event("incoming_message", {
      updateId: update.update_id,
      chatId,
      text,
      mediaCount: media.length,
    });

    if (!shouldAllowChat(chatId)) {
      botLogger.warn("chat_rejected", {
        chatId,
      });
      await sendChatMessage(
        chatId,
        "⛔ This chat is not allowed to control the browser agent.",
      );
      return;
    }

    if (!text && !media.length) {
      await sendChatMessage(
        chatId,
        "📎 Send a text instruction, media, or both.",
      );
      return;
    }

    if (text === "/start" || text === "/help") {
      await handleStart(chatId);
      return;
    }

    if (text === "/new" || text === NEW_THREAD_BUTTON) {
      await handleNewThread(chatId);
      return;
    }

    await sendPromptToCurrentThread(chatId, text, media);
  }

  async function deliverAssistantMessage(threadId, message) {
    const chatIds = [...(threadOwners.get(threadId) || [])];
    if (!chatIds.length || message.role !== "assistant") {
      return;
    }

    const thread = store.getThread(threadId);
    const rendered = formatAssistantMessage(thread, message);
    const messageMedia = collectMessageMedia(thread, message);
    if (!rendered) {
      return;
    }

    for (const chatId of chatIds) {
      try {
        await sendChatMessage(chatId, rendered);
        for (const mediaRecord of messageMedia.slice(0, 4)) {
          await sendMediaPreview(chatId, threadId, mediaRecord);
        }
      } catch (error) {
        botLogger.error("message_delivery_failed", error, {
          chatId,
          threadId,
          messageId: message.id,
        });
      }
    }
  }

  async function handleUpdate(update) {
    state.pollingOffset = Math.max(Number(state.pollingOffset || 0), Number(update.update_id || 0) + 1);
    persistState();

    if (update.message) {
      await handleMessage(update);
    }
  }

  async function pollLoop() {
    while (running) {
      try {
        const updates = await callTelegram("getUpdates", {
          offset: Number(state.pollingOffset || 0),
          timeout: 30,
          allowed_updates: ["message"],
        });

        for (const update of updates) {
          await handleUpdate(update);
        }
      } catch (error) {
        if (isPollingConflictError(error)) {
          if (!pollConflictLogged) {
            pollConflictLogged = true;
            botLogger.warn("polling_conflict_detected", {
              pollingOffset: state.pollingOffset,
              action: "stopping_poll_loop",
              note: "Another Telegram bot instance is already consuming getUpdates for this token.",
            });
          }
          running = false;
          break;
        }

        botLogger.error("poll_failed", error, {
          pollingOffset: state.pollingOffset,
        });
        await wait(2000);
      }
    }
  }

  const unsubscribeMessages = store.onMessage(({ threadId, message }) => {
    deliverAssistantMessage(threadId, message).catch((error) => {
      botLogger.error("message_forward_failed", error, {
        threadId,
        messageId: message.id,
      });
    });
  });

  return {
    async start() {
      if (running) {
        return;
      }

      running = true;
      pollConflictLogged = false;
      botLogger.event("starting", {
        statePath,
        hasAllowedChatIds: allowedChatIds.size > 0,
      });

      if (!allowedChatIds.size) {
        botLogger.warn("no_chat_allowlist_configured", {
          note: "Bot accepts commands from any Telegram chat unless TELEGRAM_ALLOWED_CHAT_IDS is set.",
        });
      }

      try {
        await setCommands();
      } catch (error) {
        botLogger.error("set_commands_failed", error, {});
      }
      await pollLoop();
    },
    stop() {
      running = false;
      unsubscribeMessages();
      botLogger.event("stopped", {});
    },
  };
}

module.exports = {
  NEW_THREAD_BUTTON,
  createTelegramBot,
};
