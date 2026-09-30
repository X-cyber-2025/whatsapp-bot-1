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
const AI_MODEL = process.env.AI_MODEL || "gemini-1.5-flash";
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
  if (!geminiModel) return null;
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
    return result.response.text().trim();
  } catch (error) {
    console.log("⚠️ AI reply error:", error?.message);
    return null;
  }
}

/* =========================================================
   MODERATE MESSAGE
========================================================= */

async function moderateMessage(remoteJid, message, text) {
  try {
    if (!remoteJid || !message || !text) return false;
    if (!isBotEnabled(remoteJid)) return false;

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
      if (isDuplicateSpam(remoteJid, targetJid, text)) {
        const deleted = await deleteMessage(remoteJid, message);
        if (deleted) {
          let warningCount = 0;
          if (isModerationEnabled(remoteJid, "warnings")) {
            warningCount = addWarning(remoteJid, targetJid);
          }
          if (isModerationEnabled(remoteJid, "warnings")) {
            await sendModerationWarning(remoteJid, message,
              "Duplicate Spam: একই Message ১ মিনিটের মধ্যে পুনরায় পাঠানো হয়েছে",
              warningCount);
          }
        }
        return true;
      }
    }

    return false;
  } catch (error) {
    console.log("⚠️ Moderation error:", error?.message);
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
      connected: !!sock,
      ai: !!geminiModel,
      model: AI_MODEL,
      uptime: Math.floor(process.uptime()),
      groups: Object.keys(botStatus).length,
      warnings: Object.keys(warnings).length,
      muted: Object.keys(mutedUsers).length,
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + " MB"
    }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("WhatsApp Bot is running!");
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

/* =========================================================
   NAME HELPERS
========================================================= */

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

/* =========================================================
   LID MAPPING
========================================================= */

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

/* =========================================================
   CONTACT CACHE
========================================================= */

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

/* =========================================================
   PHONE JID
========================================================= */

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
    if (phoneJid && isLidJid(participant.id)) saveLidMapping(participant.id, phoneJid);
    if (phoneJid && isLidJid(participant.lid)) saveLidMapping(participant.lid, phoneJid);
    if (name && name !== "Member") {
      if (participant.id) contactNames.set(participant.id, name);
      if (participant.lid) contactNames.set(participant.lid, name);
      if (phoneJid) contactNames.set(phoneJid, name);
    }
  }
}

/* =========================================================
   GROUP HELPERS
========================================================= */

function isAdminParticipant(participant = {}) {
  return participant.admin === "admin" ||
         participant.admin === "superadmin" ||
         participant.admin === true ||
         participant.isAdmin === true ||
         participant.isSuperAdmin === true;
}

function isOwnerParticipant(participant = {}) {
  return participant.admin === "superadmin" || participant.isSuperAdmin === true;
}

function findParticipant(participants = [], jid) {
  if (!jid) return null;
  return participants.find(p =>
    p?.id === jid || p?.lid === jid || p?.phoneNumber === jid
  ) || null;
}

/* =========================================================
   BOT JID
========================================================= */

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

/* =========================================================
   BOT ADMIN CHECK
========================================================= */

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
    if (!botParticipant && botPhoneJid) {
      const botNumber = botPhoneJid.split("@")[0].replace(/[^0-9]/g, "");
      botParticipant = participants.find(p => {
        const phone = String(p?.phoneNumber || "").replace(/@s.whatsapp.net/g, "").replace(/[^0-9]/g, "");
        return phone && phone === botNumber;
      });
    }
    if (!botParticipant && botJid && isLidJid(botJid)) {
      const resolved = await resolveLidToPhoneJid(botJid);
      if (resolved) botParticipant = findParticipant(participants, resolved);
    }
    if (!botParticipant) return false;
    return isAdminParticipant(botParticipant);
  } catch (error) {
    console.log("⚠️ Bot admin check error:", error?.message);
    return false;
  }
}

async function isGroupAllowed(groupId) {
  if (!groupId || !groupId.endsWith("@g.us")) return false;
  return await isBotAdminInGroup(groupId);
}

