import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const DB = path.join(CODEX_HOME, "state_5.sqlite");
const LOGS_DB = path.join(CODEX_HOME, "logs_2.sqlite");
const APP_DIR = path.join(CODEX_HOME, "lan-companion");
const TOKEN_FILE = path.join(APP_DIR, "token");
const PINS_FILE = path.join(APP_DIR, "pins.json");
const ATTACHMENTS_DIR = path.join(APP_DIR, "attachments");
const GLOBAL_STATE_FILE = path.join(CODEX_HOME, ".codex-global-state.json");
const SESSION_INDEX_FILE = path.join(CODEX_HOME, "session_index.jsonl");
const PAIRING_QR_FILE = path.join(APP_DIR, "pairing-qr.png");
const SEND_MODE = process.env.CODEX_LAN_SEND_MODE || "desktop-ui";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const runs = new Map();

await mkdir(APP_DIR, { recursive: true });
await mkdir(ATTACHMENTS_DIR, { recursive: true });
const token = await loadOrCreateToken();

function sqlite(args, db = DB) {
  return new Promise((resolve, reject) => {
    execFile("sqlite3", ["-json", db, ...args], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout.trim() ? JSON.parse(stdout) : []);
    });
  });
}

async function loadOrCreateToken() {
  try {
    const existing = (await readFile(TOKEN_FILE, "utf8")).trim();
    if (existing) return existing;
  } catch {}
  const fresh = randomBytes(24).toString("base64url");
  await writeFile(TOKEN_FILE, fresh, { mode: 0o600 });
  return fresh;
}

async function readPins() {
  const desktopPins = await readDesktopPins();
  try {
    const parsed = JSON.parse(await readFile(PINS_FILE, "utf8"));
    const companionPins = new Set(Array.isArray(parsed.threadIds) ? parsed.threadIds : []);
    const hiddenDesktopPins = new Set(Array.isArray(parsed.hiddenDesktopThreadIds) ? parsed.hiddenDesktopThreadIds : []);
    return {
      visible: new Set([...desktopPins, ...companionPins].filter((id) => !hiddenDesktopPins.has(id))),
      desktop: desktopPins,
      companion: companionPins,
      hiddenDesktop: hiddenDesktopPins,
    };
  } catch {
    return { visible: desktopPins, desktop: desktopPins, companion: new Set(), hiddenDesktop: new Set() };
  }
}

