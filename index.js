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

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);
const PHONE_NUMBER = (process.env.PHONE_NUMBER || "").replace(/[^0-9]/g, "");
const WEBSITE_URL = "https://x-cyber-2025.github.io/X-cyber.web/";
const BACKUP_GROUP_URL =
  "https://chat.whatsapp.com/KsIJqeOdSTVC2FBIuWCvlN?s=cl&p=a&mlu=4&ilr=4";

const AUTH_DIR = "./auth_info";
const PAIRING_NUMBER_FILE = "./pairing_number.txt";
const BOT_STATUS_FILE = "./bot_status.json";
const WARNING_FILE = "./warnings.json";
const MUTE_FILE = "./muted.json";
const AI_STATUS_FILE = "./ai_status.json";
const AI_MEMORY_FILE = "./ai_memory.json";

const AI_NAME = process.env.AI_NAME || "আর-রাইয়ান";
const AI_CREATOR = "Piyas";
const AI_NAME_EN = "Ar-Rayyan";

const GROUP_LOCK_CHECK_INTERVAL = 10 * 1000;

let sock = null;
let reconnecting = false;
let pairingRequested = false;

const contactNames = new Map();
const contactPhoneJids = new Map();
const lidToPhoneJid = new Map();

/* =========================================================
   GEMINI AI SETUP
========================================================= */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "gemini-1.5-flash";

const AI_MODELS_FALLBACK = [
  AI_MODEL,
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-pro"
];

let genAI = null;
let currentModelIndex = 0;

if (GEMINI_API_KEY) {
  try {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    console.log(`🤖 ${AI_NAME} AI ready.`);
  } catch (error) {
    console.log("⚠️ Gemini init error:", error?.message);
  }
} else {
  console.log("⚠️ GEMINI_API_KEY missing in .env");
}

/* =========================================================
   AI SYSTEM PROMPT
========================================================= */

const AI_SYSTEM_PROMPT = `তুমি "${AI_NAME}" — একটি বুদ্ধিমান, বিনয়ী এবং সৃজনশীল AI assistant।

তোমার পরিচয়:
- নাম: ${AI_NAME} (${AI_NAME_EN})
- নির্মাতা: ${AI_CREATOR}
- তুমি "Piyas Bot" এর একটি অংশ যা WhatsApp গ্রুপে কাজ করে
- তুমি বাংলাদেশী, বাংলায় কথা বলো

তোমার দক্ষতা:
1. সাধারণ প্রশ্নের উত্তর
2. 📝 গল্প লেখা
3. 🎵 গান লেখা
4. 📢 সোশ্যাল মিডিয়া পোস্ট
5. ✍️ কবিতা লেখা
6. 😄 কৌতুক বলা
7. 📚 পড়াশোনায় সাহায্য
8. 💡 আইডিয়া ও পরামর্শ
9. 🌐 অনুবাদ
10. 💻 প্রোগ্রামিং সাহায্য

নিয়ম:
- বিনয়ী, বন্ধুত্বপূর্ণ ও সাহায্যকারী হও
- বাংলায় উত্তর দাও (ইংরেজিতে লিখলে ইংরেজিতে)
- সংক্ষিপ্ত কিন্তু সম্পূর্ণ উত্তর (২-৮ লাইন, কনটেন্ট হলে বেশি)
- অশ্লীল, রাজনৈতিক বা ধর্মীয় বিতর্ক এড়িয়ে চলো
- কখনো বলো না তুমি Google/Gemini — তুমি "${AI_NAME}"
- নিজেকে "${AI_CREATOR}" এর তৈরি বলো
- মার্কডাউন *bold* সাপোর্ট করে
- ইমোজি মাত্রাতিরিক্ত নয়`;

/* =========================================================
   AI MEMORY
========================================================= */

const aiMemory = new Map();
const AI_MEMORY_LIMIT = 10;
const AI_MEMORY_MAX_GROUPS = 500;
let aiMemoryData = {};

function loadAIMemory() {
  try {
    if (!fs.existsSync(AI_MEMORY_FILE)) return;
    aiMemoryData = JSON.parse(fs.readFileSync(AI_MEMORY_FILE, "utf8")) || {};
    for (const [key, value] of Object.entries(aiMemoryData)) {
      if (Array.isArray(value)) aiMemory.set(key, value);
    }
    console.log("📂 AI memory loaded.");
  } catch (error) {
    aiMemoryData = {};
  }
}

function saveAIMemory() {
  try {
    const obj = {};
    let count = 0;
    for (const [key, value] of aiMemory.entries()) {
      if (count++ > AI_MEMORY_MAX_GROUPS) break;
      obj[key] = value;
    }
    aiMemoryData = obj;
    fs.writeFileSync(AI_MEMORY_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (error) {}
}

setInterval(saveAIMemory, 60 * 1000);

function getMemoryKey(groupId, memberJid) {
  return `${groupId}:${memberJid}`;
}

function getConversation(groupId, memberJid) {
  const key = getMemoryKey(groupId, memberJid);
  if (!aiMemory.has(key)) aiMemory.set(key, []);
  return aiMemory.get(key);
}

function addToConversation(groupId, memberJid, role, content) {
  const conv = getConversation(groupId, memberJid);
  conv.push({ role, content, time: Date.now() });
  while (conv.length > AI_MEMORY_LIMIT * 2) conv.shift();
}

function clearConversation(groupId, memberJid) {
  const key = getMemoryKey(groupId, memberJid);
  aiMemory.delete(key);
  delete aiMemoryData[key];
  saveAIMemory();
}

/* =========================================================
   AI RATE LIMIT
========================================================= */

const aiRateLimit = new Map();
const AI_RATE_WINDOW = 30 * 1000;
const AI_RATE_MAX = 5;

function isAIRateLimited(memberJid) {
  if (!memberJid) return false;
  const now = Date.now();
  const data = aiRateLimit.get(memberJid);
  if (!data || now - data.start > AI_RATE_WINDOW) {
    aiRateLimit.set(memberJid, { start: now, count: 1 });
    return false;
  }
  data.count += 1;
  return data.count > AI_RATE_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, data] of aiRateLimit.entries()) {
    if (!data || now - data.start > AI_RATE_WINDOW * 5) aiRateLimit.delete(key);
  }
}, 5 * 60 * 1000);

/* =========================================================
   AI STATUS
========================================================= */

let aiStatus = {};

function loadAIStatus() {
  try {
    if (!fs.existsSync(AI_STATUS_FILE)) {
      aiStatus = {};
      return;
    }
    aiStatus = JSON.parse(fs.readFileSync(AI_STATUS_FILE, "utf8")) || {};
    console.log("📂 AI status loaded.");
  } catch (error) {
    aiStatus = {};
  }
}

function saveAIStatus() {
  try {
    fs.writeFileSync(AI_STATUS_FILE, JSON.stringify(aiStatus, null, 2), "utf8");
  } catch (error) {}
}

function isAIEnabled(groupId) {
  return aiStatus[groupId] !== false;
}

function setAIStatus(groupId, enabled) {
  aiStatus[groupId] = Boolean(enabled);
  saveAIStatus();
}

/* =========================================================
   AI CORE
========================================================= */