/* =========================================================
   SENDER ADMIN
========================================================= */

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
    if (!sender) {
      sender = participants.find(p =>
        p?.id === participantJid || p?.lid === participantJid || p?.phoneNumber === participantJid
      );
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
                text: "🤖 PIYAS BOT"
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
        🤖 *BOT MENU*
╰━━━━━━━━━━━━━━━━━━━━╯

╭─❖ 👥 *GROUP COMMANDS*
│
│ 1️⃣ ${enabled("menu") ? "/menu" : "🔴 /menu OFF"}
│ 2️⃣ ${enabled("bot") ? "/bot" : "🔴 /bot OFF"}
│ 3️⃣ ${enabled("rules") ? "/rules" : "🔴 /rules OFF"}
│ 4️⃣ ${enabled("admin") ? "/admin" : "🔴 /admin OFF"}
│ 5️⃣ ${enabled("members") ? "/members" : "🔴 /members OFF"}
│ 6️⃣ ${enabled("groupinfo") ? "/groupinfo" : "🔴 /groupinfo OFF"}
│ 7️⃣ ${enabled("id") ? "/id" : "🔴 /id OFF"}
│ 8️⃣ ${enabled("tagall") ? "/tagall <msg> 🔒" : "🔴 /tagall OFF"}
╰────────────────────

╭─❖ 🤖 *AI COMMANDS*
│
│ 9️⃣ ${enabled("ai") ? "/ai <প্রশ্ন>" : "🔴 /ai OFF"}
│ 🔟 @ai <প্রশ্ন>
│ 1️⃣1️⃣ বটকে মেনশন করে প্রশ্ন
╰────────────────────

╭─❖ ⚙️ *UTILITY*
│
│ 1️⃣2️⃣ ${enabled("ping") ? "/ping" : "🔴 /ping OFF"}
╰────────────────────

╭─❖ 💰 *BUY / SELL*
│
│ 1️⃣3️⃣ ${enabled("deal") ? "/deal /ডিল" : "🔴 /deal /ডিল OFF"}
╰────────────────────

╭─❖ 🤍 *PIYAS*
│
│ 1️⃣4️⃣ ${enabled("piyas") ? "/piyas" : "🔴 /piyas OFF"}
╰────────────────────

╭─❖ 🌐 *OUR WEBSITE*
│
│ 1️⃣5️⃣ ${enabled("website") ? "/website" : "🔴 /website OFF"}
╰────────────────────

╭─❖ 🧮 *CALCULATOR*
│
│ 1️⃣6️⃣ /20+2
│ 1️⃣7️⃣ /100-25
│ 1️⃣8️⃣ /20*5
│ 1️⃣9️⃣ /100/4
╰────────────────────

━━━━━━━━━━━━━━━━━━━━
🔒 = Admin Only
━━━━━━━━━━━━━━━━━━━━
`;
}

async function sendPublicMenu(remoteJid) {
  try {
    await sock.sendMessage(remoteJid, { text: buildMenuText(remoteJid) });
    const commands = [
      "/menu", "/bot", "/rules", "/admin", "/members",
      "/groupinfo", "/id", "/tagall", "/ping", "/deal",
      "/ডিল", "/piyas", "/website", "/ai বাংলাদেশের রাজধানী কোথায়?"
    ].filter(command => isCommandEnabled(remoteJid, command));
    await sendCopyButtons(remoteJid, commands);
  } catch (error) {
    console.log("❌ Public menu error:", error?.message);
  }
}

/* =========================================================
   CALCULATOR
========================================================= */

function calculateExpression(expression) {
  try {
    const value = String(expression || "").trim().replace(/,/g, "");
    if (!value) return null;
    if (!/^[0-9+\-*/%.()\s]+$/.test(value)) return null;
    if (value.includes("**") || value.includes("//") || value.includes("/*") || value.includes("*/")) return null;
    if (!/\d/.test(value)) return null;
    if (!/[+\-*/%]/.test(value)) return null;
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
  return /^[0-9+\-*/%.()\s]+$/.test(expression);
}

async function handleCalculator(remoteJid, text) {
  try {
    const expression = String(text).trim().slice(1).trim();
    const result = calculateExpression(expression);
    if (result === null) {
      await sock.sendMessage(remoteJid, {
        text: `🧮 *CALCULATOR*\n\n❌ হিসাবটি সঠিক নয়।\n\n💡 উদাহরণ:\n/20+2\n/100-25\n/20*5\n/100/4\n/(20+5)*2\n/500+250-100\n\n🤍 *Piyas Bot*`
      });
      return true;
    }
    const formattedResult = formatCalculationResult(result);
    await sock.sendMessage(remoteJid, {
      text: `🧮 *CALCULATOR*\n\n📌 Expression: ${expression}\n\n✅ Result: ${formattedResult}\n\n🤍 *Piyas Bot*`
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
    const commandStatus = COMMAND_DEFINITIONS.map(item => {
      const enabled = !disabled.includes(item.key);
      return `│ ${enabled ? "🟢" : "🔴"} ${item.command} ${enabled ? "ON" : "OFF"}`;
    }).join("\n");

    const moderation = getModerationStatus(remoteJid);
    const lock = getGroupStatus(remoteJid).groupLockedUntil;
    const lockStatus = typeof lock === "number" && lock > Date.now()
      ? `🔒 Group Closed\n⏰ ${new Date(lock).toLocaleString("en-BD")}`
      : "🔓 Group Open";

    const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
       👑 *ADMIN PANEL*
╰━━━━━━━━━━━━━━━━━━━━╯

🔐 *শুধুমাত্র Group Owner ও Admin-এর জন্য*

╭─❖ 🤖 *BOT STATUS*
│ ${isBotEnabled(remoteJid) ? "🟢 Bot: ON" : "🔴 Bot: OFF"}
│ ${isAIEnabled(remoteJid) ? "🟢 AI: ON" : "🔴 AI: OFF"}
│ 📦 Model: ${AI_MODEL}
╰────────────────────

╭─❖ 🔒 *GROUP STATUS*
│ ${lockStatus}
╰────────────────────

╭─❖ ⚙️ *COMMAND STATUS*
${commandStatus}
╰────────────────────

╭─❖ 🛡️ *MODERATION*
│ ${moderation.badWords ? "🟢" : "🔴"} Bad Word: ${moderation.badWords ? "ON" : "OFF"}
│ ${moderation.links ? "🟢" : "🔴"} Link: ${moderation.links ? "ON" : "OFF"}
│ ${moderation.spam ? "🟢" : "🔴"} Duplicate Spam: ${moderation.spam ? "ON" : "OFF"}
│ ${moderation.warnings ? "🟢" : "🔴"} Warning: ${moderation.warnings ? "ON" : "OFF"}
│ ${moderation.antiForward ? "🟢" : "🔴"} Anti-Forward: ${moderation.antiForward ? "ON" : "OFF"}
╰────────────────────

╭─❖ 🔇 *MUTE CONTROL* 🔒
│ /mute @user 10m
│ /unmute @user
│ /mutelist
╰────────────────────

╭─❖ 🤖 *AI CONTROL* 🔒
│ /aion — AI চালু
│ /aioff — AI বন্ধ
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
  } catch (error) {
    console.log("❌ Admin panel error:", error?.message);
  }
}

/* =========================================================
   COMMAND LIST
========================================================= */

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
    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
      📋 *COMMAND STATUS*
╰━━━━━━━━━━━━━━━━━━━━╯

${commandLines.join("\n")}

━━━━━━━━━━━━━━━━━━━━
🟢 ON: ${onCount}
🔴 OFF: ${offCount}
🔒 = Admin Only
━━━━━━━━━━━━━━━━━━━━
`
  });
}

