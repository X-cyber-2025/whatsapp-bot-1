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

const PHONE_NUMBER = (process.env.PHONE_NUMBER || "")
  .replace(/[^0-9]/g, "");

const WEBSITE_URL = "https://x-cyber-2025.github.io/X-cyber.web/";

const BACKUP_GROUP_URL =
  "https://chat.whatsapp.com/KsIJqeOdSTVC2FBIuWCvlN?s=cl&p=a&mlu=4&ilr=4";

const AUTH_DIR = "./auth_info";
const PAIRING_NUMBER_FILE = "./pairing_number.txt";
const BOT_STATUS_FILE = "./bot_status.json";
const WARNING_FILE = "./warnings.json";
const MUTE_FILE = "./muted.json";
const AI_STATUS_FILE = "./ai_status.json";

const BOT_NAME = "Piyas Bot";

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
const AI_MODEL = process.env.AI_MODEL || "gemini-1.5-flash-latest";
let geminiModel = null;

if (GEMINI_API_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({
      model: AI_MODEL
    });
    console.log(`🤖 Gemini AI ready (${AI_MODEL}).`);
  } catch (error) {
    console.log("⚠️ Gemini init error:", error?.message);
  }
} else {
  console.log("⚠️ GEMINI_API_KEY missing in .env");
}

/* =========================================================
   AI RATE LIMIT
========================================================= */

const aiRateLimit = new Map();
const AI_RATE_WINDOW = 60 * 1000;

function isAIRateLimited(memberJid) {
  const now = Date.now();
  const last = aiRateLimit.get(memberJid);
  if (!last || now - last > AI_RATE_WINDOW) {
    aiRateLimit.set(memberJid, now);
    return false;
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, time] of aiRateLimit.entries()) {
    if (!time || now - time > AI_RATE_WINDOW * 5) aiRateLimit.delete(key);
  }
}, 5 * 60 * 1000);

/* =========================================================
   AI STATUS (per group)
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
    console.log("⚠️ AI status load error:", error?.message);
    aiStatus = {};
  }
}

function saveAIStatus() {
  try {
    fs.writeFileSync(AI_STATUS_FILE, JSON.stringify(aiStatus, null, 2), "utf8");
  } catch (error) {
    console.log("⚠️ AI status save error:", error?.message);
  }
}

function isAIEnabled(groupId) {
  return aiStatus[groupId] !== false;
}

function setAIStatus(groupId, enabled) {
  aiStatus[groupId] = Boolean(enabled);
  saveAIStatus();
}

/* =========================================================
   DUPLICATE SPAM MEMORY
========================================================= */

const spamTracker = new Map();
const SPAM_WINDOW_MS = 60 * 1000;

/* =========================================================
   RATE LIMIT MEMORY
========================================================= */

const rateLimitTracker = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_COMMANDS = 3;

/* =========================================================
   ANTI-FORWARD MEMORY
========================================================= */

const forwardTracker = new Map();
const FORWARD_WINDOW_MS = 10 * 60 * 1000;

/* =========================================================
   MUTE MEMORY
========================================================= */

let mutedUsers = {};

/* =========================================================
   LOGGER
========================================================= */

const logger = P({ level: "silent" });