async function tryModelWithRetry(prompt, retries = 2) {
  if (!genAI) return null;
  const models = AI_MODELS_FALLBACK;
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (let i = 0; i < models.length; i++) {
      const idx = (currentModelIndex + i) % models.length;
      const modelName = models[idx];
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const text = result?.response?.text?.();
        if (text && text.trim()) {
          currentModelIndex = idx;
          return text.trim();
        }
      } catch (error) {
        const msg = String(error?.message || "");
        if (msg.includes("429") || msg.includes("quota") || msg.includes("rate")) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
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
    if (mode === "story") {
      modeInstruction = `\n\n📝 টাস্ক: একটি সুন্দর ও আকর্ষণীয় গল্প লিখো (২০০-৪০০ শব্দ)। শুরু, মধ্য, শেষ থাকবে। গল্পের নাম দেবে।`;
    } else if (mode === "song") {
      modeInstruction = `\n\n🎵 টাস্ক: একটি সুন্দর গান লিখো। অন্তরা, স্থায়ী, সঞ্চারী থাকবে। ছন্দ মিলিয়ে লিখো।`;
    } else if (mode === "post") {
      modeInstruction = `\n\n📢 টাস্ক: একটি আকর্ষণীয় সোশ্যাল মিডিয়া পোস্ট লিখো। হ্যাশট্যাগ ও ইমোজি সহ।`;
    } else if (mode === "poem") {
      modeInstruction = `\n\n✍️ টাস্ক: একটি সুন্দর কবিতা লিখো। ছন্দ ও অনুভূতি থাকবে।`;
    } else if (mode === "joke") {
      modeInstruction = `\n\n😄 টাস্ক: একটি মজার কৌতুক বলো।`;
    }

    const historyText = history.slice(-AI_MEMORY_LIMIT).map(item => {
      const who = item.role === "user" ? userName : AI_NAME;
      return `${who}: ${item.content}`;
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
  } catch (error) {
    console.log("⚠️ AI reply error:", error?.message);
    return null;
  }
}

function detectAIMode(text) {
  const t = String(text).toLowerCase();
  if (/^\/(story|গল্প)/.test(t) || /(গল্প|story)\s*(লিখ|বল|বানাও)/.test(t)) return "story";
  if (/^\/(song|গান)/.test(t) || /(গান|song)\s*(লিখ|বল|বানাও)/.test(t)) return "song";
  if (/^\/(post|পোস্ট)/.test(t) || /(পোস্ট|post)\s*(লিখ|বানাও)/.test(t)) return "post";
  if (/^\/(poem|কবিতা)/.test(t) || /(কবিতা|poem)\s*(লিখ|বল)/.test(t)) return "poem";
  if (/^\/(joke|কৌতুক)/.test(t)) return "joke";
  return "chat";
}

function stripAIPrefix(text) {
  return String(text)
    .replace(/^\/(story|song|post|poem|joke|গল্প|গান|পোস্ট|কবিতা|কৌতুক|ai)\s*/i, "")
    .replace(/^@ai\s*/i, "")
    .trim();
}

/* =========================================================
   SPAM / RATE / FORWARD MEMORY
========================================================= */

const spamTracker = new Map();
const SPAM_WINDOW_MS = 60 * 1000;

const rateLimitTracker = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_COMMANDS = 8;

const forwardTracker = new Map();
const FORWARD_WINDOW_MS = 10 * 60 * 1000;

let mutedUsers = {};
const logger = P({ level: "silent" });

const MODERATION_DEFAULTS = {
  badWords: true,
  links: true,
  spam: true,
  warnings: true,
  antiForward: true
};

/* =========================================================
   BAD WORDS
========================================================= */

const BAD_WORDS = [
  "সালা","শালা","সালি","সালী","খাংকি","খানকি","মাগি","বেশ্যা",
  "চোদা","চুদ","চুদা","চুদাচুদি","হারামি","হারামজাদা",
  "কুত্তা","শুয়োর","বাঞ্চোদ","বাল","ফাক","গাধা","পাগল",
  "বদমাশ","জারজ","নষ্ট","কুত্তি","মাদারচোদ","ভোদা","পোদ",
  "রান্ডি","লাওরা","ছিনাল","ডাইনি","হিজড়া","কমিনা","বেইমান",
  "চোর","ডাকাত","জোচ্চোর",
  "fuck","fucking","fucker","bitch","bastard","asshole","dick",
  "pussy","sex","sexy","porn","cunt","whore","slut","nigga","nigger",
  "retard","idiot","stupid","dumb","moron","shit","crap",
  "madarchod","bhenchod","chutiya","gandu","harami","kutta","suar",
  "randi","loda","bhosda","lund","kamina","badmash","haram"
];

/* =========================================================
   WARNING DATA
========================================================= */

let warnings = {};

function loadWarnings() {
  try {
    if (!fs.existsSync(WARNING_FILE)) {
      warnings = {};
      return;
    }
    warnings = JSON.parse(fs.readFileSync(WARNING_FILE, "utf8")) || {};
    console.log("📂 Warning data loaded.");
  } catch (error) {
    warnings = {};
  }
}

function saveWarnings() {
  try {
    fs.writeFileSync(WARNING_FILE, JSON.stringify(warnings, null, 2), "utf8");
  } catch (error) {}
}

function getGroupWarningData(groupId) {
  if (!warnings[groupId]) warnings[groupId] = {};
  return warnings[groupId];
}

function getMemberWarningCount(groupId, memberJid) {
  if (!groupId || !memberJid) return 0;
  const groupWarnings = getGroupWarningData(groupId);
  return Number(groupWarnings[memberJid] || 0);
}

function addWarning(groupId, memberJid) {
  if (!groupId || !memberJid) return 0;
  const groupWarnings = getGroupWarningData(groupId);
  groupWarnings[memberJid] = getMemberWarningCount(groupId, memberJid) + 1;
  saveWarnings();
  return groupWarnings[memberJid];
}

/* =========================================================
   MUTE DATA
========================================================= */

function loadMuted() {
  try {
    if (!fs.existsSync(MUTE_FILE)) {
      mutedUsers = {};
      return;
    }
    mutedUsers = JSON.parse(fs.readFileSync(MUTE_FILE, "utf8")) || {};
    console.log("📂 Mute data loaded.");
  } catch (error) {
    mutedUsers = {};
  }
}

function saveMuted() {
  try {
    fs.writeFileSync(MUTE_FILE, JSON.stringify(mutedUsers, null, 2), "utf8");
  } catch (error) {}
}

function getMuteKey(groupId, memberJid) {
  return `${groupId}:${memberJid}`;
}

function isMuted(groupId, memberJid) {
  if (!groupId || !memberJid) return false;
  const key = getMuteKey(groupId, memberJid);
  const data = mutedUsers[key];
  if (!data) return false;
  if (Date.now() >= data.until) {
    delete mutedUsers[key];
    saveMuted();
    return false;
  }
  return true;
}

function getMuteRemaining(groupId, memberJid) {
  if (!groupId || !memberJid) return 0;
  const key = getMuteKey(groupId, memberJid);
  const data = mutedUsers[key];
  if (!data) return 0;
  return Math.max(0, data.until - Date.now());
}

function setMute(groupId, memberJid, durationMs) {
  if (!groupId || !memberJid) return false;
  const key = getMuteKey(groupId, memberJid);
  mutedUsers[key] = {
    until: Date.now() + durationMs,
    mutedAt: Date.now()
  };
  saveMuted();
  return true;
}

function removeMute(groupId, memberJid) {
  if (!groupId || !memberJid) return false;
  const key = getMuteKey(groupId, memberJid);
  if (mutedUsers[key]) {
    delete mutedUsers[key];
    saveMuted();
    return true;
  }
  return false;
}

/* =========================================================
   BAD WORD / LINK / SPAM CHECKS
========================================================= */

function normalizeForBadWordCheck(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\s\-_.,!?()[\]{}:;'"`~|\\/*+@#$%^&]/g, "");
}

function containsBadWord(text) {
  if (!text) return null;
  const normalized = normalizeForBadWordCheck(text);
  for (const word of BAD_WORDS) {
    const normalizedWord = normalizeForBadWordCheck(word);
    if (normalizedWord && normalized.includes(normalizedWord)) {
      return word;
    }
  }
  return null;
}

function containsLink(text) {
  if (!text) return false;
  const value = String(text);
  const patterns = [
    /https?:\/\/\S+/i,
    /www\.\S+/i,
    /\b[a-z0-9-]+\.(com|net|org|xyz|bd|me|io|co|app|site|online|info|dev|ly|gg)\b/i,
    /\bt\.me\/\S+/i,
    /\bwa\.me\/\S+/i,
    /\bchat\.whatsapp\.com\/\S+/i
  ];
  return patterns.some(pattern => pattern.test(value));
}

function normalizeSpamText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDuplicateSpam(groupId, memberJid, text) {
  if (!groupId || !memberJid || !text) return false;
  const normalized = normalizeSpamText(text);
  if (!normalized) return false;
  const key = `${groupId}:${memberJid}`;
  const now = Date.now();
  const previous = spamTracker.get(key);
  if (previous && previous.text === normalized && now - previous.time < SPAM_WINDOW_MS) {
    spamTracker.set(key, { text: normalized, time: now });
    return true;
  }
  spamTracker.set(key, { text: normalized, time: now });
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, data] of spamTracker.entries()) {
    if (!data || now - data.time > SPAM_WINDOW_MS * 2) spamTracker.delete(key);
  }
}, 5 * 60 * 1000);

function isRateLimited(groupId, memberJid) {
  if (!groupId || !memberJid) return false;
  const key = `${groupId}:${memberJid}`;
  const now = Date.now();
  const data = rateLimitTracker.get(key);
  if (!data || now - data.start > RATE_LIMIT_WINDOW_MS) {
    rateLimitTracker.set(key, { start: now, count: 1 });
    return false;
  }
  data.count += 1;
  return data.count > RATE_LIMIT_MAX_COMMANDS;
}

function isForwardTooSoon(groupId, memberJid) {
  if (!groupId || !memberJid) return false;
  const key = `${groupId}:${memberJid}`;
  const now = Date.now();
  const last = forwardTracker.get(key);
  if (!last || now - last > FORWARD_WINDOW_MS) {
    forwardTracker.set(key, now);
    return false;
  }
  return true;
}

/* =========================================================
   BOT STATUS
========================================================= */

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
    if (!fs.existsSync(BOT_STATUS_FILE)) {
      botStatus = {};
      return;
    }
    botStatus = JSON.parse(fs.readFileSync(BOT_STATUS_FILE, "utf8")) || {};
    for (const [groupId, value] of Object.entries(botStatus)) {
      if (typeof value === "boolean") {
        botStatus[groupId] = createDefaultGroupStatus();
        botStatus[groupId].enabled = value;
      }
      if (!botStatus[groupId] || typeof botStatus[groupId] !== "object") {
        botStatus[groupId] = createDefaultGroupStatus();
      }
      if (!Array.isArray(botStatus[groupId].disabledCommands)) {
        botStatus[groupId].disabledCommands = [];
      }
      if (!botStatus[groupId].moderation || typeof botStatus[groupId].moderation !== "object") {
        botStatus[groupId].moderation = { ...MODERATION_DEFAULTS };
      }
      for (const [key, defaultValue] of Object.entries(MODERATION_DEFAULTS)) {
        if (typeof botStatus[groupId].moderation[key] !== "boolean") {
          botStatus[groupId].moderation[key] = defaultValue;
        }
      }
      if (!Object.prototype.hasOwnProperty.call(botStatus[groupId], "groupLockedUntil")) {
        botStatus[groupId].groupLockedUntil = null;
      }
    }
    console.log("📂 Bot status loaded.");
  } catch (error) {
    botStatus = {};
  }
}

function saveBotStatus() {
  try {
    fs.writeFileSync(BOT_STATUS_FILE, JSON.stringify(botStatus, null, 2), "utf8");
  } catch (error) {}
}