/* =========================================================
   MOD STATUS
========================================================= */

async function sendModerationStatus(remoteJid) {
  const disabled = getGroupStatus(remoteJid).disabledCommands || [];
  const moderation = getModerationStatus(remoteJid);
  const disabledText = disabled.length
    ? disabled.map(command => `│ 🔴 /${command}`).join("\n")
    : "│ 🟢 কোনো Command OFF নেই";

  await sock.sendMessage(remoteJid, {
    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
        🛠️ *MOD STATUS*
╰━━━━━━━━━━━━━━━━━━━━╯

╭─❖ 🚫 *COMMAND OFF*
${disabledText}
╰────────────────────

╭─❖ 🛡️ *MODERATION*
│ ${moderation.badWords ? "🟢" : "🔴"} Bad Word: ${moderation.badWords ? "ON" : "OFF"}
│ ${moderation.links ? "🟢" : "🔴"} Link: ${moderation.links ? "ON" : "OFF"}
│ ${moderation.spam ? "🟢" : "🔴"} Duplicate Spam: ${moderation.spam ? "ON" : "OFF"}
│ ${moderation.warnings ? "🟢" : "🔴"} Warning: ${moderation.warnings ? "ON" : "OFF"}
│ ${moderation.antiForward ? "🟢" : "🔴"} Anti-Forward: ${moderation.antiForward ? "ON" : "OFF"}
╰────────────────────
`
  });
}

/* =========================================================
   RULES
========================================================= */

const GROUP_RULES = `
╭━━━━━━━━━━━━━━━━━━━━╮
        📜 *GROUP RULES*
╰━━━━━━━━━━━━━━━━━━━━╯

1️⃣ সবাইকে সম্মান করে কথা বলুন।

2️⃣ অশ্লীল বা আপত্তিকর কোনো
কনটেন্ট শেয়ার করবেন না।

3️⃣ Spam বা একই মেসেজ
বারবার পাঠাবেন না।

4️⃣ ১০ মিনিটের মধ্যে একই
Forward বারবার পাঠাবেন না।

5️⃣ সন্দেহজনক লিংক শেয়ার করবেন না।

6️⃣ Admin ছাড়া কেউ লিংক
শেয়ার করতে পারবে না।

7️⃣ অন্য সদস্যকে হয়রানি
করবেন না।

8️⃣ সমস্যায় পড়লে Admin-কে জানান।

🛡️ Bad Word, Link, Spam,
Anti-Forward শনাক্ত হলে
Message Delete হতে পারে।

🤍 *Piyas*
`;

/* =========================================================
   WEBSITE
========================================================= */

const WEBSITE_TEXT = `
╭━━━━━━━━━━━━━━━━━━━━╮
      🌐 *OUR WEBSITE*
╰━━━━━━━━━━━━━━━━━━━━╯

🌐 *Official Website:*

${WEBSITE_URL}

🎁 এখানে Account Buy/Sell,
Google Play Points এবং
অন্যান্য earning সম্পর্কিত
তথ্য পাওয়া যাবে।

🤍 *Piyas*
`;

/* =========================================================
   PIYAS
========================================================= */

const PIYAS_INFO = `
╭━━━━━━━━━━━━━━━━━━╮
       🤍 *PIYAS*
╰━━━━━━━━━━━━━━━━━━╯

👤 *Name:* মোঃ আল আমিন
🌐 *English Name:* MD. AL AMIN

👨‍👦 *Father:* মোঃ মোশারফ হোসেন
👩‍👦 *Mother:* মোসাম্মৎ রীপা বেগম

🎂 *Date of Birth:* ০৯ জানুয়ারি ২০০৬
🩸 *Blood Group:* A+

💍 *Marital Status:* Unmarried

🏠 *Address:*
গ্রাম/রাস্তা: বলদার চর, নান্দাইল
ডাকঘর: হেমগঞ্জ বাজার - ২২৯০
নান্দাইল, ময়মনসিংহ

🤍 *Thank You*
`;

/* =========================================================
   BOT ON / OFF
========================================================= */

const BOT_OFF_TEXT = `🔴 *BOT OFF*\n\nবট এখন সাময়িকভাবে বন্ধ করা হয়েছে।\n\n👑 শুধুমাত্র Admin / Owner আবার চালু করতে পারবেন।\n\n🟢 /boton`;
const BOT_ON_TEXT = `🟢 *BOT ON*\n\nবট এখন পুনরায় চালু করা হয়েছে। ✅\n\n🤍 *Piyas*`;
const BOT_ALREADY_OFF_TEXT = `🔴 *BOT STATUS*\n\nবট ইতোমধ্যে OFF আছে।`;
const BOT_ALREADY_ON_TEXT = `🟢 *BOT STATUS*\n\nবট ইতোমধ্যে ON আছে।`;

/* =========================================================
   DEAL
========================================================= */

const DEAL_NOTICE_TOP = `
╭━━━━━━━━━━━━━━━━━━━━╮
        🤝 *DEAL NOTICE*
╰━━━━━━━━━━━━━━━━━━━━╯

⚠️ *গুরুত্বপূর্ণ সতর্কতা!*

কোনো ধরনের Account Buy/Sell,
Google Play Points অথবা অন্য
কোনো Deal করার আগে অবশ্যই
Group-এর Admin-এর সাথে
যোগাযোগ করুন।

🚫 *Admin ছাড়া কারো সাথে
কোনো Deal করবেন না।*

👑 *Deal করার জন্য Group Admin:*

`;

const DEAL_NOTICE_BOTTOM = `
📌 নিরাপদ থাকতে সবসময়
Admin-এর মাধ্যমে Deal করুন।

🤍 *PIYAS*
`;

/* =========================================================
   ADMIN DATA
========================================================= */

async function getAdminData(remoteJid) {
  try {
    const metadata = await sock.groupMetadata(remoteJid);
    const participants = metadata?.participants || [];
    await cacheParticipants(participants);
    const adminParticipants = participants.filter(isAdminParticipant);
    const result = [];
    const usedJids = new Set();

    for (const participant of adminParticipants) {
      const phoneJid = await getPhoneJid(participant);
      let name = getDisplayName(participant);
      if (!name || name === "Member") name = "Admin";
      if (phoneJid && usedJids.has(phoneJid)) continue;
      if (phoneJid) usedJids.add(phoneJid);
      result.push({
        jid: phoneJid || participant.id || participant.lid || null,
        name,
        owner: isOwnerParticipant(participant)
      });
    }
    return { admins: result, result };
  } catch (error) {
    return { admins: [], result: [] };
  }
}

async function sendAdminList(remoteJid) {
  const { admins } = await getAdminData(remoteJid);
  if (!admins.length) {
    await sock.sendMessage(remoteJid, { text: "👑 এই গ্রুপে কোনো Admin পাওয়া যায়নি।" });
    return;
  }
  const lines = [];
  const mentions = [];
  let number = 1;
  for (const admin of admins) {
    const role = admin.owner ? "⭐ *Group Owner*" : "👑 *Admin*";
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
    text: `👑 *GROUP ADMINS*\n\n${lines.join("\n\n")}\n\n👥 *মোট Admin:* ${admins.length} জন\n\n🤍 *Piyas*`,
    mentions
  });
}

async function sendDealNotice(remoteJid) {
  const { admins } = await getAdminData(remoteJid);
  if (!admins.length) {
    await sock.sendMessage(remoteJid, {
      text: DEAL_NOTICE_TOP + "⚠️ বর্তমানে কোনো Admin পাওয়া যায়নি.\n\n" + DEAL_NOTICE_BOTTOM
    });
    return;
  }
  const lines = [];
  const mentions = [];
  let number = 1;
  for (const admin of admins) {
    const role = admin.owner ? "⭐ *Group Owner*" : "👑 *Admin*";
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
    text: DEAL_NOTICE_TOP + lines.join("\n\n") + `\n\n👥 *মোট Admin:* ${admins.length} জন\n\n` + DEAL_NOTICE_BOTTOM,
    mentions
  });
}

/* =========================================================
   WELCOME
========================================================= */

function getWelcomeText(name, groupName) {
  const safeName = cleanName(name) || "Member";
  const safeGroupName = cleanName(groupName) || "এই গ্রুপ";
  return `
╭━━━━━━━━━━━━━━━━━━━━╮
        🎉 *স্বাগতম*
╰━━━━━━━━━━━━━━━━━━━━╯

🎉 *স্বাগতম @${safeName}* ❤️

🌸 আপনাকে *${safeGroupName}*
গ্রুপে স্বাগতম।

📌 গ্রুপের নিয়ম দেখতে লিখুন:
*/rules*

🌐 Website দেখতে লিখুন:
*/website*

🌐 আমাদের Website:
${WEBSITE_URL}

🔰 *ব্যাকআপ গ্রুপে যুক্ত থাকুন:*
${BACKUP_GROUP_URL}

❤️ *Piyas*
`;
}

async function sendWelcome(groupId, participant) {
  try {
    if (!sock || !isBotEnabled(groupId)) return;
    let metadata = null;
    try {
      metadata = await sock.groupMetadata(groupId);
      await cacheParticipants(metadata?.participants || []);
    } catch {}

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

/* =========================================================
   GOODBYE
========================================================= */

function getGoodbyeText(name, groupName) {
  const safeName = cleanName(name) || "Member";
  const safeGroupName = cleanName(groupName) || "এই গ্রুপ";
  return `
╭━━━━━━━━━━━━━━━━━━━━╮
        👋 *বিদায়*
╰━━━━━━━━━━━━━━━━━━━━╯

👋 *@${safeName}* গ্রুপ ছেড়ে চলে গেলেন।

🌸 তিনি *${safeGroupName}*
গ্রুপের সদস্য ছিলেন।

💙 আবার আসবেন, ভালো থাকবেন।

🤍 *Piyas*
`;
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
    const phoneJid = await getPhoneJid(member);
    const goodbyeText = getGoodbyeText(name, groupName);

    if (isPhoneJid(phoneJid)) {
      await sock.sendMessage(groupId, { text: goodbyeText, mentions: [phoneJid] });
    } else {
      await sock.sendMessage(groupId, { text: goodbyeText.replace(`@${name}`, name) });
    }
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
  const words = {
    "এক":1,"দুই":2,"তিন":3,"চার":4,"পাঁচ":5,"ছয়":6,"সাত":7,"আট":8,"নয়":9,"দশ":10,
    "বিশ":20,"ত্রিশ":30,"পঞ্চাশ":50,"একশ":100,"একশো":100
  };
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
    if (!sock || !remoteJid || !remoteJid.endsWith("@g.us")) return false;
    const botAdmin = await isBotAdminInGroup(remoteJid);
    if (!botAdmin) {
      await sock.sendMessage(remoteJid, { text: `❌ *Group বন্ধ করা যাচ্ছে না।*\n\n🤖 Bot-কে অবশ্যই Group Admin করে দিতে হবে।` });
      return false;
    }
    await sock.groupSettingUpdate(remoteJid, "announcement");
    const status = getGroupStatus(remoteJid);
    status.groupLockedUntil = Date.now() + durationMs;
    saveBotStatus();
    await sock.sendMessage(remoteJid, {
      text: `🔒 *GROUP CLOSED*\n\n🔒 এখন শুধুমাত্র Group Admin Message পাঠাতে পারবে।\n\n⏱️ *সময়:* ${formatGroupDuration(durationMs)}\n\n🤍 *Piyas Bot*`
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function unlockGroup(remoteJid, reason = "manual") {
  try {
    if (!sock || !remoteJid || !remoteJid.endsWith("@g.us")) return false;
    await sock.groupSettingUpdate(remoteJid, "not_announcement");
    const status = getGroupStatus(remoteJid);
    status.groupLockedUntil = null;
    saveBotStatus();
    if (reason === "timer") {
      await sock.sendMessage(remoteJid, {
        text: `🔓 *GROUP OPEN*\n\n⏰ নির্ধারিত সময় শেষ হয়েছে।\n\n👥 এখন সবাই Message পাঠাতে পারবে।\n\n🤍 *Piyas Bot*`
      });
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
    const lockedUntil = status.groupLockedUntil;
    if (typeof lockedUntil !== "number") continue;
    if (lockedUntil <= now) await unlockGroup(groupId, "timer");
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
      try {
        if (isPhoneJid(memberJid)) {
          await sock.sendMessage(memberJid, {
            text: `🔊 *Mute শেষ*\n\nআপনার Mute শেষ হয়েছে।\n\n✅ এখন আপনি আবার Message পাঠাতে পারবেন।\n\n🤍 *Piyas Bot*`
          });
        }
      } catch {}
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
      console.log("🗑️ Old WhatsApp session removed.");
    }
  } catch (error) {
    console.log("❌ Failed to remove old session:", error?.message);
  }
}

async function generatePairingCode(state) {
  try {
    if (!PHONE_NUMBER) {
      console.log("❌ PHONE_NUMBER is missing in .env");
      return;
    }
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
   MESSAGE TEXT
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
      await sock.sendMessage(remoteJid, { text: "❌ কোনো Member পাওয়া যায়নি।" });
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
    await sock.sendMessage(remoteJid, { text: "❌ Tag All করতে সমস্যা হয়েছে।" });
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
        text: `🔇 *MUTE SYSTEM* 🔒\n\nব্যবহার:\n/mute @user 10m\n/mute @user 2h\n/mute @user 1d\n/mute @user 1h 30m`
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
      text: `🔇 *MUTED*\n\n${names.join(", ")} কে Mute করা হয়েছে।\n\n⏱️ *সময়:* ${formatGroupDuration(durationMs)}\n\n🤍 *Piyas Bot*`,
      mentions: mentioned
    });
  } catch (error) {}
}

async function handleUnmute(remoteJid, message) {
  try {
    const mentioned = getMentionedJids(message);
    if (!mentioned.length) {
      await sock.sendMessage(remoteJid, { text: "❌ কাউকে মেনশন করুন।\n\nউদাহরণ: /unmute @user" });
      return;
    }
    const names = [];
    for (const jid of mentioned) {
      const memberJid = await getPhoneJid({ id: jid }) || jid;
      const removed = removeMute(remoteJid, memberJid);
      if (removed) names.push(`@${memberJid.split("@")[0]}`);
    }
    if (!names.length) {
      await sock.sendMessage(remoteJid, { text: "⚠️ এই Member Mute ছিল না।" });
      return;
    }
    await sock.sendMessage(remoteJid, {
      text: `🔊 *UNMUTED*\n\n${names.join(", ")} এর Mute তুলে নেওয়া হয়েছে।\n\n🤍 *Piyas Bot*`,
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
      await sock.sendMessage(remoteJid, { text: `🔊 *MUTE LIST*\n\nএই গ্রুপে কেউ Mute নেই।\n\n🤍 *Piyas Bot*` });
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
      text: `🔇 *MUTE LIST*\n\n${lines.join("\n")}\n\n👥 মোট: ${list.length} জন\n\n🤍 *Piyas Bot*`,
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
        const botIsAdmin = await isGroupAllowed(groupId);
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
          console.log("🔄 Connecting to WhatsApp...");
          if (PHONE_NUMBER && !state.creds.registered) {
            await generatePairingCode(state);
          }
        }

        if (connection === "open") {
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.log("✅ WhatsApp Bot Connected Successfully!");
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          reconnecting = false;
          pairingRequested = false;
          return;
        }

        if (connection === "close") {
          const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          console.log(`❌ WhatsApp connection closed. Code: ${statusCode}`);
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

    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        if (!Array.isArray(messages)) return;

        for (const message of messages) {
          try {
            if (!message) continue;
            if (message.key?.fromMe) continue;

            const remoteJid = message.key?.remoteJid;
            if (!remoteJid || !remoteJid.endsWith("@g.us")) continue;

            const botIsAdmin = await isGroupAllowed(remoteJid);
            if (!botIsAdmin) continue;

            const text = getMessageText(message);
            if (!text) continue;

            const moderated = await moderateMessage(remoteJid, message, text);
            if (moderated) continue;

            const trimmedText = text.trim();

            /* 🤖 AI AUTO REPLY - FIXED LOGIC */
            const botJid = getBotPhoneJid();
            const mentioned = getMentionedJids(message);
            const textLower = trimmedText.toLowerCase();
            
            // বটকে মেনশন করা হয়েছে কি না (ফোন নাম্বার বা LID JID উভয় ভাবেই চেক)
            const botMentioned = botJid && mentioned.some(jid => 
              jid === botJid || 
              (jid.includes("@lid") && botJid.includes(jid.split("@")[0]))
            );

            // AI কমান্ড ডিটেকশন
            const isAICommand = textLower.startsWith("/ai ") || textLower === "/ai";
            const isAIMention = textLower.startsWith("@ai ") || textLower === "@ai";

            if ((botMentioned || isAICommand || isAIMention) && isBotEnabled(remoteJid) && isAIEnabled(remoteJid)) {
              const sender = message.key.participant;
              const phoneJid = await getPhoneJid({ id: sender });
              const name = contactNames.get(phoneJid) || "User";

              if (isAIRateLimited(phoneJid)) {
                await sock.sendMessage(remoteJid, {
                  text: "⏳ একটু অপেক্ষা করুন...",
                  quoted: message
                });
                continue;
              }

              // প্রশ্ন বের করা
              let question = trimmedText
                .replace(/^\/ai\s+/i, "")
                .replace(/^@ai\s+/i, "");

              // মেনশন টেক্সট রিমুভ করা (নাম্বার এবং LID উভয়ের জন্য)
              if (botJid) {
                const botNumber = botJid.split("@")[0];
                question = question.replace(new RegExp(`@${botNumber}`, "gi"), "").trim();
              }

              if (!question) {
                await sock.sendMessage(remoteJid, {
                  text: "❓ কী জানতে চান? লিখুন।\n\nউদাহরণ:\n/ai বাংলাদেশের রাজধানী কোথায়?",
                  quoted: message
                });
                continue;
              }

              await sock.sendMessage(remoteJid, {
                text: "🤔 ভাবছি...",
                quoted: message
              });

              const reply = await getAIReply(remoteJid, question, name);
              if (reply) {
                await sock.sendMessage(remoteJid, {
                  text: `🤖 *AI Reply*\n\n${reply}\n\n🤍 *Piyas Bot*`,
                  quoted: message
                });
              } else {
                await sock.sendMessage(remoteJid, {
                  text: "❌ দুঃখিত, উত্তর দিতে পারছি না।",
                  quoted: message
                });
              }
              continue;
            }

            /* CALCULATOR */
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

            if (ADMIN_ONLY_COMMANDS.includes(command)) {
              const admin = await isSenderAdmin(remoteJid, message);
              if (!admin) {
                if (command === "mute" || command === "unmute" || command === "mutelist" ||
                    command === "aion" || command === "aioff") {
                  await sock.sendMessage(remoteJid, {
                    text: `❌ *ADMIN ONLY* 🔒\n\nএই Command শুধুমাত্র Group Admin/Owner ব্যবহার করতে পারবেন।`
                  });
                }
                continue;
              }
            }

            if (command === "গ্রুপ") {
              const subCommand = normalizeCommandName(args[0]);
              if (subCommand !== "বন্ধ") {
                await sock.sendMessage(remoteJid, {
                  text: `🔒 *GROUP CONTROL*\n\nব্যবহার:\n/গ্রুপ বন্ধ 2 মিনিট`
                });
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

            if (command === "aion") {
              setAIStatus(remoteJid, true);
              await sock.sendMessage(remoteJid, { text: "🤖 *AI ON*\n\n✅ এখন থেকে AI রিপ্লাই দিবে।" });
              continue;
            }
            if (command === "aioff") {
              setAIStatus(remoteJid, false);
              await sock.sendMessage(remoteJid, { text: "🤖 *AI OFF*\n\n❌ AI বন্ধ করা হয়েছে।" });
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

            if (command === "mod" || command === "moderation" || command === "modstatus") {
              await sendModerationStatus(remoteJid);
              continue;
            }

            if (command === "modon") {
              setModerationStatus(remoteJid, "badWords", true);
              setModerationStatus(remoteJid, "links", true);
              setModerationStatus(remoteJid, "spam", true);
              setModerationStatus(remoteJid, "warnings", true);
              setModerationStatus(remoteJid, "antiForward", true);
              await sock.sendMessage(remoteJid, { text: "🛡️ *MODERATION ON*" });
              continue;
            }

            if (command === "modoff") {
              setModerationStatus(remoteJid, "badWords", false);
              setModerationStatus(remoteJid, "links", false);
              setModerationStatus(remoteJid, "spam", false);
              setModerationStatus(remoteJid, "warnings", false);
              setModerationStatus(remoteJid, "antiForward", false);
              await sock.sendMessage(remoteJid, { text: "🛡️ *MODERATION OFF*" });
              continue;
            }

            if (command === "on" || command === "off") {
              const targetRaw = args[0] || "";
              const target = getCanonicalCommand(targetRaw);
              if (!target) {
                await sock.sendMessage(remoteJid, { text: "⚙️ /off <command>" });
                continue;
              }
              if (PROTECTED_COMMANDS.includes(target)) {
                await sock.sendMessage(remoteJid, { text: "⚠️ এই Command বন্ধ করা যাবে না।" });
                continue;
              }
              if (!isKnownCommand(target)) {
                await sock.sendMessage(remoteJid, { text: `❌ /${target} নামে কোনো Command নেই।` });
                continue;
              }
              const enable = command === "on";
              setCommandStatus(remoteJid, target, enable);
              await sock.sendMessage(remoteJid, {
                text: `${enable ? "🟢" : "🔴"} */${target}* ${enable ? "ON" : "OFF"} করা হয়েছে।`
              });
              continue;
            }

            if (command === "cmdlist") {
              await sendCommandList(remoteJid);
              continue;
            }

            if (command === "mute") {
              await handleMute(remoteJid, message, args);
              continue;
            }
            if (command === "unmute") {
              await handleUnmute(remoteJid, message);
              continue;
            }
            if (command === "mutelist") {
              await handleMuteList(remoteJid);
              continue;
            }

            if (!isBotEnabled(remoteJid)) continue;

            const commandAlias = getCanonicalCommand(command);
            if (!isKnownCommand(commandAlias)) continue;
            if (!isCommandEnabled(remoteJid, commandAlias)) continue;

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
              const participants = metadata?.participants || [];
              await sock.sendMessage(remoteJid, {
                text: `👥 *GROUP MEMBERS*\n\nমোট Member: ${participants.length} জন`
              });
              continue;
            }

            if (commandAlias === "groupinfo") {
              const metadata = await sock.groupMetadata(remoteJid);
              const participants = metadata?.participants || [];
              const admins = participants.filter(isAdminParticipant);
              await sock.sendMessage(remoteJid, {
                text: `👥 *GROUP INFO*\n\n📛 *Name:* ${metadata?.subject || "Unknown"}\n\n🆔 *ID:* ${remoteJid}\n\n👥 *Members:* ${participants.length}\n\n👑 *Admins:* ${admins.length}\n\n🤖 *Bot:* ${isBotEnabled(remoteJid) ? "🟢 ON" : "🔴 OFF"}\n\n🧠 *AI:* ${isAIEnabled(remoteJid) ? "🟢 ON" : "🔴 OFF"}\n\n🤍 *Powered by Piyas*`
              });
              continue;
            }

            if (commandAlias === "id") {
              await sock.sendMessage(remoteJid, { text: `🆔 *GROUP ID*\n\n${remoteJid}` });
              continue;
            }

            if (commandAlias === "ping") {
              const start = Date.now();
              const msg = await sock.sendMessage(remoteJid, { text: "🏓 Checking Bot..." });
              const ping = Date.now() - start;
              await sock.sendMessage(remoteJid, {
                text: `🏓 *PONG!*\n\n⚡ Response: ${ping}ms\n🤖 Bot: Online`,
                quoted: msg
              });
              continue;
            }

            if (commandAlias === "piyas") {
              await sock.sendMessage(remoteJid, { text: PIYAS_INFO });
              continue;
            }
          } catch (messageError) {
            console.log("⚠️ Single message error:", messageError?.message);
          }
        }
      } catch (error) {
        console.log("⚠️ Message handler error:", error?.message);
      }
    });

    console.log("🚀 WhatsApp Bot Starting...");
  } catch (error) {
    console.log("❌ Failed to start bot:", error?.message);
    sock = null;
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(() => {
        reconnecting = false;
        startBot();
      }, 5000);
    }
  }
}

/* =========================================================
   GLOBAL ERRORS
========================================================= */

process.on("uncaughtException", error => {
  console.log("❌ Uncaught Exception:", error);
});

process.on("unhandledRejection", error => {
  console.log("❌ Unhandled Rejection:", error);
});

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown() {
  console.log("\n🛑 Shutting down bot...");
  try {
    if (sock) sock.end(new Error("Bot shutting down"));
  } catch {}
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

startBot();