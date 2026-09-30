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

/* ================= CONFIG ================= */
const PORT = Number(process.env.PORT || 3000);
const PHONE_NUMBER = (process.env.PHONE_NUMBER || "").replace(/[^0-9]/g, "");
const WEBSITE_URL = "https://x-cyber-2025.github.io/X-cyber.web/";
const BACKUP_GROUP_URL = "https://chat.whatsapp.com/KsIJqeOdSTVC2FBIuWCvlN?s=cl&p=a&mlu=4&ilr=4";

const AUTH_DIR = "./auth_info";
const PAIRING_NUMBER_FILE = "./pairing_number.txt";
const BOT_STATUS_FILE = "./bot_status.json";
const WARNING_FILE = "./warnings.json";
const MUTE_FILE = "./muted.json";
const AI_STATUS_FILE = "./ai_status.json";

const BOT_NAME = "আর-রাইয়ান";
const OWNER_NAME = "পিয়াস";
const GROUP_LOCK_CHECK_INTERVAL = 10 * 1000;

let sock = null;
let reconnecting = false;
let pairingRequested = false;

const contactNames = new Map();
const contactPhoneJids = new Map();
const lidToPhoneJid = new Map();

/* ================= GEMINI AI ================= */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "gemini-1.5-flash-latest";
let geminiModel = null;

if (GEMINI_API_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({
      model: AI_MODEL,
      generationConfig: { temperature: 0.9, topK: 40, topP: 0.95, maxOutputTokens: 800 }
    });
    console.log(`🤖 Gemini AI ready (${AI_MODEL}).`);
  } catch (e) { console.log("⚠️ Gemini init error:", e?.message); }
} else { console.log("⚠️ GEMINI_API_KEY missing in .env"); }

/* ================= AI RATE LIMIT ================= */
const aiRateLimit = new Map();
const AI_RATE_WINDOW = 60 * 1000;
function isAIRateLimited(jid) {
  const now = Date.now();
  const last = aiRateLimit.get(jid);
  if (!last || now - last > AI_RATE_WINDOW) { aiRateLimit.set(jid, now); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of aiRateLimit.entries()) if (!t || now - t > AI_RATE_WINDOW * 5) aiRateLimit.delete(k);
}, 5 * 60 * 1000);

/* ================= AI STATUS ================= */
let aiStatus = {};
function loadAIStatus() {
  try { aiStatus = fs.existsSync(AI_STATUS_FILE) ? JSON.parse(fs.readFileSync(AI_STATUS_FILE, "utf8")) || {} : {}; console.log("📂 AI status loaded."); }
  catch { aiStatus = {}; }
}
function saveAIStatus() { try { fs.writeFileSync(AI_STATUS_FILE, JSON.stringify(aiStatus, null, 2)); } catch {} }
function isAIEnabled(g) { return aiStatus[g] !== false; }
function setAIStatus(g, e) { aiStatus[g] = Boolean(e); saveAIStatus(); }

/* ================= SPAM/RATE/FORWARD ================= */
const spamTracker = new Map();
const SPAM_WINDOW_MS = 60 * 1000;
const rateLimitTracker = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_COMMANDS = 3;
const forwardTracker = new Map();
const FORWARD_WINDOW_MS = 10 * 60 * 1000;
let mutedUsers = {};
const logger = P({ level: "silent" });

/* ================= MODERATION ================= */
const MODERATION_DEFAULTS = { badWords: true, links: true, spam: true, warnings: true, antiForward: true };
const BAD_WORDS = [
  "সালা","শালা","সালি","সালী","শালি","ষালি","ষালী","খাংকি","খাংকী","খানকি","খানকী","মাগি","মাগী",
  "বেসসা","বেশ্যা","বেশা","চোদা","চোদন","চুদ","চুদা","চুদাচুদি","হারামি","হারামী","হারামজাদা","হারামজাদী",
  "কুত্তা","কুত্তার","শুয়োর","শুয়োরের","বাঞ্চোদ","বাল","বালের","ফাক","ফাকিং","গাধা","গাধার","পাগল","পাগলি",
  "বদমাশ","বদমাশি","জারজ","জারজের","নষ্ট","নষ্টা","কুত্তি","কুত্তির","শুয়োরি","মাদারচোদ","মাদারচোদন",
  "ভোদা","ভোদার","ভোদাই","পোদ","পোদা","পোদার","লাওরা","লাওরার","ছিনাল","ছিনালি","ডাইনি","ডাইনির",
  "রান্ডি","রান্ডির","খানকির","মাগির","বেশ্যার","চোদান","চোদানি","লেংটা","লেংটার","নাংগা","নাংগি",
  "হিজরা","হিজড়া","হিজড়ার","কাজা","কাজার","বেক্কল","বেক্কলের","আবাল","আবালের","টালা","টালার",
  "চামার","চামারের","নীচ","নীচের","কমিনা","কমিনার","বেইমান","বেইমানের","খবিশ","খবিশের","লম্পট","লম্পটের",
  "কুলাঙ্গার","কুলাঙ্গারের","অপদার্থ","অপদার্থের","নপুংসক","নপুংসকের","ভণ্ড","ভণ্ডের","প্রতারক","প্রতারকের",
  "চোর","চোরের","ডাকাত","ডাকাতের","জোচ্চোর","জোচ্চোরের","fuck","fucking","fucked","fucker","fuckers",
  "motherfucker","motherfucking","mf","bitch","bitches","bitchy","bastard","bastards","asshole","assholes",
  "dick","dicks","dickhead","pussy","pussies","sex","sexy","sexual","porn","porno","pornography","cunt",
  "cunts","whore","whores","slut","sluts","nigga","nigger","niggas","niggers","retard","retarded","idiot",
  "idiots","idiotic","stupid","stupider","stupidest","dumb","dumbass","dumbasses","moron","morons","moronic",
  "fool","fools","foolish","jerk","jerks","loser","losers","shit","shits","shitty","shitting","crap","crappy",
  "damn","dammit","damned","hell","hellish","bloody","bloodyhell","bugger","buggers","wanker","wankers",
  "tosser","tossers","twat","twats","prick","pricks","cock","cocks","cocksucker","balls","ballsack","tits",
  "titties","boobs","boobies","rape","raped","raping","rapist","molest","molested","molester","pedo",
  "pedophile","pedophiles","kys","kyself","stfu","gtfo","wtf","wth","omfg","omg","fml","fubar","madarchod",
  "bhenchod","bhenchodd","behenchod","behanchod","bhosdike","bhosdi","chutiya","chutiye","chutiyapa","gandu",
  "gaandu","gaand","harami","haramkhor","haramzada","kutta","kutti","kutte","kutton","suar","suvar","suwar",
  "randi","rand","randy","loda","lode","laura","lauda","bhosda","bhosdika","lund","chinal","chinaal","kamina",
  "kamine","kaminay","badmash","badmashi","badzaat","najaiz","najayaz","haram","বোকা","বোকার","বোকাচোদা",
  "বোকাচোদ","হাবলা","হাবলার","গবেট","গবেটের","ল্যাংড়া","ল্যাংড়ার","কানা","কানার","কালা","কালার","কুচকুচে",
  "কুচকুচের","মোটা","মোটার","চিকনা","চিকনার","বামন","বামনের","খোঁড়া","খোঁড়ার","ঠেংগা","ঠেংগার","নেংটা",
  "নেংটার","ছোটোলোক","ছোটোলোকের","হলদে","হলদের","ম্লেচ্ছ","ম্লেচ্ছের","ইয়াতিম","ইয়াতিমের","বেজন্মা","বেজন্মার",
  "দুর্জন","দুর্জনের","অধম","অধমের","পাপী","পাপীর","ঘৃণ্য","ঘৃণ্যের","জঘন্য","জঘন্যের","লজ্জাহীন","লজ্জাহীনের",
  "বেহায়া","বেহায়ার","নির্লজ্জ","নির্লজ্জের","বদনাম","বদনামের"
];

/* ================= WARNINGS ================= */
let warnings = {};
function loadWarnings() {
  try { warnings = fs.existsSync(WARNING_FILE) ? JSON.parse(fs.readFileSync(WARNING_FILE, "utf8")) || {} : {}; console.log("📂 Warning data loaded."); }
  catch { warnings = {}; }
}
function saveWarnings() { try { fs.writeFileSync(WARNING_FILE, JSON.stringify(warnings, null, 2)); } catch {} }
function getGroupWarningData(g) { if (!warnings[g]) warnings[g] = {}; return warnings[g]; }
function getMemberWarningCount(g, m) { if (!g || !m) return 0; return Number(getGroupWarningData(g)[m] || 0); }
function addWarning(g, m) {
  if (!g || !m) return 0;
  const d = getGroupWarningData(g);
  d[m] = getMemberWarningCount(g, m) + 1;
  saveWarnings();
  return d[m];
}