function getGroupStatus(groupId) {
  if (!botStatus[groupId]) {
    botStatus[groupId] = createDefaultGroupStatus();
  }
  if (!Array.isArray(botStatus[groupId].disabledCommands)) {
    botStatus[groupId].disabledCommands = [];
  }
  if (!botStatus[groupId].moderation || typeof botStatus[groupId].moderation !== "object") {
    botStatus[groupId].moderation = { ...MODERATION_DEFAULTS };
  }
  for (const [key, defaultValue] of Object.entries(MODERATION_DEFAULTS)) {
    if (typeof botStatus[groupId].moderation[key] !== "boolean") {
      botStatus[groupId].moderation[key] = defaultValue;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(botStatus[groupId], "groupLockedUntil")) {
    botStatus[groupId].groupLockedUntil = null;
  }
  return botStatus[groupId];
}

function isBotEnabled(groupId) {
  return getGroupStatus(groupId).enabled !== false;
}

function setBotStatus(groupId, enabled) {
  getGroupStatus(groupId).enabled = Boolean(enabled);
  saveBotStatus();
}

/* =========================================================
   COMMAND DEFINITIONS
========================================================= */

const COMMAND_DEFINITIONS = [
  { key: "menu", command: "/menu", title: "Main Menu" },
  { key: "bot", command: "/bot", title: "Bot Menu" },
  { key: "rules", command: "/rules", title: "Group Rules" },
  { key: "admin", command: "/admin", title: "Admin List" },
  { key: "members", command: "/members", title: "Group Members" },
  { key: "groupinfo", command: "/groupinfo", title: "Group Info" },
  { key: "id", command: "/id", title: "Group ID" },
  { key: "ping", command: "/ping", title: "Ping" },
  { key: "deal", command: "/deal", title: "Buy / Sell Deal" },
  { key: "piyas", command: "/piyas", title: "Piyas Info" },
  { key: "website", command: "/website", title: "Official Website" },
  { key: "tagall", command: "/tagall", title: "Tag All Members" },
  { key: "mute", command: "/mute", title: "Mute a member" },
  { key: "unmute", command: "/unmute", title: "Unmute a member" },
  { key: "mutelist", command: "/mutelist", title: "Muted members list" },
  { key: "ai", command: "/ai", title: "Ask AI" },
  { key: "story", command: "/story", title: "AI Story" },
  { key: "song", command: "/song", title: "AI Song" },
  { key: "post", command: "/post", title: "AI Post" },
  { key: "poem", command: "/poem", title: "AI Poem" },
  { key: "joke", command: "/joke", title: "AI Joke" },
  { key: "aihelp", command: "/aihelp", title: "AI Help" },
  { key: "clear", command: "/clear", title: "Clear AI Memory" },
  { key: "aion", command: "/aion", title: "Turn AI ON" },
  { key: "aioff", command: "/aioff", title: "Turn AI OFF" }
];

const COMMAND_ALIASES = { "ডিল": "deal" };

const ADMIN_ONLY_COMMANDS = [
  "adminpanel","cmdlist","on","off","boton","botoff",
  "mod","moderation","modstatus","modon","modoff","গ্রুপ",
  "tagall","mute","unmute","mutelist",
  "aion","aioff"
];

const PROTECTED_COMMANDS = [
  "adminpanel","cmdlist","on","off","boton","botoff",
  "mod","moderation","modstatus","modon","modoff","গ্রুপ",
  "mute","unmute","mutelist",
  "aion","aioff"
];

function normalizeCommandName(command) {
  if (!command) return "";
  return String(command).trim().toLowerCase().replace(/^\/+/, "");
}

function getCanonicalCommand(command) {
  const normalized = normalizeCommandName(command);
  if (!normalized) return "";
  return COMMAND_ALIASES[normalized] || normalized;
}

function getCommandDefinition(command) {
  const key = getCanonicalCommand(command);
  return COMMAND_DEFINITIONS.find(item => item.key === key) || null;
}

function isKnownCommand(command) {
  return Boolean(getCommandDefinition(command));
}

function isCommandEnabled(groupId, command) {
  const name = getCanonicalCommand(command);
  if (!name) return true;
  return !getGroupStatus(groupId).disabledCommands.includes(name);
}

function setCommandStatus(groupId, command, enabled) {
  const name = getCanonicalCommand(command);
  if (!name) return false;
  const status = getGroupStatus(groupId);
  const list = status.disabledCommands;
  const index = list.indexOf(name);
  if (enabled) {
    if (index !== -1) list.splice(index, 1);
  } else {
    if (index === -1) list.push(name);
  }
  saveBotStatus();
  return true;
}

/* =========================================================
   MODERATION
========================================================= */

function getModerationStatus(groupId) {
  return getGroupStatus(groupId).moderation;
}

function isModerationEnabled(groupId, type) {
  return Boolean(getModerationStatus(groupId)[type]);
}

function setModerationStatus(groupId, type, enabled) {
  const moderation = getModerationStatus(groupId);
  if (!Object.prototype.hasOwnProperty.call(moderation, type)) return false;
  moderation[type] = Boolean(enabled);
  saveBotStatus();
  return true;
}

/* =========================================================
   MESSAGE HELPERS
========================================================= */

async function deleteMessage(remoteJid, message) {
  try {
    if (!sock || !remoteJid || !message?.key) return false;
    await sock.sendMessage(remoteJid, { delete: message.key });
    return true;
  } catch (error) {
    return false;
  }
}

async function sendModerationWarning(remoteJid, message, reason, warningCount) {
  try {
    const participant = message?.key?.participant;
    const phoneJid = participant ? await getPhoneJid({ id: participant }) : null;
    const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
       ⚠️ *MODERATION*
╰━━━━━━━━━━━━━━━━━━━━╯

🚫 এই Message টি Group Rule
ভঙ্গ করার কারণে Delete করা হয়েছে।

📌 *কারণ:* ${reason}

⚠️ *Warning:* ${warningCount}

🤍 *Piyas Bot*
`;
    const messageData = { text };
    if (isPhoneJid(phoneJid)) messageData.mentions = [phoneJid];
    await sock.sendMessage(remoteJid, messageData);
  } catch (error) {}
}

async function sendMuteWarning(remoteJid, memberJid, remainingMs) {
  try {
    const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
     🔇 *মেসেজ অপশন বন্ধ*
╰━━━━━━━━━━━━━━━━━━━━╯

❌ *দুঃখিত!*

আপনার মেসেজ পাঠানোর
অপশন বন্ধ করা হয়েছে।

⏱️ *বাকি সময়:*
${formatGroupDuration(remainingMs)}

🤍 *Piyas Bot*
`;
    if (isPhoneJid(memberJid)) {
      await sock.sendMessage(memberJid, { text });
    } else {
      await sock.sendMessage(remoteJid, { text, mentions: [memberJid] });
    }
  } catch (error) {}
}

/* =========================================================
   MODERATION ENGINE
========================================================= */

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
        const remaining = getMuteRemaining(remoteJid, targetJid);
        await sendMuteWarning(remoteJid, targetJid, remaining);
      }
      return true;
    }

    if (sender) {
      const admin = await isSenderAdmin(remoteJid, message);
      if (admin) return false;
    }

    if (isModerationEnabled(remoteJid, "badWords")) {
      const badWord = containsBadWord(text);
      if (badWord) {
        const deleted = await deleteMessage(remoteJid, message);
        if (deleted) {
          let warningCount = 0;
          if (isModerationEnabled(remoteJid, "warnings") && targetJid) {
            warningCount = addWarning(remoteJid, targetJid);
          }
          await sendModerationWarning(remoteJid, message, `Bad Word: ${badWord}`, warningCount);
        }
        return true;
      }
    }

    if (isModerationEnabled(remoteJid, "links") && containsLink(text)) {
      const deleted = await deleteMessage(remoteJid, message);
      if (deleted) {
        let warningCount = 0;
        if (isModerationEnabled(remoteJid, "warnings") && targetJid) {
          warningCount = addWarning(remoteJid, targetJid);
        }
        await sendModerationWarning(remoteJid, message, "Link / URL", warningCount);
      }
      return true;
    }

    if (isModerationEnabled(remoteJid, "antiForward") && targetJid) {
      const isForward = message?.message?.extendedTextMessage?.contextInfo?.isForwarded ||
                       message?.message?.imageMessage?.contextInfo?.isForwarded ||
                       message?.message?.videoMessage?.contextInfo?.isForwarded;
      if (isForward) {
        if (isForwardTooSoon(remoteJid, targetJid)) {
          const deleted = await deleteMessage(remoteJid, message);
          if (deleted) {
            await sock.sendMessage(remoteJid, {
              text: `⚠️ @${targetJid.split("@")[0]} আপনার Forward ডিলিট করা হয়েছে।\n\n📌 কারণ: ১০ মিনিটের মধ্যে আবার Forward করেছেন।`,
              mentions: [targetJid]
            });
          }
          return true;
        }
      }
    }

    if (isModerationEnabled(remoteJid, "spam") && targetJid) {
      if (isDuplicateSpam(remoteJid, targetJid, text)) {
        const deleted = await deleteMessage(remoteJid, message);
        if (deleted) {
          let warningCount = 0;
          if (isModerationEnabled(remoteJid, "warnings")) {
            warningCount = addWarning(remoteJid, targetJid);
          }
          await sendModerationWarning(remoteJid, message,
            "Duplicate Spam", warningCount);
        }
        return true;
      }
    }

    return false;
  } catch (error) {
    return false;
  }
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status: "online",
      bot: "WhatsApp Group Bot",
      ai: AI_NAME,
      connected: !!sock,
      model: AI_MODEL,
      uptime: Math.floor(process.uptime()),
      groups: Object.keys(botStatus).length,
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + " MB"
    }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`🤖 ${AI_NAME} Bot is running!`);
});

server.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

/* =========================================================
   JID HELPERS
========================================================= */

function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return null;
  return jid.trim();
}

function isPhoneJid(jid) {
  return typeof jid === "string" && jid.endsWith("@s.whatsapp.net");
}

function isLidJid(jid) {
  return typeof jid === "string" && jid.endsWith("@lid");
}

function phoneNumberToJid(phone) {
  if (!phone) return null;
  const number = String(phone).replace(/@s.whatsapp.net/g, "").replace(/[^0-9]/g, "");
  if (number.length < 8) return null;
  return number + "@s.whatsapp.net";
}

function cleanName(name) {
  if (!name) return null;
  const value = String(name).replace(/\s+/g, " ").trim();
  if (!value) return null;
  return value.slice(0, 80);
}

function getDisplayName(participant = {}) {
  const ids = [participant.id, participant.lid, participant.phoneNumber].filter(Boolean);
  for (const id of ids) {
    const cached = contactNames.get(id);
    if (cached) return cached;
  }
  const directName = cleanName(
    participant.username || participant.notify || participant.name ||
    participant.verifiedName || participant.pushName
  );
  if (directName) return directName;
  if (participant.phoneNumber) {
    const phone = String(participant.phoneNumber).replace(/@s.whatsapp.net/g, "").replace(/[^0-9]/g, "");
    if (phone) return phone;
  }
  if (participant.id) {
    const idPart = String(participant.id).split("@")[0];
    if (idPart) return idPart;
  }
  return "Member";
}

function saveLidMapping(lid, pn) {
  const lidJid = normalizeJid(lid);
  let phoneJid = normalizeJid(pn);
  if (!isLidJid(lidJid)) return;
  if (!isPhoneJid(phoneJid)) phoneJid = phoneNumberToJid(phoneJid);
  if (!isPhoneJid(phoneJid)) return;
  lidToPhoneJid.set(lidJid, phoneJid);
  contactPhoneJids.set(lidJid, phoneJid);
}

async function resolveLidToPhoneJid(lid) {
  if (!lid) return null;
  if (isPhoneJid(lid)) return lid;
  if (!isLidJid(lid)) return null;
  const cached = lidToPhoneJid.get(lid) || contactPhoneJids.get(lid);
  if (isPhoneJid(cached)) return cached;
  try {
    const mapping = sock?.signalRepository?.lidMapping;
    if (mapping && typeof mapping.getPNForLID === "function") {
      const pn = await mapping.getPNForLID(lid);
      const phoneJid = isPhoneJid(pn) ? pn : phoneNumberToJid(pn);
      if (phoneJid) {
        saveLidMapping(lid, phoneJid);
        return phoneJid;
      }
    }
  } catch (error) {}
  return null;
}