async function readDesktopPins() {
  try {
    const parsed = JSON.parse(await readFile(GLOBAL_STATE_FILE, "utf8"));
    const ids = parsed["pinned-thread-ids"];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

async function readQueuedFollowUps() {
  try {
    const parsed = JSON.parse(await readFile(GLOBAL_STATE_FILE, "utf8"));
    const raw = parsed["queued-follow-ups"];
    if (!raw || typeof raw !== "object") return new Map();
    const queued = new Map();
    for (const [threadId, entries] of Object.entries(raw)) {
      if (!Array.isArray(entries)) continue;
      queued.set(
        threadId,
        entries
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => ({
            id: String(entry.id || hash(JSON.stringify(entry))),
            text: String(entry.text || entry.context?.prompt || ""),
            imageAttachments: Array.isArray(entry.context?.imageAttachments) ? entry.context.imageAttachments : [],
            createdAt: Number(entry.createdAt || 0),
          }))
          .filter((entry) => entry.text.trim()),
      );
    }
    return queued;
  } catch {
    return new Map();
  }
}

async function removeQueuedFollowUp(threadId, followUpId) {
  const parsed = JSON.parse(await readFile(GLOBAL_STATE_FILE, "utf8"));
  const raw = parsed["queued-follow-ups"];
  if (!raw || !Array.isArray(raw[threadId])) return false;
  const before = raw[threadId].length;
  raw[threadId] = raw[threadId].filter((entry) => String(entry?.id || "") !== followUpId);
  const removed = raw[threadId].length !== before;
  if (raw[threadId].length === 0) delete raw[threadId];
  await writeFile(GLOBAL_STATE_FILE, JSON.stringify(parsed));
  return removed;
}

async function enqueueFollowUp(threadId, prompt, savedAttachments = []) {
  const rows = await sqlite([`select id,cwd from threads where id = '${threadId.replaceAll("'", "''")}' limit 1`]);
  if (!rows[0]) throw new Error("Thread not found");

  let parsed = {};
  try {
    parsed = JSON.parse(await readFile(GLOBAL_STATE_FILE, "utf8"));
  } catch {}

  const queued = parsed["queued-follow-ups"] && typeof parsed["queued-follow-ups"] === "object" ? parsed["queued-follow-ups"] : {};
  const cwd = rows[0].cwd || process.cwd();
  queued[threadId] = Array.isArray(queued[threadId]) ? queued[threadId] : [];
  queued[threadId].push({
    id: randomUUID(),
    text: prompt,
    context: {
      addedFiles: [],
      prompt,
      ideContext: null,
      imageAttachments: savedAttachments.map((attachment) => ({
        id: randomUUID(),
        src: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
        localPath: attachment.filePath,
        filename: attachment.filename,
        uploadStatus: "idle",
      })),
      nativeAppContexts: [],
      fileAttachments: [],
      inAppBrowserContext: null,
      commentAttachments: [],
      selectedTextAttachments: [],
      pullRequestChecks: [],
      workspaceRoots: [cwd],
    },
    cwd,
    createdAt: Date.now(),
  });
  parsed["queued-follow-ups"] = queued;
  await writeFile(GLOBAL_STATE_FILE, JSON.stringify(parsed));
}

async function readCustomThreadTitles() {
  const titles = new Map();

  try {
    const parsed = JSON.parse(await readFile(GLOBAL_STATE_FILE, "utf8"));
    const customTitles = parsed["thread-titles"]?.titles;
    if (customTitles && typeof customTitles === "object") {
      for (const [id, title] of Object.entries(customTitles)) {
        if (typeof title === "string" && title.trim()) titles.set(id, title.trim());
      }
    }
  } catch {}

  try {
    const raw = await readFile(SESSION_INDEX_FILE, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.id && typeof entry.thread_name === "string" && entry.thread_name.trim()) {
          titles.set(entry.id, entry.thread_name.trim());
        }
      } catch {}
    }
  } catch {}

  return titles;
}

async function readLatestLimits() {
  const rows = await sqlite(
    [
      `select id,ts,feedback_log_body
       from logs
       where feedback_log_body like '%"type":"codex.rate_limits"%'
       order by id desc
       limit 50`,
    ],
    LOGS_DB,
  );

  for (const row of rows) {
    const event = parseCodexRateLimitEvent(row.feedback_log_body);
    if (!event?.rate_limits) continue;
    return {
      updatedAt: new Date((Number(row.ts) || Date.now() / 1000) * 1000).toISOString(),
      planType: event.plan_type || null,
      limits: {
        fiveHour: normalizeLimitWindow(event.rate_limits.primary),
        weekly: normalizeLimitWindow(event.rate_limits.secondary),
      },
    };
  }

  return {
    updatedAt: null,
    planType: null,
    limits: {
      fiveHour: null,
      weekly: null,
    },
  };
}

function parseCodexRateLimitEvent(message) {
  const marker = "websocket event: ";
  const start = message.indexOf(marker);
  if (start < 0) return null;
  try {
    return JSON.parse(message.slice(start + marker.length));
  } catch {
    return null;
  }
}

function normalizeLimitWindow(limit) {
  if (!limit || typeof limit !== "object") return null;
  const usedPercent = clampPercent(limit.used_percent);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes: Number(limit.window_minutes || 0),
    resetAt: limit.reset_at ? new Date(Number(limit.reset_at) * 1000).toISOString() : null,
    resetAfterSeconds: Number(limit.reset_after_seconds || 0),
  };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