/* ================= MUTES ================= */
function loadMuted() {
  try { mutedUsers = fs.existsSync(MUTE_FILE) ? JSON.parse(fs.readFileSync(MUTE_FILE, "utf8")) || {} : {}; console.log("📂 Mute data loaded."); }
  catch { mutedUsers = {}; }
}
function saveMuted() { try { fs.writeFileSync(MUTE_FILE, JSON.stringify(mutedUsers, null, 2)); } catch {} }
function getMuteKey(g, m) { return `${g}:${m}`; }
function isMuted(g, m) {
  if (!g || !m) return false;
  const k = getMuteKey(g, m), d = mutedUsers[k];
  if (!d) return false;
  if (Date.now() >= d.until) { delete mutedUsers[k]; saveMuted(); return false; }
  return true;
}
function getMuteRemaining(g, m) { if (!g || !m) return 0; const d = mutedUsers[getMuteKey(g, m)]; return d ? Math.max(0, d.until - Date.now()) : 0; }
function setMute(g, m, ms) { if (!g || !m) return false; mutedUsers[getMuteKey(g, m)] = { until: Date.now() + ms, mutedAt: Date.now() }; saveMuted(); return true; }
function removeMute(g, m) {
  if (!g || !m) return false;
  const k = getMuteKey(g, m);
  if (mutedUsers[k]) { delete mutedUsers[k]; saveMuted(); return true; }
  return false;
}

/* ================= CHECKS ================= */
function normalizeForBadWordCheck(t) {
  return String(t || "").toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[\s\-_.,!?()[\]{}:;'"`~|\\/*+@#$%^&]/g, "");
}
function containsBadWord(t) {
  if (!t) return null;
  const n = normalizeForBadWordCheck(t);
  for (const w of BAD_WORDS) { const nw = normalizeForBadWordCheck(w); if (nw && n.includes(nw)) return w; }
  return null;
}
function containsLink(t) {
  if (!t) return false;
  const v = String(t);
  const p = [/https?:\/\/\S+/i, /www\.\S+/i, /\b[a-z0-9-]+\.(com|net|org|xyz|bd|me|io|co|app|site|online|info|dev|ly|gg)\b/i, /\bt\.me\/\S+/i, /\bwa\.me\/\S+/i, /\bchat\.whatsapp\.com\/\S+/i];
  return p.some(x => x.test(v));
}
function normalizeSpamText(t) { return String(t || "").toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim(); }
function getSpamKey(g, m) { return `${g}:${m}`; }
function isDuplicateSpam(g, m, t) {
  if (!g || !m || !t) return false;
  const n = normalizeSpamText(t);
  if (!n) return false;
  const k = getSpamKey(g, m), now = Date.now(), prev = spamTracker.get(k);
  if (prev && prev.text === n && now - prev.time < SPAM_WINDOW_MS) { spamTracker.set(k, { text: n, time: now }); return true; }
  spamTracker.set(k, { text: n, time: now });
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, d] of spamTracker.entries()) if (!d || now - d.time > SPAM_WINDOW_MS * 2) spamTracker.delete(k);
}, 5 * 60 * 1000);
function isForwardTooSoon(g, m) {
  if (!g || !m) return false;
  const k = `${g}:${m}`, now = Date.now(), last = forwardTracker.get(k);
  if (!last || now - last > FORWARD_WINDOW_MS) { forwardTracker.set(k, now); return false; }
  return true;
}

/* ================= BOT STATUS ================= */
let botStatus = {};
function createDefaultGroupStatus() {
  return { enabled: true, disabledCommands: [], moderation: { ...MODERATION_DEFAULTS }, groupLockedUntil: null };
}
function loadBotStatus() {
  try {
    if (!fs.existsSync(BOT_STATUS_FILE)) { botStatus = {}; return; }
    botStatus = JSON.parse(fs.readFileSync(BOT_STATUS_FILE, "utf8")) || {};
    for (const [g, v] of Object.entries(botStatus)) {
      if (typeof v === "boolean") { botStatus[g] = createDefaultGroupStatus(); botStatus[g].enabled = v; }
      if (!botStatus[g] || typeof botStatus[g] !== "object") botStatus[g] = createDefaultGroupStatus();
      if (!Array.isArray(botStatus[g].disabledCommands)) botStatus[g].disabledCommands = [];
      if (!botStatus[g].moderation || typeof botStatus[g].moderation !== "object") botStatus[g].moderation = { ...MODERATION_DEFAULTS };
      for (const [k, d] of Object.entries(MODERATION_DEFAULTS)) if (typeof botStatus[g].moderation[k] !== "boolean") botStatus[g].moderation[k] = d;
      if (!Object.prototype.hasOwnProperty.call(botStatus[g], "groupLockedUntil")) botStatus[g].groupLockedUntil = null;
      if (typeof botStatus[g].groupLockedUntil !== "number" && botStatus[g].groupLockedUntil !== null) botStatus[g].groupLockedUntil = null;
    }
    console.log("📂 Bot status loaded.");
  } catch { botStatus = {}; }
}
function saveBotStatus() { try { fs.writeFileSync(BOT_STATUS_FILE, JSON.stringify(botStatus, null, 2)); } catch {} }
function getGroupStatus(g) {
  if (!botStatus[g]) botStatus[g] = createDefaultGroupStatus();
  if (!Array.isArray(botStatus[g].disabledCommands)) botStatus[g].disabledCommands = [];
  if (!botStatus[g].moderation || typeof botStatus[g].moderation !== "object") botStatus[g].moderation = { ...MODERATION_DEFAULTS };
  for (const [k, d] of Object.entries(MODERATION_DEFAULTS)) if (typeof botStatus[g].moderation[k] !== "boolean") botStatus[g].moderation[k] = d;
  if (!Object.prototype.hasOwnProperty.call(botStatus[g], "groupLockedUntil")) botStatus[g].groupLockedUntil = null;
  return botStatus[g];
}
function isBotEnabled(g) { return getGroupStatus(g).enabled !== false; }
function setBotStatus(g, e) { getGroupStatus(g).enabled = Boolean(e); saveBotStatus(); }

/* ================= COMMANDS ================= */
const COMMAND_DEFINITIONS = [
  { key: "menu", command: "/menu" }, { key: "bot", command: "/bot" }, { key: "rules", command: "/rules" },
  { key: "admin", command: "/admin" }, { key: "members", command: "/members" },
  { key: "groupinfo", command: "/groupinfo" }, { key: "id", command: "/id" }, { key: "ping", command: "/ping" },
  { key: "deal", command: "/deal" }, { key: "piyas", command: "/piyas" }, { key: "website", command: "/website" },
  { key: "tagall", command: "/tagall" }, { key: "mute", command: "/mute" }, { key: "unmute", command: "/unmute" },
  { key: "mutelist", command: "/mutelist" }, { key: "ai", command: "/ai" }, { key: "aion", command: "/aion" },
  { key: "aioff", command: "/aioff" }
];
const COMMAND_ALIASES = { "ডিল": "deal" };
const ADMIN_ONLY_COMMANDS = ["adminpanel","cmdlist","on","off","boton","botoff","mod","moderation","modstatus","modon","modoff","গ্রুপ","tagall","mute","unmute","mutelist","aion","aioff"];
const PROTECTED_COMMANDS = ["adminpanel","cmdlist","on","off","boton","botoff","mod","moderation","modstatus","modon","modoff","গ্রুপ","mute","unmute","mutelist","aion","aioff"];
function normalizeCommandName(c) { return c ? String(c).trim().toLowerCase().replace(/^\/+/, "") : ""; }
function getCanonicalCommand(c) { const n = normalizeCommandName(c); return n ? (COMMAND_ALIASES[n] || n) : ""; }
function getCommandDefinition(c) { const k = getCanonicalCommand(c); return COMMAND_DEFINITIONS.find(i => i.key === k) || null; }
function isKnownCommand(c) { return Boolean(getCommandDefinition(c)); }
function isCommandEnabled(g, c) { const n = getCanonicalCommand(c); return n ? !getGroupStatus(g).disabledCommands.includes(n) : true; }
function setCommandStatus(g, c, e) {
  const n = getCanonicalCommand(c);
  if (!n) return false;
  const l = getGroupStatus(g).disabledCommands, i = l.indexOf(n);
  if (e) { if (i !== -1) l.splice(i, 1); } else { if (i === -1) l.push(n); }
  saveBotStatus(); return true;
}
function getModerationStatus(g) { return getGroupStatus(g).moderation; }
function isModerationEnabled(g, t) { return Boolean(getModerationStatus(g)[t]); }
function setModerationStatus(g, t, e) {
  const m = getModerationStatus(g);
  if (!Object.prototype.hasOwnProperty.call(m, t)) return false;
  m[t] = Boolean(e); saveBotStatus(); return true;
}