/* =========================================================
   MODERATION CONFIG
========================================================= */

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
  "সালা","শালা","সালি","সালী","শালি","ষালি","ষালী",
  "খাংকি","খাংকী","খানকি","খানকী","মাগি","মাগী",
  "বেসসা","বেশ্যা","বেশা","চোদা","চোদন","চুদ","চুদা",
  "চুদাচুদি","হারামি","হারামী","হারামজাদা","হারামজাদী",
  "কুত্তা","কুত্তার","শুয়োর","শুয়োরের","বাঞ্চোদ","বাল",
  "বালের","ফাক","ফাকিং","গাধা","গাধার","পাগল","পাগলি",
  "বদমাশ","বদমাশি","জারজ","জারজের","নষ্ট","নষ্টা",
  "কুত্তি","কুত্তির","শুয়োরি","মাদারচোদ","মাদারচোদন",
  "ভোদা","ভোদার","ভোদাই","পোদ","পোদা","পোদার",
  "লাওরা","লাওরার","ছিনাল","ছিনালি","ডাইনি","ডাইনির",
  "রান্ডি","রান্ডির","খানকির","মাগির","বেশ্যার",
  "চোদান","চোদানি","লেংটা","লেংটার","নাংগা","নাংগি",
  "হিজরা","হিজড়া","হিজড়ার","কাজা","কাজার",
  "বেক্কল","বেক্কলের","আবাল","আবালের","টালা","টালার",
  "চামার","চামারের","নীচ","নীচের","কমিনা","কমিনার",
  "বেইমান","বেইমানের","খবিশ","খবিশের","লম্পট","লম্পটের",
  "কুলাঙ্গার","কুলাঙ্গারের","অপদার্থ","অপদার্থের",
  "নপুংসক","নপুংসকের","ভণ্ড","ভণ্ডের","প্রতারক","প্রতারকের",
  "চোর","চোরের","ডাকাত","ডাকাতের","জোচ্চোর","জোচ্চোরের",
  "fuck","fucking","fucked","fucker","fuckers",
  "motherfucker","motherfucking","mf",
  "bitch","bitches","bitchy",
  "bastard","bastards",
  "asshole","assholes",
  "dick","dicks","dickhead",
  "pussy","pussies",
  "sex","sexy","sexual",
  "porn","porno","pornography",
  "cunt","cunts",
  "whore","whores",
  "slut","sluts",
  "nigga","nigger","niggas","niggers",
  "retard","retarded",
  "idiot","idiots","idiotic",
  "stupid","stupider","stupidest",
  "dumb","dumbass","dumbasses",
  "moron","morons","moronic",
  "fool","fools","foolish",
  "jerk","jerks",
  "loser","losers",
  "shit","shits","shitty","shitting",
  "crap","crappy",
  "damn","dammit","damned",
  "hell","hellish",
  "bloody","bloodyhell",
  "bugger","buggers",
  "wanker","wankers",
  "tosser","tossers",
  "twat","twats",
  "prick","pricks",
  "cock","cocks","cocksucker",
  "balls","ballsack",
  "tits","titties",
  "boobs","boobies",
  "rape","raped","raping","rapist",
  "molest","molested","molester",
  "pedo","pedophile","pedophiles",
  "kys","kyself",
  "stfu","gtfo",
  "wtf","wth",
  "omfg","omg",
  "fml","fubar",
  "madarchod","bhenchod","bhenchodd",
  "behenchod","behanchod","bhosdike","bhosdi",
  "chutiya","chutiye","chutiyapa",
  "gandu","gaandu","gaand",
  "harami","haramkhor","haramzada",
  "kutta","kutti","kutte","kutton",
  "suar","suvar","suwar",
  "randi","rand","randy",
  "loda","lode","laura","lauda",
  "bhosda","bhosdika",
  "lund","chinal","chinaal",
  "kamina","kamine","kaminay",
  "badmash","badmashi","badzaat",
  "najaiz","najayaz","haram",
  "বোকা","বোকার","বোকাচোদা","বোকাচোদ",
  "হাবলা","হাবলার","গবেট","গবেটের",
  "ল্যাংড়া","ল্যাংড়ার","কানা","কানার",
  "কালা","কালার","কুচকুচে","কুচকুচের",
  "মোটা","মোটার","চিকনা","চিকনার",
  "বামন","বামনের","খোঁড়া","খোঁড়ার",
  "ঠেংগা","ঠেংগার","নেংটা","নেংটার",
  "ছোটোলোক","ছোটোলোকের","হলদে","হলদের",
  "ম্লেচ্ছ","ম্লেচ্ছের","ইয়াতিম","ইয়াতিমের",
  "বেজন্মা","বেজন্মার","দুর্জন","দুর্জনের",
  "অধম","অধমের","পাপী","পাপীর",
  "ঘৃণ্য","ঘৃণ্যের","জঘন্য","জঘন্যের",
  "লজ্জাহীন","লজ্জাহীনের","বেহায়া","বেহায়ার",
  "নির্লজ্জ","নির্লজ্জের","বদনাম","বদনামের"
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
    console.log("⚠️ Warning data load error:", error?.message);
    warnings = {};
  }
}

function saveWarnings() {
  try {
    fs.writeFileSync(WARNING_FILE, JSON.stringify(warnings, null, 2), "utf8");
  } catch (error) {
    console.log("⚠️ Warning data save error:", error?.message);
  }
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
    console.log("⚠️ Mute data load error:", error?.message);
    mutedUsers = {};
  }
}

