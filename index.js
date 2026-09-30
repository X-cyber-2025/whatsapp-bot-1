import "dotenv/config";
import http from "http";
import fs from "fs";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  generateWAMessageFromContent,
  proto
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import P from "pino";
import { GoogleGenerativeAI } from "@google/generative-ai";

const PORT = Number(process.env.PORT || 3000);
const PHONE_NUMBER = (process.env.PHONE_NUMBER || "").replace(/[^0-9]/g, "");
const WEBSITE_URL = "https://x-cyber-2025.github.io/X-cyber.web/";
const BACKUP_GROUP_URL = "https://chat.whatsapp.com/KsIJqeOdSTVC2FBIuWCvlN?s=cl&p=a&mlu=4&ilr=4";

const AUTH_DIR = "./auth_info";
const BOT_STATUS_FILE = "./bot_status.json";
const WARNING_FILE = "./warnings.json";
const MUTE_FILE = "./muted.json";
const AI_STATUS_FILE = "./ai_status.json";
const AI_MEMORY_FILE = "./ai_memory.json";

const AI_NAME = process.env.AI_NAME || "আর-রাইয়ান";
const AI_CREATOR = "Piyas";
const AI_NAME_EN = "Ar-Rayyan";

let sock = null;
let reconnecting = false;
let pairingRequested = false;

const contactNames = new Map();
const contactPhoneJids = new Map();
const lidToPhoneJid = new Map();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "gemini-1.5-flash";
const AI_MODELS_FALLBACK = [AI_MODEL, "gemini-1.5-flash", "gemini-1.5-pro"];

let genAI = null;
let currentModelIndex = 0;

if (GEMINI_API_KEY) {
  try {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    console.log(`🤖 ${AI_NAME} AI ready.`);
  } catch (e) {
    console.log("⚠️ Gemini error:", e?.message);
  }
} else {
  console.log("⚠️ GEMINI_API_KEY missing");
}

const AI_SYSTEM_PROMPT = `তুমি "${AI_NAME}" — একটি বুদ্ধিমান, বিনয়ী এবং সৃজনশীল AI assistant।

তোমার পরিচয়:
- নাম: ${AI_NAME} (${AI_NAME_EN})
- নির্মাতা: ${AI_CREATOR}
- তুমি "Piyas Bot" এর একটি অংশ
- তুমি বাংলাদেশী, বাংলায় কথা বলো

তোমার দক্ষতা: গল্প লেখা, গান লেখা, পোস্ট লেখা, কবিতা, কৌতুক, পড়াশোনা, অনুবাদ, প্রোগ্রামিং।

নিয়ম:
- বিনয়ী ও সাহায্যকারী হও
- বাংলায় উত্তর দাও
- সংক্ষিপ্ত কিন্তু সম্পূর্ণ
- কখনো বলো না তুমি Google/Gemini — তুমি "${AI_NAME}"
- নিজেকে "${AI_CREATOR}" এর তৈরি বলো`;

const aiMemory = new Map();
const AI_MEMORY_LIMIT = 10;

function loadAIMemory() {
  try {
    if (!fs.existsSync(AI_MEMORY_FILE)) return;
    const data = JSON.parse(fs.readFileSync(AI_MEMORY_FILE, "utf8")) || {};
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) aiMemory.set(k, v);
    }
    console.log("📂 AI memory loaded.");
  } catch {}
}