/* ================= DELETE / WARN ================= */
async function deleteMessage(remoteJid, message) {
  try { if (!sock || !remoteJid || !message?.key) return false; await sock.sendMessage(remoteJid, { delete: message.key }); return true; }
  catch { return false; }
}
async function sendModerationWarning(remoteJid, message, reason, count) {
  try {
    const p = message?.key?.participant, pj = p ? await getPhoneJid({ id: p }) : null;
    const t = `╭━━━━━━━━━━━━━━━━━━━━╮\n       ⚠️ *MODERATION*\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n🚫 এই Message টি Group Rule\nভঙ্গ করার কারণে Delete করা হয়েছে।\n\n📌 *কারণ:* ${reason}\n\n⚠️ *Warning:* ${count}\n\n🤍 *${BOT_NAME}*`;
    const d = { text: t }; if (isPhoneJid(pj)) d.mentions = [pj];
    await sock.sendMessage(remoteJid, d);
  } catch {}
}
async function sendMuteWarning(remoteJid, m, rem) {
  try {
    const t = `╭━━━━━━━━━━━━━━━━━━━━╮\n     🔇 *মেসেজ অপশন বন্ধ*\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n❌ *দুঃখিত!*\n\n⏱️ *বাকি সময়:* ${formatGroupDuration(rem)}\n\n🤍 *${BOT_NAME}*`;
    if (isPhoneJid(m)) await sock.sendMessage(m, { text: t });
    else await sock.sendMessage(remoteJid, { text: t, mentions: [m] });
  } catch {}
}

/* ================= AI REPLY ================= */
async function getAIReply(groupId, userMessage, userName) {
  if (!geminiModel) return null;
  const low = String(userMessage).toLowerCase().trim();
  if (low.includes("তোমার নাম") || low.includes("তুমি কে") || low.includes("নাম কি") || low === "কে তুমি")
    return `আমার নাম *${BOT_NAME}*। আমি এই গ্রুপের একটি বিনয়ী AI বট। 🤖\n\nকেমন আছেন?`;
  if (low.includes("কে বানিয়েছে") || low.includes("কে তৈরি") || low.includes("নির্মাতা") || low.includes("owner"))
    return `আমাকে তৈরি করেছেন *${OWNER_NAME}*। 🙏\n\nতিনি এই গ্রুপের একজন গুরুত্বপূর্ণ ব্যক্তি।`;
  try {
    const prompt = `তুমি "${BOT_NAME}" — একটি বাংলাদেশী WhatsApp গ্রুপের বিনয়ী, বুদ্ধিমান এবং সাহায্যকারী AI বট।
নিয়ম:
1. তোমার নাম "${BOT_NAME}"। কেউ জিজ্ঞেস করলে বলবে "${BOT_NAME}"।
2. তোমাকে তৈরি করেছেন "${OWNER_NAME}"।
3. গল্প লিখতে বললে সুন্দর, কল্পনাপ্রসূত ও শিক্ষামূলক ছোট গল্প লিখবে (৩-৫ প্যারা)।
4. পোস্ট লিখতে বললে সোশ্যাল মিডিয়া পোস্ট/ক্যাপশন/স্ট্যাটাস সুন্দর করে লিখে দেবে।
5. বাংলায় উত্তর দাও (কেউ ইংরেজিতে লিখলে ইংরেজিতে)।
6. সবসময় বিনয়ী, ভদ্র ও সাহায্যকারী হবে।
7. অশ্লীল, রাজনৈতিক, ধর্মীয় বিতর্ক এড়িয়ে চলবে।
8. ছোট প্রশ্নে ছোট উত্তর, বিস্তারিত প্রশ্নে বিস্তারিত উত্তর দেবে।
9. ইমোজি ব্যবহার করবে সুন্দরভাবে (অতিরিক্ত নয়)।

গ্রুপ তথ্য: /rules, /deal, /website

👤 ইউজারের নাম: ${userName}
💬 ইউজার লিখেছে: ${userMessage}

তোমার উত্তর (বাংলায়):`;
    const r = await geminiModel.generateContent(prompt);
    const rep = r?.response?.text()?.trim();
    if (!rep) return null;
    return rep;
  } catch (e) { console.log("⚠️ AI reply error:", e?.message); return null; }
}

/* ================= MODERATE ================= */
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
      if (deleted) { const rem = getMuteRemaining(remoteJid, targetJid); await sendMuteWarning(remoteJid, targetJid, rem); }
      return true;
    }
    if (sender) { const admin = await isSenderAdmin(remoteJid, message); if (admin) return false; }
    if (isModerationEnabled(remoteJid, "badWords")) {
      const bw = containsBadWord(text);
      if (bw) {
        const deleted = await deleteMessage(remoteJid, message);
        if (deleted) {
          let c = 0;
          if (isModerationEnabled(remoteJid, "warnings") && targetJid) c = addWarning(remoteJid, targetJid);
          if (isModerationEnabled(remoteJid, "warnings")) await sendModerationWarning(remoteJid, message, `Bad Word: ${bw}`, c);
        }
        return true;
      }
    }
    if (isModerationEnabled(remoteJid, "links") && containsLink(text)) {
      const deleted = await deleteMessage(remoteJid, message);
      if (deleted) {
        let c = 0;
        if (isModerationEnabled(remoteJid, "warnings") && targetJid) c = addWarning(remoteJid, targetJid);
        await sendModerationWarning(remoteJid, message, "Link / URL", c);
      }
      return true;
    }
    if (isModerationEnabled(remoteJid, "antiForward") && targetJid) {
      const isFwd = message?.message?.extendedTextMessage?.contextInfo?.isForwarded || message?.message?.imageMessage?.contextInfo?.isForwarded || message?.message?.videoMessage?.contextInfo?.isForwarded;
      if (isFwd && isForwardTooSoon(remoteJid, targetJid)) {
        const deleted = await deleteMessage(remoteJid, message);
        if (deleted) await sock.sendMessage(remoteJid, { text: `⚠️ @${targetJid.split("@")[0]} আপনার Forward ডিলিট করা হয়েছে।`, mentions: [targetJid] });
        return true;
      }
    }
    if (isModerationEnabled(remoteJid, "spam") && targetJid) {
      if (isDuplicateSpam(remoteJid, targetJid, text)) {
        const deleted = await deleteMessage(remoteJid, message);
        if (deleted) {
          let c = 0;
          if (isModerationEnabled(remoteJid, "warnings")) c = addWarning(remoteJid, targetJid);
          if (isModerationEnabled(remoteJid, "warnings")) await sendModerationWarning(remoteJid, message, "Duplicate Spam", c);
        }
        return true;
      }
    }
    return false;
  } catch { return false; }
}

/* ================= HTTP SERVER ================= */
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "online", connected: !!sock, ai: !!geminiModel, model: AI_MODEL, uptime: Math.floor(process.uptime()) }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("WhatsApp Bot is running!");
});
server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

