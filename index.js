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

const BOT_NAME = "আর-রাইয়ান";

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
      model: AI_MODEL,
      generationConfig: {
        temperature: 0.9,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 800
      }
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