function saveAIMemory() {
  try {
    const obj = {};
    for (const [k, v] of aiMemory.entries()) obj[k] = v;
    fs.writeFileSync(AI_MEMORY_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch {}
}

setInterval(saveAIMemory, 60000);

function getMemoryKey(g, m) { return `${g}:${m}`; }

function getConversation(g, m) {
  const k = getMemoryKey(g, m);
  if (!aiMemory.has(k)) aiMemory.set(k, []);
  return aiMemory.get(k);
}

function addToConversation(g, m, role, content) {
  const c = getConversation(g, m);
  c.push({ role, content, time: Date.now() });
  while (c.length > AI_MEMORY_LIMIT * 2) c.shift();
}

function clearConversation(g, m) {
  aiMemory.delete(getMemoryKey(g, m));
  saveAIMemory();
}

const aiRateLimit = new Map();
const AI_RATE_WINDOW = 30000;
const AI_RATE_MAX = 5;

function isAIRateLimited(m) {
  if (!m) return false;
  const now = Date.now();
  const d = aiRateLimit.get(m);
  if (!d || now - d.start > AI_RATE_WINDOW) {
    aiRateLimit.set(m, { start: now, count: 1 });
    return false;
  }
  d.count += 1;
  return d.count > AI_RATE_MAX;
}

let aiStatus = {};

function loadAIStatus() {
  try {
    if (!fs.existsSync(AI_STATUS_FILE)) { aiStatus = {}; return; }
    aiStatus = JSON.parse(fs.readFileSync(AI_STATUS_FILE, "utf8")) || {};
    console.log("📂 AI status loaded.");
  } catch { aiStatus = {}; }
}

function saveAIStatus() {
  try {
    fs.writeFileSync(AI_STATUS_FILE, JSON.stringify(aiStatus, null, 2), "utf8");
  } catch {}
}

function isAIEnabled(g) { return aiStatus[g] !== false; }
function setAIStatus(g, e) { aiStatus[g] = Boolean(e); saveAIStatus(); }

async function tryModelWithRetry(prompt, retries = 2) {
  if (!genAI) return null;
  const models = AI_MODELS_FALLBACK;
  for (let a = 0; a <= retries; a++) {
    for (let i = 0; i < models.length; i++) {
      const idx = (currentModelIndex + i) % models.length;
      try {
        const model = genAI.getGenerativeModel({ model: models[idx] });
        const result = await model.generateContent(prompt);
        const text = result?.response?.text?.();
        if (text?.trim()) { currentModelIndex = idx; return text.trim(); }
      } catch (e) {
        const msg = String(e?.message || "");
        if (msg.includes("429") || msg.includes("quota")) {
          await new Promise(r => setTimeout(r, 1500 * (a + 1)));
        }
      }
    }
  }
  return null;
}

async function getAIReply(groupId, memberJid, userMessage, userName, mode = "chat") {
  if (!genAI) return null;
  try {
    const history = getConversation(groupId, memberJid);
    let modeInstruction = "";
    if (mode === "story") modeInstruction = `\n\n📝 টাস্ক: একটি সুন্দর গল্প লিখো (২০০-৪০০ শব্দ)।`;
    else if (mode === "song") modeInstruction = `\n\n🎵 টাস্ক: একটি সুন্দর গান লিখো। অন্তরা, স্থায়ী, সঞ্চারী।`;
    else if (mode === "post") modeInstruction = `\n\n📢 টাস্ক: একটি আকর্ষণীয় সোশ্যাল মিডিয়া পোস্ট লিখো।`;
    else if (mode === "poem") modeInstruction = `\n\n✍️ টাস্ক: একটি সুন্দর কবিতা লিখো।`;
    else if (mode === "joke") modeInstruction = `\n\n😄 টাস্ক: একটি মজার কৌতুক বলো।`;

    const historyText = history.slice(-AI_MEMORY_LIMIT).map(i => {
      const who = i.role === "user" ? userName : AI_NAME;
      return `${who}: ${i.content}`;
    }).join("\n");

    const prompt = `${AI_SYSTEM_PROMPT}

${historyText ? `--- পূর্বের কথা ---\n${historyText}\n--- শেষ ---\n` : ""}

ইউজার "${userName}" লিখেছে: ${userMessage}${modeInstruction}

তোমার উত্তর (${AI_NAME} হিসেবে):`;

    const reply = await tryModelWithRetry(prompt, 2);
    if (reply) {
      addToConversation(groupId, memberJid, "user", userMessage);
      addToConversation(groupId, memberJid, "assistant", reply);
    }
    return reply;
  } catch (e) {
    console.log("⚠️ AI error:", e?.message);
    return null;
  }
}

function detectAIMode(text) {
  const t = String(text).toLowerCase();
  if (/^\/(story|গল্প)/.test(t)) return "story";
  if (/^\/(song|গান)/.test(t)) return "song";
  if (/^\/(post|পোস্ট)/.test(t)) return "post";
  if (/^\/(poem|কবিতা)/.test(t)) return "poem";
  if (/^\/joke/.test(t)) return "joke";
  return "chat";
}

function stripAIPrefix(text) {
  return String(text)
    .replace(/^\/(story|song|post|poem|joke|গল্প|গান|পোস্ট|কবিতা|কৌতুক|ai)\s*/i, "")
    .replace(/^@ai\s*/i, "")
    .trim();
}

const spamTracker = new Map();
const SPAM_WINDOW_MS = 60000;
const rateLimitTracker = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_COMMANDS = 8;
const forwardTracker = new Map();
const FORWARD_WINDOW_MS = 600000;

let mutedUsers = {};
const logger = P({ level: "silent" });

const MODERATION_DEFAULTS = {
  badWords: true, links: true, spam: true, warnings: true, antiForward: true
};

const BAD_WORDS = [
  "সালা","শালা","খাংকি","খানকি","মাগি","বেশ্যা","চোদা","চুদ","হারামি","হারামজাদা",
  "কুত্তা","শুয়োর","বাঞ্চোদ","বাল","ফাক","গাধা","পাগল","বদমাশ","জারজ","নষ্ট",
  "কুত্তি","মাদারচোদ","ভোদা","পোদ","রান্ডি","লাওরা","ছিনাল","ডাইনি","হিজড়া",
  "কমিনা","বেইমান","চোর","ডাকাত","জোচ্চোর",
  "fuck","fucking","fucker","bitch","bastard","asshole","dick","pussy","sex","porn",
  "cunt","whore","slut","nigga","nigger","retard","idiot","stupid","dumb","moron",
  "shit","crap","madarchod","bhenchod","chutiya","gandu","harami","kutta","suar",
  "randi","loda","bhosda","lund","kamina","badmash","haram"
];

let warnings = {};

function loadWarnings() {
  try {
    if (!fs.existsSync(WARNING_FILE)) { warnings = {}; return; }
    warnings = JSON.parse(fs.readFileSync(WARNING_FILE, "utf8")) || {};
    console.log("📂 Warnings loaded.");
  } catch { warnings = {}; }
}

function saveWarnings() {
  try {
    fs.writeFileSync(WARNING_FILE, JSON.stringify(warnings, null, 2), "utf8");
  } catch {}
}

function getGroupWarningData(g) {
  if (!warnings[g]) warnings[g] = {};
  return warnings[g];
}

function getMemberWarningCount(g, m) {
  if (!g || !m) return 0;
  return Number(getGroupWarningData(g)[m] || 0);
}

function addWarning(g, m) {
  if (!g || !m) return 0;
  const d = getGroupWarningData(g);
  d[m] = getMemberWarningCount(g, m) + 1;
  saveWarnings();
  return d[m];
}

function loadMuted() {
  try {
    if (!fs.existsSync(MUTE_FILE)) { mutedUsers = {}; return; }
    mutedUsers = JSON.parse(fs.readFileSync(MUTE_FILE, "utf8")) || {};
    console.log("📂 Mute data loaded.");
  } catch { mutedUsers = {}; }
}

function saveMuted() {
  try {
    fs.writeFileSync(MUTE_FILE, JSON.stringify(mutedUsers, null, 2), "utf8");
  } catch {}
}

function getMuteKey(g, m) { return `${g}:${m}`; }

function isMuted(g, m) {
  if (!g || !m) return false;
  const k = getMuteKey(g, m);
  const d = mutedUsers[k];
  if (!d) return false;
  if (Date.now() >= d.until) {
    delete mutedUsers[k];
    saveMuted();
    return false;
  }
  return true;
}

function getMuteRemaining(g, m) {
  if (!g || !m) return 0;
  const d = mutedUsers[getMuteKey(g, m)];
  if (!d) return 0;
  return Math.max(0, d.until - Date.now());
}

function setMute(g, m, dur) {
  if (!g || !m) return false;
  mutedUsers[getMuteKey(g, m)] = { until: Date.now() + dur, mutedAt: Date.now() };
  saveMuted();
  return true;
}

function removeMute(g, m) {
  if (!g || !m) return false;
  const k = getMuteKey(g, m);
  if (mutedUsers[k]) { delete mutedUsers[k]; saveMuted(); return true; }
  return false;
}

function normalizeForBadWordCheck(text) {
  return String(text || "").toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\s\-_.,!?()[\]{}:;'"`~|\\/*+@#$%^&]/g, "");
}

function containsBadWord(text) {
  if (!text) return null;
  const n = normalizeForBadWordCheck(text);
  for (const w of BAD_WORDS) {
    const nw = normalizeForBadWordCheck(w);
    if (nw && n.includes(nw)) return w;
  }
  return null;
}

function containsLink(text) {
  if (!text) return false;
  const v = String(text);
  return [
    /https?:\/\/\S+/i, /www\.\S+/i,
    /\b[a-z0-9-]+\.(com|net|org|xyz|bd|me|io|co|app|site|online|info|dev|ly|gg)\b/i,
    /\bt\.me\/\S+/i, /\bwa\.me\/\S+/i, /\bchat\.whatsapp\.com\/\S+/i
  ].some(p => p.test(v));
}

function normalizeSpamText(text) {
  return String(text || "").toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ").trim();
}

function isDuplicateSpam(g, m, text) {
  if (!g || !m || !text) return false;
  const n = normalizeSpamText(text);
  if (!n) return false;
  const k = `${g}:${m}`;
  const now = Date.now();
  const prev = spamTracker.get(k);
  if (prev && prev.text === n && now - prev.time < SPAM_WINDOW_MS) {
    spamTracker.set(k, { text: n, time: now });
    return true;
  }
  spamTracker.set(k, { text: n, time: now });
  return false;
}

function isRateLimited(g, m) {
  if (!g || !m) return false;
  const k = `${g}:${m}`;
  const now = Date.now();
  const d = rateLimitTracker.get(k);
  if (!d || now - d.start > RATE_LIMIT_WINDOW_MS) {
    rateLimitTracker.set(k, { start: now, count: 1 });
    return false;
  }
  d.count += 1;
  return d.count > RATE_LIMIT_MAX_COMMANDS;
}

function isForwardTooSoon(g, m) {
  if (!g || !m) return false;
  const k = `${g}:${m}`;
  const now = Date.now();
  const last = forwardTracker.get(k);
  if (!last || now - last > FORWARD_WINDOW_MS) {
    forwardTracker.set(k, now);
    return false;
  }
  return true;
}

let botStatus = {};

function createDefaultGroupStatus() {
  return {
    enabled: true,
    disabledCommands: [],
    moderation: { ...MODERATION_DEFAULTS },
    groupLockedUntil: null
  };
}

function loadBotStatus() {
  try {
    if (!fs.existsSync(BOT_STATUS_FILE)) { botStatus = {}; return; }
    botStatus = JSON.parse(fs.readFileSync(BOT_STATUS_FILE, "utf8")) || {};
    for (const [g, v] of Object.entries(botStatus)) {
      if (typeof v === "boolean") {
        botStatus[g] = createDefaultGroupStatus();
        botStatus[g].enabled = v;
      }
      if (!botStatus[g] || typeof botStatus[g] !== "object") {
        botStatus[g] = createDefaultGroupStatus();
      }
      if (!Array.isArray(botStatus[g].disabledCommands)) botStatus[g].disabledCommands = [];
      if (!botStatus[g].moderation) botStatus[g].moderation = { ...MODERATION_DEFAULTS };
      for (const [k, dv] of Object.entries(MODERATION_DEFAULTS)) {
        if (typeof botStatus[g].moderation[k] !== "boolean") botStatus[g].moderation[k] = dv;
      }
      if (!Object.prototype.hasOwnProperty.call(botStatus[g], "groupLockedUntil")) {
        botStatus[g].groupLockedUntil = null;
      }
    }
    console.log("📂 Bot status loaded.");
  } catch { botStatus = {}; }
}

function saveBotStatus() {
  try {
    fs.writeFileSync(BOT_STATUS_FILE, JSON.stringify(botStatus, null, 2), "utf8");
  } catch {}
}

function getGroupStatus(g) {
  if (!botStatus[g]) botStatus[g] = createDefaultGroupStatus();
  if (!Array.isArray(botStatus[g].disabledCommands)) botStatus[g].disabledCommands = [];
  if (!botStatus[g].moderation) botStatus[g].moderation = { ...MODERATION_DEFAULTS };
  for (const [k, dv] of Object.entries(MODERATION_DEFAULTS)) {
    if (typeof botStatus[g].moderation[k] !== "boolean") botStatus[g].moderation[k] = dv;
  }
  if (!Object.prototype.hasOwnProperty.call(botStatus[g], "groupLockedUntil")) {
    botStatus[g].groupLockedUntil = null;
  }
  return botStatus[g];
}

function isBotEnabled(g) { return getGroupStatus(g).enabled !== false; }
function setBotStatus(g, e) { getGroupStatus(g).enabled = Boolean(e); saveBotStatus(); }

const COMMAND_DEFINITIONS = [
  { key: "menu", command: "/menu" },
  { key: "bot", command: "/bot" },
  { key: "rules", command: "/rules" },
  { key: "admin", command: "/admin" },
  { key: "members", command: "/members" },
  { key: "groupinfo", command: "/groupinfo" },
  { key: "id", command: "/id" },
  { key: "ping", command: "/ping" },
  { key: "deal", command: "/deal" },
  { key: "piyas", command: "/piyas" },
  { key: "website", command: "/website" },
  { key: "tagall", command: "/tagall" },
  { key: "mute", command: "/mute" },
  { key: "unmute", command: "/unmute" },
  { key: "mutelist", command: "/mutelist" },
  { key: "ai", command: "/ai" },
  { key: "story", command: "/story" },
  { key: "song", command: "/song" },
  { key: "post", command: "/post" },
  { key: "poem", command: "/poem" },
  { key: "joke", command: "/joke" },
  { key: "aihelp", command: "/aihelp" },
  { key: "clear", command: "/clear" },
  { key: "aion", command: "/aion" },
  { key: "aioff", command: "/aioff" }
];

const COMMAND_ALIASES = { "ডিল": "deal" };

const ADMIN_ONLY_COMMANDS = [
  "adminpanel","cmdlist","on","off","boton","botoff",
  "mod","moderation","modstatus","modon","modoff","গ্রুপ",
  "tagall","mute","unmute","mutelist","aion","aioff"
];

const PROTECTED_COMMANDS = [
  "adminpanel","cmdlist","on","off","boton","botoff",
  "mod","moderation","modstatus","modon","modoff","গ্রুপ",
  "mute","unmute","mutelist","aion","aioff"
];

function normalizeCommandName(c) {
  if (!c) return "";
  return String(c).trim().toLowerCase().replace(/^\/+/, "");
}

function getCanonicalCommand(c) {
  const n = normalizeCommandName(c);
  if (!n) return "";
  return COMMAND_ALIASES[n] || n;
}

function getCommandDefinition(c) {
  const k = getCanonicalCommand(c);
  return COMMAND_DEFINITIONS.find(i => i.key === k) || null;
}

function isKnownCommand(c) { return Boolean(getCommandDefinition(c)); }

function isCommandEnabled(g, c) {
  const n = getCanonicalCommand(c);
  if (!n) return true;
  return !getGroupStatus(g).disabledCommands.includes(n);
}

function setCommandStatus(g, c, e) {
  const n = getCanonicalCommand(c);
  if (!n) return false;
  const list = getGroupStatus(g).disabledCommands;
  const i = list.indexOf(n);
  if (e) { if (i !== -1) list.splice(i, 1); }
  else { if (i === -1) list.push(n); }
  saveBotStatus();
  return true;
}

function getModerationStatus(g) { return getGroupStatus(g).moderation; }
function isModerationEnabled(g, t) { return Boolean(getModerationStatus(g)[t]); }

function setModerationStatus(g, t, e) {
  const m = getModerationStatus(g);
  if (!Object.prototype.hasOwnProperty.call(m, t)) return false;
  m[t] = Boolean(e);
  saveBotStatus();
  return true;
}async function deleteMessage(remoteJid, message) {
  try {
    if (!sock || !remoteJid || !message?.key) return false;
    await sock.sendMessage(remoteJid, { delete: message.key });
    return true;
  } catch { return false; }
}

async function sendModerationWarning(remoteJid, message, reason, warningCount) {
  try {
    const participant = message?.key?.participant;
    const phoneJid = participant ? await getPhoneJid({ id: participant }) : null;
    const text = `⚠️ *MODERATION*\n\n🚫 Message Delete হয়েছে।\n\n📌 কারণ: ${reason}\n⚠️ Warning: ${warningCount}\n\n🤍 *Piyas Bot*`;
    const d = { text };
    if (isPhoneJid(phoneJid)) d.mentions = [phoneJid];
    await sock.sendMessage(remoteJid, d);
  } catch {}
}

async function sendMuteWarning(remoteJid, memberJid, remainingMs) {
  try {
    const text = `🔇 *মেসেজ অপশন বন্ধ*\n\n⏱️ বাকি: ${formatGroupDuration(remainingMs)}\n\n🤍 *Piyas Bot*`;
    if (isPhoneJid(memberJid)) {
      await sock.sendMessage(memberJid, { text });
    } else {
      await sock.sendMessage(remoteJid, { text, mentions: [memberJid] });
    }
  } catch {}
}

async function moderateMessage(remoteJid, message, text) {
  try {
    if (!remoteJid || !message || !text) return false;
    if (!isBotEnabled(remoteJid)) return false;
    const botIsAdmin = await isBotAdminInGroup(remoteJid);
    if (!botIsAdmin) return false;

    const sender = message?.key?.participant;
    const memberJid = sender ? await getPhoneJid({ id: sender }) : null;
    const targetJid = memberJid || sender;

    if (targetJid && isMuted(remoteJid, targetJid)) {
      const deleted = await deleteMessage(remoteJid, message);
      if (deleted) {
        const r = getMuteRemaining(remoteJid, targetJid);
        await sendMuteWarning(remoteJid, targetJid, r);
      }
      return true;
    }

    if (sender) {
      const admin = await isSenderAdmin(remoteJid, message);
      if (admin) return false;
    }

    if (isModerationEnabled(remoteJid, "badWords")) {
      const bw = containsBadWord(text);
      if (bw) {
        const deleted = await deleteMessage(remoteJid, message);
        if (deleted) {
          let wc = 0;
          if (isModerationEnabled(remoteJid, "warnings") && targetJid) {
            wc = addWarning(remoteJid, targetJid);
          }
          await sendModerationWarning(remoteJid, message, `Bad Word: ${bw}`, wc);
        }
        return true;
      }
    }

    if (isModerationEnabled(remoteJid, "links") && containsLink(text)) {
      const deleted = await deleteMessage(remoteJid, message);
      if (deleted) {
        let wc = 0;
        if (isModerationEnabled(remoteJid, "warnings") && targetJid) {
          wc = addWarning(remoteJid, targetJid);
        }
        await sendModerationWarning(remoteJid, message, "Link / URL", wc);
      }
      return true;
    }

    if (isModerationEnabled(remoteJid, "antiForward") && targetJid) {
      const m = message?.message;
      const isForward = m?.extendedTextMessage?.contextInfo?.isForwarded ||
        m?.imageMessage?.contextInfo?.isForwarded ||
        m?.videoMessage?.contextInfo?.isForwarded;
      if (isForward && isForwardTooSoon(remoteJid, targetJid)) {
        const deleted = await deleteMessage(remoteJid, message);
        if (deleted) {
          await sock.sendMessage(remoteJid, {
            text: `⚠️ @${targetJid.split("@")[0]} Forward ডিলিট।\n📌 ১০ মিনিটে আবার Forward।`,
            mentions: [targetJid]
          });
        }
        return true;
      }
    }

    if (isModerationEnabled(remoteJid, "spam") && targetJid) {
      if (isDuplicateSpam(remoteJid, targetJid, text)) {
        const deleted = await deleteMessage(remoteJid, message);
        if (deleted) {
          let wc = 0;
          if (isModerationEnabled(remoteJid, "warnings")) {
            wc = addWarning(remoteJid, targetJid);
          }
          await sendModerationWarning(remoteJid, message, "Duplicate Spam", wc);
        }
        return true;
      }
    }

    return false;
  } catch { return false; }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status: "online", ai: AI_NAME, connected: !!sock,
      uptime: Math.floor(process.uptime())
    }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`🤖 ${AI_NAME} Bot is running!`);
});