/* ================= JID HELPERS ================= */
function normalizeJid(j) { return (!j || typeof j !== "string") ? null : j.trim(); }
function isPhoneJid(j) { return typeof j === "string" && j.endsWith("@s.whatsapp.net"); }
function isLidJid(j) { return typeof j === "string" && j.endsWith("@lid"); }
function phoneNumberToJid(p) {
  if (!p) return null;
  const n = String(p).replace(/@s.whatsapp.net/g, "").replace(/[^0-9]/g, "");
  return n.length < 8 ? null : n + "@s.whatsapp.net";
}
function cleanName(n) { if (!n) return null; const v = String(n).replace(/\s+/g, " ").trim(); return v ? v.slice(0, 80) : null; }
function getDisplayName(p = {}) {
  const ids = [p.id, p.lid, p.phoneNumber].filter(Boolean);
  for (const i of ids) { const c = contactNames.get(i); if (c) return c; }
  const d = cleanName(p.username || p.notify || p.name || p.verifiedName || p.pushName);
  if (d) return d;
  if (p.phoneNumber) { const ph = String(p.phoneNumber).replace(/@s.whatsapp.net/g, "").replace(/[^0-9]/g, ""); if (ph) return ph; }
  if (p.id) { const ip = String(p.id).split("@")[0]; if (ip) return ip; }
  return "Member";
}
function saveLidMapping(lid, pn) {
  const l = normalizeJid(lid); let p = normalizeJid(pn);
  if (!isLidJid(l)) return;
  if (!isPhoneJid(p)) p = phoneNumberToJid(p);
  if (!isPhoneJid(p)) return;
  lidToPhoneJid.set(l, p); contactPhoneJids.set(l, p);
}
async function resolveLidToPhoneJid(lid) {
  if (!lid) return null;
  if (isPhoneJid(lid)) return lid;
  if (!isLidJid(lid)) return null;
  const c = lidToPhoneJid.get(lid) || contactPhoneJids.get(lid);
  if (isPhoneJid(c)) return c;
  try {
    const m = sock?.signalRepository?.lidMapping;
    if (m && typeof m.getPNForLID === "function") {
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
    const id = normalizeJid(c.id), lid = normalizeJid(c.lid);
    let p = null;
    if (c.phoneNumber) p = isPhoneJid(c.phoneNumber) ? c.phoneNumber : phoneNumberToJid(c.phoneNumber);
    if (!p && isPhoneJid(id)) p = id;
    if (p && isLidJid(id)) saveLidMapping(id, p);
    if (p && lid) saveLidMapping(lid, p);
    const n = cleanName(c.username || c.notify || c.name || c.verifiedName || c.pushName);
    if (n) { if (id) contactNames.set(id, n); if (lid) contactNames.set(lid, n); if (p) contactNames.set(p, n); }
    if (p) { if (id) contactPhoneJids.set(id, p); if (lid) contactPhoneJids.set(lid, p); contactPhoneJids.set(p, p); }
  }
}
function getDirectPhoneJid(p = {}) {
  if (p.phoneNumber) { const j = isPhoneJid(p.phoneNumber) ? p.phoneNumber : phoneNumberToJid(p.phoneNumber); if (j) return j; }
  if (isPhoneJid(p.id)) return p.id;
  return null;
}
async function getPhoneJid(p = {}) {
  const d = getDirectPhoneJid(p);
  if (d) return d;
  const ids = [p.id, p.lid].filter(Boolean);
  for (const i of ids) {
    const c = contactPhoneJids.get(i) || lidToPhoneJid.get(i);
    if (isPhoneJid(c)) return c;
    if (isLidJid(i)) { const r = await resolveLidToPhoneJid(i); if (r) return r; }
  }
  return null;
}
async function cacheParticipants(ps = []) {
  for (const p of ps) {
    if (!p) continue;
    const n = getDisplayName(p);
    let pj = getDirectPhoneJid(p);
    if (!pj && p.id) pj = await resolveLidToPhoneJid(p.id);
    if (!pj && p.lid) pj = await resolveLidToPhoneJid(p.lid);
    if (pj && p.id) contactPhoneJids.set(p.id, pj);
    if (pj && p.lid) contactPhoneJids.set(p.lid, pj);
    if (pj && isLidJid(p.id)) saveLidMapping(p.id, pj);
    if (pj && isLidJid(p.lid)) saveLidMapping(p.lid, pj);
    if (n && n !== "Member") { if (p.id) contactNames.set(p.id, n); if (p.lid) contactNames.set(p.lid, n); if (pj) contactNames.set(pj, n); }
  }
}
function isAdminParticipant(p = {}) {
  return p.admin === "admin" || p.admin === "superadmin" || p.admin === true || p.isAdmin === true || p.isSuperAdmin === true;
}
function isOwnerParticipant(p = {}) { return p.admin === "superadmin" || p.isSuperAdmin === true; }
function findParticipant(ps = [], j) { if (!j) return null; return ps.find(p => p?.id === j || p?.lid === j || p?.phoneNumber === j) || null; }
function getBotPhoneJid() {
  try {
    const o = normalizeJid(sock?.user?.id);
    if (isPhoneJid(o)) return o.split(":")[0];
    if (isLidJid(o)) { const c = lidToPhoneJid.get(o) || contactPhoneJids.get(o); if (isPhoneJid(c)) return c; }
    if (PHONE_NUMBER) return phoneNumberToJid(PHONE_NUMBER);
    return null;
  } catch { return null; }
}
async function isBotAdminInGroup(g) {
  try {
    if (!sock || !g || !g.endsWith("@g.us")) return false;
    const m = await sock.groupMetadata(g);
    const ps = m?.participants || [];
    if (!ps.length) return false;
    await cacheParticipants(ps);
    const bj = normalizeJid(sock?.user?.id), bp = getBotPhoneJid();
    let b = findParticipant(ps, bj);
    if (!b && bp) b = findParticipant(ps, bp);
    if (!b && bp) { const bn = bp.split("@")[0].replace(/[^0-9]/g, ""); b = ps.find(p => { const ph = String(p?.phoneNumber || "").replace(/@s.whatsapp.net/g, "").replace(/[^0-9]/g, ""); return ph && ph === bn; }); }
    if (!b && bj && isLidJid(bj)) { const r = await resolveLidToPhoneJid(bj); if (r) b = findParticipant(ps, r); }
    if (!b) return false;
    return isAdminParticipant(b);
  } catch { return false; }
}
async function isSenderAdmin(remoteJid, message) {
  try {
    if (!sock || !remoteJid) return false;
    const pj = message?.key?.participant;
    if (!pj) return false;
    const m = await sock.groupMetadata(remoteJid);
    const ps = m?.participants || [];
    await cacheParticipants(ps);
    let s = findParticipant(ps, pj);
    if (!s) { const sp = await resolveLidToPhoneJid(pj); if (sp) s = findParticipant(ps, sp); }
    if (!s) s = ps.find(p => p?.id === pj || p?.lid === pj || p?.phoneNumber === pj);
    if (!s) return false;
    return isAdminParticipant(s);
  } catch { return false; }
}

/* ================= COPY BUTTON ================= */
function makeCopyButton(c) { return { name: "cta_copy", buttonParamsJson: JSON.stringify({ display_text: "📋 Copy", id: "copy_" + normalizeCommandName(c), copy_code: c }) }; }
async function sendCopyButton(j, c) {
  try {
    const b = makeCopyButton(c);
    const m = generateWAMessageFromContent(j, { viewOnceMessage: { message: { interactiveMessage: proto.Message.InteractiveMessage.create({ body: proto.Message.InteractiveMessage.Body.create({ text: `📋 *Copy Command*\n\n${c}` }), footer: proto.Message.InteractiveMessage.Footer.create({ text: `🤖 ${BOT_NAME}` }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: [b] }) }) } } }, { userJid: sock?.user?.id });
    await sock.relayMessage(j, m.message, { messageId: m.key.id });
    return true;
  } catch { return false; }
}
async function sendCopyButtons(j, cs) { const u = [...new Set(cs.filter(Boolean))]; for (const c of u) { await sendCopyButton(j, c); await new Promise(r => setTimeout(r, 250)); } }

/* ================= MENUS ================= */
function buildMenuText(remoteJid) {
  const e = c => isCommandEnabled(remoteJid, c);
  return `╭━━━━━━━━━━━━━━━━━━━━╮\n        🤖 *BOT MENU*\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n╭─❖ 👥 *GROUP COMMANDS*\n│ 1️⃣ ${e("menu") ? "/menu" : "🔴 /menu OFF"}\n│ 2️⃣ ${e("bot") ? "/bot" : "🔴 /bot OFF"}\n│ 3️⃣ ${e("rules") ? "/rules" : "🔴 /rules OFF"}\n│ 4️⃣ ${e("admin") ? "/admin" : "🔴 /admin OFF"}\n│ 5️⃣ ${e("members") ? "/members" : "🔴 /members OFF"}\n│ 6️⃣ ${e("groupinfo") ? "/groupinfo" : "🔴 /groupinfo OFF"}\n│ 7️⃣ ${e("id") ? "/id" : "🔴 /id OFF"}\n│ 8️⃣ ${e("tagall") ? "/tagall 🔒" : "🔴 /tagall OFF"}\n╰────────────────────\n\n╭─❖ 🤖 *AI COMMANDS*\n│ 9️⃣ ${e("ai") ? "/ai <প্রশ্ন>" : "🔴 /ai OFF"}\n│ 🔟 @ai <প্রশ্ন>\n│ 1️⃣1️⃣ বটকে মেনশন করে প্রশ্ন\n╰────────────────────\n\n╭─❖ ⚙️ *UTILITY*\n│ 1️⃣2️⃣ ${e("ping") ? "/ping" : "🔴 /ping OFF"}\n╰────────────────────\n\n╭─❖ 💰 *BUY / SELL*\n│ 1️⃣3️⃣ ${e("deal") ? "/deal /ডিল" : "🔴 /deal OFF"}\n╰────────────────────\n\n╭─❖ 🤍 *PIYAS*\n│ 1️⃣4️⃣ ${e("piyas") ? "/piyas" : "🔴 /piyas OFF"}\n╰────────────────────\n\n╭─❖ 🌐 *WEBSITE*\n│ 1️⃣5️⃣ ${e("website") ? "/website" : "🔴 /website OFF"}\n╰────────────────────\n\n╭─❖ 🧮 *CALCULATOR*\n│ /20+2  /100-25  /20*5  /100/4\n╰────────────────────\n\n━━━━━━━━━━━━━━━━━━━━\n🔒 = Admin Only\n━━━━━━━━━━━━━━━━━━━━`;
}
async function sendPublicMenu(j) {
  try {
    await sock.sendMessage(j, { text: buildMenuText(j) });
    const cs = ["/menu","/bot","/rules","/admin","/members","/groupinfo","/id","/tagall","/ping","/deal","/ডিল","/piyas","/website","/ai বাংলাদেশের রাজধানী কোথায়?"].filter(c => isCommandEnabled(j, c));
    await sendCopyButtons(j, cs);
  } catch {}
}