async function writePins(pins) {
  await writeFile(
    PINS_FILE,
    JSON.stringify(
      {
        threadIds: [...pins.companion],
        hiddenDesktopThreadIds: [...pins.hiddenDesktop],
      },
      null,
      2,
    ),
  );
}

function normalizeIp(ip) {
  if (!ip) return "";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function isPrivateNetwork(ip) {
  ip = normalizeIp(ip);
  if (ip === "::1" || ip === "127.0.0.1") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fd")) return true;
  return false;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function logRequest(req, message) {
  console.log(`[${new Date().toISOString()}] ${normalizeIp(req.socket.remoteAddress)} ${message}`);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 60 * 1024 * 1024) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function authed(req) {
  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const fromQuery = new URL(req.url, `http://${req.headers.host}`).searchParams.get("token") || "";
  return provided === token || fromQuery === token;
}

function requireAccess(req, res) {
  const ip = req.socket.remoteAddress;
  if (!isPrivateNetwork(ip)) {
    sendJson(res, 403, { error: "Only private local-network clients are allowed." });
    return false;
  }
  if (req.url.startsWith("/api") && !authed(req)) {
    sendJson(res, 401, { error: "Missing or invalid token." });
    return false;
  }
  return true;
}

async function listThreads() {
  const rows = await sqlite([
    `select id,title,cwd,rollout_path,source,archived,created_at_ms,updated_at_ms,first_user_message,agent_nickname,agent_role,model,reasoning_effort
     from threads
     order by updated_at_ms desc, updated_at desc
     limit 500`,
  ]);
  const pins = await readPins();
  const customTitles = await readCustomThreadTitles();
  return rows.map((row) => ({
    ...row,
    customTitle: customTitles.get(row.id) || null,
    pinned: pins.visible.has(row.id),
    project: row.cwd || "Unknown project",
  }));
}

function eventText(payload) {
  if (payload?.message) return payload.message;
  if (Array.isArray(payload?.content)) {
    return payload.content
      .map((part) => part.text || part.input_text || part.output_text || "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function readTranscript(threadId) {
  const rows = await sqlite([`select * from threads where id = '${threadId.replaceAll("'", "''")}' limit 1`]);
  if (!rows[0]) return null;
  const pins = await readPins();
  const customTitles = await readCustomThreadTitles();
  const thread = {
    ...rows[0],
    customTitle: customTitles.get(rows[0].id) || null,
    pinned: pins.visible.has(rows[0].id),
    project: rows[0].cwd || "Unknown project",
  };
  const raw = await readFile(thread.rollout_path, "utf8");
  const events = [];
  let pendingFileChanges = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = obj.payload || {};
    if (obj.type === "response_item" && payload.type === "message") {
      const text = eventText(payload);
      if (text && payload.role !== "developer") {
        const event = { id: hash(line), at: obj.timestamp, kind: "message", role: payload.role, text, phase: payload.phase || "" };
        if (shouldAttachFileChanges(event) && pendingFileChanges.length) {
          event.fileChanges = pendingFileChanges;
          pendingFileChanges = [];
        }
        events.push(event);
      }
    } else if (obj.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)) {
      const text = summarizeToolCall(payload);
      if (text) events.push({ id: hash(line), at: obj.timestamp, kind: "event", role: "system", text, phase: "" });
    } else if (obj.type === "event_msg") {
      if (["agent_message", "user_message"].includes(payload.type)) {
        const event = {
          id: hash(line),
          at: obj.timestamp,
          kind: "message",
          role: payload.type === "user_message" ? "user" : "assistant",
          text: payload.message || "",
          phase: payload.phase || "",
        };
        if (shouldAttachFileChanges(event) && pendingFileChanges.length) {
          event.fileChanges = pendingFileChanges;
          pendingFileChanges = [];
        }
        events.push(event);
      } else if (["exec_command_begin", "exec_command_end", "patch_apply_end", "task_started", "task_complete"].includes(payload.type)) {
        const fileChanges = summarizeFileChanges(payload, thread.cwd);
        if (fileChanges.length) pendingFileChanges = mergeFileChanges(pendingFileChanges, fileChanges);
        events.push({ id: hash(line), at: obj.timestamp, kind: "event", role: "system", text: summarizeEvent(payload), phase: "", fileChanges });
      }
    }
  }
  const queuedFollowUps = (await readQueuedFollowUps()).get(threadId) || [];
  return { thread, events: compactDuplicateMessages(events), queuedFollowUps };
}

function compactDuplicateMessages(events) {
  const out = [];
  const seen = new Set();
  for (const event of events) {
    const key = `${event.role}:${event.kind}:${event.text}`;
    if (seen.has(key) && event.kind === "message") continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

function shouldAttachFileChanges(event) {
  return event.role === "assistant" && event.phase === "final_answer";
}

function summarizeFileChanges(payload, cwd) {
  if (payload?.type !== "patch_apply_end" || payload.success === false || !payload.changes) return [];
  return Object.entries(payload.changes).map(([filePath, change]) => {
    const counts = countUnifiedDiff(change?.unified_diff || "");
    return {
      path: filePath,
      displayPath: displayFilePath(filePath, cwd),
      filename: path.basename(filePath),
      status: change?.type || "update",
      additions: counts.additions,
      deletions: counts.deletions,
    };
  });
}

function countUnifiedDiff(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff).split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function displayFilePath(filePath, cwd) {
  if (!cwd || !path.isAbsolute(filePath)) return filePath;
  const relative = path.relative(cwd, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative || path.basename(filePath);
  return filePath;
}

function mergeFileChanges(existing, incoming) {
  const merged = new Map(existing.map((change) => [change.path, { ...change }]));
  for (const change of incoming) {
    const current = merged.get(change.path);
    if (current) {
      current.additions += change.additions;
      current.deletions += change.deletions;
      current.status = change.status;
    } else {
      merged.set(change.path, { ...change });
    }
  }
  return Array.from(merged.values());
}

function summarizeEvent(payload) {
  if (payload.type === "exec_command_begin") return `$ ${payload.cmd || "command"}`;
  if (payload.type === "exec_command_end") return `command exited ${payload.exit_code ?? ""}`.trim();
  if (payload.type === "patch_apply_end") return payload.success === false ? "patch failed" : "patch applied";
  if (payload.type === "task_started") return "task started";
  if (payload.type === "task_complete") return "task complete";
  return payload.type || "event";
}

function summarizeToolCall(payload) {
  if (payload.type === "custom_tool_call" && payload.name === "apply_patch") return "applying patch";
  if (payload.type !== "function_call") return payload.name ? `using ${payload.name}` : "";

  if (payload.name === "exec_command") {
    const args = parseToolArguments(payload.arguments);
    if (args?.cmd) return `$ ${oneLine(args.cmd, 140)}`;
    return "running command";
  }
  if (payload.name === "write_stdin") return "reading command output";
  if (payload.name === "apply_patch") return "applying patch";
  return payload.name ? `using ${payload.name}` : "";
}

function parseToolArguments(argumentsText) {
  if (!argumentsText || typeof argumentsText !== "string") return null;
  try {
    return JSON.parse(argumentsText);
  } catch {
    return null;
  }
}

function oneLine(value, maxLength) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function hash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

async function startRun(threadId, prompt, savedAttachments = []) {
  if (SEND_MODE === "desktop-ui") {
    const active = await isThreadActive(threadId);
    console.log(
      `[${new Date().toISOString()}] route thread=${threadId} active=${active} mode=desktop-ui`,
    );
    return startDesktopUiRun(threadId, prompt);
  }
  return startCliRun(threadId, prompt);
}

async function isThreadActive(threadId) {
  const rows = await sqlite([`select rollout_path from threads where id = '${threadId.replaceAll("'", "''")}' limit 1`]);
  const rolloutPath = rows[0]?.rollout_path;
  if (!rolloutPath) return false;

  try {
    const raw = await readFile(rolloutPath, "utf8");
    let latestTaskEvent = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type !== "event_msg") continue;
      const type = obj.payload?.type;
      if (type === "task_started" || type === "task_complete") latestTaskEvent = type;
    }
    return latestTaskEvent === "task_started";
  } catch {
    return false;
  }
}

async function buildPromptWithAttachments(threadId, prompt, attachments) {
  const trimmed = typeof prompt === "string" ? prompt.trim() : "";
  const saved = await saveAttachments(threadId, attachments);
  if (!saved.length) return { prompt: trimmed, savedAttachments: [] };

  const base = trimmed || "Please review the attached image(s).";
  const lines = saved.flatMap((attachment, index) => [
    `Image ${index + 1}: ${attachment.filename}`,
    `![${attachment.filename}](${attachment.filePath})`,
  ]);
  return { prompt: `${base}\n\nAttached images:\n${lines.join("\n")}`, savedAttachments: saved };
}

async function saveAttachments(threadId, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  if (attachments.length > 8) throw new Error("Attach up to 8 images at a time.");

  const threadDir = path.join(ATTACHMENTS_DIR, sanitizePathSegment(threadId));
  await mkdir(threadDir, { recursive: true });

  const saved = [];
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment || typeof attachment.dataBase64 !== "string") throw new Error("Invalid attachment payload.");
    const mimeType = String(attachment.mimeType || "application/octet-stream").toLowerCase();
    if (!mimeType.startsWith("image/")) throw new Error("Only image attachments are supported.");

    const buffer = Buffer.from(attachment.dataBase64, "base64");
    if (!buffer.length) throw new Error("Attachment is empty.");
    if (buffer.length > 12 * 1024 * 1024) throw new Error("Each image attachment must be 12 MB or smaller.");

    const ext = extensionForMime(mimeType);
    const originalName = sanitizeFilename(attachment.filename || `image-${index + 1}${ext}`);
    const baseName = originalName.toLowerCase().endsWith(ext) ? originalName.slice(0, -ext.length) : originalName;
    const filename = `${Date.now()}-${index + 1}-${baseName}${ext}`;
    const filePath = path.join(threadDir, filename);
    await writeFile(filePath, buffer, { mode: 0o600 });
    saved.push({ filename, filePath, mimeType, size: buffer.length, dataBase64: buffer.toString("base64") });
  }
  return saved;
}

function extensionForMime(mimeType) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/heic" || mimeType === "image/heif") return ".heic";
  return ".jpg";
}

function sanitizePathSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "thread";
}

function sanitizeFilename(value) {
  const filename = path.basename(String(value)).replace(/[^a-zA-Z0-9._-]/g, "_");
  return filename.slice(0, 120) || "image";
}

async function startQueuedFollowUpRun(threadId, prompt, savedAttachments = []) {
  const id = randomBytes(10).toString("hex");
  const run = { id, threadId, status: "running", mode: "queued-follow-up", lines: [], startedAt: Date.now(), finishedAt: null, exitCode: null };
  runs.set(id, run);
  console.log(`[${new Date().toISOString()}] run ${id} queued-follow-up submit thread=${threadId} chars=${prompt.length} attachments=${savedAttachments.length}`);
  try {
    await enqueueFollowUp(threadId, prompt, savedAttachments);
    run.status = "complete";
    run.exitCode = 0;
    run.lines.push({
      at: new Date().toISOString(),
      type: "stdout",
      text: savedAttachments.length > 0 ? "Added to the Codex desktop follow-up queue with image attachments." : "Added to the Codex desktop follow-up queue.",
      parsed: null,
    });
  } catch (error) {
    run.status = "failed";
    run.exitCode = 1;
    run.lines.push({ at: new Date().toISOString(), type: "error", text: error.message });
  }
  run.finishedAt = Date.now();
  return run;
}