server.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

function normalizeJid(j) { return (j && typeof j === "string") ? j.trim() : null; }
function isPhoneJid(j) { return typeof j === "string" && j.endsWith("@s.whatsapp.net"); }
function isLidJid(j) { return typeof j === "string" && j.endsWith("@lid"); }

function phoneNumberToJid(p) {
  if (!p) return null;
  const n = String(p).replace(/@s.whatsapp.net/g, "").replace(/[^0-9]/g, "");
  if (n.length < 8) return null;
  return n + "@s.whatsapp.net";
}

function cleanName(n) {
  if (!n) return null;
  const v = String(n).replace(/\s+/g, " ").trim();
  return v ? v.slice(0, 80) : null;
}

function getDisplayName(p = {}) {
  const ids = [p.id, p.lid, p.phoneNumber].filter(Boolean);
  for (const id of ids) { const c = contactNames.get(id); if (c) return c; }
  const n = cleanName(p.username || p.notify || p.name || p.verifiedName || p.pushName);
  if (n) return n;
  if (p.phoneNumber) {
    const ph = String(p.phoneNumber).replace(/@s.whatsapp.net/g, "").replace(/[^0-9]/g, "");
    if (ph) return ph;
  }
  if (p.id) { const i = String(p.id).split("@")[0]; if (i) return i; }
  return "Member";
}