/* ================= CALCULATOR ================= */
function calculateExpression(ex) {
  try {
    const v = String(ex || "").trim().replace(/,/g, "");
    if (!v || !/^[0-9+\-*/%.()\s]+$/.test(v) || v.includes("**") || v.includes("//") || v.includes("/*") || v.includes("*/") || !/\d/.test(v) || !/[+\-*/%]/.test(v)) return null;
    const r = Function(`"use strict"; return (${v})`)();
    return (typeof r === "number" && Number.isFinite(r)) ? r : null;
  } catch { return null; }
}
function formatCalculationResult(r) { if (typeof r !== "number" || !Number.isFinite(r)) return null; return Number.isInteger(r) ? String(r) : Number(r.toFixed(10)).toString(); }
function isCalculatorMessage(t) { if (!t) return false; const v = String(t).trim(); if (!v.startsWith("/")) return false; const ex = v.slice(1).trim(); return ex ? /^[0-9+\-*/%.()\s]+$/.test(ex) : false; }
async function handleCalculator(j, t) {
  try {
    const ex = String(t).trim().slice(1).trim(), r = calculateExpression(ex);
    if (r === null) { await sock.sendMessage(j, { text: `🧮 *CALCULATOR*\n\n❌ হিসাবটি সঠিক নয়।\n\n💡 উদাহরণ:\n/20+2\n/100-25\n/20*5\n/100/4\n\n🤍 *${BOT_NAME}*` }); return true; }
    await sock.sendMessage(j, { text: `🧮 *CALCULATOR*\n\n📌 Expression: ${ex}\n\n✅ Result: ${formatCalculationResult(r)}\n\n🤍 *${BOT_NAME}*` });
    return true;
  } catch { return false; }
}

/* ================= ADMIN PANEL ================= */
async function sendAdminPanel(j) {
  try {
    const d = getGroupStatus(j).disabledCommands || [];
    const cs = COMMAND_DEFINITIONS.map(i => `│ ${!d.includes(i.key) ? "🟢" : "🔴"} ${i.command} ${!d.includes(i.key) ? "ON" : "OFF"}`).join("\n");
    const m = getModerationStatus(j), l = getGroupStatus(j).groupLockedUntil;
    const ls = typeof l === "number" && l > Date.now() ? `🔒 Group Closed\n⏰ ${new Date(l).toLocaleString("en-BD")}` : "🔓 Group Open";
    const ba = await isBotAdminInGroup(j);
    const t = `╭━━━━━━━━━━━━━━━━━━━━╮\n       👑 *ADMIN PANEL*\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n🔐 *শুধুমাত্র Admin-এর জন্য*\n\n╭─❖ 🤖 *BOT STATUS*\n│ ${isBotEnabled(j) ? "🟢 Bot: ON" : "🔴 Bot: OFF"}\n│ ${isAIEnabled(j) ? "🟢 AI: ON" : "🔴 AI: OFF"}\n│ ${ba ? "🛡️ Moderation: Active" : "⚠️ Moderation: Inactive"}\n│ 📦 Model: ${AI_MODEL}\n╰────────────────────\n\n╭─❖ 🔒 *GROUP STATUS*\n│ ${ls}\n╰────────────────────\n\n╭─❖ ⚙️ *COMMAND STATUS*\n${cs}\n╰────────────────────\n\n╭─❖ 🛡️ *MODERATION*\n│ ${m.badWords ? "🟢" : "🔴"} Bad Word\n│ ${m.links ? "🟢" : "🔴"} Link\n│ ${m.spam ? "🟢" : "🔴"} Spam\n│ ${m.warnings ? "🟢" : "🔴"} Warning\n│ ${m.antiForward ? "🟢" : "🔴"} Anti-Forward\n╰────────────────────\n\n━━━━━━━━━━━━━━━━━━━━`;
    await sock.sendMessage(j, { text: t });
    await sendCopyButtons(j, ["/adminpanel","/aion","/aioff","/on ai","/off ai","/mute @user 10m","/unmute @user","/mutelist"]);
  } catch {}
}
async function sendCommandList(j) {
  const d = getGroupStatus(j).disabledCommands || [];
  const lines = COMMAND_DEFINITIONS.map(i => `${!d.includes(i.key) ? "🟢 ON " : "🔴 OFF"} ${i.command}${ADMIN_ONLY_COMMANDS.includes(i.key) ? " 🔒" : ""}`);
  await sock.sendMessage(j, { text: `📋 *COMMAND STATUS*\n\n${lines.join("\n")}\n\n🟢 ON: ${COMMAND_DEFINITIONS.filter(i => !d.includes(i.key)).length}\n🔴 OFF: ${COMMAND_DEFINITIONS.filter(i => d.includes(i.key)).length}` });
}
async function sendModerationStatus(j) {
  const d = getGroupStatus(j).disabledCommands || [], m = getModerationStatus(j);
  const dt = d.length ? d.map(c => `│ 🔴 /${c}`).join("\n") : "│ 🟢 কোনো Command OFF নেই";
  await sock.sendMessage(j, { text: `🛠️ *MOD STATUS*\n\n${dt}\n\n🛡️ Bad Word: ${m.badWords ? "ON" : "OFF"}\n🛡️ Link: ${m.links ? "ON" : "OFF"}\n🛡️ Spam: ${m.spam ? "ON" : "OFF"}\n🛡️ Warning: ${m.warnings ? "ON" : "OFF"}\n🛡️ Anti-Forward: ${m.antiForward ? "ON" : "OFF"}` });
}

/* ================= RULES/WEBSITE/PIYAS ================= */
const GROUP_RULES = `📜 *GROUP RULES*\n\n1️⃣ সবাইকে সম্মান করে কথা বলুন।\n2️⃣ অশ্লীল কনটেন্ট শেয়ার করবেন না।\n3️⃣ Spam করবেন না।\n4️⃣ Admin ছাড়া লিংক শেয়ার করবেন না।\n5️⃣ অন্যকে হয়রানি করবেন না।\n\n🤍 *Piyas*`;
const WEBSITE_TEXT = `🌐 *OUR WEBSITE*\n\n${WEBSITE_URL}\n\n🎁 Account Buy/Sell এবং earning সম্পর্কিত তথ্য পাওয়া যাবে।\n\n🤍 *Piyas*`;
const PIYAS_INFO = `🤍 *PIYAS*\n\n👤 *Name:* মোঃ আল আমিন\n🌐 *English Name:* MD. AL AMIN\n👨‍👦 *Father:* মোঃ মোশারফ হোসেন\n👩‍👦 *Mother:* মোসাম্মৎ রীপা বেগম\n🎂 *Date of Birth:* ০৯ জানুয়ারি ২০০৬\n🩸 *Blood Group:* A+\n💍 *Marital Status:* Unmarried\n🏠 *Address:* বলদার চর, নান্দাইল, ময়মনসিংহ\n\n🤍 *Thank You*`;
const BOT_OFF_TEXT = `🔴 *BOT OFF*\n\nবট বন্ধ করা হয়েছে।\n\n🟢 /boton`;
const BOT_ON_TEXT = `🟢 *BOT ON*\n\nবট চালু হয়েছে। ✅\n\n🤍 *Piyas*`;
const BOT_ALREADY_OFF_TEXT = `🔴 *BOT STATUS*\n\nবট ইতোমধ্যে OFF আছে।`;
const BOT_ALREADY_ON_TEXT = `🟢 *BOT STATUS*\n\nবট ইতোমধ্যে ON আছে।`;
const DEAL_NOTICE_TOP = `🤝 *DEAL NOTICE*\n\n⚠️ *গুরুত্বপূর্ণ সতর্কতা!*\n\nকোনো Deal করার আগে Admin-এর সাথে যোগাযোগ করুন।\n\n🚫 *Admin ছাড়া Deal করবেন না।*\n\n👑 *Group Admin:*\n\n`;
const DEAL_NOTICE_BOTTOM = `\n📌 নিরাপদ থাকতে Admin-এর মাধ্যমে Deal করুন।\n\n🤍 *PIYAS*`;