function saveContacts(contacts = []) {
  for (const contact of contacts) {
    if (!contact) continue;
    const id = normalizeJid(contact.id);
    const lid = normalizeJid(contact.lid);
    let phoneJid = null;
    if (contact.phoneNumber) {
      phoneJid = isPhoneJid(contact.phoneNumber) ? contact.phoneNumber : phoneNumberToJid(contact.phoneNumber);
    }
    if (!phoneJid && isPhoneJid(id)) phoneJid = id;
    if (phoneJid && isLidJid(id)) saveLidMapping(id, phoneJid);
    if (phoneJid && lid) saveLidMapping(lid, phoneJid);
    const name = cleanName(
      contact.username || contact.notify || contact.name ||
      contact.verifiedName || contact.pushName
    );
    if (name) {
      if (id) contactNames.set(id, name);
      if (lid) contactNames.set(lid, name);
      if (phoneJid) contactNames.set(phoneJid, name);
    }
    if (phoneJid) {
      if (id) contactPhoneJids.set(id, phoneJid);
      if (lid) contactPhoneJids.set(lid, phoneJid);
      contactPhoneJids.set(phoneJid, phoneJid);
    }
  }
}

function getDirectPhoneJid(participant = {}) {
  if (participant.phoneNumber) {
    const jid = isPhoneJid(participant.phoneNumber)
      ? participant.phoneNumber
      : phoneNumberToJid(participant.phoneNumber);
    if (jid) return jid;
  }
  if (isPhoneJid(participant.id)) return participant.id;
  return null;
}

async function getPhoneJid(participant = {}) {
  const direct = getDirectPhoneJid(participant);
  if (direct) return direct;
  const ids = [participant.id, participant.lid].filter(Boolean);
  for (const id of ids) {
    const cached = contactPhoneJids.get(id) || lidToPhoneJid.get(id);
    if (isPhoneJid(cached)) return cached;
    if (isLidJid(id)) {
      const resolved = await resolveLidToPhoneJid(id);
      if (resolved) return resolved;
    }
  }
  return null;
}

async function cacheParticipants(participants = []) {
  for (const participant of participants) {
    if (!participant) continue;
    const name = getDisplayName(participant);
    let phoneJid = getDirectPhoneJid(participant);
    if (!phoneJid && participant.id) phoneJid = await resolveLidToPhoneJid(participant.id);
    if (!phoneJid && participant.lid) phoneJid = await resolveLidToPhoneJid(participant.lid);
    if (phoneJid && participant.id) contactPhoneJids.set(participant.id, phoneJid);
    if (phoneJid && participant.lid) contactPhoneJids.set(participant.lid, phoneJid);
    if (name && name !== "Member") {
      if (participant.id) contactNames.set(participant.id, name);
      if (participant.lid) contactNames.set(participant.lid, name);
      if (phoneJid) contactNames.set(phoneJid, name);
    }
  }
}

function isAdminParticipant(participant = {}) {
  return participant.admin === "admin" ||
         participant.admin === "superadmin" ||
         participant.admin === true;
}

function isOwnerParticipant(participant = {}) {
  return participant.admin === "superadmin";
}

function findParticipant(participants = [], jid) {
  if (!jid) return null;
  return participants.find(p =>
    p?.id === jid || p?.lid === jid || p?.phoneNumber === jid
  ) || null;
}

function getBotPhoneJid() {
  try {
    const ownId = normalizeJid(sock?.user?.id);
    if (isPhoneJid(ownId)) return ownId.split(":")[0];
    if (isLidJid(ownId)) {
      const cached = lidToPhoneJid.get(ownId) || contactPhoneJids.get(ownId);
      if (isPhoneJid(cached)) return cached;
    }
    if (PHONE_NUMBER) return phoneNumberToJid(PHONE_NUMBER);
    return null;
  } catch { return null; }
}

async function isBotAdminInGroup(groupId) {
  try {
    if (!sock || !groupId || !groupId.endsWith("@g.us")) return false;
    const metadata = await sock.groupMetadata(groupId);
    const participants = metadata?.participants || [];
    if (!participants.length) return false;
    await cacheParticipants(participants);
    const botJid = normalizeJid(sock?.user?.id);
    const botPhoneJid = getBotPhoneJid();
    let botParticipant = findParticipant(participants, botJid);
    if (!botParticipant && botPhoneJid) botParticipant = findParticipant(participants, botPhoneJid);
    if (!botParticipant) return false;
    return isAdminParticipant(botParticipant);
  } catch (error) {
    return false;
  }
}

async function isSenderAdmin(remoteJid, message) {
  try {
    if (!sock || !remoteJid) return false;
    const participantJid = message?.key?.participant;
    if (!participantJid) return false;
    const metadata = await sock.groupMetadata(remoteJid);
    const participants = metadata?.participants || [];
    await cacheParticipants(participants);
    let sender = findParticipant(participants, participantJid);
    if (!sender) {
      const senderPhone = await resolveLidToPhoneJid(participantJid);
      if (senderPhone) sender = findParticipant(participants, senderPhone);
    }
    if (!sender) return false;
    return isAdminParticipant(sender);
  } catch (error) {
    return false;
  }
}

/* =========================================================
   COPY BUTTON
========================================================= */

function makeCopyButton(command) {
  return {
    name: "cta_copy",
    buttonParamsJson: JSON.stringify({
      display_text: "📋 Copy",
      id: "copy_" + normalizeCommandName(command),
      copy_code: command
    })
  };
}

async function sendCopyButton(remoteJid, command) {
  try {
    const button = makeCopyButton(command);
    const message = generateWAMessageFromContent(
      remoteJid,
      {
        viewOnceMessage: {
          message: {
            interactiveMessage: proto.Message.InteractiveMessage.create({
              body: proto.Message.InteractiveMessage.Body.create({
                text: `📋 *Copy Command*\n\n${command}`
              }),
              footer: proto.Message.InteractiveMessage.Footer.create({
                text: `🤖 ${AI_NAME}`
              }),
              nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: [button]
              })
            })
          }
        }
      },
      { userJid: sock?.user?.id }
    );
    await sock.relayMessage(remoteJid, message.message, { messageId: message.key.id });
    return true;
  } catch (error) {
    return false;
  }
}