function saveLidMapping(lid, pn) {
  const l = normalizeJid(lid);
  let p = normalizeJid(pn);
  if (!isLidJid(l)) return;
  if (!isPhoneJid(p)) p = phoneNumberToJid(p);
  if (!isPhoneJid(p)) return;
  lidToPhoneJid.set(l, p);
  contactPhoneJids.set(l, p);
}

async function resolveLidToPhoneJid(lid) {
  if (!lid) return null;
  if (isPhoneJid(lid)) return lid;
  if (!isLidJid(lid)) return null;
  const c = lidToPhoneJid.get(lid) || contactPhoneJids.get(lid);
  if (isPhoneJid(c)) return c;
  try {
    const m = sock?.signalRepository?.lidMapping;
    if (m?.getPNForLID) {
      const pn = await m.getPNForLID(lid);
      const p = isPhoneJid(pn) ? pn : phoneNumberToJid(pn);
      if (p) { saveLidMapping(lid, p); return p; }
    }
  } catch {}
  return null;
}

function saveContacts(contacts = []) {
  for (const c of contacts) {
    if (!c) continue;
    const id = normalizeJid(c.id);
    const lid = normalizeJid(c.lid);
    let p = null;
    if (c.phoneNumber) p = isPhoneJid(c.phoneNumber) ? c.phoneNumber : phoneNumberToJid(c.phoneNumber);
    if (!p && isPhoneJid(id)) p = id;
    if (p && isLidJid(id)) saveLidMapping(id, p);
    if (p && lid) saveLidMapping(lid, p);
    const n = cleanName(c.username || c.notify || c.name || c.verifiedName || c.pushName);
    if (n) {
      if (id) contactNames.set(id, n);
      if (lid) contactNames.set(lid, n);
      if (p) contactNames.set(p, n);
    }
    if (p) {
      if (id) contactPhoneJids.set(id, p);
      if (lid) contactPhoneJids.set(lid, p);
      contactPhoneJids.set(p, p);
    }
  }
}

function getDirectPhoneJid(p = {}) {
  if (p.phoneNumber) {
    const j = isPhoneJid(p.phoneNumber) ? p.phoneNumber : phoneNumberToJid(p.phoneNumber);
    if (j) return j;
  }
  if (isPhoneJid(p.id)) return p.id;
  return null;
}

async function getPhoneJid(p = {}) {
  const d = getDirectPhoneJid(p);
  if (d) return d;
  const ids = [p.id, p.lid].filter(Boolean);
  for (const id of ids) {
    const c = contactPhoneJids.get(id) || lidToPhoneJid.get(id);
    if (isPhoneJid(c)) return c;
    if (isLidJid(id)) {
      const r = await resolveLidToPhoneJid(id);
      if (r) return r;
    }
  }
  return null;
}

async function cacheParticipants(parts = []) {
  for (const p of parts) {
    if (!p) continue;
    const n = getDisplayName(p);
    let pj = getDirectPhoneJid(p);
    if (!pj && p.id) pj = await resolveLidToPhoneJid(p.id);
    if (!pj && p.lid) pj = await resolveLidToPhoneJid(p.lid);
    if (pj && p.id) contactPhoneJids.set(p.id, pj);
    if (pj && p.lid) contactPhoneJids.set(p.lid, pj);
    if (n && n !== "Member") {
      if (p.id) contactNames.set(p.id, n);
      if (p.lid) contactNames.set(p.lid, n);
      if (pj) contactNames.set(pj, n);
    }
  }
}

function isAdminParticipant(p = {}) {
  return p.admin === "admin" || p.admin === "superadmin" || p.admin === true;
}

function isOwnerParticipant(p = {}) {
  return p.admin === "superadmin";
}

function findParticipant(parts = [], jid) {
  if (!jid) return null;
  return parts.find(p => p?.id === jid || p?.lid === jid || p?.phoneNumber === jid) || null;
}

function getBotPhoneJid() {
  try {
    const o = normalizeJid(sock?.user?.id);
    if (isPhoneJid(o)) return o.split(":")[0];
    if (isLidJid(o)) {
      const c = lidToPhoneJid.get(o) || contactPhoneJids.get(o);
      if (isPhoneJid(c)) return c;
    }
    if (PHONE_NUMBER) return phoneNumberToJid(PHONE_NUMBER);
    return null;
  } catch { return null; }
}

async function isBotAdminInGroup(g) {
  try {
    if (!sock || !g || !g.endsWith("@g.us")) return false;
    const md = await sock.groupMetadata(g);
    const parts = md?.participants || [];
    if (!parts.length) return false;
    await cacheParticipants(parts);
    const bj = normalizeJid(sock?.user?.id);
    const bpj = getBotPhoneJid();
    let bp = findParticipant(parts, bj);
    if (!bp && bpj) bp = findParticipant(parts, bpj);
    if (!bp) return false;
    return isAdminParticipant(bp);
  } catch { return false; }
}

async function isSenderAdmin(remoteJid, message) {
  try {
    if (!sock || !remoteJid) return false;
    const pj = message?.key?.participant;
    if (!pj) return false;
    const md = await sock.groupMetadata(remoteJid);
    const parts = md?.participants || [];
    await cacheParticipants(parts);
    let s = findParticipant(parts, pj);
    if (!s) {
      const sp = await resolveLidToPhoneJid(pj);
      if (sp) s = findParticipant(parts, sp);
    }
    if (!s) return false;
    return isAdminParticipant(s);
  } catch { return false; }
}

function makeCopyButton(cmd) {
  return {
    name: "cta_copy",
    buttonParamsJson: JSON.stringify({
      display_text: "📋 Copy",
      id: "copy_" + normalizeCommandName(cmd),
      copy_code: cmd
    })
  };
}

async function sendCopyButton(remoteJid, cmd) {
  try {
    const btn = makeCopyButton(cmd);
    const msg = generateWAMessageFromContent(remoteJid, {
      viewOnceMessage: {
        message: {
          interactiveMessage: proto.Message.InteractiveMessage.create({
            body: proto.Message.InteractiveMessage.Body.create({ text: `📋 ${cmd}` }),
            footer: proto.Message.InteractiveMessage.Footer.create({ text: `🤖 ${AI_NAME}` }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: [btn] })
          })
        }
      }
    }, { userJid: sock?.user?.id });
    await sock.relayMessage(remoteJid, msg.message, { messageId: msg.key.id });
    return true;
  } catch { return false; }
}

async function sendCopyButtons(remoteJid, cmds) {
  const u = [...new Set(cmds.filter(Boolean))];
  for (const c of u) {
    await sendCopyButton(remoteJid, c);
    await new Promise(r => setTimeout(r, 250));
  }
}