/* ================= ADMIN DATA ================= */
async function getAdminData(j) {
  try {
    const m = await sock.groupMetadata(j);
    const ps = m?.participants || [];
    await cacheParticipants(ps);
    const aps = ps.filter(isAdminParticipant);
    const res = [], used = new Set();
    for (const p of aps) {
      const pj = await getPhoneJid(p);
      let n = getDisplayName(p);
      if (!n || n === "Member") n = "Admin";
      const dj = pj || p.id || p.lid || null;
      if (dj && used.has(dj)) continue;
      if (dj) used.add(dj);
      res.push({ jid: dj, name: n, owner: isOwnerParticipant(p), isPhone: isPhoneJid(pj) });
    }
    return { admins: res, result: res };
  } catch { return { admins: [], result: [] }; }
}
async function sendAdminList(j) {
  const { admins } = await getAdminData(j);
  if (!admins.length) { await sock.sendMessage(j, { text: "👑 কোনো Admin পাওয়া যায়নি।" }); return; }
  const lines = [], mentions = [];
  let num = 1;
  for (const a of admins) {
    const role = a.owner ? "⭐ *Group Owner*" : "👑 *Admin*";
    if (a.isPhone && isPhoneJid(a.jid)) { const ph = a.jid.split("@")[0].replace(/[^0-9]/g, ""); mentions.push(a.jid); lines.push(`${num}️⃣ @${ph} ${role}`); }
    else lines.push(`${num}️⃣ ${a.name} ${role}`);
    num++;
  }
  await sock.sendMessage(j, { text: `👑 *GROUP ADMINS*\n\n${lines.join("\n\n")}\n\n👥 *মোট:* ${admins.length} জন\n\n🤍 *Piyas*`, mentions });
}
async function sendDealNotice(j) {
  const { admins } = await getAdminData(j);
  if (!admins.length) { await sock.sendMessage(j, { text: DEAL_NOTICE_TOP + "⚠️ Admin পাওয়া যায়নি.\n\n" + DEAL_NOTICE_BOTTOM }); return; }
  const lines = [], mentions = [];
  let num = 1;
  for (const a of admins) {
    const role = a.owner ? "⭐ *Group Owner*" : "👑 *Admin*";
    if (a.isPhone && isPhoneJid(a.jid)) { const ph = a.jid.split("@")[0].replace(/[^0-9]/g, ""); mentions.push(a.jid); lines.push(`${num}️⃣ @${ph} ${role}`); }
    else lines.push(`${num}️⃣ ${a.name} ${role}`);
    num++;
  }
  await sock.sendMessage(j, { text: DEAL_NOTICE_TOP + lines.join("\n\n") + `\n\n👥 *মোট:* ${admins.length} জন\n\n` + DEAL_NOTICE_BOTTOM, mentions });
}

/* ================= WELCOME/GOODBYE ================= */
function getWelcomeText(n, g) {
  const sn = cleanName(n) || "Member", sg = cleanName(g) || "এই গ্রুপ";
  return `🎉 *স্বাগতম @${sn}* ❤️\n\n🌸 আপনাকে *${sg}* গ্রুপে স্বাগতম।\n\n📌 নিয়ম দেখতে: */rules*\n🌐 Website: */website*\n\n🔰 *ব্যাকআপ:* ${BACKUP_GROUP_URL}\n\n❤️ *Piyas*`;
}
async function sendWelcome(g, p) {
  try {
    if (!sock || !isBotEnabled(g)) return;
    let m = null;
    try { m = await sock.groupMetadata(g); await cacheParticipants(m?.participants || []); } catch {}
    let mem = findParticipant(m?.participants || [], p?.id) || findParticipant(m?.participants || [], p?.lid) || p;
    const n = getDisplayName(mem), gn = cleanName(m?.subject) || "এই গ্রুপ";
    const pj = await getPhoneJid(mem), wt = getWelcomeText(n, gn);
    if (isPhoneJid(pj)) await sock.sendMessage(g, { text: wt, mentions: [pj] });
    else await sock.sendMessage(g, { text: wt.replace(`@${n}`, n) });
  } catch {}
}
function getGoodbyeText(n, g) { const sn = cleanName(n) || "Member", sg = cleanName(g) || "এই গ্রুপ"; return `👋 *@${sn}* গ্রুপ ছেড়ে চলে গেলেন।\n\n🌸 তিনি *${sg}* এর সদস্য ছিলেন।\n\n💙 ভালো থাকবেন।\n\n🤍 *Piyas*`; }
async function sendGoodbye(g, p) {
  try {
    if (!sock || !isBotEnabled(g)) return;
    let m = null;
    try { m = await sock.groupMetadata(g); } catch {}
    let mem = findParticipant(m?.participants || [], p?.id) || findParticipant(m?.participants || [], p?.lid) || p;
    const n = getDisplayName(mem), gn = cleanName(m?.subject) || "এই গ্রুপ";
    const pj = await getPhoneJid(mem), gt = getGoodbyeText(n, gn);
    if (isPhoneJid(pj)) await sock.sendMessage(g, { text: gt, mentions: [pj] });
    else await sock.sendMessage(g, { text: gt.replace(`@${n}`, n) });
  } catch {}
}

/* ================= DURATION ================= */
const BANGLA_DIGITS = { "০":"0","১":"1","২":"2","৩":"3","৪":"4","৫":"5","৬":"6","৭":"7","৮":"8","৯":"9" };
function convertBanglaDigits(v) { return String(v).replace(/[০-৯]/g, d => BANGLA_DIGITS[d]); }
function parseDurationNumber(v) {
  if (!v) return null;
  const c = convertBanglaDigits(String(v).trim().toLowerCase());
  if (/^\d+(\.\d+)?$/.test(c)) return Number(c);
  const w = { "এক":1,"দুই":2,"তিন":3,"চার":4,"পাঁচ":5,"ছয়":6,"সাত":7,"আট":8,"নয়":9,"দশ":10,"বিশ":20,"ত্রিশ":30,"পঞ্চাশ":50,"একশ":100,"একশো":100 };
  return w[c] ?? null;
}
function parseGroupDuration(t) {
  if (!t) return null;
  const inp = convertBanglaDigits(String(t).trim().toLowerCase()).replace(/\s+/g, " ");
  let total = 0, found = false;
  const pats = [
    { re: /(\d+(?:\.\d+)?)\s*(বছর|year|years|y)(?=\s|$)/giu, ms: 365*24*60*60*1000 },
    { re: /(\d+(?:\.\d+)?)\s*(মাস|month|months|mo)(?=\s|$)/giu, ms: 30*24*60*60*1000 },
    { re: /(\d+(?:\.\d+)?)\s*(সপ্তাহ|week|weeks|w)(?=\s|$)/giu, ms: 7*24*60*60*1000 },
    { re: /(\d+(?:\.\d+)?)\s*(দিন|day|days|d)(?=\s|$)/giu, ms: 24*60*60*1000 },
    { re: /(\d+(?:\.\d+)?)\s*(ঘণ্টা|ঘন্টা|hour|hours|hr|h)(?=\s|$)/giu, ms: 60*60*1000 },
    { re: /(\d+(?:\.\d+)?)\s*(মিনিট|minute|minutes|min|m)(?=\s|$)/giu, ms: 60*1000 },
    { re: /(\d+(?:\.\d+)?)\s*(সেকেন্ড|second|seconds|sec|s)(?=\s|$)/giu, ms: 1000 }
  ];
  for (const p of pats) {
    let m;
    while ((m = p.re.exec(inp)) !== null) { const n = parseDurationNumber(m[1]); if (n && n > 0) { total += n * p.ms; found = true; } }
  }
  if (!found) { const n = parseDurationNumber(inp); if (n && n > 0) return n * 60 * 1000; }
  return total > 0 ? total : null;
}
function formatGroupDuration(ms) {
  let s = Math.floor(ms / 1000);
  const y = Math.floor(s / (365*24*60*60)); s %= 365*24*60*60;
  const mo = Math.floor(s / (30*24*60*60)); s %= 30*24*60*60;
  const d = Math.floor(s / (24*60*60)); s %= 24*60*60;
  const h = Math.floor(s / (60*60)); s %= 60*60;
  const mi = Math.floor(s / 60); s %= 60;
  const parts = [];
  if (y) parts.push(`${y} বছর`); if (mo) parts.push(`${mo} মাস`); if (d) parts.push(`${d} দিন`);
  if (h) parts.push(`${h} ঘণ্টা`); if (mi) parts.push(`${mi} মিনিট`); if (s) parts.push(`${s} সেকেন্ড`);
  return parts.join(" ") || "0 সেকেন্ড";
}