async function startDesktopUiRun(threadId, prompt) {
  const rows = await sqlite([`select id,cwd from threads where id = '${threadId.replaceAll("'", "''")}' limit 1`]);
  if (!rows[0]) throw new Error("Thread not found");
  const id = randomBytes(10).toString("hex");
  const run = { id, threadId, status: "running", mode: "desktop-ui", lines: [], startedAt: Date.now(), finishedAt: null, exitCode: null };
  runs.set(id, run);
  console.log(`[${new Date().toISOString()}] run ${id} desktop-ui submit thread=${threadId} chars=${prompt.length}`);
  const pasteDelay = Math.min(5, Math.max(0.35, prompt.length / 1200));

  const script = `
on run
  tell application "Codex" to activate
  delay 0.35
  tell application "System Events"
    tell process "Codex"
      set frontmost to true
      keystroke "v" using command down
      delay ${pasteDelay.toFixed(2)}
      key code 36
    end tell
  end tell
end run
`;

  (async () => {
    try {
      await setClipboard(prompt);
    } catch (error) {
      console.log(`[${new Date().toISOString()}] run ${id} clipboard failed: ${error.message}`);
      run.status = "failed";
      run.exitCode = 1;
      run.lines.push({
        at: new Date().toISOString(),
        type: "error",
        text: `Could not copy the prompt to the Mac clipboard: ${error.message}`,
      });
      run.finishedAt = Date.now();
      return;
    }

    execFile("osascript", ["-e", script], { timeout: 10000 }, (err, stdout, stderr) => {
      if (stdout.trim()) appendRun(run, stdout);
      if (stderr.trim()) appendRun(run, stderr, true);
      if (err) {
        console.log(`[${new Date().toISOString()}] run ${id} failed: ${stderr.trim() || err.message}`);
        run.status = "failed";
        run.exitCode = err.code ?? 1;
        run.lines.push({
          at: new Date().toISOString(),
          type: "error",
          text:
            "Could not submit through the Codex desktop UI. Give Terminal/AgentSidecar bridge Accessibility permission in System Settings > Privacy & Security > Accessibility, make sure the target Codex chat is visible, then try again.",
        });
      } else {
        console.log(`[${new Date().toISOString()}] run ${id} submitted to Codex desktop UI; waiting for transcript confirmation`);
        waitForPromptAccepted(threadId, prompt, 25000).then((confirmation) => {
          if (confirmation.accepted) {
            console.log(`[${new Date().toISOString()}] run ${id} confirmed in Codex ${confirmation.location}`);
            run.status = "complete";
            run.exitCode = 0;
            run.lines.push({
              at: new Date().toISOString(),
              type: "stdout",
              text: confirmation.location === "queued follow-up" ? "Added to the visible Codex desktop follow-up queue." : "Submitted to the visible Codex desktop chat.",
              parsed: null,
            });
          } else {
            console.log(`[${new Date().toISOString()}] run ${id} was not found in the Codex transcript; queueing follow-up fallback`);
            enqueueFollowUp(threadId, prompt)
              .then(() => {
                run.status = "complete";
                run.exitCode = 0;
                run.lines.push({
                  at: new Date().toISOString(),
                  type: "stdout",
                  text: "The desktop paste was not confirmed, so AgentSidecar added the prompt to the Codex follow-up queue.",
                  parsed: null,
                });
              })
              .catch((error) => {
                run.status = "failed";
                run.exitCode = 1;
                run.lines.push({
                  at: new Date().toISOString(),
                  type: "error",
                  text:
                    "The prompt reached the Mac bridge, but Codex did not record it after the desktop paste/submit step. Make sure the target Codex chat is visible and its composer can accept keyboard input.",
                });
                run.lines.push({ at: new Date().toISOString(), type: "error", text: error.message });
              })
              .finally(() => {
                run.finishedAt = Date.now();
              });
            return;
          }
          run.finishedAt = Date.now();
        });
        return;
      }
      run.finishedAt = Date.now();
    });
  })();

  return run;
}

