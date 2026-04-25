const fs = require("fs");
const path = require("path");

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function compact(value) {
  return String(value || "").trim();
}

function sanitizeFileName(fileName) {
  const normalized = compact(fileName) || "media";
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function extensionForMimeType(mimeType) {
  const normalized = compact(mimeType).toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "video/quicktime") return ".mov";
  if (normalized === "video/webm") return ".webm";
  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/mp4") return ".m4a";
  if (normalized === "application/pdf") return ".pdf";
  return "";
}

function inferKind({ mimeType, fileName }) {
  const normalizedMime = compact(mimeType).toLowerCase();
  const normalizedName = compact(fileName).toLowerCase();

  if (normalizedMime.startsWith("image/")) return "image";
  if (normalizedMime.startsWith("video/")) return "video";
  if (normalizedMime.startsWith("audio/")) return "audio";
  if (normalizedName.match(/\.(png|jpe?g|gif|webp)$/)) return "image";
  if (normalizedName.match(/\.(mp4|mov|webm|mkv)$/)) return "video";
  if (normalizedName.match(/\.(mp3|wav|m4a|aac)$/)) return "audio";
  return "file";
}

function clientRecord(record) {
  return {
    id: record.id,
    threadId: record.threadId,
    fileName: record.fileName,
    mimeType: record.mimeType,
    kind: record.kind,
    size: record.size,
    source: record.source,
    createdAt: record.createdAt,
    url: `/api/media/${record.id}`,
  };
}

function createMediaStore({ rootDir, logger }) {
  ensureDirectory(rootDir);
  const indexPath = path.join(rootDir, "index.json");

  function readIndex() {
    return readJson(indexPath, []);
  }

  function writeIndex(records) {
    writeJson(indexPath, records);
  }

  function getMedia(mediaId) {
    return readIndex().find((record) => record.id === mediaId) || null;
  }

  function listByThread(threadId) {
    return readIndex()
      .filter((record) => record.threadId === threadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  function saveMedia({ threadId, fileName, mimeType, buffer, source = "api" }) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw new Error("Media buffer is required.");
    }

    const id = randomId();
    const safeName = sanitizeFileName(fileName || "media");
    const ext = path.extname(safeName) || extensionForMimeType(mimeType);
    const fileBase = path.basename(safeName, path.extname(safeName));
    const storedName = `${id}-${fileBase}${ext}`;
    const filePath = path.join(rootDir, storedName);
    fs.writeFileSync(filePath, buffer);

    const record = {
      id,
      threadId,
      fileName: safeName,
      mimeType: compact(mimeType) || "application/octet-stream",
      kind: inferKind({ mimeType, fileName: safeName }),
      size: buffer.length,
      source,
      createdAt: new Date().toISOString(),
      filePath,
    };

    const records = readIndex();
    records.push(record);
    writeIndex(records);

    logger.event("media.store", "media_saved", {
      mediaId: id,
      threadId,
      fileName: record.fileName,
      mimeType: record.mimeType,
      kind: record.kind,
      size: record.size,
      source,
    });

    return record;
  }

  function resolveSelection(threadId, mediaRef) {
    const items = listByThread(threadId);
    const normalizedRef = compact(mediaRef).toLowerCase() || "first_media";

    if (!items.length) {
      return [];
    }

    if (normalizedRef === "first_media") return [items[0]];
    if (normalizedRef === "first_image") return items.find((item) => item.kind === "image") ? [items.find((item) => item.kind === "image")] : [];
    if (normalizedRef === "first_video") return items.find((item) => item.kind === "video") ? [items.find((item) => item.kind === "video")] : [];
    if (normalizedRef === "all_media") return items;
    if (normalizedRef === "all_images") return items.filter((item) => item.kind === "image");
    if (normalizedRef === "all_videos") return items.filter((item) => item.kind === "video");
    if (normalizedRef.startsWith("media:")) {
      const mediaId = normalizedRef.slice("media:".length);
      const match = items.find((item) => item.id === mediaId);
      return match ? [match] : [];
    }

    return [];
  }

  return {
    clientRecord,
    getMedia,
    listByThread,
    resolveSelection,
    saveMedia,
  };
}

module.exports = {
  createMediaStore,
  clientRecord,
};