/* ================= GROUP LOCK ================= */
async function lockGroup(j, ms) {
  try {
    if (!sock || !j || !j.endsWith("@g.us")) return false;
    if (!(await isBotAdminInGroup(j))) { await sock.sendMessage(j, { text: `❌ Bot-কে Admin করতে হবে।` }); return false; }
    await sock.groupSettingUpdate(j, "announcement");
    const st = getGroupStatus(j);
    st.groupLockedUntil = Date.now() + ms;
    saveBotStatus();
    await sock.sendMessage(j, { text: `🔒 *GROUP CLOSED*\n\n⏱️ ${formatGroupDuration(ms)}\n\n🤍 *${BOT_NAME}*` });
    return true;
  } catch { return false; }
}
async function unlockGroup(j, r = "manual") {
  try {
    if (!sock || !j || !j.endsWith("@g.us")) return false;
    await sock.groupSettingUpdate(j, "not_announcement");
    const st = getGroupStatus(j);
    st.groupLockedUntil = null;
    saveBotStatus();
    if (r === "timer") await sock.sendMessage(j, { text: `🔓 *GROUP OPEN*\n\n⏰ সময় শেষ।\n\n🤍 *${BOT_NAME}*` });
    return true;
  } catch { return false; }
}
async function checkExpiredGroupLocks() {
  if (!sock) return;
  const now = Date.now();
  for (const [g, st] of Object.entries(botStatus)) {
    if (!st || typeof st !== "object") continue;
    if (typeof st.groupLockedUntil !== "number") continue;
    if (st.groupLockedUntil <= now) await unlockGroup(g, "timer");
  }
}
async function checkExpiredMutes() {
  if (!sock) return;
  const now = Date.now();
  for (const [k, d] of Object.entries(mutedUsers)) {
    if (!d || !d.until) continue;
    if (d.until <= now) {
      const [g, m] = k.split(":");
      delete mutedUsers[k]; saveMuted();
      try { if (isPhoneJid(m)) await sock.sendMessage(m, { text: `🔊 *Mute শেষ*\n\n🤍 *${BOT_NAME}*` }); } catch {}
    }
  }
}
setInterval(checkExpiredGroupLocks, GROUP_LOCK_CHECK_INTERVAL);
setInterval(checkExpiredMutes, 10 * 1000);