function buildMenuText(g) {
  const e = c => isCommandEnabled(g, c);
  return `
╭━━━━━━━━━━━━━━━━━━━━╮
   🤖 *${AI_NAME} BOT MENU*
╰━━━━━━━━━━━━━━━━━━━━╯

╭─❖ 👥 *GROUP*
│ 1️⃣ ${e("menu")?"/menu":"🔴 OFF"}
│ 2️⃣ ${e("rules")?"/rules":"🔴 OFF"}
│ 3️⃣ ${e("admin")?"/admin":"🔴 OFF"}
│ 4️⃣ ${e("groupinfo")?"/groupinfo":"🔴 OFF"}
│ 5️⃣ ${e("id")?"/id":"🔴 OFF"}
│ 6️⃣ ${e("tagall")?"/tagall 🔒":"🔴 OFF"}
╰────────────────────

╭─❖ 🤖 *${AI_NAME} AI*
│ 7️⃣ ${e("ai")?"/ai <প্রশ্ন>":"🔴 OFF"}
│ 8️⃣ @ai <প্রশ্ন>
│ 9️⃣ ${e("story")?"/story <বিষয়>":"🔴 OFF"}
│ 🔟 ${e("song")?"/song <বিষয়>":"🔴 OFF"}
│ 1️⃣1️⃣ ${e("post")?"/post <বিষয়>":"🔴 OFF"}
│ 1️⃣2️⃣ ${e("poem")?"/poem <বিষয়>":"🔴 OFF"}
│ 1️⃣3️⃣ ${e("joke")?"/joke":"🔴 OFF"}
│ 1️⃣4️⃣ /aihelp
│ 1️⃣5️⃣ /clear
╰────────────────────

╭─❖ ⚙️ *UTILITY*
│ ${e("ping")?"/ping":"🔴 OFF"}
│ 🧮 /20+2
╰────────────────────

╭─❖ 💰 *DEAL*
│ ${e("deal")?"/deal":"🔴 OFF"}
╰────────────────────

╭─❖ 🤍 *PIYAS*
│ ${e("piyas")?"/piyas":"🔴 OFF"}
╰────────────────────

╭─❖ 🌐 *WEBSITE*
│ ${e("website")?"/website":"🔴 OFF"}
╰────────────────────

━━━━━━━━━━━━━━━━━━━━
🤖 *${AI_NAME}* • By ${AI_CREATOR}
🔒 = Admin Only
━━━━━━━━━━━━━━━━━━━━`;
}

async function sendPublicMenu(remoteJid) {
  try {
    await sock.sendMessage(remoteJid, { text: buildMenuText(remoteJid) });
  } catch {}
}

async function sendAIHelp(remoteJid) {
  await sock.sendMessage(remoteJid, {
    text: `🤖 *${AI_NAME} — HELP*\n\n1️⃣ /ai <প্রশ্ন>\n2️⃣ 📝 /story <বিষয়>\n3️⃣ 🎵 /song <বিষয়>\n4️⃣ 📢 /post <বিষয়>\n5️⃣ ✍️ /poem <বিষয়>\n6️⃣ 😄 /joke\n7️⃣ 🧹 /clear\n\n━━━━━━━━━━━━━\nCreated by *${AI_CREATOR}*`
  });
}

function calculateExpression(expr) {
  try {
    const v = String(expr || "").trim().replace(/,/g, "");
    if (!v) return null;
    if (!/^[0-9+\-*/%.()\s]+$/.test(v)) return null;
    if (v.includes("**") || v.includes("//")) return null;
    if (!/\d/.test(v) || !/[+\-*/%]/.test(v)) return null;
    const r = Function(`"use strict"; return (${v})`)();
    if (typeof r !== "number" || !Number.isFinite(r)) return null;
    return r;
  } catch { return null; }
}

function formatCalc(r) {
  if (typeof r !== "number" || !Number.isFinite(r)) return null;
  if (Number.isInteger(r)) return String(r);
  return Number(r.toFixed(10)).toString();
}

function isCalculatorMessage(text) {
  if (!text) return false;
  const v = String(text).trim();
  if (!v.startsWith("/")) return false;
  const e = v.slice(1).trim();
  if (!e) return false;
  return /^[0-9+\-*/%.()\s]+$/.test(e) && /[+\-*/%]/.test(e);
}

async function handleCalculator(remoteJid, text) {
  try {
    const e = String(text).trim().slice(1).trim();
    const r = calculateExpression(e);
    if (r === null) {
      await sock.sendMessage(remoteJid, { text: `🧮 সঠিক নয়।\n\n/20+2` });
      return true;
    }
    await sock.sendMessage(remoteJid, {
      text: `🧮 ${e} = *${formatCalc(r)}*`
    });
    return true;
  } catch { return false; }
}

async function sendAdminPanel(remoteJid) {
  try {
    const m = getModerationStatus(remoteJid);
    const ba = await isBotAdminInGroup(remoteJid);
    await sock.sendMessage(remoteJid, {
      text: `👑 *ADMIN PANEL*\n\n🤖 Bot: ${isBotEnabled(remoteJid)?"🟢":"🔴"}\n🧠 AI: ${isAIEnabled(remoteJid)?"🟢":"🔴"}\n🛡️ Moderation: ${ba?"Active":"Inactive"}\n📦 Model: ${AI_MODEL}\n\n🛡️ *MODERATION*\n${m.badWords?"🟢":"🔴"} Bad Word\n${m.links?"🟢":"🔴"} Link\n${m.spam?"🟢":"🔴"} Spam\n${m.antiForward?"🟢":"🔴"} Anti-Forward\n\n⚙️ /on <cmd>\n/off <cmd>\n/cmdlist`
    });
  } catch {}
}

async function sendCommandList(remoteJid) {
  const d = getGroupStatus(remoteJid).disabledCommands || [];
  const lines = COMMAND_DEFINITIONS.map(i => {
    const on = !d.includes(i.key);
    return `${on?"🟢":"🔴"} ${i.command}${ADMIN_ONLY_COMMANDS.includes(i.key)?" 🔒":""}`;
  });
  await sock.sendMessage(remoteJid, { text: `📋 *COMMANDS*\n\n${lines.join("\n")}` });
}

const GROUP_RULES = `📜 *GROUP RULES*\n\n1️⃣ সম্মান করুন।\n2️⃣ অশ্লীল নয়।\n3️⃣ Spam নয়।\n4️⃣ Forward সীমিত।\n5️⃣ লিংক নয়।\n\n🤍 *Piyas*`;

const WEBSITE_TEXT = `🌐 *WEBSITE*\n\n${WEBSITE_URL}\n\n🤍 *Piyas*`;

const PIYAS_INFO = `🤍 *PIYAS*\n\n👤 মোঃ আল আমিন\n🌐 MD. AL AMIN\n👨‍👦 মোঃ মোশারফ হোসেন\n👩‍👦 মোসাম্মৎ রীপা বেগম\n🎂 ০৯ জানুয়ারি ২০০৬\n🩸 A+\n🏠 বলদার চর, নান্দাইল, ময়মনসিংহ\n\n🤍 Thank You`;

const BOT_OFF_TEXT = `🔴 *BOT OFF*`;
const BOT_ON_TEXT = `🟢 *BOT ON* ✅`;
const BOT_ALREADY_OFF_TEXT = `🔴 ইতোমধ্যে OFF`;
const BOT_ALREADY_ON_TEXT = `🟢 ইতোমধ্যে ON`;

const DEAL_NOTICE_TOP = `🤝 *DEAL NOTICE*\n\n⚠️ Admin ছাড়া Deal করবেন না।\n\n👑 *Admins:*\n`;

async function getAdminData(g) {
  try {
    const md = await sock.groupMetadata(g);
    const parts = md?.participants || [];
    await cacheParticipants(parts);
    const ap = parts.filter(isAdminParticipant);
    const admins = [];
    const used = new Set();
    for (const p of ap) {
      const pj = await getPhoneJid(p);
      let n = getDisplayName(p);
      if (!n || n === "Member") n = "Admin";
      if (pj && used.has(pj)) continue;
      if (pj) used.add(pj);
      admins.push({ jid: pj || p.id || p.lid, name: n, owner: isOwnerParticipant(p) });
    }
    return { admins };
  } catch { return { admins: [] }; }
}

async function sendAdminList(remoteJid) {
  const { admins } = await getAdminData(remoteJid);
  if (!admins.length) {
    await sock.sendMessage(remoteJid, { text: "👑 কোনো Admin নেই।" });
    return;
  }
  const lines = [], mentions = [];
  let n = 1;
  for (const a of admins) {
    const role = a.owner ? "⭐ Owner" : "👑 Admin";
    if (isPhoneJid(a.jid)) {
      const ph = a.jid.split("@")[0];
      mentions.push(a.jid);
      lines.push(`${n}. @${ph} ${role}`);
    } else {
      lines.push(`${n}. ${a.name} ${role}`);
    }
    n++;
  }
  await sock.sendMessage(remoteJid, {
    text: `👑 *ADMINS*\n\n${lines.join("\n")}\n\nমোট: ${admins.length}`,
    mentions
  });
}