function saveMuted() {
  try {
    fs.writeFileSync(MUTE_FILE, JSON.stringify(mutedUsers, null, 2), "utf8");
  } catch (error) {
    console.log("⚠️ Mute data save error:", error?.message);
  }
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
   BAD WORD CHECK
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

/* =========================================================
   LINK CHECK
========================================================= */

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

/* =========================================================
   SPAM
========================================================= */

function normalizeSpamText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getSpamKey(groupId, memberJid) {
  return `${groupId}:${memberJid}`;
}

function isDuplicateSpam(groupId, memberJid, text) {
  if (!groupId || !memberJid || !text) return false;
  const normalized = normalizeSpamText(text);
  if (!normalized) return false;
  const key = getSpamKey(groupId, memberJid);
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

/* =========================================================
   RATE LIMIT
========================================================= */

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
  if (data.count > RATE_LIMIT_MAX_COMMANDS) return true;
  return false;
}

/* =========================================================
   ANTI-FORWARD
========================================================= */

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
      if (typeof botStatus[groupId].groupLockedUntil !== "number" && botStatus[groupId].groupLockedUntil !== null) {
        botStatus[groupId].groupLockedUntil = null;
      }
    }
    console.log("📂 Bot status loaded.");
  } catch (error) {
    console.log("⚠️ Bot status load error:", error?.message);
    botStatus = {};
  }
}

function saveBotStatus() {
  try {
    fs.writeFileSync(BOT_STATUS_FILE, JSON.stringify(botStatus, null, 2), "utf8");
  } catch (error) {
    console.log("⚠️ Bot status save error:", error?.message);
  }
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
   DELETE MESSAGE
========================================================= */

async function deleteMessage(remoteJid, message) {
  try {
    if (!sock || !remoteJid || !message?.key) return false;
    await sock.sendMessage(remoteJid, { delete: message.key });
    return true;
  } catch (error) {
    console.log("⚠️ Message delete error:", error?.message);
    return false;
  }
}

/* =========================================================
   MODERATION WARNING
========================================================= */

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

❗ বারবার Group Rules ভঙ্গ
না করার অনুরোধ করা হচ্ছে।

🚫 Member Remove/Kick করা হয়নি।

🤍 *Piyas Bot*
`;
    const messageData = { text };
    if (isPhoneJid(phoneJid)) messageData.mentions = [phoneJid];
    await sock.sendMessage(remoteJid, messageData);
  } catch (error) {
    console.log("⚠️ Moderation warning error:", error?.message);
  }
}

/* =========================================================
   MUTE WARNING
========================================================= */

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

📌 *কারণ:*
Admin কর্তৃক Mute করা হয়েছে।

❗ Mute শেষ না হওয়া পর্যন্ত
আপনি কোনো মেসেজ পাঠাতে
পারবেন না।

👑 Admin-এর সাথে যোগাযোগ
করুন Mute তুলে নেওয়ার জন্য।

🤍 *Piyas Bot*
`;
    if (isPhoneJid(memberJid)) {
      await sock.sendMessage(memberJid, { text });
    } else {
      await sock.sendMessage(remoteJid, { text, mentions: [memberJid] });
    }
  } catch (error) {
    console.log("⚠️ Mute warning error:", error?.message);
  }
}

/* =========================================================
   AI AUTO REPLY
========================================================= */

async function getAIReply(groupId, userMessage, userName) {
  if (!geminiModel) {
    console.log("⚠️ AI Reply: geminiModel is null");
    return null;
  }
  try {
    const prompt = `তুমি "Piyas Bot" — একটি বাংলাদেশী WhatsApp গ্রুপের বিনয়ী বট।

নিয়ম:
- বাংলায় উত্তর দাও (কেউ ইংরেজিতে লিখলে ইংরেজিতে)
- বিনয়ী ও সাহায্যকারী হও
- ছোট ও পরিষ্কার উত্তর (২-৪ লাইন)
- অশ্লীল, রাজনৈতিক বা ধর্মীয় বিতর্ক এড়িয়ে চলো
- গ্রুপের নিয়ম: /rules
- Deal করতে: /deal
- Website: /website

ইউজারের নাম: ${userName}
ইউজার লিখেছে: ${userMessage}

তোমার উত্তর:`;

    const result = await geminiModel.generateContent(prompt);
    const reply = result?.response?.text()?.trim();
    if (!reply) {
      console.log("⚠️ AI Reply: empty response");
      return null;
    }
    return reply;
  } catch (error) {
    console.log("⚠️ AI reply error:", error?.message || error);
    return null;
  }
}

/* =========================================================
   MODERATE MESSAGE (শুধু বট অ্যাডমিন থাকলে কাজ করবে)
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
          if (isModerationEnabled(remoteJid, "warnings")) {
            await sendModerationWarning(remoteJid, message, `Bad Word: ${badWord}`, warningCount);
          }
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