/* ================= PAIRING ================= */
function savePairingNumber(n) { try { fs.writeFileSync(PAIRING_NUMBER_FILE, n, "utf8"); } catch {} }
function getCredentialPhoneNumber(c) { const id = c?.me?.id; return (!id || typeof id !== "string") ? "" : id.split(":")[0].split("@")[0].replace(/[^0-9]/g, ""); }
async function resetAuthForNumberChange() { try { if (fs.existsSync(AUTH_DIR)) { await fs.promises.rm(AUTH_DIR, { recursive: true, force: true }); console.log("🗑️ Old session removed."); } } catch {} }
async function generatePairingCode(st) {
  try {
    if (!PHONE_NUMBER) { console.log("❌ PHONE_NUMBER missing in .env"); return; }
    if (st.creds.registered || pairingRequested) return;
    pairingRequested = true;
    await new Promise(r => setTimeout(r, 2500));
    if (!sock || st.creds.registered) { pairingRequested = false; return; }
    const c = await sock.requestPairingCode(PHONE_NUMBER);
    savePairingNumber(PHONE_NUMBER);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`🔐 PAIRING CODE: ${c}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  } catch (e) { pairingRequested = false; console.log("❌ Pairing error:", e?.message); }
}

/* ================= MESSAGE HELPERS ================= */
function getMessageText(m) {
  const x = m?.message;
  if (!x) return "";
  return (x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.videoMessage?.caption || x.documentMessage?.caption || x.buttonsResponseMessage?.selectedButtonId || x.listResponseMessage?.singleSelectReply?.selectedRowId || "").trim();
}
function getMentionedJids(m) {
  const x = m?.message;
  if (!x) return [];
  return x.extendedTextMessage?.contextInfo?.mentionedJid || x.imageMessage?.contextInfo?.mentionedJid || x.videoMessage?.contextInfo?.mentionedJid || x.documentMessage?.contextInfo?.mentionedJid || [];
}

/* ================= TAG ALL ================= */
async function handleTagAll(j, msg, args) {
  try {
    const m = await sock.groupMetadata(j);
    const ps = m?.participants || [];
    if (!ps.length) { await sock.sendMessage(j, { text: "❌ কোনো Member নেই।" }); return; }
    await cacheParticipants(ps);
    const mentions = [];
    for (const p of ps) { const pj = await getPhoneJid(p); if (pj) mentions.push(pj); else if (p.id) mentions.push(p.id); }
    const ct = args.join(" ").trim();
    const txt = ct ? `📢 *TAG ALL*\n\n${ct}\n\n━━━━━━━━━━━━━━━━━━━━` : `📢 *TAG ALL*\n\nসবাইকে ডাকা হচ্ছে!\n\n━━━━━━━━━━━━━━━━━━━━`;
    await sock.sendMessage(j, { text: txt, mentions });
  } catch { await sock.sendMessage(j, { text: "❌ Tag All সমস্যা।" }); }
}

/* ================= MUTE CMDS ================= */
async function handleMute(j, msg, args) {
  try {
    const men = getMentionedJids(msg);
    if (!men.length) { await sock.sendMessage(j, { text: `🔇 *MUTE SYSTEM*\n\n/mute @user 10m` }); return; }
    const dt = args.filter(a => !a.startsWith("@")).join(" ").trim();
    const dms = parseGroupDuration(dt);
    if (!dms || dms <= 0) { await sock.sendMessage(j, { text: "❌ সময় সঠিক নয়।" }); return; }
    const names = [];
    for (const jid of men) { const mj = await getPhoneJid({ id: jid }) || jid; setMute(j, mj, dms); names.push(`@${mj.split("@")[0]}`); }
    await sock.sendMessage(j, { text: `🔇 *MUTED*\n\n${names.join(", ")}\n\n⏱️ ${formatGroupDuration(dms)}\n\n🤍 *${BOT_NAME}*`, mentions: men });
  } catch {}
}
async function handleUnmute(j, msg) {
  try {
    const men = getMentionedJids(msg);
    if (!men.length) { await sock.sendMessage(j, { text: "❌ কাউকে মেনশন করুন।" }); return; }
    const names = [];
    for (const jid of men) { const mj = await getPhoneJid({ id: jid }) || jid; if (removeMute(j, mj)) names.push(`@${mj.split("@")[0]}`); }
    if (!names.length) { await sock.sendMessage(j, { text: "⚠️ এই Member Mute ছিল না।" }); return; }
    await sock.sendMessage(j, { text: `🔊 *UNMUTED*\n\n${names.join(", ")}\n\n🤍 *${BOT_NAME}*`, mentions: men });
  } catch {}
}
async function handleMuteList(j) {
  try {
    const list = [];
    for (const [k, d] of Object.entries(mutedUsers)) {
      const [g, m] = k.split(":");
      if (g !== j) continue;
      const rem = d.until - Date.now();
      if (rem <= 0) continue;
      list.push({ m, rem });
    }
    if (!list.length) { await sock.sendMessage(j, { text: `🔊 *MUTE LIST*\n\nকেউ Mute নেই।\n\n🤍 *${BOT_NAME}*` }); return; }
    const lines = [], mentions = [];
    let n = 1;
    for (const it of list) { lines.push(`${n}. @${it.m.split("@")[0]} — ⏱️ ${formatGroupDuration(it.rem)}`); mentions.push(it.m); n++; }
    await sock.sendMessage(j, { text: `🔇 *MUTE LIST*\n\n${lines.join("\n")}\n\n👥 মোট: ${list.length}\n\n🤍 *${BOT_NAME}*`, mentions });
  } catch {}
}

/* ================= START BOT ================= */
async function startBot() {
  try {
    let authState = await useMultiFileAuthState(AUTH_DIR);
    let { state, saveCreds } = authState;
    const cp = getCredentialPhoneNumber(state.creds);
    const nc = PHONE_NUMBER && state.creds.registered && cp && cp !== PHONE_NUMBER;
    if (nc) {
      await resetAuthForNumberChange();
      pairingRequested = false;
      authState = await useMultiFileAuthState(AUTH_DIR);
      state = authState.state; saveCreds = authState.saveCreds;
    }
    sock = makeWASocket({ auth: state, logger, browser: Browsers.ubuntu("Chrome"), markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false, printQRInTerminal: false });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("contacts.upsert", c => { try { saveContacts(c); } catch {} });
    sock.ev.on("contacts.update", c => { try { saveContacts(c); } catch {} });
    sock.ev.on("group-participants.update", async e => {
      try {
        const g = e?.id, act = e?.action, ps = e?.participants || [];
        if (!g) return;
        if (!(await isBotAdminInGroup(g))) return;
        if (act === "add") for (const p of ps) await sendWelcome(g, p);
        if (act === "remove") for (const p of ps) await sendGoodbye(g, p);
      } catch {}
    });
    sock.ev.on("connection.update", async u => {
      try {
        const { connection, lastDisconnect } = u;
        if (connection === "connecting") { console.log("🔄 Connecting..."); if (PHONE_NUMBER && !state.creds.registered) await generatePairingCode(state); }
        if (connection === "open") { console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━"); console.log("✅ WhatsApp Bot Connected!"); console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━"); reconnecting = false; pairingRequested = false; return; }
        if (connection === "close") {
          const sc = new Boom(lastDisconnect?.error)?.output?.statusCode;
          const sr = sc !== DisconnectReason.loggedOut;
          console.log(`❌ Closed. Code: ${sc}`);
          sock = null; pairingRequested = false;
          if (sr && !reconnecting) { reconnecting = true; setTimeout(() => { reconnecting = false; startBot(); }, 3000); }
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
            if (await moderateMessage(remoteJid, message, text)) continue;
            const trimmed = text.trim();
            const botJid = getBotPhoneJid();
            const men = getMentionedJids(message);
            const low = trimmed.toLowerCase();
            const botMen = botJid && men.some(j => j === botJid || (j.includes("@lid") && botJid.includes(j.split("@")[0])));
            const isAI = low.startsWith("/ai ") || low === "/ai";
            const isAIM = low.startsWith("@ai ") || low === "@ai";
            if ((botMen || isAI || isAIM) && isBotEnabled(remoteJid) && isAIEnabled(remoteJid)) {
              const sender = message.key.participant;
              const pj = await getPhoneJid({ id: sender });
              const n = contactNames.get(pj) || "User";
              if (isAIRateLimited(pj)) { await sock.sendMessage(remoteJid, { text: "⏳ একটু অপেক্ষা করুন...", quoted: message }); continue; }
              let q = trimmed.replace(/^\/ai\s+/i, "").replace(/^@ai\s+/i, "");
              if (botJid) { const bn = botJid.split("@")[0]; q = q.replace(new RegExp(`@${bn}`, "gi"), "").trim(); }
              if (!q) { await sock.sendMessage(remoteJid, { text: "❓ কী জানতে চান?", quoted: message }); continue; }
              await sock.sendMessage(remoteJid, { text: "🤔 ভাবছি...", quoted: message });
              const reply = await getAIReply(remoteJid, q, n);
              if (reply) await sock.sendMessage(remoteJid, { text: `${reply}\n\n🤍 *${BOT_NAME}*`, quoted: message });
              else await sock.sendMessage(remoteJid, { text: "❌ দুঃখিত, এখন উত্তর দিতে পারছি না।", quoted: message });
              continue;
            }
            if (isCalculatorMessage(trimmed)) { await handleCalculator(remoteJid, trimmed); continue; }
            if (!trimmed.startsWith("/")) continue;
            const parts = trimmed.split(/\s+/);
            const rc = parts.shift() || "";
            const cmd = normalizeCommandName(rc);
            const args = parts;
            if (!cmd) continue;
            if (ADMIN_ONLY_COMMANDS.includes(cmd)) {
              if (!(await isSenderAdmin(remoteJid, message))) {
                if (["mute","unmute","mutelist","aion","aioff"].includes(cmd)) await sock.sendMessage(remoteJid, { text: `❌ *ADMIN ONLY* 🔒` });
                continue;
              }
            }
            if (cmd === "গ্রুপ") {
              const sub = normalizeCommandName(args[0]);
              if (sub !== "বন্ধ") { await sock.sendMessage(remoteJid, { text: `🔒 /গ্রুপ বন্ধ 2 মিনিট` }); continue; }
              const dms = parseGroupDuration(args.slice(1).join(" ").trim());
              if (!dms) { await sock.sendMessage(remoteJid, { text: "❌ সময় সঠিক নয়।" }); continue; }
              await lockGroup(remoteJid, dms);
              continue;
            }
            if (cmd === "aion") { setAIStatus(remoteJid, true); await sock.sendMessage(remoteJid, { text: "🤖 *AI ON*" }); continue; }
            if (cmd === "aioff") { setAIStatus(remoteJid, false); await sock.sendMessage(remoteJid, { text: "🤖 *AI OFF*" }); continue; }
            if (cmd === "botoff") { if (!isBotEnabled(remoteJid)) { await sock.sendMessage(remoteJid, { text: BOT_ALREADY_OFF_TEXT }); continue; } setBotStatus(remoteJid, false); await sock.sendMessage(remoteJid, { text: BOT_OFF_TEXT }); continue; }
            if (cmd === "boton") { if (isBotEnabled(remoteJid)) { await sock.sendMessage(remoteJid, { text: BOT_ALREADY_ON_TEXT }); continue; } setBotStatus(remoteJid, true); await sock.sendMessage(remoteJid, { text: BOT_ON_TEXT }); continue; }
            if (cmd === "adminpanel") { await sendAdminPanel(remoteJid); continue; }
            if (["mod","moderation","modstatus"].includes(cmd)) { await sendModerationStatus(remoteJid); continue; }
            if (cmd === "modon") { for (const k of Object.keys(MODERATION_DEFAULTS)) setModerationStatus(remoteJid, k, true); await sock.sendMessage(remoteJid, { text: "🛡️ *MODERATION ON*" }); continue; }
            if (cmd === "modoff") { for (const k of Object.keys(MODERATION_DEFAULTS)) setModerationStatus(remoteJid, k, false); await sock.sendMessage(remoteJid, { text: "🛡️ *MODERATION OFF*" }); continue; }
            if (cmd === "on" || cmd === "off") {
              const t = getCanonicalCommand(args[0] || "");
              if (!t) { await sock.sendMessage(remoteJid, { text: "⚙️ /off <command>" }); continue; }
              if (PROTECTED_COMMANDS.includes(t)) { await sock.sendMessage(remoteJid, { text: "⚠️ বন্ধ করা যাবে না।" }); continue; }
              if (!isKnownCommand(t)) { await sock.sendMessage(remoteJid, { text: `❌ /${t} নেই।` }); continue; }
              const en = cmd === "on";
              setCommandStatus(remoteJid, t, en);
              await sock.sendMessage(remoteJid, { text: `${en ? "🟢" : "🔴"} */${t}* ${en ? "ON" : "OFF"}` });
              continue;
            }
            if (cmd === "cmdlist") { await sendCommandList(remoteJid); continue; }
            if (cmd === "mute") { await handleMute(remoteJid, message, args); continue; }
            if (cmd === "unmute") { await handleUnmute(remoteJid, message); continue; }
            if (cmd === "mutelist") { await handleMuteList(remoteJid); continue; }
            if (!isBotEnabled(remoteJid)) continue;
            const ca = getCanonicalCommand(cmd);
            if (!isKnownCommand(ca) || !isCommandEnabled(remoteJid, ca)) continue;
            if (ca === "menu" || ca === "bot") { await sendPublicMenu(remoteJid); continue; }
            if (ca === "rules") { await sock.sendMessage(remoteJid, { text: GROUP_RULES }); continue; }
            if (ca === "website") { await sock.sendMessage(remoteJid, { text: WEBSITE_TEXT }); continue; }
            if (ca === "deal") { await sendDealNotice(remoteJid); continue; }
            if (ca === "admin") { await sendAdminList(remoteJid); continue; }
            if (ca === "tagall") { await handleTagAll(remoteJid, message, args); continue; }
            if (ca === "members") { const m = await sock.groupMetadata(remoteJid); await sock.sendMessage(remoteJid, { text: `👥 *MEMBERS*\n\nমোট: ${(m?.participants || []).length} জন` }); continue; }
            if (ca === "groupinfo") {
              const m = await sock.groupMetadata(remoteJid);
              const ps = m?.participants || [], ads = ps.filter(isAdminParticipant);
              await sock.sendMessage(remoteJid, { text: `👥 *GROUP INFO*\n\n📛 ${m?.subject || "Unknown"}\n🆔 ${remoteJid}\n👥 ${ps.length}\n👑 ${ads.length}\n🤖 Bot: ${isBotEnabled(remoteJid) ? "🟢" : "🔴"}\n🧠 AI: ${isAIEnabled(remoteJid) ? "🟢" : "🔴"}` });
              continue;
            }
            if (ca === "id") { await sock.sendMessage(remoteJid, { text: `🆔 *GROUP ID*\n\n${remoteJid}` }); continue; }
            if (ca === "ping") {
              const st = Date.now();
              const msg = await sock.sendMessage(remoteJid, { text: "🏓 Checking..." });
              await sock.sendMessage(remoteJid, { text: `🏓 *PONG!*\n⚡ ${Date.now() - st}ms`, quoted: msg });
              continue;
            }
            if (ca === "piyas") { await sock.sendMessage(remoteJid, { text: PIYAS_INFO }); continue; }
          } catch (me) { console.log("⚠️ msg err:", me?.message); }
        }
      } catch (e) { console.log("⚠️ handler err:", e?.message); }
    });
    console.log("🚀 WhatsApp Bot Starting...");
  } catch (e) {
    console.log("❌ Failed:", e?.message);
    sock = null;
    if (!reconnecting) { reconnecting = true; setTimeout(() => { reconnecting = false; startBot(); }, 5000); }
  }
}

/* ================= GLOBAL ERRORS ================= */
process.on("uncaughtException", e => console.log("❌ Uncaught:", e));
process.on("unhandledRejection", e => console.log("❌ Unhandled:", e));

/* ================= SHUTDOWN ================= */
async function shutdown() {
  console.log("\n🛑 Shutting down...");
  try { if (sock) sock.end(new Error("Shutdown")); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/* ================= LOAD & START ================= */
loadBotStatus();
loadWarnings();
loadMuted();
loadAIStatus();

startBot();