async function sendCopyButtons(remoteJid, commands) {
  const uniqueCommands = [...new Set(commands.filter(Boolean))];
  for (const command of uniqueCommands) {
    await sendCopyButton(remoteJid, command);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/* =========================================================
   PUBLIC MENU
========================================================= */

function buildMenuText(remoteJid) {
  const enabled = command => isCommandEnabled(remoteJid, command);
  return `
╭━━━━━━━━━━━━━━━━━━━━╮
     🤖 *${AI_NAME} BOT MENU*
╰━━━━━━━━━━━━━━━━━━━━╯

╭─❖ 👥 *GROUP COMMANDS*
│ 1️⃣ ${enabled("menu") ? "/menu" : "🔴 /menu OFF"}
│ 2️⃣ ${enabled("bot") ? "/bot" : "🔴 /bot OFF"}
│ 3️⃣ ${enabled("rules") ? "/rules" : "🔴 /rules OFF"}
│ 4️⃣ ${enabled("admin") ? "/admin" : "🔴 /admin OFF"}
│ 5️⃣ ${enabled("members") ? "/members" : "🔴 /members OFF"}
│ 6️⃣ ${enabled("groupinfo") ? "/groupinfo" : "🔴 /groupinfo OFF"}
│ 7️⃣ ${enabled("id") ? "/id" : "🔴 /id OFF"}
│ 8️⃣ ${enabled("tagall") ? "/tagall <msg> 🔒" : "🔴 /tagall OFF"}
╰────────────────────

╭─❖ 🤖 *${AI_NAME} AI*
│ 9️⃣ ${enabled("ai") ? "/ai <প্রশ্ন>" : "🔴 /ai OFF"}
│ 🔟 @ai <প্রশ্ন>
│ 1️⃣1️⃣ বটকে মেনশন করে প্রশ্ন
│ 1️⃣2️⃣ ${enabled("story") ? "/story <বিষয়>" : "🔴 /story OFF"}
│ 1️⃣3️⃣ ${enabled("song") ? "/song <বিষয়>" : "🔴 /song OFF"}
│ 1️⃣4️⃣ ${enabled("post") ? "/post <বিষয়>" : "🔴 /post OFF"}
│ 1️⃣5️⃣ ${enabled("poem") ? "/poem <বিষয়>" : "🔴 /poem OFF"}
│ 1️⃣6️⃣ ${enabled("joke") ? "/joke" : "🔴 /joke OFF"}
│ 1️⃣7️⃣ ${enabled("aihelp") ? "/aihelp" : "🔴 /aihelp OFF"}
│ 1️⃣8️⃣ /clear — AI মেমোরি রিসেট
╰────────────────────

╭─❖ ⚙️ *UTILITY*
│ 1️⃣9️⃣ ${enabled("ping") ? "/ping" : "🔴 /ping OFF"}
│ 🧮 ক্যালকুলেটর: /20+2
╰────────────────────

╭─❖ 💰 *BUY / SELL*
│ 2️⃣0️⃣ ${enabled("deal") ? "/deal /ডিল" : "🔴 /deal OFF"}
╰────────────────────

╭─❖ 🤍 *PIYAS*
│ 2️⃣1️⃣ ${enabled("piyas") ? "/piyas" : "🔴 /piyas OFF"}
╰────────────────────

╭─❖ 🌐 *WEBSITE*
│ 2️⃣2️⃣ ${enabled("website") ? "/website" : "🔴 /website OFF"}
╰────────────────────

━━━━━━━━━━━━━━━━━━━━
🤖 AI: *${AI_NAME}* • Created by ${AI_CREATOR}
🔒 = Admin Only
━━━━━━━━━━━━━━━━━━━━
`;
}

async function sendPublicMenu(remoteJid) {
  try {
    await sock.sendMessage(remoteJid, { text: buildMenuText(remoteJid) });
    const commands = [
      "/menu", "/rules", "/admin", "/members", "/groupinfo",
      "/id", "/ping", "/deal", "/piyas", "/website",
      "/ai বাংলাদেশের রাজধানী কোথায়?",
      "/story একটি ছোট মেয়ে",
      "/song ভালোবাসা",
      "/post নতুন পণ্য",
      "/poem বৃষ্টি"
    ].filter(command => isCommandEnabled(remoteJid, command));
    await sendCopyButtons(remoteJid, commands);
  } catch (error) {}
}

/* =========================================================
   AI HELP MENU
========================================================= */

async function sendAIHelp(remoteJid) {
  await sock.sendMessage(remoteJid, {
    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
   🤖 *${AI_NAME} — AI HELP*
╰━━━━━━━━━━━━━━━━━━━━╯

🎯 *${AI_NAME}* কী কী করতে পারে:

1️⃣ *সাধারণ প্রশ্ন*
   /ai বাংলাদেশের রাজধানী?
   @ai আকাশ কেন নীল?

2️⃣ 📝 *গল্প লিখা*
   /story একটি সাহসী ছেলে
   /ai একটি গল্প বলো

3️⃣ 🎵 *গান লিখা*
   /song মায়ের ভালোবাসা
   /ai একটি গান লিখো

4️⃣ 📢 *পোস্ট লিখা*
   /post নতুন ফোন
   /ai একটা পোস্ট লিখো

5️⃣ ✍️ *কবিতা*
   /poem বৃষ্টির দিন

6️⃣ 😄 *কৌতুক*
   /joke

7️⃣ 🧠 *মেমোরি*
   আগের কথা মনে রাখে (১০ মিনিট)
   /clear দিয়ে রিসেট

━━━━━━━━━━━━━━━━━━━━
🤖 Created by *${AI_CREATOR}*
━━━━━━━━━━━━━━━━━━━━
`
  });
  await sendCopyButtons(remoteJid, [
    "/ai বাংলাদেশের রাজধানী?",
    "/story সাহসী ছেলে",
    "/song মায়ের ভালোবাসা",
    "/post নতুন ফোন",
    "/poem বৃষ্টি",
    "/joke"
  ]);
}

/* =========================================================
   CALCULATOR
========================================================= */

function calculateExpression(expression) {
  try {
    const value = String(expression || "").trim().replace(/,/g, "");
    if (!value) return null;
    if (!/^[0-9+\-*/%.()\s]+$/.test(value)) return null;
    if (value.includes("**") || value.includes("//")) return null;
    if (!/\d/.test(value) || !/[+\-*/%]/.test(value)) return null;
    const result = Function(`"use strict"; return (${value})`)();
    if (typeof result !== "number" || !Number.isFinite(result)) return null;
    return result;
  } catch { return null; }
}

function formatCalculationResult(result) {
  if (typeof result !== "number" || !Number.isFinite(result)) return null;
  if (Number.isInteger(result)) return String(result);
  return Number(result.toFixed(10)).toString();
}

function isCalculatorMessage(text) {
  if (!text) return false;
  const value = String(text).trim();
  if (!value.startsWith("/")) return false;
  const expression = value.slice(1).trim();
  if (!expression) return false;
  return /^[0-9+\-*/%.()\s]+$/.test(expression) && /[+\-*/%]/.test(expression);
}

async function handleCalculator(remoteJid, text) {
  try {
    const expression = String(text).trim().slice(1).trim();
    const result = calculateExpression(expression);
    if (result === null) {
      await sock.sendMessage(remoteJid, {
        text: `🧮 *CALCULATOR*\n\n❌ হিসাব সঠিক নয়।\n\n💡 উদাহরণ:\n/20+2\n/100-25\n/20*5\n/100/4\n/(20+5)*2`
      });
      return true;
    }
    await sock.sendMessage(remoteJid, {
      text: `🧮 *CALCULATOR*\n\n📌 ${expression}\n✅ = ${formatCalculationResult(result)}\n\n🤍 *Piyas Bot*`
    });
    return true;
  } catch (error) {
    return false;
  }
}

/* =========================================================
   ADMIN PANEL
========================================================= */

async function sendAdminPanel(remoteJid) {
  try {
    const disabled = getGroupStatus(remoteJid).disabledCommands || [];
    const moderation = getModerationStatus(remoteJid);
    const botIsAdmin = await isBotAdminInGroup(remoteJid);

    const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
       👑 *ADMIN PANEL*
╰━━━━━━━━━━━━━━━━━━━━╯

╭─❖ 🤖 *BOT STATUS*
│ ${isBotEnabled(remoteJid) ? "🟢 Bot: ON" : "🔴 Bot: OFF"}
│ ${isAIEnabled(remoteJid) ? "🟢 AI: ON" : "🔴 AI: OFF"}
│ ${botIsAdmin ? "🛡️ Moderation: Active" : "⚠️ Moderation: Inactive"}
│ 📦 Model: ${AI_MODEL}
│ 🧠 AI Name: ${AI_NAME}
╰────────────────────

╭─❖ 🛡️ *MODERATION*
│ ${moderation.badWords ? "🟢" : "🔴"} Bad Word
│ ${moderation.links ? "🟢" : "🔴"} Link
│ ${moderation.spam ? "🟢" : "🔴"} Spam
│ ${moderation.antiForward ? "🟢" : "🔴"} Anti-Forward
╰────────────────────

╭─❖ 🔇 *MUTE*
│ /mute @user 10m
│ /unmute @user
│ /mutelist
╰────────────────────

╭─❖ 🤖 *AI CONTROL*
│ /aion — চালু
│ /aioff — বন্ধ
╰────────────────────

╭─❖ ⚙️ *COMMAND CONTROL*
│ /on <command>
│ /off <command>
│ /cmdlist
╰────────────────────

━━━━━━━━━━━━━━━━━━━━
`;
    await sock.sendMessage(remoteJid, { text });
    await sendCopyButtons(remoteJid, [
      "/adminpanel", "/aion", "/aioff",
      "/on ai", "/off ai",
      "/mute @user 10m", "/unmute @user", "/mutelist"
    ]);
  } catch (error) {}
}

async function sendCommandList(remoteJid) {
  const disabled = getGroupStatus(remoteJid).disabledCommands || [];
  const commandLines = COMMAND_DEFINITIONS.map(item => {
    const enabled = !disabled.includes(item.key);
    const isAdminOnly = ADMIN_ONLY_COMMANDS.includes(item.key);
    return `${enabled ? "🟢 ON " : "🔴 OFF"} ${item.command}${isAdminOnly ? " 🔒" : ""}`;
  });
  const onCount = COMMAND_DEFINITIONS.filter(item => !disabled.includes(item.key)).length;
  const offCount = COMMAND_DEFINITIONS.length - onCount;

  await sock.sendMessage(remoteJid, {
    text: `📋 *COMMAND STATUS*\n\n${commandLines.join("\n")}\n\n━━━━━━━━━━━━━━\n🟢 ON: ${onCount}\n🔴 OFF: ${offCount}`
  });
}

/* =========================================================
   RULES / WEBSITE / PIYAS
========================================================= */

const GROUP_RULES = `
╭━━━━━━━━━━━━━━━━━━━━╮
        📜 *GROUP RULES*
╰━━━━━━━━━━━━━━━━━━━━╯

1️⃣ সবাইকে সম্মান করে কথা বলুন।
2️⃣ অশ্লীল কনটেন্ট শেয়ার করবেন না।
3️⃣ Spam করবেন না।
4️⃣ ১০ মিনিটে একই Forward দেবেন না।
5️⃣ সন্দেহজনক লিংক শেয়ার করবেন না।
6️⃣ Admin ছাড়া লিংক শেয়ার নয়।
7️⃣ অন্যকে হয়রানি করবেন না।
8️⃣ সমস্যায় Admin-কে জানান।

🤍 *Piyas*
`;

const WEBSITE_TEXT = `
╭━━━━━━━━━━━━━━━━━━━━╮
      🌐 *OUR WEBSITE*
╰━━━━━━━━━━━━━━━━━━━━╯

🌐 ${WEBSITE_URL}

🎁 Account Buy/Sell, Google Play
Points এবং অন্যান্য earning তথ্য।

🤍 *Piyas*
`;

const PIYAS_INFO = `
╭━━━━━━━━━━━━━━━━━━╮
       🤍 *PIYAS*
╰━━━━━━━━━━━━━━━━━━╯

👤 *Name:* মোঃ আল আমিন
🌐 *English:* MD. AL AMIN
👨‍👦 *Father:* মোঃ মোশারফ হোসেন
👩‍👦 *Mother:* মোসাম্মৎ রীপা বেগম
🎂 *DOB:* ০৯ জানুয়ারি ২০০৬
🩸 *Blood:* A+
💍 *Status:* Unmarried
🏠 *Address:* বলদার চর, নান্দাইল,
হেমগঞ্জ বাজার - ২২৯০, ময়মনসিংহ

🤍 *Thank You*
`;

/* =========================================================
   BOT ON/OFF / DEAL
========================================================= */

const BOT_OFF_TEXT = `🔴 *BOT OFF*\n\nবট বন্ধ করা হয়েছে।`;
const BOT_ON_TEXT = `🟢 *BOT ON*\n\nবট চালু হয়েছে। ✅`;
const BOT_ALREADY_OFF_TEXT = `🔴 বট ইতোমধ্যে OFF।`;
const BOT_ALREADY_ON_TEXT = `🟢 বট ইতোমধ্যে ON।`;

const DEAL_NOTICE_TOP = `
╭━━━━━━━━━━━━━━━━━━━━╮
        🤝 *DEAL NOTICE*
╰━━━━━━━━━━━━━━━━━━━━╯

⚠️ *সতর্কতা!*

Account Buy/Sell বা যেকোনো
Deal করার আগে Admin-এর সাথে
যোগাযোগ করুন।

🚫 *Admin ছাড়া Deal নয়।*

👑 *Group Admin:*
`;

const DEAL_NOTICE_BOTTOM = `
📌 নিরাপদে Deal করুন।

🤍 *PIYAS*
`;

/* =========================================================
   ADMIN DATA / DEAL NOTICE
========================================================= */

async function getAdminData(remoteJid) {
  try {
    const metadata = await sock.groupMetadata(remoteJid);
    const participants = metadata?.participants || [];
    await cacheParticipants(participants);
    const adminParticipants = participants.filter(isAdminParticipant);
    const admins = [];
    const usedJids = new Set();

    for (const participant of adminParticipants) {
      const phoneJid = await getPhoneJid(participant);
      let name = getDisplayName(participant);
      if (!name || name === "Member") name = "Admin";
      if (phoneJid && usedJids.has(phoneJid)) continue;
      if (phoneJid) usedJids.add(phoneJid);
      admins.push({
        jid: phoneJid || participant.id || participant.lid || null,
        name,
        owner: isOwnerParticipant(participant)
      });
    }
    return { admins, result: admins };
  } catch (error) {
    return { admins: [], result: [] };
  }
}

async function sendAdminList(remoteJid) {
  const { admins } = await getAdminData(remoteJid);
  if (!admins.length) {
    await sock.sendMessage(remoteJid, { text: "👑 কোনো Admin নেই।" });
    return;
  }
  const lines = [];
  const mentions = [];
  let number = 1;
  for (const admin of admins) {
    const role = admin.owner ? "⭐ *Owner*" : "👑 *Admin*";
    if (isPhoneJid(admin.jid)) {
      const phone = admin.jid.split("@")[0].replace(/[^0-9]/g, "");
      mentions.push(admin.jid);
      lines.push(`${number}️⃣ @${phone} ${role}`);
    } else {
      lines.push(`${number}️⃣ ${admin.name} ${role}`);
    }
    number++;
  }
  await sock.sendMessage(remoteJid, {
    text: `👑 *GROUP ADMINS*\n\n${lines.join("\n\n")}\n\n👥 মোট: ${admins.length}`,
    mentions
  });
}

async function sendDealNotice(remoteJid) {
  const { admins } = await getAdminData(remoteJid);
  if (!admins.length) {
    await sock.sendMessage(remoteJid, {
      text: DEAL_NOTICE_TOP + "⚠️ কোনো Admin পাওয়া যায়নি।\n\n" + DEAL_NOTICE_BOTTOM
    });
    return;
  }
  const lines = [];
  const mentions = [];
  let number = 1;
  for (const admin of admins) {
    const role = admin.owner ? "⭐ *Owner*" : "👑 *Admin*";
    if (isPhoneJid(admin.jid)) {
      const phone = admin.jid.split("@")[0].replace(/[^0-9]/g, "");
      mentions.push(admin.jid);
      lines.push(`${number}️⃣ @${phone} ${role}`);
    } else {
      lines.push(`${number}️⃣ ${admin.name} ${role}`);
    }
    number++;
  }
  await sock.sendMessage(remoteJid, {
    text: DEAL_NOTICE_TOP + lines.join("\n\n") + `\n\n👥 মোট: ${admins.length}\n\n` + DEAL_NOTICE_BOTTOM,
    mentions
  });
}

/* =========================================================
   WELCOME / GOODBYE
========================================================= */

function getWelcomeText(name, groupName) {
  const safeName = cleanName(name) || "Member";
  const safeGroupName = cleanName(groupName) || "এই গ্রুপ";
  return `
╭━━━━━━━━━━━━━━━━━━━━╮
        🎉 *স্বাগতম*
╰━━━━━━━━━━━━━━━━━━━━╯

🎉 *স্বাগতম @${safeName}* ❤️

🌸 আপনাকে *${safeGroupName}*-এ
স্বাগতম।

📌 /rules — নিয়ম
🌐 ${WEBSITE_URL}

🔰 *ব্যাকআপ গ্রুপ:*
${BACKUP_GROUP_URL}

❤️ *Piyas*
`;
}

async function sendWelcome(groupId, participant) {
  try {
    if (!sock || !isBotEnabled(groupId)) return;
    let metadata = null;
    try { metadata = await sock.groupMetadata(groupId); } catch {}
    let member = findParticipant(metadata?.participants || [], participant?.id);
    if (!member) member = findParticipant(metadata?.participants || [], participant?.lid);
    if (!member) member = participant;
    const name = getDisplayName(member);
    const groupName = cleanName(metadata?.subject) || "এই গ্রুপ";
    const phoneJid = await getPhoneJid(member);
    const welcomeText = getWelcomeText(name, groupName);
    if (isPhoneJid(phoneJid)) {
      await sock.sendMessage(groupId, { text: welcomeText, mentions: [phoneJid] });
    } else {
      await sock.sendMessage(groupId, { text: welcomeText.replace(`@${name}`, name) });
    }
  } catch (error) {}
}

async function sendGoodbye(groupId, participant) {
  try {
    if (!sock || !isBotEnabled(groupId)) return;
    let metadata = null;
    try { metadata = await sock.groupMetadata(groupId); } catch {}
    let member = findParticipant(metadata?.participants || [], participant?.id);
    if (!member) member = findParticipant(metadata?.participants || [], participant?.lid);
    if (!member) member = participant;
    const name = getDisplayName(member);
    const groupName = cleanName(metadata?.subject) || "এই গ্রুপ";
    const text = `👋 *@${name}* গ্রুপ ছেড়ে গেলেন।\n\n💙 ভালো থাকবেন।\n\n🤍 *Piyas*`;
    await sock.sendMessage(groupId, { text: text.replace(`@${name}`, name) });
  } catch (error) {}
}

/* =========================================================
   DURATION PARSER
========================================================= */

const BANGLA_DIGITS = { "০":"0","১":"1","২":"2","৩":"3","৪":"4","৫":"5","৬":"6","৭":"7","৮":"8","৯":"9" };

function convertBanglaDigits(value) {
  return String(value).replace(/[০-৯]/g, digit => BANGLA_DIGITS[digit]);
}

function parseDurationNumber(value) {
  if (!value) return null;
  const converted = convertBanglaDigits(String(value).trim().toLowerCase());
  if (/^\d+(\.\d+)?$/.test(converted)) return Number(converted);
  const words = { "এক":1,"দুই":2,"তিন":3,"চার":4,"পাঁচ":5,"ছয়":6,"সাত":7,"আট":8,"নয়":9,"দশ":10 };
  return words[converted] ?? null;
}

function parseGroupDuration(text) {
  if (!text) return null;
  const input = convertBanglaDigits(String(text).trim().toLowerCase()).replace(/\s+/g, " ");
  let total = 0;
  let found = false;
  const patterns = [
    { regex: /(\d+(?:\.\d+)?)\s*(বছর|year|years|y)(?=\s|$)/giu, ms: 365*24*60*60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(মাস|month|months|mo)(?=\s|$)/giu, ms: 30*24*60*60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(সপ্তাহ|week|weeks|w)(?=\s|$)/giu, ms: 7*24*60*60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(দিন|day|days|d)(?=\s|$)/giu, ms: 24*60*60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(ঘণ্টা|ঘন্টা|hour|hours|hr|h)(?=\s|$)/giu, ms: 60*60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(মিনিট|minute|minutes|min|m)(?=\s|$)/giu, ms: 60*1000 },
    { regex: /(\d+(?:\.\d+)?)\s*(সেকেন্ড|second|seconds|sec|s)(?=\s|$)/giu, ms: 1000 }
  ];
  for (const item of patterns) {
    let match;
    while ((match = item.regex.exec(input)) !== null) {
      const number = parseDurationNumber(match[1]);
      if (number && number > 0) {
        total += number * item.ms;
        found = true;
      }
    }
  }
  if (!found) {
    const number = parseDurationNumber(input);
    if (number && number > 0) return number * 60 * 1000;
  }
  return total > 0 ? total : null;
}

function formatGroupDuration(milliseconds) {
  let seconds = Math.floor(milliseconds / 1000);
  const years = Math.floor(seconds / (365*24*60*60)); seconds %= 365*24*60*60;
  const months = Math.floor(seconds / (30*24*60*60)); seconds %= 30*24*60*60;
  const days = Math.floor(seconds / (24*60*60)); seconds %= 24*60*60;
  const hours = Math.floor(seconds / (60*60)); seconds %= 60*60;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  const parts = [];
  if (years) parts.push(`${years} বছর`);
  if (months) parts.push(`${months} মাস`);
  if (days) parts.push(`${days} দিন`);
  if (hours) parts.push(`${hours} ঘণ্টা`);
  if (minutes) parts.push(`${minutes} মিনিট`);
  if (seconds) parts.push(`${seconds} সেকেন্ড`);
  return parts.join(" ") || "0 সেকেন্ড";
}

/* =========================================================
   GROUP LOCK
========================================================= */

async function lockGroup(remoteJid, durationMs) {
  try {
    if (!sock || !remoteJid?.endsWith("@g.us")) return false;
    const botAdmin = await isBotAdminInGroup(remoteJid);
    if (!botAdmin) {
      await sock.sendMessage(remoteJid, { text: `❌ Bot-কে Admin করুন।` });
      return false;
    }
    await sock.groupSettingUpdate(remoteJid, "announcement");
    const status = getGroupStatus(remoteJid);
    status.groupLockedUntil = Date.now() + durationMs;
    saveBotStatus();
    await sock.sendMessage(remoteJid, {
      text: `🔒 *GROUP CLOSED*\n\n⏱️ ${formatGroupDuration(durationMs)}`
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function unlockGroup(remoteJid, reason = "manual") {
  try {
    if (!sock || !remoteJid?.endsWith("@g.us")) return false;
    await sock.groupSettingUpdate(remoteJid, "not_announcement");
    const status = getGroupStatus(remoteJid);
    status.groupLockedUntil = null;
    saveBotStatus();
    if (reason === "timer") {
      await sock.sendMessage(remoteJid, { text: `🔓 *GROUP OPEN*\n\n👥 সবাই Message পাঠাতে পারবে।` });
    }
    return true;
  } catch (error) {
    return false;
  }
}

async function checkExpiredGroupLocks() {
  if (!sock) return;
  const now = Date.now();
  for (const [groupId, status] of Object.entries(botStatus)) {
    if (!status || typeof status !== "object") continue;
    if (typeof status.groupLockedUntil !== "number") continue;
    if (status.groupLockedUntil <= now) await unlockGroup(groupId, "timer");
  }
}

async function checkExpiredMutes() {
  if (!sock) return;
  const now = Date.now();
  for (const [key, data] of Object.entries(mutedUsers)) {
    if (!data || !data.until) continue;
    if (data.until <= now) {
      const [groupId, memberJid] = key.split(":");
      delete mutedUsers[key];
      saveMuted();
    }
  }
}

setInterval(checkExpiredGroupLocks, GROUP_LOCK_CHECK_INTERVAL);
setInterval(checkExpiredMutes, 10 * 1000);

/* =========================================================
   PAIRING
========================================================= */

function savePairingNumber(number) {
  try { fs.writeFileSync(PAIRING_NUMBER_FILE, number, "utf8"); } catch {}
}

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
  } catch (error) {}
}

async function generatePairingCode(state) {
  try {
    if (!PHONE_NUMBER) return;
    if (state.creds.registered) return;
    if (pairingRequested) return;
    pairingRequested = true;
    await new Promise(resolve => setTimeout(resolve, 2500));
    if (!sock || state.creds.registered) {
      pairingRequested = false;
      return;
    }
    const code = await sock.requestPairingCode(PHONE_NUMBER);
    savePairingNumber(PHONE_NUMBER);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`🔐 PAIRING CODE: ${code}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  } catch (error) {
    pairingRequested = false;
    console.log("❌ Pairing code error:", error?.message);
  }
}

/* =========================================================
   MESSAGE TEXT / MENTIONS
========================================================= */

function getMessageText(message) {
  const msg = message?.message;
  if (!msg) return "";
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  ).trim();
}

function getMentionedJids(message) {
  const msg = message?.message;
  if (!msg) return [];
  return (
    msg.extendedTextMessage?.contextInfo?.mentionedJid ||
    msg.imageMessage?.contextInfo?.mentionedJid ||
    msg.videoMessage?.contextInfo?.mentionedJid ||
    msg.documentMessage?.contextInfo?.mentionedJid ||
    []
  );
}

/* =========================================================
   TAG ALL
========================================================= */

async function handleTagAll(remoteJid, message, args) {
  try {
    const metadata = await sock.groupMetadata(remoteJid);
    const participants = metadata?.participants || [];
    if (!participants.length) {
      await sock.sendMessage(remoteJid, { text: "❌ কোনো Member নেই।" });
      return;
    }
    await cacheParticipants(participants);
    const mentions = [];
    for (const p of participants) {
      const phoneJid = await getPhoneJid(p);
      if (phoneJid) mentions.push(phoneJid);
      else if (p.id) mentions.push(p.id);
    }
    const customText = args.join(" ").trim();
    const finalText = customText
      ? `📢 *TAG ALL*\n\n${customText}\n\n━━━━━━━━━━━━━━━━━━━━\n`
      : `📢 *TAG ALL*\n\nসবাইকে ডাকা হচ্ছে!\n\n━━━━━━━━━━━━━━━━━━━━\n`;
    await sock.sendMessage(remoteJid, { text: finalText, mentions });
  } catch (error) {
    await sock.sendMessage(remoteJid, { text: "❌ Tag All ব্যর্থ।" });
  }
}

/* =========================================================
   MUTE COMMANDS
========================================================= */

async function handleMute(remoteJid, message, args) {
  try {
    const mentioned = getMentionedJids(message);
    if (!mentioned.length) {
      await sock.sendMessage(remoteJid, {
        text: `🔇 *MUTE* 🔒\n\n/mute @user 10m\n/mute @user 2h\n/mute @user 1d`
      });
      return;
    }
    const durationText = args.filter(a => !a.startsWith("@")).join(" ").trim();
    const durationMs = parseGroupDuration(durationText);
    if (!durationMs || durationMs <= 0) {
      await sock.sendMessage(remoteJid, { text: "❌ সময় সঠিক নয়। উদাহরণ: /mute @user 10m" });
      return;
    }
    const names = [];
    for (const jid of mentioned) {
      const memberJid = await getPhoneJid({ id: jid }) || jid;
      setMute(remoteJid, memberJid, durationMs);
      names.push(`@${memberJid.split("@")[0]}`);
    }
    await sock.sendMessage(remoteJid, {
      text: `🔇 *MUTED*\n\n${names.join(", ")}\n\n⏱️ ${formatGroupDuration(durationMs)}`,
      mentions: mentioned
    });
  } catch (error) {}
}

async function handleUnmute(remoteJid, message) {
  try {
    const mentioned = getMentionedJids(message);
    if (!mentioned.length) {
      await sock.sendMessage(remoteJid, { text: "❌ /unmute @user" });
      return;
    }
    const names = [];
    for (const jid of mentioned) {
      const memberJid = await getPhoneJid({ id: jid }) || jid;
      if (removeMute(remoteJid, memberJid)) names.push(`@${memberJid.split("@")[0]}`);
    }
    if (!names.length) {
      await sock.sendMessage(remoteJid, { text: "⚠️ Member Mute ছিল না।" });
      return;
    }
    await sock.sendMessage(remoteJid, {
      text: `🔊 *UNMUTED*\n\n${names.join(", ")}`,
      mentions: mentioned
    });
  } catch (error) {}
}

async function handleMuteList(remoteJid) {
  try {
    const list = [];
    for (const [key, data] of Object.entries(mutedUsers)) {
      const [groupId, memberJid] = key.split(":");
      if (groupId !== remoteJid) continue;
      const remaining = data.until - Date.now();
      if (remaining <= 0) continue;
      list.push({ memberJid, remaining });
    }
    if (!list.length) {
      await sock.sendMessage(remoteJid, { text: `🔊 *MUTE LIST*\n\nকেউ Mute নেই।` });
      return;
    }
    const lines = [];
    const mentions = [];
    let n = 1;
    for (const item of list) {
      lines.push(`${n}. @${item.memberJid.split("@")[0]} — ⏱️ ${formatGroupDuration(item.remaining)}`);
      mentions.push(item.memberJid);
      n++;
    }
    await sock.sendMessage(remoteJid, {
      text: `🔇 *MUTE LIST*\n\n${lines.join("\n")}\n\nমোট: ${list.length}`,
      mentions
    });
  } catch (error) {}
}

/* =========================================================
   START BOT
========================================================= */

async function startBot() {
  try {
    let authState = await useMultiFileAuthState(AUTH_DIR);
    let { state, saveCreds } = authState;

    const currentCredPhone = getCredentialPhoneNumber(state.creds);
    const numberChanged = PHONE_NUMBER && state.creds.registered &&
      currentCredPhone && currentCredPhone !== PHONE_NUMBER;

    if (numberChanged) {
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

    sock.ev.on("contacts.upsert", contacts => {
      try { saveContacts(contacts); } catch (e) {}
    });
    sock.ev.on("contacts.update", contacts => {
      try { saveContacts(contacts); } catch (e) {}
    });

    sock.ev.on("group-participants.update", async event => {
      try {
        const groupId = event?.id;
        const action = event?.action;
        const participants = event?.participants || [];
        if (!groupId) return;
        const botIsAdmin = await isBotAdminInGroup(groupId);
        if (!botIsAdmin) return;
        if (action === "add") {
          for (const participant of participants) {
            await sendWelcome(groupId, participant);
          }
        }
        if (action === "remove") {
          for (const participant of participants) {
            await sendGoodbye(groupId, participant);
          }
        }
      } catch (error) {}
    });

    sock.ev.on("connection.update", async update => {
      try {
        const { connection, lastDisconnect } = update;

        if (connection === "connecting") {
          console.log("🔄 Connecting...");
          if (PHONE_NUMBER && !state.creds.registered) {
            await generatePairingCode(state);
          }
        }

        if (connection === "open") {
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.log(`✅ ${AI_NAME} Bot Connected!`);
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          reconnecting = false;
          pairingRequested = false;
          return;
        }

        if (connection === "close") {
          const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          console.log(`❌ Closed. Code: ${statusCode}`);
          sock = null;
          pairingRequested = false;
          if (shouldReconnect && !reconnecting) {
            reconnecting = true;
            setTimeout(() => {
              reconnecting = false;
              startBot();
            }, 3000);
          }
        }
      } catch (error) {}
    });

    /* =========================================================
       MAIN MESSAGE HANDLER
    ========================================================= */

    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        if (!Array.isArray(messages)) return;

        for (const message of messages) {
          try {
            if (!message) continue;
            if (message.key?.fromMe) continue;

            const remoteJid = message.key?.remoteJid;
            if (!remoteJid || !remoteJid.endsWith("@g.us")) continue;

            const text = getMessageText(message);
            if (!text) continue;

            const moderated = await moderateMessage(remoteJid, message, text);
            if (moderated) continue;

            const trimmedText = text.trim();
            const textLower = trimmedText.toLowerCase();

            /* ====== AI AUTO REPLY ====== */
            const botJid = getBotPhoneJid();
            const botLid = sock?.user?.id;
            const mentioned = getMentionedJids(message);

            const botMentioned = mentioned.some(jid =>
              (botJid && jid === botJid) ||
              (botLid && jid === botLid) ||
              (botJid && jid.includes(botJid.split("@")[0]))
            );

            const isAICommand = /^\/ai(\s|$)/i.test(trimmedText);
            const isAIMention = /^@ai(\s|$)/i.test(trimmedText);
            const isStory = /^\/(story|গল্প)(\s|$)/i.test(trimmedText);
            const isSong = /^\/(song|গান)(\s|$)/i.test(trimmedText);
            const isPost = /^\/(post|পোস্ট)(\s|$)/i.test(trimmedText);
            const isPoem = /^\/(poem|কবিতা)(\s|$)/i.test(trimmedText);
            const isJoke = /^\/joke(\s|$)/i.test(trimmedText);
            const isAIHelp = /^\/aihelp(\s|$)/i.test(trimmedText);
            const isClear = /^\/clear(\s|$)/i.test(trimmedText);

            /* AI HELP */
            if (isAIHelp && isBotEnabled(remoteJid)) {
              await sendAIHelp(remoteJid);
              continue;
            }

            /* CLEAR AI MEMORY */
            if (isClear && isBotEnabled(remoteJid)) {
              const sender = message.key.participant;
              const phoneJid = await getPhoneJid({ id: sender });
              if (phoneJid) clearConversation(remoteJid, phoneJid);
              await sock.sendMessage(remoteJid, {
                text: `🧹 *AI Memory Cleared*\n\n${AI_NAME} আপনার আগের কথা ভুলে গেছে।`,
                quoted: message
              });
              continue;
            }

            const wantsAI = botMentioned || isAICommand || isAIMention ||
              isStory || isSong || isPost || isPoem || isJoke;

            if (wantsAI && isBotEnabled(remoteJid) && isAIEnabled(remoteJid)) {
              if (!genAI) {
                await sock.sendMessage(remoteJid, {
                  text: "❌ AI এখনো চালু হয়নি (API Key নেই)।",
                  quoted: message
                });
                continue;
              }

              const sender = message.key.participant;
              const phoneJid = await getPhoneJid({ id: sender });
              const name = contactNames.get(phoneJid) || "User";

              if (phoneJid && isAIRateLimited(phoneJid)) {
                await sock.sendMessage(remoteJid, {
                  text: `⏳ *একটু অপেক্ষা করুন...*\n\nআপনি খুব দ্রুত প্রশ্ন করছেন। ৩০ সেকেন্ড পর আবার চেষ্টা করুন।`,
                  quoted: message
                });
                continue;
              }

              const mode = detectAIMode(trimmedText);
              let question = stripAIPrefix(trimmedText);

              if (botJid) {
                const botNumber = botJid.split("@")[0];
                question = question.replace(new RegExp(`@${botNumber}`, "gi"), "").trim();
              }
              if (botLid) {
                const lidNumber = String(botLid).split("@")[0].split(":")[0];
                question = question.replace(new RegExp(`@${lidNumber}`, "gi"), "").trim();
              }
              if (phoneJid) {
                const phoneNum = phoneJid.split("@")[0];
                question = question.replace(new RegExp(`@${phoneNum}`, "gi"), "").trim();
              }
              question = question.replace(/\s+/g, " ").trim();

              if (!question && mode === "chat") {
                await sock.sendMessage(remoteJid, {
                  text: `❓ কী জানতে চান?\n\nউদাহরণ:\n/ai বাংলাদেশের রাজধানী?\n/story ছোট মেয়ে\n/song ভালোবাসা`,
                  quoted: message
                });
                continue;
              }

              // Only send "thinking" for long tasks
              if (mode !== "chat" || question.length > 30) {
                const emoji = {
                  story: "📝", song: "🎵", post: "📢",
                  poem: "✍️", joke: "😄", chat: "🤔"
                }[mode] || "🤔";
                await sock.sendMessage(remoteJid, {
                  text: `${emoji} *${AI_NAME} ভাবছেন...*`,
                  quoted: message
                });
              }

              const reply = await getAIReply(remoteJid, phoneJid || sender, question, name, mode);

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
                  text: `${header}\n\n${reply}\n\n━━━━━━━━━━━━━━━━━━━━\n🤖 *${AI_NAME}* • Created by *${AI_CREATOR}*`,
                  quoted: message
                });
              } else {
                await sock.sendMessage(remoteJid, {
                  text: `❌ *দুঃখিত...*\n\n${AI_NAME} এই মুহূর্তে উত্তর দিতে পারছেন না।\n\nকিছুক্ষণ পর আবার চেষ্টা করুন।`,
                  quoted: message
                });
              }
              continue;
            }

            /* ====== CALCULATOR ====== */
            if (isCalculatorMessage(trimmedText)) {
              await handleCalculator(remoteJid, trimmedText);
              continue;
            }

            if (!trimmedText.startsWith("/")) continue;

            const parts = trimmedText.split(/\s+/);
            const rawCommand = parts.shift() || "";
            const command = normalizeCommandName(rawCommand);
            const args = parts;
            if (!command) continue;

            /* ADMIN CHECK */
            if (ADMIN_ONLY_COMMANDS.includes(command)) {
              const admin = await isSenderAdmin(remoteJid, message);
              if (!admin) {
                if (["mute","unmute","mutelist","aion","aioff"].includes(command)) {
                  await sock.sendMessage(remoteJid, {
                    text: `❌ *ADMIN ONLY* 🔒\n\nশুধু Admin ব্যবহার করতে পারবেন।`
                  });
                }
                continue;
              }
            }

            /* GROUP LOCK */
            if (command === "গ্রুপ") {
              const subCommand = normalizeCommandName(args[0]);
              if (subCommand !== "বন্ধ") {
                await sock.sendMessage(remoteJid, { text: `🔒 /গ্রুপ বন্ধ 2 মিনিট` });
                continue;
              }
              const durationText = args.slice(1).join(" ").trim();
              const durationMs = parseGroupDuration(durationText);
              if (!durationMs) {
                await sock.sendMessage(remoteJid, { text: "❌ সময় সঠিক নয়।" });
                continue;
              }
              await lockGroup(remoteJid, durationMs);
              continue;
            }

            /* AI ON/OFF */
            if (command === "aion") {
              setAIStatus(remoteJid, true);
              await sock.sendMessage(remoteJid, { text: `🤖 *${AI_NAME} ON*\n\n✅ AI চালু হলো।` });
              continue;
            }
            if (command === "aioff") {
              setAIStatus(remoteJid, false);
              await sock.sendMessage(remoteJid, { text: `🤖 *${AI_NAME} OFF*\n\n❌ AI বন্ধ।` });
              continue;
            }

            /* BOT ON/OFF */
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

            /* ADMIN PANEL */
            if (command === "adminpanel") {
              await sendAdminPanel(remoteJid);
              continue;
            }

            /* MODERATION */
            if (["mod","moderation","modstatus"].includes(command)) {
              const m = getModerationStatus(remoteJid);
              await sock.sendMessage(remoteJid, {
                text: `🛠️ *MOD STATUS*\n\n${m.badWords?"🟢":"🔴"} Bad Word\n${m.links?"🟢":"🔴"} Link\n${m.spam?"🟢":"🔴"} Spam\n${m.warnings?"🟢":"🔴"} Warning\n${m.antiForward?"🟢":"🔴"} Anti-Forward`
              });
              continue;
            }

            if (command === "modon") {
              for (const k of Object.keys(MODERATION_DEFAULTS)) setModerationStatus(remoteJid, k, true);
              await sock.sendMessage(remoteJid, { text: "🛡️ *MODERATION ON*" });
              continue;
            }

            if (command === "modoff") {
              for (const k of Object.keys(MODERATION_DEFAULTS)) setModerationStatus(remoteJid, k, false);
              await sock.sendMessage(remoteJid, { text: "🛡️ *MODERATION OFF*" });
              continue;
            }

            /* ON/OFF COMMAND */
            if (command === "on" || command === "off") {
              const targetRaw = args[0] || "";
              const target = getCanonicalCommand(targetRaw);
              if (!target) {
                await sock.sendMessage(remoteJid, { text: `⚙️ /${command} <command>` });
                continue;
              }
              if (PROTECTED_COMMANDS.includes(target)) {
                await sock.sendMessage(remoteJid, { text: "⚠️ এই Command বন্ধ করা যাবে না।" });
                continue;
              }
              if (!isKnownCommand(target)) {
                await sock.sendMessage(remoteJid, { text: `❌ /${target} নেই।` });
                continue;
              }
              const enable = command === "on";
              setCommandStatus(remoteJid, target, enable);
              await sock.sendMessage(remoteJid, {
                text: `${enable ? "🟢" : "🔴"} */${target}* ${enable ? "ON" : "OFF"}`
              });
              continue;
            }

            if (command === "cmdlist") {
              await sendCommandList(remoteJid);
              continue;
            }

            /* MUTE */
            if (command === "mute") { await handleMute(remoteJid, message, args); continue; }
            if (command === "unmute") { await handleUnmute(remoteJid, message); continue; }
            if (command === "mutelist") { await handleMuteList(remoteJid); continue; }

            if (!isBotEnabled(remoteJid)) continue;

            const commandAlias = getCanonicalCommand(command);
            if (!isKnownCommand(commandAlias)) continue;
            if (!isCommandEnabled(remoteJid, commandAlias)) continue;

            /* PUBLIC COMMANDS */
            if (commandAlias === "menu" || commandAlias === "bot") {
              await sendPublicMenu(remoteJid);
              continue;
            }

            if (commandAlias === "rules") {
              await sock.sendMessage(remoteJid, { text: GROUP_RULES });
              continue;
            }

            if (commandAlias === "website") {
              await sock.sendMessage(remoteJid, { text: WEBSITE_TEXT });
              continue;
            }

            if (commandAlias === "deal") {
              await sendDealNotice(remoteJid);
              continue;
            }

            if (commandAlias === "admin") {
              await sendAdminList(remoteJid);
              continue;
            }

            if (commandAlias === "tagall") {
              await handleTagAll(remoteJid, message, args);
              continue;
            }

            if (commandAlias === "members") {
              const metadata = await sock.groupMetadata(remoteJid);
              await sock.sendMessage(remoteJid, {
                text: `👥 *MEMBERS*\n\nমোট: ${metadata?.participants?.length || 0}`
              });
              continue;
            }

            if (commandAlias === "groupinfo") {
              const metadata = await sock.groupMetadata(remoteJid);
              const participants = metadata?.participants || [];
              const admins = participants.filter(isAdminParticipant);
              await sock.sendMessage(remoteJid, {
                text: `👥 *GROUP INFO*\n\n📛 ${metadata?.subject || "Unknown"}\n🆔 ${remoteJid}\n👥 ${participants.length}\n👑 ${admins.length}\n🤖 Bot: ${isBotEnabled(remoteJid)?"🟢":"🔴"}\n🧠 AI: ${isAIEnabled(remoteJid)?"🟢":"🔴"}`
              });
              continue;
            }

            if (commandAlias === "id") {
              await sock.sendMessage(remoteJid, { text: `🆔 ${remoteJid}` });
              continue;
            }

            if (commandAlias === "ping") {
              const start = Date.now();
              const msg = await sock.sendMessage(remoteJid, { text: "🏓 Pinging..." });
              const ping = Date.now() - start;
              await sock.sendMessage(remoteJid, {
                text: `🏓 *PONG!*\n\n⚡ ${ping}ms\n🤖 ${AI_NAME} Online`,
                quoted: msg
              });
              continue;
            }

            if (commandAlias === "piyas") {
              await sock.sendMessage(remoteJid, { text: PIYAS_INFO });
              continue;
            }

          } catch (messageError) {
            console.log("⚠️ Message error:", messageError?.message);
          }
        }
      } catch (error) {
        console.log("⚠️ Handler error:", error?.message);
      }
    });

    console.log("🚀 Starting bot...");
  } catch (error) {
    console.log("❌ Start failed:", error?.message);
    sock = null;
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(() => { reconnecting = false; startBot(); }, 5000);
    }
  }
}

/* =========================================================
   GLOBAL ERRORS
========================================================= */

process.on("uncaughtException", error => {
  console.log("❌ Uncaught:", error?.message);
});

process.on("unhandledRejection", error => {
  console.log("❌ Unhandled:", error?.message);
});

/* =========================================================
   SHUTDOWN
========================================================= */

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

/* =========================================================
   START
========================================================= */

loadBotStatus();
loadWarnings();
loadMuted();
loadAIStatus();
loadAIMemory();

startBot();