async function sendDealNotice(remoteJid) {
  const { admins } = await getAdminData(remoteJid);
  if (!admins.length) {
    await sock.sendMessage(remoteJid, { text: DEAL_NOTICE_TOP + "কোনো Admin নেই।" });
    return;
  }
  const lines = [], mentions = [];
  let n = 1;
  for (const a of admins) {
    const role = a.owner ? "⭐ Owner" : "👑 Admin";
    if (isPhoneJid(a.jid)) {
      const ph = a.jid.split("@")[0];
      mentions.push(a.jid);
      lines.push(`${n}. @${ph} ${role}`);
    } else {
      lines.push(`${n}. ${a.name} ${role}`);
    }
    n++;
  }
  await sock.sendMessage(remoteJid, {
    text: DEAL_NOTICE_TOP + lines.join("\n") + `\n\n🤍 *PIYAS*`,
    mentions
  });
}

function getWelcomeText(name, groupName) {
  const n = cleanName(name) || "Member";
  const g = cleanName(groupName) || "এই গ্রুপ";
  return `🎉 *স্বাগতম @${n}* ❤️\n\n🌸 *${g}*-এ স্বাগতম।\n\n📌 /rules\n🌐 ${WEBSITE_URL}\n\n🔰 ${BACKUP_GROUP_URL}\n\n❤️ *Piyas*`;
}

async function sendWelcome(groupId, participant) {
  try {
    if (!sock || !isBotEnabled(groupId)) return;
    let md = null;
    try { md = await sock.groupMetadata(groupId); } catch {}
    let m = findParticipant(md?.participants || [], participant?.id);
    if (!m) m = findParticipant(md?.participants || [], participant?.lid);
    if (!m) m = participant;
    const n = getDisplayName(m);
    const gn = cleanName(md?.subject) || "এই গ্রুপ";
    const pj = await getPhoneJid(m);
    const t = getWelcomeText(n, gn);
    if (isPhoneJid(pj)) {
      await sock.sendMessage(groupId, { text: t, mentions: [pj] });
    } else {
      await sock.sendMessage(groupId, { text: t.replace(`@${n}`, n) });
    }
  } catch {}
}

async function sendGoodbye(groupId, participant) {
  try {
    if (!sock || !isBotEnabled(groupId)) return;
    let md = null;
    try { md = await sock.groupMetadata(groupId); } catch {}
    let m = findParticipant(md?.participants || [], participant?.id);
    if (!m) m = participant;
    const n = getDisplayName(m);
    await sock.sendMessage(groupId, { text: `👋 *${n}* গ্রুপ ছেড়ে গেলেন।\n\n🤍 *Piyas*` });
  } catch {}
}

const BANGLA_DIGITS = { "০":"0","১":"1","২":"2","৩":"3","৪":"4","৫":"5","৬":"6","৭":"7","৮":"8","৯":"9" };

function convertBanglaDigits(v) {
  return String(v).replace(/[০-৯]/g, d => BANGLA_DIGITS[d]);
}

function parseGroupDuration(text) {
  if (!text) return null;
  const input = convertBanglaDigits(String(text).trim().toLowerCase()).replace(/\s+/g, " ");
  let total = 0, found = false;
  const patterns = [
    { regex: /(\d+(?:\.\d+)?)\s*(বছর|year|years|y)(?=\s|$)/giu, ms: 365*24*60*60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(মাস|month|months|mo)(?=\s|$)/giu, ms: 30*24*60*60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(সপ্তাহ|week|weeks|w)(?=\s|$)/giu, ms: 7*24*60*60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(দিন|day|days|d)(?=\s|$)/giu, ms: 24*60*60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(ঘণ্টা|ঘন্টা|hour|hours|hr|h)(?=\s|$)/giu, ms: 60*60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(মিনিট|minute|minutes|min|m)(?=\s|$)/giu, ms: 60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(সেকেন্ড|second|seconds|sec|s)(?=\s|$)/giu, ms: 1000 }
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.regex.exec(input)) !== null) {
      const num = Number(m[1]);
      if (num > 0) { total += num * p.ms; found = true; }
    }
  }
  if (!found) {
    const num = Number(input);
    if (num > 0) return num * 60 * 1000;
  }
  return total > 0 ? total : null;
}

function formatGroupDuration(ms) {
  let s = Math.floor(ms / 1000);
  const y = Math.floor(s / (365*24*60*60)); s %= 365*24*60*60;
  const mo = Math.floor(s / (30*24*60*60)); s %= 30*24*60*60;
  const d = Math.floor(s / (24*60*60)); s %= 24*60*60;
  const h = Math.floor(s / (60*60)); s %= 60*60;
  const mi = Math.floor(s / 60); s %= 60;
  const p = [];
  if (y) p.push(`${y} বছর`);
  if (mo) p.push(`${mo} মাস`);
  if (d) p.push(`${d} দিন`);
  if (h) p.push(`${h} ঘণ্টা`);
  if (mi) p.push(`${mi} মিনিট`);
  if (s) p.push(`${s} সেকেন্ড`);
  return p.join(" ") || "0 সেকেন্ড";
}

async function lockGroup(g, dur) {
  try {
    if (!sock || !g?.endsWith("@g.us")) return false;
    if (!await isBotAdminInGroup(g)) {
      await sock.sendMessage(g, { text: "❌ Bot-কে Admin করুন।" });
      return false;
    }
    await sock.groupSettingUpdate(g, "announcement");
    getGroupStatus(g).groupLockedUntil = Date.now() + dur;
    saveBotStatus();
    await sock.sendMessage(g, { text: `🔒 Group Closed\n⏱️ ${formatGroupDuration(dur)}` });
    return true;
  } catch { return false; }
}

async function checkExpiredGroupLocks() {
  if (!sock) return;
  const now = Date.now();
  for (const [g, s] of Object.entries(botStatus)) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.groupLockedUntil !== "number") continue;
    if (s.groupLockedUntil <= now) {
      try {
        await sock.groupSettingUpdate(g, "not_announcement");
        s.groupLockedUntil = null;
        saveBotStatus();
        await sock.sendMessage(g, { text: `🔓 Group Open` });
      } catch {}
    }
  }
}

setInterval(checkExpiredGroupLocks, 10000);

setInterval(() => {
  const now = Date.now();
  for (const [k, d] of Object.entries(mutedUsers)) {
    if (!d || !d.until) continue;
    if (d.until <= now) { delete mutedUsers[k]; saveMuted(); }
  }
}, 10000);

function getCredentialPhoneNumber(creds) {
  const id = creds?.me?.id;
  if (!id || typeof id !== "string") return "";
  return id.split(":")[0].split("@")[0].replace(/[^0-9]/g, "");
}

async function resetAuthForNumberChange() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      await fs.promises.rm(AUTH_DIR, { recursive: true, force: true });
      console.log("🗑️ Old session removed.");
    }
  } catch {}
}