async function waitForPromptAccepted(threadId, prompt, timeoutMs) {
  const expected = normalizeMessageForCompare(prompt);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const transcript = await readTranscript(threadId);
      const found = transcript?.events?.some(
        (event) => event.role === "user" && event.kind === "message" && normalizeMessageForCompare(event.text) === expected,
      );
      if (found) return { accepted: true, location: "transcript" };
      const queued = transcript?.queuedFollowUps?.some((entry) => normalizeMessageForCompare(entry.text) === expected);
      if (queued) return { accepted: true, location: "queued follow-up" };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return { accepted: false, location: null };
}

function normalizeMessageForCompare(text) {
  return String(text).replace(/\r\n/g, "\n").trim();
}

function setClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `pbcopy exited ${code}`));
    });
    child.stdin.end(text);
  });
}

async function startCliRun(threadId, prompt) {
  const rows = await sqlite([`select id,cwd from threads where id = '${threadId.replaceAll("'", "''")}' limit 1`]);
  if (!rows[0]) throw new Error("Thread not found");
  const id = randomBytes(10).toString("hex");
  const run = { id, threadId, status: "running", mode: "cli-resume", lines: [], startedAt: Date.now(), finishedAt: null, exitCode: null };
  runs.set(id, run);
  console.log(`[${new Date().toISOString()}] run ${id} cli-resume submit thread=${threadId} chars=${prompt.length}`);

  const args = ["exec", "resume", "--json", "--skip-git-repo-check", threadId, "-"];
  const child = spawn("codex", args, { cwd: rows[0].cwd || process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(prompt);

  child.stdout.on("data", (chunk) => appendRun(run, chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => appendRun(run, chunk.toString("utf8"), true));
  child.on("close", (code) => {
    run.status = code === 0 ? "complete" : "failed";
    run.exitCode = code;
    run.finishedAt = Date.now();
  });
  child.on("error", (error) => {
    run.status = "failed";
    run.lines.push({ at: new Date().toISOString(), type: "error", text: error.message });
    run.finishedAt = Date.now();
  });
  return run;
}

function appendRun(run, text, stderr = false) {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {}
    run.lines.push({ at: new Date().toISOString(), type: stderr ? "stderr" : "stdout", text: line, parsed });
    if (run.lines.length > 1000) run.lines.shift();
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/health") {
    logRequest(req, "health check");
    sendJson(res, 200, {
      ok: true,
      app: "AgentSidecar",
      sendMode: SEND_MODE,
      port: PORT,
      time: new Date().toISOString(),
      tokenSuffix: token.slice(-6),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/limits") {
    logRequest(req, "limits");
    sendJson(res, 200, await readLatestLimits());
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const threads = await listThreads();
    const projects = [...new Map(threads.map((t) => [t.project, { cwd: t.project, count: 0, updated_at_ms: 0 }])).values()];
    for (const project of projects) {
      const projectThreads = threads.filter((t) => t.project === project.cwd);
      project.count = projectThreads.length;
      project.updated_at_ms = Math.max(...projectThreads.map((t) => t.updated_at_ms || 0));
    }
    sendJson(res, 200, { threads, projects: projects.sort((a, b) => b.updated_at_ms - a.updated_at_ms) });
    return;
  }
  const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (req.method === "GET" && threadMatch) {
    const transcript = await readTranscript(threadMatch[1]);
    if (!transcript) return sendJson(res, 404, { error: "Thread not found" });
    sendJson(res, 200, transcript);
    return;
  }
  const pinMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/pin$/);
  if (req.method === "POST" && pinMatch) {
    const body = await readBody(req);
    const pins = await readPins();
    if (body.pinned) {
      pins.hiddenDesktop.delete(pinMatch[1]);
      pins.companion.add(pinMatch[1]);
    } else {
      pins.companion.delete(pinMatch[1]);
      if (pins.desktop.has(pinMatch[1])) pins.hiddenDesktop.add(pinMatch[1]);
    }
    await writePins(pins);
    const visible = body.pinned || (pins.desktop.has(pinMatch[1]) && !pins.hiddenDesktop.has(pinMatch[1]));
    sendJson(res, 200, { ok: true, pinned: visible });
    return;
  }
  const followUpMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/followups\/([^/]+)$/);
  if (req.method === "DELETE" && followUpMatch) {
    const removed = await removeQueuedFollowUp(followUpMatch[1], followUpMatch[2]);
    sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: "Follow-up not found." });
    return;
  }
  const resumeMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/resume$/);
  if (req.method === "POST" && resumeMatch) {
    const body = await readBody(req);
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (typeof body.prompt !== "string") return sendJson(res, 400, { error: "Prompt is required." });
    if (!body.prompt.trim() && attachments.length === 0) return sendJson(res, 400, { error: "Prompt or image attachment is required." });
    const { prompt, savedAttachments } = await buildPromptWithAttachments(resumeMatch[1], body.prompt, attachments);
    logRequest(req, `resume thread=${resumeMatch[1]} chars=${prompt.length} attachments=${savedAttachments.length}`);
    const run = await startRun(resumeMatch[1], prompt, savedAttachments);
    sendJson(res, 202, { runId: run.id });
    return;
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (req.method === "GET" && runMatch) {
    const run = runs.get(runMatch[1]);
    if (!run) return sendJson(res, 404, { error: "Run not found" });
    sendJson(res, 200, run);
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/pairing-qr.png") {
    try {
      await stat(PAIRING_QR_FILE);
      res.writeHead(200, { "content-type": "image/png" });
      createReadStream(PAIRING_QR_FILE).pipe(res);
    } catch {
      sendJson(res, 404, { error: "Pairing QR has not been generated yet." });
    }
    return;
  }
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(__dirname, "public", pathname));
  if (!file.startsWith(path.join(__dirname, "public"))) return sendJson(res, 403, { error: "Forbidden" });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!requireAccess(req, res)) return;
    if (req.url.startsWith("/api/")) await handleApi(req, res);
    else await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    printAlreadyRunningMessage();
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const addresses = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === "IPv4" && !n.internal);
  const preferred = addresses.find((addr) => !addr.address.startsWith("169.254.")) || addresses[0];
  console.log(`AgentSidecar bridge running on port ${PORT}`);
  console.log(`Send mode: ${SEND_MODE}`);
  console.log(`Token: ${token}`);
  if (preferred) {
    const serverURL = `http://${preferred.address}:${PORT}`;
    const pairingURL = `agentsidecar://pair?url=${serverURL}&token=${token}`;
    console.log(`Pairing URL: ${pairingURL}`);
    writePairingQRCode(pairingURL).catch(() => {
      console.log("QR image unavailable. Use the Pairing URL above or enter the URL/token manually.");
    });
  }
  for (const addr of addresses) console.log(`Manual setup URL: http://${addr.address}:${PORT}`);
});

function printAlreadyRunningMessage() {
  const addresses = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === "IPv4" && !n.internal);
  const preferred = addresses.find((addr) => !addr.address.startsWith("169.254.")) || addresses[0];
  console.log(`AgentSidecar bridge is already running on port ${PORT}.`);
  if (preferred) {
    console.log(`Manual setup URL: http://${preferred.address}:${PORT}`);
  }
  console.log(`Pairing QR: http://127.0.0.1:${PORT}/pairing-qr.png`);
  console.log("Keep the existing bridge running; you do not need to start another copy.");
}

async function writePairingQRCode(payload) {
  await QRCode.toFile(PAIRING_QR_FILE, payload, {
    errorCorrectionLevel: "M",
    margin: 4,
    scale: 10,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  });
  console.log(`Pairing QR image: ${PAIRING_QR_FILE}`);
  console.log(`Open in browser: http://127.0.0.1:${PORT}/pairing-qr.png`);
  execFile("open", [PAIRING_QR_FILE], () => {});
}