async function generatePairingCode(state) {
  try {
    if (!PHONE_NUMBER || state.creds.registered || pairingRequested) return;
    pairingRequested = true;
    await new Promise(r => setTimeout(r, 2500));
    if (!sock || state.creds.registered) { pairingRequested = false; return; }
    const code = await sock.requestPairingCode(PHONE_NUMBER);
    fs.writeFileSync("./pairing_number.txt", PHONE_NUMBER, "utf8");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`🔐 PAIRING CODE: ${code}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━");
  } catch (e) {
    pairingRequested = false;
    console.log("❌ Pairing error:", e?.message);
  }
}

function getMessageText(message) {
  const m = message?.message;
  if (!m) return "";
  return (m.conversation || m.extendedTextMessage?.text ||
    m.imageMessage?.caption || m.videoMessage?.caption ||
    m.documentMessage?.caption || "").trim();
}

function getMentionedJids(message) {
  const m = message?.message;
  if (!m) return [];
  return (m.extendedTextMessage?.contextInfo?.mentionedJid ||
    m.imageMessage?.contextInfo?.mentionedJid ||
    m.videoMessage?.contextInfo?.mentionedJid || []);
}

async function handleTagAll(remoteJid, message, args) {
  try {
    const md = await sock.groupMetadata(remoteJid);
    const parts = md?.participants || [];
    if (!parts.length) return;
    await cacheParticipants(parts);
    const mentions = [];
    for (const p of parts) {
      const pj = await getPhoneJid(p);
      mentions.push(pj || p.id);
    }
    const custom = args.join(" ").trim();
    const text = custom ? `📢 ${custom}\n\n━━━━━━━\n` : `📢 সবাই!\n\n━━━━━━━\n`;
    await sock.sendMessage(remoteJid, { text, mentions });
  } catch {}
}

async function handleMute(remoteJid, message, args) {
  try {
    const mj = getMentionedJids(message);
    if (!mj.length) {
      await sock.sendMessage(remoteJid, { text: `🔇 /mute @user 10m` });
      return;
    }
    const dt = args.filter(a => !a.startsWith("@")).join(" ").trim();
    const dur = parseGroupDuration(dt);
    if (!dur) {
      await sock.sendMessage(remoteJid, { text: "❌ সময় সঠিক নয়।" });
      return;
    }
    for (const j of mj) {
      const pj = await getPhoneJid({ id: j }) || j;
      setMute(remoteJid, pj, dur);
    }
    await sock.sendMessage(remoteJid, {
      text: `🔇 Muted.\n⏱️ ${formatGroupDuration(dur)}`,
      mentions: mj
    });
  } catch {}
}

async function handleUnmute(remoteJid, message) {
  try {
    const mj = getMentionedJids(message);
    if (!mj.length) return;
    for (const j of mj) {
      const pj = await getPhoneJid({ id: j }) || j;
      removeMute(remoteJid, pj);
    }
    await sock.sendMessage(remoteJid, { text: `🔊 Unmuted.`, mentions: mj });
  } catch {}
}

async function handleMuteList(remoteJid) {
  try {
    const list = [];
    for (const [k, d] of Object.entries(mutedUsers)) {
      const [g, m] = k.split(":");
      if (g !== remoteJid) continue;
      const r = d.until - Date.now();
      if (r > 0) list.push({ m, r });
    }
    if (!list.length) {
      await sock.sendMessage(remoteJid, { text: `🔊 Mute list খালি।` });
      return;
    }
    const lines = [], mentions = [];
    let n = 1;
    for (const i of list) {
      lines.push(`${n}. @${i.m.split("@")[0]} ⏱️ ${formatGroupDuration(i.r)}`);
      mentions.push(i.m);
      n++;
    }
    await sock.sendMessage(remoteJid, {
      text: `🔇 *MUTE LIST*\n\n${lines.join("\n")}`,
      mentions
    });
  } catch {}
}

async function startBot() {
  try {
    let authState = await useMultiFileAuthState(AUTH_DIR);
    let { state, saveCreds } = authState;

    const currPhone = getCredentialPhoneNumber(state.creds);
    const changed = PHONE_NUMBER && state.creds.registered &&
      currPhone && currPhone !== PHONE_NUMBER;

    if (changed) {
      await resetAuthForNumberChange();
      pairingRequested = false;
      authState = await useMultiFileAuthState(AUTH_DIR);
      state = authState.state;
      saveCreds = authState.saveCreds;
    }

    sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("contacts.upsert", c => { try { saveContacts(c); } catch {} });
    sock.ev.on("contacts.update", c => { try { saveContacts(c); } catch {} });

    sock.ev.on("group-participants.update", async event => {
      try {
        const g = event?.id;
        const a = event?.action;
        const p = event?.participants || [];
        if (!g) return;
        if (!await isBotAdminInGroup(g)) return;
        if (a === "add") for (const x of p) await sendWelcome(g, x);
        if (a === "remove") for (const x of p) await sendGoodbye(g, x);
      } catch {}
    });

    sock.ev.on("connection.update", async upd => {
      try {
        const { connection, lastDisconnect } = upd;
        if (connection === "connecting") {
          console.log("🔄 Connecting...");
          if (PHONE_NUMBER && !state.creds.registered) {
            await generatePairingCode(state);
          }
        }
        if (connection === "open") {
          console.log("━━━━━━━━━━━━━━━━━━━━━━");
          console.log(`✅ ${AI_NAME} Bot Connected!`);
          console.log("━━━━━━━━━━━━━━━━━━━━━━");
          reconnecting = false;
          pairingRequested = false;
          return;
        }
        if (connection === "close") {
          const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
          const reconn = code !== DisconnectReason.loggedOut;
          console.log(`❌ Closed. Code: ${code}`);
          sock = null;
          pairingRequested = false;
          if (reconn && !reconnecting) {
            reconnecting = true;
            setTimeout(() => { reconnecting = false; startBot(); }, 3000);
          }
        }
      } catch {}
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        if (!Array.isArray(messages)) return;

        for (const message of messages) {
          try {
            if (!message || message.key?.fromMe) continue;
            const remoteJid = message.key?.remoteJid;
            if (!remoteJid || !remoteJid.endsWith("@g.us")) continue;

            const text = getMessageText(message);
            if (!text) continue;

            const mod = await moderateMessage(remoteJid, message, text);
            if (mod) continue;

            const trimmed = text.trim();

            const botJid = getBotPhoneJid();
            const botLid = sock?.user?.id;
            const mentioned = getMentionedJids(message);

            const botMentioned = mentioned.some(j =>
              (botJid && j === botJid) ||
              (botLid && j === botLid) ||
              (botJid && j.includes(botJid.split("@")[0]))
            );

            const isAI = /^\/ai(\s|$)/i.test(trimmed);
            const isAIMen = /^@ai(\s|$)/i.test(trimmed);
            const isStory = /^\/(story|গল্প)(\s|$)/i.test(trimmed);
            const isSong = /^\/(song|গান)(\s|$)/i.test(trimmed);
            const isPost = /^\/(post|পোস্ট)(\s|$)/i.test(trimmed);
            const isPoem = /^\/(poem|কবিতা)(\s|$)/i.test(trimmed);
            const isJoke = /^\/joke(\s|$)/i.test(trimmed);
            const isHelp = /^\/aihelp(\s|$)/i.test(trimmed);
            const isClear = /^\/clear(\s|$)/i.test(trimmed);

            if (isHelp && isBotEnabled(remoteJid)) {
              await sendAIHelp(remoteJid);
              continue;
            }

            if (isClear && isBotEnabled(remoteJid)) {
              const s = message.key.participant;
              const pj = await getPhoneJid({ id: s });
              if (pj) clearConversation(remoteJid, pj);
              await sock.sendMessage(remoteJid, {
                text: `🧹 *Memory Cleared*\n\n${AI_NAME} আগের কথা ভুলে গেছেন।`,
                quoted: message
              });
              continue;
            }

            const wants = botMentioned || isAI || isAIMen ||
              isStory || isSong || isPost || isPoem || isJoke;

            if (wants && isBotEnabled(remoteJid) && isAIEnabled(remoteJid)) {
              if (!genAI) {
                await sock.sendMessage(remoteJid, {
                  text: "❌ AI Key নেই।",
                  quoted: message
                });
                continue;
              }

              const s = message.key.participant;
              const pj = await getPhoneJid({ id: s });
              const name = contactNames.get(pj) || "User";

              if (pj && isAIRateLimited(pj)) {
                await sock.sendMessage(remoteJid, {
                  text: `⏳ *একটু অপেক্ষা করুন...*\n\n৩০ সেকেন্ড পর আবার।`,
                  quoted: message
                });
                continue;
              }

              const mode = detectAIMode(trimmed);
              let q = stripAIPrefix(trimmed);

              if (botJid) {
                const bn = botJid.split("@")[0];
                q = q.replace(new RegExp(`@${bn}`, "gi"), "").trim();
              }
              if (botLid) {
                const ln = String(botLid).split("@")[0].split(":")[0];
                q = q.replace(new RegExp(`@${ln}`, "gi"), "").trim();
              }
              if (pj) {
                const pn = pj.split("@")[0];
                q = q.replace(new RegExp(`@${pn}`, "gi"), "").trim();
              }
              q = q.replace(/\s+/g, " ").trim();

              if (!q && mode === "chat") {
                await sock.sendMessage(remoteJid, {
                  text: `❓ কী জানতে চান?\n\n/ai বাংলাদেশের রাজধানী?\n/story ছোট মেয়ে\n/song ভালোবাসা`,
                  quoted: message
                });
                continue;
              }

              if (mode !== "chat" || q.length > 30) {
                const emoji = { story:"📝", song:"🎵", post:"📢", poem:"✍️", joke:"😄", chat:"🤔" }[mode];
                await sock.sendMessage(remoteJid, {
                  text: `${emoji} *${AI_NAME} ভাবছেন...*`,
                  quoted: message
                });
              }

              const reply = await getAIReply(remoteJid, pj || s, q, name, mode);

              if (reply) {
                const header = {
                  story: `📝 *${AI_NAME} — গল্প*`,
                  song: `🎵 *${AI_NAME} — গান*`,
                  post: `📢 *${AI_NAME} — পোস্ট*`,
                  poem: `✍️ *${AI_NAME} — কবিতা*`,
                  joke: `😄 *${AI_NAME} — কৌতুক*`,
                  chat: `🤖 *${AI_NAME}*`
                }[mode];

                await sock.sendMessage(remoteJid, {
                  text: `${header}\n\n${reply}\n\n━━━━━━━━━━━━━━━\n🤖 By *${AI_CREATOR}*`,
                  quoted: message
                });
              } else {
                await sock.sendMessage(remoteJid, {
                  text: `❌ উত্তর দিতে পারছি না।`,
                  quoted: message
                });
              }
              continue;
            }

            if (isCalculatorMessage(trimmed)) {
              await handleCalculator(remoteJid, trimmed);
              continue;
            }

            if (!trimmed.startsWith("/")) continue;

            const parts = trimmed.split(/\s+/);
            const rawCmd = parts.shift() || "";
            const command = normalizeCommandName(rawCmd);
            const args = parts;
            if (!command) continue;

            if (ADMIN_ONLY_COMMANDS.includes(command)) {
              const a = await isSenderAdmin(remoteJid, message);
              if (!a) {
                if (["mute","unmute","mutelist","aion","aioff"].includes(command)) {
                  await sock.sendMessage(remoteJid, { text: `❌ *ADMIN ONLY* 🔒` });
                }
                continue;
              }
            }

            if (command === "গ্রুপ") {
              const sub = normalizeCommandName(args[0]);
              if (sub !== "বন্ধ") {
                await sock.sendMessage(remoteJid, { text: `🔒 /গ্রুপ বন্ধ 2 মিনিট` });
                continue;
              }
              const d = parseGroupDuration(args.slice(1).join(" ").trim());
              if (!d) {
                await sock.sendMessage(remoteJid, { text: "❌ সময় সঠিক নয়।" });
                continue;
              }
              await lockGroup(remoteJid, d);
              continue;
            }

            if (command === "aion") {
              setAIStatus(remoteJid, true);
              await sock.sendMessage(remoteJid, { text: `🤖 *${AI_NAME} ON* ✅` });
              continue;
            }
            if (command === "aioff") {
              setAIStatus(remoteJid, false);
              await sock.sendMessage(remoteJid, { text: `🤖 *${AI_NAME} OFF*` });
              continue;
            }
            if (command === "botoff") {
              if (!isBotEnabled(remoteJid)) {
                await sock.sendMessage(remoteJid, { text: BOT_ALREADY_OFF_TEXT });
                continue;
              }
              setBotStatus(remoteJid, false);
              await sock.sendMessage(remoteJid, { text: BOT_OFF_TEXT });
              continue;
            }
            if (command === "boton") {
              if (isBotEnabled(remoteJid)) {
                await sock.sendMessage(remoteJid, { text: BOT_ALREADY_ON_TEXT });
                continue;
              }
              setBotStatus(remoteJid, true);
              await sock.sendMessage(remoteJid, { text: BOT_ON_TEXT });
              continue;
            }
            if (command === "adminpanel") {
              await sendAdminPanel(remoteJid);
              continue;
            }
            if (["mod","moderation","modstatus"].includes(command)) {
              const m = getModerationStatus(remoteJid);
              await sock.sendMessage(remoteJid, {
                text: `🛠️ *MOD*\n${m.badWords?"🟢":"🔴"} Bad Word\n${m.links?"🟢":"🔴"} Link\n${m.spam?"🟢":"🔴"} Spam\n${m.antiForward?"🟢":"🔴"} Forward`
              });
              continue;
            }
            if (command === "modon") {
              for (const k of Object.keys(MODERATION_DEFAULTS)) setModerationStatus(remoteJid, k, true);
              await sock.sendMessage(remoteJid, { text: "🛡️ MOD ON" });
              continue;
            }
            if (command === "modoff") {
              for (const k of Object.keys(MODERATION_DEFAULTS)) setModerationStatus(remoteJid, k, false);
              await sock.sendMessage(remoteJid, { text: "🛡️ MOD OFF" });
              continue;
            }
            if (command === "on" || command === "off") {
              const t = getCanonicalCommand(args[0] || "");
              if (!t) { await sock.sendMessage(remoteJid, { text: `⚙️ /${command} <cmd>` }); continue; }
              if (PROTECTED_COMMANDS.includes(t)) {
                await sock.sendMessage(remoteJid, { text: "⚠️ Protected." });
                continue;
              }
              if (!isKnownCommand(t)) {
                await sock.sendMessage(remoteJid, { text: `❌ /${t} নেই।` });
                continue;
              }
              const e = command === "on";
              setCommandStatus(remoteJid, t, e);
              await sock.sendMessage(remoteJid, { text: `${e?"🟢":"🔴"} /${t} ${e?"ON":"OFF"}` });
              continue;
            }
            if (command === "cmdlist") { await sendCommandList(remoteJid); continue; }
            if (command === "mute") { await handleMute(remoteJid, message, args); continue; }
            if (command === "unmute") { await handleUnmute(remoteJid, message); continue; }
            if (command === "mutelist") { await handleMuteList(remoteJid); continue; }

            if (!isBotEnabled(remoteJid)) continue;
            const ca = getCanonicalCommand(command);
            if (!isKnownCommand(ca)) continue;
            if (!isCommandEnabled(remoteJid, ca)) continue;

            if (ca === "menu" || ca === "bot") { await sendPublicMenu(remoteJid); continue; }
            if (ca === "rules") { await sock.sendMessage(remoteJid, { text: GROUP_RULES }); continue; }
            if (ca === "website") { await sock.sendMessage(remoteJid, { text: WEBSITE_TEXT }); continue; }
            if (ca === "deal") { await sendDealNotice(remoteJid); continue; }
            if (ca === "admin") { await sendAdminList(remoteJid); continue; }
            if (ca === "tagall") { await handleTagAll(remoteJid, message, args); continue; }
            if (ca === "members") {
              const md = await sock.groupMetadata(remoteJid);
              await sock.sendMessage(remoteJid, { text: `👥 মোট: ${md?.participants?.length || 0}` });
              continue;
            }
            if (ca === "groupinfo") {
              const md = await sock.groupMetadata(remoteJid);
              const p = md?.participants || [];
              const a = p.filter(isAdminParticipant);
              await sock.sendMessage(remoteJid, {
                text: `👥 *GROUP INFO*\n\n📛 ${md?.subject}\n🆔 ${remoteJid}\n👥 ${p.length}\n👑 ${a.length}`
              });
              continue;
            }
            if (ca === "id") {
              await sock.sendMessage(remoteJid, { text: `🆔 ${remoteJid}` });
              continue;
            }
            if (ca === "ping") {
              const s = Date.now();
              const m = await sock.sendMessage(remoteJid, { text: "🏓" });
              const p = Date.now() - s;
              await sock.sendMessage(remoteJid, {
                text: `🏓 PONG ${p}ms`,
                quoted: m
              });
              continue;
            }
            if (ca === "piyas") {
              await sock.sendMessage(remoteJid, { text: PIYAS_INFO });
              continue;
            }
          } catch (e) {
            console.log("⚠️ Msg error:", e?.message);
          }
        }
      } catch (e) {
        console.log("⚠️ Handler error:", e?.message);
      }
    });

    console.log("🚀 Starting...");
  } catch (e) {
    console.log("❌ Start failed:", e?.message);
    sock = null;
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(() => { reconnecting = false; startBot(); }, 5000);
    }
  }
}

process.on("uncaughtException", e => console.log("❌ Uncaught:", e?.message));
process.on("unhandledRejection", e => console.log("❌ Unhandled:", e?.message));

async function shutdown() {
  console.log("\n🛑 Shutting down...");
  saveAIMemory();
  saveBotStatus();
  saveMuted();
  saveWarnings();
  saveAIStatus();
  try { if (sock) sock.end(new Error("shutdown")); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

loadBotStatus();
loadWarnings();
loadMuted();
loadAIStatus();
loadAIMemory();

startBot();