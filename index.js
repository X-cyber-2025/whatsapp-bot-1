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
const STATS_FILE = "./stats.json";
const ACTIVITY_FILE = "./activity.json";

const BOT_NAME = "Piyas Bot";
const GROUP_LOCK_CHECK_INTERVAL = 10 * 1000;

let sock = null;
let reconnecting = false;
let pairingRequested = false;

const logger = P({ level: "silent" });

const contactNames = new Map();
const contactPhoneJids = new Map();
const lidToPhoneJid = new Map();

/* =========================================================
   MODERATION
========================================================= */

const MODERATION_DEFAULTS = {
  badWords: true,
  links: true,
  spam: true,
  flood: true,
  mentions: true,
  warnings: true
};

const BAD_WORDS = [
  "সালা", "শালা", "সালি", "সালী", "শালি", "ষালি", "ষালী",
  "খাংকি", "খাংকী", "খানকি", "খানকী", "মাগি", "মাগী",
  "বেসসা", "বেশ্যা", "চোদা", "চোদন", "চুদ", "চুদা",
  "চুদাচুদি", "হারামি", "হারামী", "হারামজাদা", "হারামজাদী",
  "কুত্তা", "কুত্তার", "শুয়োর", "শুয়োর", "বাঞ্চোদ", "বাল",
  "বালের", "ফাক", "fuck", "fucking", "fucker", "motherfucker",
  "bitch", "bastard", "asshole", "dick", "pussy", "sex", "porn"
];

const SPAM_WINDOW_MS = 60 * 1000;
const FLOOD_WINDOW_MS = 10 * 1000;
const FLOOD_LIMIT = 8;
const MENTION_LIMIT = 8;
const MAX_TEXT_LENGTH = 5000;

const spamTracker = new Map();
const floodTracker = new Map();

/* =========================================================
   DATA
========================================================= */

let warnings = {};
let botStatus = {};
let stats = {};
let activity = {};

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    ) || fallback;

  } catch (error) {
    console.log(`⚠️ JSON load error: ${file}`, error?.message);
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch (error) {
    console.log(`⚠️ JSON save error: ${file}`, error?.message);
  }
}

function loadWarnings() {
  warnings = readJson(WARNING_FILE, {});
}

function saveWarnings() {
  writeJson(WARNING_FILE, warnings);
}

function loadBotStatus() {
  botStatus = readJson(BOT_STATUS_FILE, {});

  for (const [groupId, value] of Object.entries(botStatus)) {
    if (typeof value === "boolean") {
      botStatus[groupId] = createDefaultGroupStatus();
      botStatus[groupId].enabled = value;
    }

    normalizeGroupStatus(groupId);
  }
}

function saveBotStatus() {
  writeJson(BOT_STATUS_FILE, botStatus);
}

function loadStats() {
  stats = readJson(STATS_FILE, {});
}

function saveStats() {
  writeJson(STATS_FILE, stats);
}

function loadActivity() {
  activity = readJson(ACTIVITY_FILE, {});
}

function saveActivity() {
  writeJson(ACTIVITY_FILE, activity);
}

/* =========================================================
   GROUP STATUS
========================================================= */

function createDefaultGroupStatus() {
  return {
    enabled: true,
    disabledCommands: [],
    moderation: {
      ...MODERATION_DEFAULTS
    },
    groupLockedUntil: null,
    welcome: true
  };
}

function normalizeGroupStatus(groupId) {
  if (
    !botStatus[groupId] ||
    typeof botStatus[groupId] !== "object"
  ) {
    botStatus[groupId] = createDefaultGroupStatus();
  }

  const status = botStatus[groupId];

  if (!Array.isArray(status.disabledCommands)) {
    status.disabledCommands = [];
  }

  if (
    !status.moderation ||
    typeof status.moderation !== "object"
  ) {
    status.moderation = {
      ...MODERATION_DEFAULTS
    };
  }

  for (const [key, value] of Object.entries(MODERATION_DEFAULTS)) {
    if (typeof status.moderation[key] !== "boolean") {
      status.moderation[key] = value;
    }
  }

  if (
    typeof status.groupLockedUntil !== "number" &&
    status.groupLockedUntil !== null
  ) {
    status.groupLockedUntil = null;
  }

  if (typeof status.welcome !== "boolean") {
    status.welcome = true;
  }

  return status;
}

function getGroupStatus(groupId) {
  return normalizeGroupStatus(groupId);
}

function isBotEnabled(groupId) {
  return getGroupStatus(groupId).enabled !== false;
}

function setBotStatus(groupId, enabled) {
  getGroupStatus(groupId).enabled = Boolean(enabled);
  saveBotStatus();
}

function isModerationEnabled(groupId, type) {
  return Boolean(
    getGroupStatus(groupId).moderation[type]
  );
}

function setModerationStatus(groupId, type, enabled) {
  if (
    !Object.prototype.hasOwnProperty.call(
      MODERATION_DEFAULTS,
      type
    )
  ) {
    return false;
  }

  getGroupStatus(groupId).moderation[type] =
    Boolean(enabled);

  saveBotStatus();
  return true;
}

/* =========================================================
   COMMANDS
========================================================= */

const COMMAND_DEFINITIONS = [
  {
    key: "menu",
    command: "/menu",
    title: "Main Menu"
  },
  {
    key: "bot",
    command: "/bot",
    title: "Bot Menu"
  },
  {
    key: "rules",
    command: "/rules",
    title: "Group Rules"
  },
  {
    key: "admin",
    command: "/admin",
    title: "Admin List"
  },
  {
    key: "members",
    command: "/members",
    title: "Group Members"
  },
  {
    key: "groupinfo",
    command: "/groupinfo",
    title: "Group Info"
  },
  {
    key: "id",
    command: "/id",
    title: "Group ID"
  },
  {
    key: "ping",
    command: "/ping",
    title: "Ping"
  },
  {
    key: "deal",
    command: "/deal",
    title: "Buy / Sell Deal"
  },
  {
    key: "piyas",
    command: "/piyas",
    title: "Piyas Info"
  },
  {
    key: "website",
    command: "/website",
    title: "Official Website"
  },
  {
    key: "warnings",
    command: "/warnings",
    title: "Warnings"
  },
  {
    key: "userinfo",
    command: "/userinfo",
    title: "User Info"
  },
  {
    key: "stats",
    command: "/stats",
    title: "Group Stats"
  },
  {
    key: "activity",
    command: "/activity",
    title: "Activity Log"
  },
  {
    key: "settings",
    command: "/settings",
    title: "Settings"
  },
  {
    key: "link",
    command: "/link",
    title: "Group Link"
  },
  {
    key: "owner",
    command: "/owner",
    title: "Group Owner"
  }
];

const COMMAND_ALIASES = {
  "ডিল": "deal"
};

const ADMIN_ONLY_COMMANDS = [
  "adminpanel",
  "cmdlist",
  "on",
  "off",
  "boton",
  "botoff",
  "mod",
  "moderation",
  "modstatus",
  "modon",
  "modoff",
  "গ্রুপ",
  "clearwarnings",
  "reset",
  "announce"
];

const PROTECTED_COMMANDS = [
  "adminpanel",
  "cmdlist",
  "on",
  "off",
  "boton",
  "botoff",
  "mod",
  "moderation",
  "modstatus",
  "modon",
  "modoff",
  "গ্রুপ"
];

function normalizeCommandName(command) {
  return String(command || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "");
}

function getCanonicalCommand(command) {
  const normalized = normalizeCommandName(command);

  return COMMAND_ALIASES[normalized] || normalized;
}

function getCommandDefinition(command) {
  const key = getCanonicalCommand(command);

  return COMMAND_DEFINITIONS.find(
    item => item.key === key
  ) || null;
}

function isKnownCommand(command) {
  return Boolean(
    getCommandDefinition(command)
  );
}

function isCommandEnabled(groupId, command) {
  const name = getCanonicalCommand(command);

  if (!name) return true;

  return !getGroupStatus(groupId)
    .disabledCommands
    .includes(name);
}

function setCommandStatus(groupId, command, enabled) {
  const name = getCanonicalCommand(command);

  if (!name) return false;

  const list =
    getGroupStatus(groupId).disabledCommands;

  const index = list.indexOf(name);

  if (enabled && index !== -1) {
    list.splice(index, 1);
  }

  if (!enabled && index === -1) {
    list.push(name);
  }

  saveBotStatus();

  return true;
}

/* =========================================================
   JID / CONTACT HELPERS
========================================================= */

function normalizeJid(jid) {
  return typeof jid === "string"
    ? jid.trim()
    : null;
}

function isPhoneJid(jid) {
  return (
    typeof jid === "string" &&
    jid.endsWith("@s.whatsapp.net")
  );
}

function isLidJid(jid) {
  return (
    typeof jid === "string" &&
    jid.endsWith("@lid")
  );
}

function phoneNumberToJid(phone) {
  const number = String(phone || "")
    .replace(/@s.whatsapp.net/g, "")
    .replace(/[^0-9]/g, "");

  return number.length >= 8
    ? `${number}@s.whatsapp.net`
    : null;
}

function cleanName(name) {
  const value = String(name || "")
    .replace(/\s+/g, " ")
    .trim();

  return value
    ? value.slice(0, 80)
    : null;
}

function getDisplayName(participant = {}) {
  const ids = [
    participant.id,
    participant.lid,
    participant.phoneNumber
  ].filter(Boolean);

  for (const id of ids) {
    const cached = contactNames.get(id);

    if (cached) {
      return cached;
    }
  }

  const direct = cleanName(
    participant.username ||
    participant.notify ||
    participant.name ||
    participant.verifiedName ||
    participant.pushName
  );

  if (direct) return direct;

  if (participant.phoneNumber) {
    return String(participant.phoneNumber)
      .replace(/@s.whatsapp.net/g, "")
      .replace(/[^0-9]/g, "") || "Member";
  }

  return (
    String(participant.id || "")
      .split("@")[0] ||
    "Member"
  );
}

function saveLidMapping(lid, pn) {
  if (!isLidJid(lid)) return;

  const phoneJid = isPhoneJid(pn)
    ? pn
    : phoneNumberToJid(pn);

  if (!phoneJid) return;

  lidToPhoneJid.set(lid, phoneJid);
  contactPhoneJids.set(lid, phoneJid);
}

async function resolveLidToPhoneJid(lid) {
  if (isPhoneJid(lid)) {
    return lid;
  }

  if (!isLidJid(lid)) {
    return null;
  }

  const cached =
    lidToPhoneJid.get(lid) ||
    contactPhoneJids.get(lid);

  if (isPhoneJid(cached)) {
    return cached;
  }

  try {
    const mapping =
      sock?.signalRepository?.lidMapping;

    if (
      mapping &&
      typeof mapping.getPNForLID === "function"
    ) {
      const pn =
        await mapping.getPNForLID(lid);

      const phoneJid = isPhoneJid(pn)
        ? pn
        : phoneNumberToJid(pn);

      if (phoneJid) {
        saveLidMapping(lid, phoneJid);
        return phoneJid;
      }
    }
  } catch (error) {
    console.log(
      "⚠️ LID mapping error:",
      error?.message
    );
  }

  return null;
}

function saveContacts(contacts = []) {
  for (const contact of contacts) {
    if (!contact) continue;

    const id = normalizeJid(contact.id);
    const lid = normalizeJid(contact.lid);

    let phoneJid = contact.phoneNumber
      ? (
          isPhoneJid(contact.phoneNumber)
            ? contact.phoneNumber
            : phoneNumberToJid(
                contact.phoneNumber
              )
        )
      : null;

    if (!phoneJid && isPhoneJid(id)) {
      phoneJid = id;
    }

    if (phoneJid && isLidJid(id)) {
      saveLidMapping(id, phoneJid);
    }

    if (phoneJid && lid) {
      saveLidMapping(lid, phoneJid);
    }

    const name = cleanName(
      contact.username ||
      contact.notify ||
      contact.name ||
      contact.verifiedName ||
      contact.pushName
    );

    if (name) {
      if (id) {
        contactNames.set(id, name);
      }

      if (lid) {
        contactNames.set(lid, name);
      }

      if (phoneJid) {
        contactNames.set(phoneJid, name);
      }
    }

    if (phoneJid) {
      if (id) {
        contactPhoneJids.set(
          id,
          phoneJid
        );
      }

      if (lid) {
        contactPhoneJids.set(
          lid,
          phoneJid
        );
      }

      contactPhoneJids.set(
        phoneJid,
        phoneJid
      );
    }
  }
}

function getDirectPhoneJid(participant = {}) {
  if (participant.phoneNumber) {
    return isPhoneJid(
      participant.phoneNumber
    )
      ? participant.phoneNumber
      : phoneNumberToJid(
          participant.phoneNumber
        );
  }

  return isPhoneJid(participant.id)
    ? participant.id
    : null;
}

async function getPhoneJid(participant = {}) {
  const direct =
    getDirectPhoneJid(participant);

  if (direct) return direct;

  for (
    const id of [
      participant.id,
      participant.lid
    ].filter(Boolean)
  ) {
    const cached =
      contactPhoneJids.get(id) ||
      lidToPhoneJid.get(id);

    if (isPhoneJid(cached)) {
      return cached;
    }

    if (isLidJid(id)) {
      const resolved =
        await resolveLidToPhoneJid(id);

      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

async function cacheParticipants(
  participants = []
) {
  for (const participant of participants) {
    if (!participant) continue;

    const name =
      getDisplayName(participant);

    let phoneJid =
      getDirectPhoneJid(participant);

    if (
      !phoneJid &&
      participant.id
    ) {
      phoneJid =
        await resolveLidToPhoneJid(
          participant.id
        );
    }

    if (
      !phoneJid &&
      participant.lid
    ) {
      phoneJid =
        await resolveLidToPhoneJid(
          participant.lid
        );
    }

    if (
      phoneJid &&
      participant.id
    ) {
      contactPhoneJids.set(
        participant.id,
        phoneJid
      );
    }

    if (
      phoneJid &&
      participant.lid
    ) {
      contactPhoneJids.set(
        participant.lid,
        phoneJid
      );
    }

    if (
      phoneJid &&
      isLidJid(participant.id)
    ) {
      saveLidMapping(
        participant.id,
        phoneJid
      );
    }

    if (
      phoneJid &&
      isLidJid(participant.lid)
    ) {
      saveLidMapping(
        participant.lid,
        phoneJid
      );
    }

    if (
      name &&
      name !== "Member"
    ) {
      if (participant.id) {
        contactNames.set(
          participant.id,
          name
        );
      }

      if (participant.lid) {
        contactNames.set(
          participant.lid,
          name
        );
      }

      if (phoneJid) {
        contactNames.set(
          phoneJid,
          name
        );
      }
    }
  }
}

function isAdminParticipant(participant = {}) {
  return (
    participant.admin === "admin" ||
    participant.admin === "superadmin" ||
    participant.admin === true ||
    participant.isAdmin === true ||
    participant.isSuperAdmin === true
  );
}

function isOwnerParticipant(participant = {}) {
  return (
    participant.admin === "superadmin" ||
    participant.isSuperAdmin === true
  );
}

function findParticipant(
  participants = [],
  jid
) {
  return participants.find(p =>
    p?.id === jid ||
    p?.lid === jid ||
    p?.phoneNumber === jid
  ) || null;
}

function getBotPhoneJid() {
  const ownId =
    normalizeJid(sock?.user?.id);

  if (isPhoneJid(ownId)) {
    return ownId.split(":")[0];
  }

  if (isLidJid(ownId)) {
    const cached =
      lidToPhoneJid.get(ownId) ||
      contactPhoneJids.get(ownId);

    if (isPhoneJid(cached)) {
      return cached;
    }
  }

  return PHONE_NUMBER
    ? phoneNumberToJid(PHONE_NUMBER)
    : null;
}

/* =========================================================
   GROUP / ADMIN
========================================================= */

async function isBotAdminInGroup(groupId) {
  try {
    if (
      !sock ||
      !groupId?.endsWith("@g.us")
    ) {
      return false;
    }

    const metadata =
      await sock.groupMetadata(groupId);

    const participants =
      metadata?.participants || [];

    await cacheParticipants(
      participants
    );

    const botJid =
      normalizeJid(sock?.user?.id);

    const botPhoneJid =
      getBotPhoneJid();

    let botParticipant =
      findParticipant(
        participants,
        botJid
      );

    if (
      !botParticipant &&
      botPhoneJid
    ) {
      botParticipant =
        findParticipant(
          participants,
          botPhoneJid
        );
    }

    if (
      !botParticipant &&
      botPhoneJid
    ) {
      const number =
        botPhoneJid
          .split("@")[0]
          .replace(/[^0-9]/g, "");

      botParticipant =
        participants.find(p =>
          String(
            p?.phoneNumber || ""
          )
            .replace(
              /@s.whatsapp.net/g,
              ""
            )
            .replace(
              /[^0-9]/g,
              ""
            ) === number
        );
    }

    if (!botParticipant) {
      return false;
    }

    return isAdminParticipant(
      botParticipant
    );

  } catch (error) {
    console.log(
      "⚠️ Bot admin check:",
      error?.message
    );

    return false;
  }
}

async function isGroupAllowed(groupId) {
  return (
    Boolean(
      groupId?.endsWith("@g.us")
    ) &&
    await isBotAdminInGroup(groupId)
  );
}

async function isSenderAdmin(
  remoteJid,
  message
) {
  try {
    const participantJid =
      message?.key?.participant;

    if (
      !sock ||
      !remoteJid ||
      !participantJid
    ) {
      return false;
    }

    const metadata =
      await sock.groupMetadata(
        remoteJid
      );

    const participants =
      metadata?.participants || [];

    await cacheParticipants(
      participants
    );

    let sender =
      findParticipant(
        participants,
        participantJid
      );

    if (!sender) {
      const phone =
        await resolveLidToPhoneJid(
          participantJid
        );

      if (phone) {
        sender =
          findParticipant(
            participants,
            phone
          );
      }
    }

    return Boolean(
      sender &&
      isAdminParticipant(sender)
    );

  } catch (error) {
    console.log(
      "⚠️ Sender admin check:",
      error?.message
    );

    return false;
  }
}
/* =========================================================
   WARNING SYSTEM
========================================================= */

function getGroupWarningData(groupId) {
  if (!warnings[groupId]) {
    warnings[groupId] = {};
  }

  return warnings[groupId];
}

function getMemberWarningCount(
  groupId,
  memberJid
) {
  const group =
    getGroupWarningData(groupId);

  return Number(
    group[memberJid]?.count || 0
  );
}

function addWarning(
  groupId,
  memberJid,
  reason = "Rule violation"
) {
  const group =
    getGroupWarningData(groupId);

  if (!group[memberJid]) {
    group[memberJid] = {
      count: 0,
      reasons: []
    };
  }

  group[memberJid].count += 1;

  if (!Array.isArray(
    group[memberJid].reasons
  )) {
    group[memberJid].reasons = [];
  }

  group[memberJid].reasons.push({
    reason,
    time: new Date().toISOString()
  });

  if (
    group[memberJid].reasons.length > 20
  ) {
    group[memberJid].reasons =
      group[memberJid].reasons.slice(-20);
  }

  saveWarnings();

  return group[memberJid].count;
}

function clearMemberWarnings(
  groupId,
  memberJid
) {
  const group =
    getGroupWarningData(groupId);

  delete group[memberJid];

  saveWarnings();
}

function clearGroupWarnings(groupId) {
  warnings[groupId] = {};
  saveWarnings();
}

/* =========================================================
   STATISTICS
========================================================= */

function createDefaultStats() {
  return {
    messages: 0,
    commands: 0,
    deleted: 0,
    badWords: 0,
    links: 0,
    spam: 0,
    flood: 0,
    mentions: 0,
    warnings: 0,
    joins: 0,
    leaves: 0
  };
}

function getGroupStats(groupId) {
  if (!stats[groupId]) {
    stats[groupId] =
      createDefaultStats();
  }

  return stats[groupId];
}

function incrementStat(
  groupId,
  key,
  amount = 1
) {
  const group =
    getGroupStats(groupId);

  if (
    typeof group[key] !== "number"
  ) {
    group[key] = 0;
  }

  group[key] += amount;

  saveStats();
}

/* =========================================================
   ACTIVITY LOG
========================================================= */

function addActivity(
  groupId,
  type,
  data = {}
) {
  if (!activity[groupId]) {
    activity[groupId] = [];
  }

  activity[groupId].push({
    type,
    ...data,
    time: new Date().toISOString()
  });

  if (
    activity[groupId].length > 100
  ) {
    activity[groupId] =
      activity[groupId].slice(-100);
  }

  saveActivity();
}

/* =========================================================
   TEXT HELPERS
========================================================= */

function normalizeText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function containsBadWord(text) {
  const normalized =
    normalizeText(text);

  if (!normalized) {
    return false;
  }

  return BAD_WORDS.some(word => {
    const normalizedWord =
      normalizeText(word);

    return (
      normalizedWord &&
      normalized.includes(
        normalizedWord
      )
    );
  });
}

function containsLink(text) {
  const value =
    String(text || "");

  const patterns = [
    /https?:\/\/\S+/i,
    /www\.\S+/i,
    /\b[a-z0-9-]+\.(com|net|org|info|xyz|site|online|app|io|co|me|bd|tv)\b/i,
    /t\.me\//i,
    /wa\.me\//i,
    /chat\.whatsapp\.com\//i
  ];

  return patterns.some(
    pattern => pattern.test(value)
  );
}

function normalizeForSpam(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getMessageKey(
  groupId,
  senderJid
) {
  return `${groupId}:${senderJid}`;
}

function isDuplicateSpam(
  groupId,
  senderJid,
  text
) {
  const normalized =
    normalizeForSpam(text);

  if (!normalized) {
    return false;
  }

  const key =
    getMessageKey(
      groupId,
      senderJid
    );

  const now = Date.now();

  const previous =
    spamTracker.get(key);

  if (
    previous &&
    previous.text === normalized &&
    now - previous.time <
      SPAM_WINDOW_MS
  ) {
    previous.count += 1;
    previous.time = now;

    spamTracker.set(
      key,
      previous
    );

    return previous.count >= 2;
  }

  spamTracker.set(
    key,
    {
      text: normalized,
      time: now,
      count: 1
    }
  );

  return false;
}

function isFlood(
  groupId,
  senderJid
) {
  const key =
    getMessageKey(
      groupId,
      senderJid
    );

  const now = Date.now();

  let data =
    floodTracker.get(key);

  if (!data) {
    data = [];
  }

  data = data.filter(
    timestamp =>
      now - timestamp <
      FLOOD_WINDOW_MS
  );

  data.push(now);

  floodTracker.set(
    key,
    data
  );

  return data.length >= FLOOD_LIMIT;
}

function countMentions(message) {
  const mentioned =
    message?.contextInfo
      ?.mentionedJid;

  return Array.isArray(mentioned)
    ? mentioned.length
    : 0;
}

/* =========================================================
   MESSAGE TEXT EXTRACTION
========================================================= */

function getMessageText(message) {
  if (!message) {
    return "";
  }

  if (
    typeof message.conversation ===
    "string"
  ) {
    return message.conversation;
  }

  if (
    message.extendedTextMessage
      ?.text
  ) {
    return (
      message.extendedTextMessage.text
    );
  }

  if (
    message.imageMessage
      ?.caption
  ) {
    return (
      message.imageMessage.caption
    );
  }

  if (
    message.videoMessage
      ?.caption
  ) {
    return (
      message.videoMessage.caption
    );
  }

  if (
    message.documentMessage
      ?.caption
  ) {
    return (
      message.documentMessage.caption
    );
  }

  if (
    message.buttonsResponseMessage
      ?.selectedButtonId
  ) {
    return (
      message.buttonsResponseMessage
        .selectedButtonId
    );
  }

  if (
    message.listResponseMessage
      ?.singleSelectReply
      ?.selectedRowId
  ) {
    return (
      message.listResponseMessage
        .singleSelectReply
        .selectedRowId
    );
  }

  if (
    message.templateButtonReplyMessage
      ?.selectedId
  ) {
    return (
      message.templateButtonReplyMessage
        .selectedId
    );
  }

  if (
    message.interactiveResponseMessage
  ) {
    const nativeFlow =
      message
        .interactiveResponseMessage
        ?.nativeFlowResponseMessage;

    if (nativeFlow?.paramsJson) {
      try {
        const parsed =
          JSON.parse(
            nativeFlow.paramsJson
          );

        return (
          parsed.id ||
          parsed.display_text ||
          ""
        );
      } catch {
        return "";
      }
    }
  }

  return "";
}

/* =========================================================
   PHONE / USER DISPLAY
========================================================= */

function jidToNumber(jid) {
  return String(jid || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/[^0-9]/g, "");
}

function formatUserMention(jid) {
  const name =
    contactNames.get(jid);

  const number =
    jidToNumber(jid);

  if (name) {
    return `${name} (${number})`;
  }

  return number
    ? `+${number}`
    : "Unknown User";
}

function getMessageSender(message) {
  return (
    message?.key?.participant ||
    message?.key?.remoteJid ||
    ""
  );
}

/* =========================================================
   COPY BUTTON
========================================================= */

async function sendCopyButton(
  jid,
  text,
  copyText,
  quoted = null
) {
  try {
    const message =
      generateWAMessageFromContent(
        jid,
        {
          viewOnceMessage: {
            message: {
              interactiveMessage: {
                body: {
                  text
                },
                footer: {
                  text: BOT_NAME
                },
                nativeFlowMessage: {
                  buttons: [
                    {
                      name: "cta_copy",
                      buttonParamsJson:
                        JSON.stringify({
                          display_text:
                            "📋 Copy",
                          copy_code:
                            copyText
                        })
                    }
                  ]
                }
              }
            }
          }
        },
        {
          userJid:
            sock?.user?.id,
          quoted
        }
      );

    await sock.relayMessage(
      jid,
      message.message,
      {
        messageId:
          message.key.id
      }
    );

    return true;

  } catch (error) {
    console.log(
      "⚠️ Copy button error:",
      error?.message
    );

    await sock.sendMessage(
      jid,
      {
        text:
          `${text}\n\n` +
          `📋 ${copyText}`
      },
      {
        quoted
      }
    );

    return false;
  }
}

/* =========================================================
   RULES
========================================================= */

const GROUP_RULES = `
╭━━━━━━━━━━━━━━━━━━╮
       📜 GROUP RULES
╰━━━━━━━━━━━━━━━━━━╯

1️⃣ সবাইকে সম্মান করুন।
2️⃣ অশ্লীল/আপত্তিকর ভাষা ব্যবহার করবেন না।
3️⃣ Spam বা একই মেসেজ বারবার পাঠাবেন না।
4️⃣ অনুমতি ছাড়া কোনো Link/Promotion দেওয়া যাবে না।
5️⃣ অন্য সদস্যকে বিরক্ত করবেন না।
6️⃣ Scam বা Fraud থেকে সবাই সতর্ক থাকুন।
7️⃣ Admin-এর নির্দেশনা মেনে চলুন।
8️⃣ সন্দেহজনক কোনো Link-এ ক্লিক করবেন না।
9️⃣ ব্যক্তিগত তথ্য প্রকাশ করবেন না।
🔟 Group-এর পরিবেশ সুন্দর রাখুন।

⚠️ নিয়ম ভঙ্গ করলে Bot Warning দিতে পারে।
`.trim();

/* =========================================================
   PIYAS INFO
========================================================= */

const PIYAS_INFO = `
╭━━━━━━━━━━━━━━━━━━╮
        👤 PIYAS INFO
╰━━━━━━━━━━━━━━━━━━╯

Name: মোঃ আল আমিন
English Name: MD. AL AMIN
Date of Birth: 09 January 2006
Blood Group: A+
Marital Status: Unmarried

━━━━━━━━━━━━━━━━━━

🌐 Website:
${WEBSITE_URL}

━━━━━━━━━━━━━━━━━━

🤖 Bot:
${BOT_NAME}
`.trim();

/* =========================================================
   DEAL MESSAGE
========================================================= */

const DEAL_TEXT = `
╭━━━━━━━━━━━━━━━━━━╮
       💰 DEAL NOTICE
╰━━━━━━━━━━━━━━━━━━╯

যেকোনো Deal করার আগে অবশ্যই
Group-এর নির্ধারিত Admin-এর সাথে
যোগাযোগ করুন।

⚠️ Unknown person-এর কাছে টাকা
পাঠানোর আগে ভালোভাবে যাচাই করুন।

⚠️ ব্যক্তিগতভাবে Deal করলে তার
দায়ভার নিজেকেই নিতে হবে।

━━━━━━━━━━━━━━━━━━

🌐 Website:
${WEBSITE_URL}
`.trim();

/* =========================================================
   MENU
========================================================= */

function getMainMenuText() {
  return `
╭━━━━━━━━━━━━━━━━━━╮
        🤖 ${BOT_NAME}
╰━━━━━━━━━━━━━━━━━━╯

📌 GENERAL COMMANDS

/menu
/bot
/rules
/admin
/members
/groupinfo
/id
/ping
/deal
/piyas
/website

🛡️ MODERATION

/warnings
/userinfo
/stats
/activity
/settings
/link
/owner

━━━━━━━━━━━━━━━━━━

🔐 ADMIN COMMANDS

/adminpanel
/cmdlist
/on
/off
/boton
/botoff
/mod
/modstatus
/modon
/modoff
/clearwarnings
/reset
/announce

━━━━━━━━━━━━━━━━━━

⚙️ GROUP CONTROL

/গ্রুপ বন্ধ 2 মিনিট
/গ্রুপ খোলা

━━━━━━━━━━━━━━━━━━

💡 Command-এর বিস্তারিত জানতে
/menu অথবা /bot ব্যবহার করুন।
`.trim();
}

function getAdminMenuText() {
  return `
╭━━━━━━━━━━━━━━━━━━╮
      🔐 ADMIN PANEL
╰━━━━━━━━━━━━━━━━━━╯

🤖 Bot Control

/boton
/botoff

🛡️ Moderation

/mod
/modstatus
/modon badWords
/modoff badWords
/modon links
/modoff links
/modon spam
/modoff spam
/modon flood
/modoff flood
/modon mentions
/modoff mentions
/modon warnings
/modoff warnings

⚙️ Command Control

/on command
/off command

📊 Management

/stats
/activity
/settings
/clearwarnings
/reset

📢 Announcement

/announce message

🔒 Group Lock

/গ্রুপ বন্ধ 2 মিনিট
/গ্রুপ খোলা

━━━━━━━━━━━━━━━━━━

⚠️ Admin command শুধুমাত্র
Group Admin ব্যবহার করতে পারবেন।
`.trim();
}

/* =========================================================
   SEND MENU
========================================================= */

async function sendMainMenu(
  jid,
  quoted = null
) {
  const text =
    getMainMenuText();

  await sendCopyButton(
    jid,
    text,
    "/menu",
    quoted
  );
}

async function sendBotMenu(
  jid,
  quoted = null
) {
  const text = `
╭━━━━━━━━━━━━━━━━━━╮
       🤖 BOT MENU
╰━━━━━━━━━━━━━━━━━━╯

/menu
➡️ Main Menu

/rules
➡️ Group Rules

/admin
➡️ Admin List

/members
➡️ Member List

/groupinfo
➡️ Group Information

/id
➡️ Group ID

/ping
➡️ Check Bot Response

/deal
➡️ Deal Information

/piyas
➡️ Piyas Information

/website
➡️ Website

/warnings
➡️ Warning Information

/userinfo
➡️ User Information

/stats
➡️ Group Statistics

/activity
➡️ Recent Activity

/settings
➡️ Bot Settings

/link
➡️ Group Invite Link

/owner
➡️ Group Owner

━━━━━━━━━━━━━━━━━━

⚡ ${BOT_NAME}
`.trim();

  await sendCopyButton(
    jid,
    text,
    "/bot",
    quoted
  );
}

/* =========================================================
   GROUP INFO
========================================================= */

async function getGroupMetadata(
  groupId
) {
  try {
    return await sock.groupMetadata(
      groupId
    );
  } catch (error) {
    console.log(
      "⚠️ Group metadata error:",
      error?.message
    );

    return null;
  }
}

async function sendGroupInfo(
  jid,
  quoted = null
) {
  const metadata =
    await getGroupMetadata(jid);

  if (!metadata) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Group information পাওয়া যায়নি।"
      },
      { quoted }
    );

    return;
  }

  const participants =
    metadata.participants || [];

  await cacheParticipants(
    participants
  );

  const admins =
    participants.filter(
      isAdminParticipant
    );

  const owners =
    participants.filter(
      isOwnerParticipant
    );

  const status =
    getGroupStatus(jid);

  const locked =
    status.groupLockedUntil &&
    status.groupLockedUntil >
      Date.now();

  const text = `
╭━━━━━━━━━━━━━━━━━━╮
       👥 GROUP INFO
╰━━━━━━━━━━━━━━━━━━╯

📛 Name:
${metadata.subject || "Unknown"}

🆔 Group ID:
${jid}

👥 Members:
${participants.length}

👑 Admins:
${admins.length}

⭐ Owner:
${
  owners.length
    ? formatUserMention(
        owners[0].id
      )
    : "Not found"
}

🤖 Bot:
${
  status.enabled
    ? "🟢 Enabled"
    : "🔴 Disabled"
}

🔒 Group:
${
  locked
    ? "🔴 Locked"
    : "🟢 Open"
}

👋 Welcome:
${
  status.welcome
    ? "🟢 On"
    : "🔴 Off"
}

━━━━━━━━━━━━━━━━━━

🌐 Website:
${WEBSITE_URL}
`.trim();

  await sock.sendMessage(
    jid,
    {
      text
    },
    { quoted }
  );
}

/* =========================================================
   MEMBERS
========================================================= */

async function sendMembers(
  jid,
  quoted = null
) {
  const metadata =
    await getGroupMetadata(jid);

  if (!metadata) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Members list পাওয়া যায়নি।"
      },
      { quoted }
    );

    return;
  }

  const participants =
    metadata.participants || [];

  await cacheParticipants(
    participants
  );

  const lines =
    participants.map(
      (participant, index) => {
        const admin =
          isAdminParticipant(
            participant
          )
            ? " 👑"
            : "";

        return (
          `${index + 1}. ` +
          `${getDisplayName(
            participant
          )}${admin}`
        );
      }
    );

  const text = `
╭━━━━━━━━━━━━━━━━━━╮
       👥 MEMBERS
╰━━━━━━━━━━━━━━━━━━╯

Total: ${participants.length}

${lines.join("\n")}
`.trim();

  await sock.sendMessage(
    jid,
    {
      text
    },
    { quoted }
  );
}

/* =========================================================
   ADMIN LIST
========================================================= */

async function sendAdminList(
  jid,
  quoted = null
) {
  const metadata =
    await getGroupMetadata(jid);

  if (!metadata) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Admin list পাওয়া যায়নি।"
      },
      { quoted }
    );

    return;
  }

  const participants =
    metadata.participants || [];

  await cacheParticipants(
    participants
  );

  const admins =
    participants.filter(
      isAdminParticipant
    );

  const lines =
    admins.map(
      (participant, index) => {
        const role =
          isOwnerParticipant(
            participant
          )
            ? "👑 Owner"
            : "🛡️ Admin";

        return (
          `${index + 1}. ` +
          `${getDisplayName(
            participant
          )}\n   ${role}`
        );
      }
    );

  const text = `
╭━━━━━━━━━━━━━━━━━━╮
        👑 ADMINS
╰━━━━━━━━━━━━━━━━━━╯

${lines.join("\n\n")}
`.trim();

  await sock.sendMessage(
    jid,
    {
      text
    },
    { quoted }
  );
}

/* =========================================================
   WARNING DISPLAY
========================================================= */

async function sendWarnings(
  jid,
  senderJid,
  quoted = null
) {
  const count =
    getMemberWarningCount(
      jid,
      senderJid
    );

  const data =
    getGroupWarningData(jid);

  const memberData =
    data[senderJid];

  let reasonText =
    "কোনো Warning নেই।";

  if (
    memberData &&
    Array.isArray(
      memberData.reasons
    ) &&
    memberData.reasons.length
  ) {
    const recent =
      memberData.reasons
        .slice(-5)
        .map(
          (item, index) =>
            `${index + 1}. ${item.reason}`
        )
        .join("\n");

    reasonText =
      recent;
  }

  const text = `
╭━━━━━━━━━━━━━━━━━━╮
       ⚠️ WARNINGS
╰━━━━━━━━━━━━━━━━━━╯

👤 User:
${formatUserMention(
  senderJid
)}

⚠️ Total Warning:
${count}

━━━━━━━━━━━━━━━━━━

${reasonText}

━━━━━━━━━━━━━━━━━━

💡 Admin চাইলে Warning
clear করতে পারবেন।
`.trim();

  await sock.sendMessage(
    jid,
    {
      text
    },
    { quoted }
  );
}

/* =========================================================
   USER INFO
========================================================= */

async function sendUserInfo(
  jid,
  targetJid,
  quoted = null
) {
  let resolved =
    await resolveLidToPhoneJid(
      targetJid
    );

  if (!resolved) {
    resolved = targetJid;
  }

  const warningsCount =
    getMemberWarningCount(
      jid,
      targetJid
    );

  const name =
    contactNames.get(
      targetJid
    ) ||
    contactNames.get(
      resolved
    ) ||
    "Unknown";

  const text = `
╭━━━━━━━━━━━━━━━━━━╮
       👤 USER INFO
╰━━━━━━━━━━━━━━━━━━╯

📛 Name:
${name}

📱 Number:
+${
  jidToNumber(
    resolved
  ) || "Unknown"
}

🆔 JID:
${targetJid}

⚠️ Warnings:
${warningsCount}

━━━━━━━━━━━━━━━━━━

🤖 ${BOT_NAME}
`.trim();

  await sock.sendMessage(
    jid,
    {
      text
    },
    { quoted }
  );
}
/* =========================================================
   GROUP SETTINGS
========================================================= */

async function sendSettings(
  jid,
  quoted = null
) {
  const status =
    getGroupStatus(jid);

  const moderation =
    status.moderation;

  const text = `
╭━━━━━━━━━━━━━━━━━━╮
       ⚙️ BOT SETTINGS
╰━━━━━━━━━━━━━━━━━━╯

🤖 Bot:
${
  status.enabled
    ? "🟢 ON"
    : "🔴 OFF"
}

👋 Welcome:
${
  status.welcome
    ? "🟢 ON"
    : "🔴 OFF"
}

━━━━━━━━━━━━━━━━━━

🛡️ MODERATION

Bad Words:
${
  moderation.badWords
    ? "🟢 ON"
    : "🔴 OFF"
}

Links:
${
  moderation.links
    ? "🟢 ON"
    : "🔴 OFF"
}

Spam:
${
  moderation.spam
    ? "🟢 ON"
    : "🔴 OFF"
}

Flood:
${
  moderation.flood
    ? "🟢 ON"
    : "🔴 OFF"
}

Mention Spam:
${
  moderation.mentions
    ? "🟢 ON"
    : "🔴 OFF"
}

Warnings:
${
  moderation.warnings
    ? "🟢 ON"
    : "🔴 OFF"
}

━━━━━━━━━━━━━━━━━━

🔒 Group Lock:
${
  status.groupLockedUntil &&
  status.groupLockedUntil >
    Date.now()
    ? "🔴 LOCKED"
    : "🟢 OPEN"
}

━━━━━━━━━━━━━━━━━━

Use /modstatus for detailed
moderation information.
`.trim();

  await sock.sendMessage(
    jid,
    {
      text
    },
    { quoted }
  );
}

/* =========================================================
   STATS
========================================================= */

async function sendStats(
  jid,
  quoted = null
) {
  const data =
    getGroupStats(jid);

  const text = `
╭━━━━━━━━━━━━━━━━━━╮
       📊 GROUP STATS
╰━━━━━━━━━━━━━━━━━━╯

💬 Messages:
${data.messages}

🤖 Commands:
${data.commands}

🗑️ Deleted:
${data.deleted}

⚠️ Warnings:
${data.warnings}

🚫 Bad Words:
${data.badWords}

🔗 Links Blocked:
${data.links}

🔁 Spam:
${data.spam}

🌊 Flood:
${data.flood}

📢 Mention Spam:
${data.mentions}

👋 Joins:
${data.joins}

🚪 Leaves:
${data.leaves}

━━━━━━━━━━━━━━━━━━

🤖 ${BOT_NAME}
`.trim();

  await sock.sendMessage(
    jid,
    {
      text
    },
    { quoted }
  );
}

/* =========================================================
   ACTIVITY
========================================================= */

async function sendActivity(
  jid,
  quoted = null
) {
  const list =
    activity[jid] || [];

  if (!list.length) {
    await sock.sendMessage(
      jid,
      {
        text:
          "📋 এখনো কোনো Activity Log নেই।"
      },
      { quoted }
    );

    return;
  }

  const recent =
    list.slice(-15).reverse();

  const lines =
    recent.map(
      (item, index) => {
        let description =
          item.type || "activity";

        if (item.user) {
          description +=
            ` — ${item.user}`;
        }

        if (item.command) {
          description +=
            ` — ${item.command}`;
        }

        if (item.reason) {
          description +=
            ` — ${item.reason}`;
        }

        return (
          `${index + 1}. ${description}`
        );
      }
    );

  const text = `
╭━━━━━━━━━━━━━━━━━━╮
       📋 ACTIVITY LOG
╰━━━━━━━━━━━━━━━━━━╯

${lines.join("\n")}

━━━━━━━━━━━━━━━━━━

Showing latest 15 activities.
`.trim();

  await sock.sendMessage(
    jid,
    {
      text
    },
    { quoted }
  );
}

/* =========================================================
   GROUP LINK
========================================================= */

async function sendGroupLink(
  jid,
  quoted = null
) {
  try {
    const code =
      await sock.groupInviteCode(
        jid
      );

    const link =
      `https://chat.whatsapp.com/${code}`;

    await sendCopyButton(
      jid,
      `🔗 Group Invite Link:\n\n${link}`,
      link,
      quoted
    );

  } catch (error) {
    console.log(
      "⚠️ Group link error:",
      error?.message
    );

    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Group invite link পাওয়া যায়নি।\n\n" +
          "⚠️ Bot-এর Admin permission প্রয়োজন হতে পারে।"
      },
      { quoted }
    );
  }
}

/* =========================================================
   GROUP OWNER
========================================================= */

async function sendOwner(
  jid,
  quoted = null
) {
  const metadata =
    await getGroupMetadata(jid);

  if (!metadata) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Group information পাওয়া যায়নি।"
      },
      { quoted }
    );

    return;
  }

  const participants =
    metadata.participants || [];

  await cacheParticipants(
    participants
  );

  const owner =
    participants.find(
      isOwnerParticipant
    );

  if (!owner) {
    await sock.sendMessage(
      jid,
      {
        text:
          "👑 Group Owner পাওয়া যায়নি।"
      },
      { quoted }
    );

    return;
  }

  const phone =
    await getPhoneJid(owner);

  const text = `
╭━━━━━━━━━━━━━━━━━━╮
       👑 GROUP OWNER
╰━━━━━━━━━━━━━━━━━━╯

📛 Name:
${getDisplayName(owner)}

📱 Number:
+${
  phone
    ? jidToNumber(phone)
    : "Unknown"
}

🆔 JID:
${owner.id || "Unknown"}
`.trim();

  await sock.sendMessage(
    jid,
    {
      text
    },
    { quoted }
  );
}

/* =========================================================
   GROUP LOCK
========================================================= */

function parseDuration(input) {
  if (!input) {
    return null;
  }

  const value =
    String(input)
      .trim()
      .toLowerCase();

  const normalized =
    value
      .replace(/মিনিট/g, " minute")
      .replace(/মিনিটে/g, " minute")
      .replace(/ঘণ্টা/g, " hour")
      .replace(/ঘন্টা/g, " hour")
      .replace(/ঘণ্টায়/g, " hour")
      .replace(/দিন/g, " day")
      .replace(/দিনে/g, " day")
      .replace(/সপ্তাহ/g, " week")
      .replace(/সপ্তাহে/g, " week")
      .replace(/মাস/g, " month")
      .replace(/মাসে/g, " month")
      .replace(/বছর/g, " year")
      .replace(/বছরে/g, " year");

  const match =
    normalized.match(
      /(\d+(?:\.\d+)?)\s*(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)/
    );

  if (!match) {
    return null;
  }

  const amount =
    Number(match[1]);

  const unit =
    match[2];

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return null;
  }

  const multipliers = {
    second: 1000,
    seconds: 1000,

    minute: 60 * 1000,
    minutes: 60 * 1000,

    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,

    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,

    week: 7 * 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,

    month: 30 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,

    year: 365 * 24 * 60 * 60 * 1000,
    years: 365 * 24 * 60 * 60 * 1000
  };

  return (
    amount *
    multipliers[unit]
  );
}

async function lockGroup(
  jid,
  durationMs,
  quoted = null
) {
  if (!durationMs) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ সঠিক সময় দিন।\n\n" +
          "Example:\n" +
          "/গ্রুপ বন্ধ 2 মিনিট"
      },
      { quoted }
    );

    return;
  }

  const botAdmin =
    await isBotAdminInGroup(jid);

  if (!botAdmin) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Bot-এর Admin permission নেই।"
      },
      { quoted }
    );

    return;
  }

  const until =
    Date.now() + durationMs;

  try {
    await sock.groupSettingUpdate(
      jid,
      "announcement"
    );

    getGroupStatus(
      jid
    ).groupLockedUntil = until;

    saveBotStatus();

    const seconds =
      Math.ceil(
        durationMs / 1000
      );

    await sock.sendMessage(
      jid,
      {
        text:
          "🔒 *GROUP LOCKED*\n\n" +
          `⏱️ Duration: ${formatDuration(
            seconds
          )}\n\n` +
          "এই সময়ে শুধুমাত্র Admin মেসেজ পাঠাতে পারবেন।"
      },
      { quoted }
    );

  } catch (error) {
    console.log(
      "⚠️ Group lock error:",
      error?.message
    );

    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Group lock করা যায়নি।"
      },
      { quoted }
    );
  }
}

async function unlockGroup(
  jid,
  quoted = null,
  silent = false
) {
  const botAdmin =
    await isBotAdminInGroup(jid);

  if (!botAdmin) {
    if (!silent) {
      await sock.sendMessage(
        jid,
        {
          text:
            "❌ Bot-এর Admin permission নেই।"
        },
        { quoted }
      );
    }

    return false;
  }

  try {
    await sock.groupSettingUpdate(
      jid,
      "not_announcement"
    );

    getGroupStatus(
      jid
    ).groupLockedUntil = null;

    saveBotStatus();

    if (!silent) {
      await sock.sendMessage(
        jid,
        {
          text:
            "🔓 *GROUP UNLOCKED*\n\n" +
            "সব সদস্য আবার মেসেজ পাঠাতে পারবেন।"
        },
        { quoted }
      );
    }

    return true;

  } catch (error) {
    console.log(
      "⚠️ Group unlock error:",
      error?.message
    );

    if (!silent) {
      await sock.sendMessage(
        jid,
        {
          text:
            "❌ Group unlock করা যায়নি।"
        },
        { quoted }
      );
    }

    return false;
  }
}

function formatDuration(
  seconds
) {
  const value =
    Number(seconds || 0);

  if (value < 60) {
    return `${value} second(s)`;
  }

  const minutes =
    Math.floor(value / 60);

  if (minutes < 60) {
    return `${minutes} minute(s)`;
  }

  const hours =
    Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours} hour(s)`;
  }

  const days =
    Math.floor(hours / 24);

  return `${days} day(s)`;
}

/* =========================================================
   LOCK CHECKER
========================================================= */

async function checkGroupLocks() {
  if (!sock) {
    return;
  }

  const now =
    Date.now();

  for (
    const [
      groupId,
      status
    ] of Object.entries(botStatus)
  ) {
    if (
      !status ||
      !status.groupLockedUntil
    ) {
      continue;
    }

    if (
      status.groupLockedUntil <= now
    ) {
      try {
        await unlockGroup(
          groupId,
          null,
          true
        );

        console.log(
          `🔓 Auto unlocked: ${groupId}`
        );

      } catch (error) {
        console.log(
          "⚠️ Auto unlock error:",
          error?.message
        );
      }
    }
  }
}

setInterval(
  checkGroupLocks,
  GROUP_LOCK_CHECK_INTERVAL
);

/* =========================================================
   WELCOME MESSAGE
========================================================= */

async function sendWelcomeMessage(
  groupId,
  participants
) {
  const status =
    getGroupStatus(groupId);

  if (!status.welcome) {
    return;
  }

  if (!Array.isArray(participants)) {
    return;
  }

  for (
    const participant of participants
  ) {
    const userJid =
      participant?.id ||
      participant?.lid ||
      participant;

    if (!userJid) {
      continue;
    }

    const name =
      getDisplayName({
        ...participant,
        id: userJid
      });

    const text = `
╭━━━━━━━━━━━━━━━━━━╮
        🎉 WELCOME
╰━━━━━━━━━━━━━━━━━━╯

👋 Welcome ${name}!

আপনাকে আমাদের Group-এ
স্বাগতম। ❤️

📜 Group Rules দেখতে:
/rules

🤖 Bot Menu:
/menu

🌐 Website:
${WEBSITE_URL}

━━━━━━━━━━━━━━━━━━

⚠️ Group Rules মেনে চলুন।
`.trim();

    try {
      await sock.sendMessage(
        groupId,
        {
          text:
            `${text}\n\n@${jidToNumber(
              userJid
            )}`,
          mentions: [
            userJid
          ]
        }
      );
    } catch (error) {
      console.log(
        "⚠️ Welcome error:",
        error?.message
      );
    }
  }
}

/* =========================================================
   MODERATION RESULT
========================================================= */

function moderationResult(
  deleted = false,
  reason = null
) {
  return {
    deleted,
    reason
  };
}

/* =========================================================
   DELETE MESSAGE
========================================================= */

async function deleteMessage(
  remoteJid,
  messageKey
) {
  try {
    await sock.sendMessage(
      remoteJid,
      {
        delete: messageKey
      }
    );

    return true;

  } catch (error) {
    console.log(
      "⚠️ Delete message error:",
      error?.message
    );

    return false;
  }
}

/* =========================================================
   MODERATION
========================================================= */

async function moderateMessage(
  remoteJid,
  message,
  text,
  senderJid,
  senderIsAdmin
) {
  if (
    !remoteJid?.endsWith("@g.us")
  ) {
    return moderationResult();
  }

  if (senderIsAdmin) {
    return moderationResult();
  }

  const status =
    getGroupStatus(remoteJid);

  if (!status.enabled) {
    return moderationResult();
  }

  const trimmedText =
    String(text || "").trim();

  if (!trimmedText) {
    return moderationResult();
  }

  /* =======================================================
     MAX TEXT LENGTH
  ======================================================= */

  if (
    trimmedText.length >
    MAX_TEXT_LENGTH
  ) {
    const deleted =
      await deleteMessage(
        remoteJid,
        message.key
      );

    if (deleted) {
      incrementStat(
        remoteJid,
        "deleted"
      );

      addActivity(
        remoteJid,
        "Long message deleted",
        {
          user:
            formatUserMention(
              senderJid
            )
        }
      );
    }

    return moderationResult(
      deleted,
      "long_message"
    );
  }

  /* =======================================================
     BAD WORDS
  ======================================================= */

  if (
    isModerationEnabled(
      remoteJid,
      "badWords"
    ) &&
    containsBadWord(
      trimmedText
    )
  ) {
    const deleted =
      await deleteMessage(
        remoteJid,
        message.key
      );

    if (deleted) {
      incrementStat(
        remoteJid,
        "deleted"
      );

      incrementStat(
        remoteJid,
        "badWords"
      );

      let warningCount = 0;

      if (
        isModerationEnabled(
          remoteJid,
          "warnings"
        )
      ) {
        warningCount =
          addWarning(
            remoteJid,
            senderJid,
            "Bad word"
          );

        incrementStat(
          remoteJid,
          "warnings"
        );
      }

      addActivity(
        remoteJid,
        "Bad word detected",
        {
          user:
            formatUserMention(
              senderJid
            ),
          reason:
            `Warning ${warningCount}`
        }
      );

      await sock.sendMessage(
        remoteJid,
        {
          text:
            `⚠️ @${jidToNumber(
              senderJid
            )} আপনার মেসেজটি সরানো হয়েছে।\n\n` +
            `কারণ: অশালীন ভাষা ব্যবহার\n` +
            `Warning: ${warningCount}`,
          mentions: [
            senderJid
          ]
        }
      );
    }

    return moderationResult(
      deleted,
      "bad_words"
    );
  }

  /* =======================================================
     LINKS
  ======================================================= */

  if (
    isModerationEnabled(
      remoteJid,
      "links"
    ) &&
    containsLink(
      trimmedText
    )
  ) {
    const deleted =
      await deleteMessage(
        remoteJid,
        message.key
      );

    if (deleted) {
      incrementStat(
        remoteJid,
        "deleted"
      );

      incrementStat(
        remoteJid,
        "links"
      );

      let warningCount = 0;

      if (
        isModerationEnabled(
          remoteJid,
          "warnings"
        )
      ) {
        warningCount =
          addWarning(
            remoteJid,
            senderJid,
            "Unauthorized link"
          );

        incrementStat(
          remoteJid,
          "warnings"
        );
      }

      addActivity(
        remoteJid,
        "Link deleted",
        {
          user:
            formatUserMention(
              senderJid
            ),
          reason:
            `Warning ${warningCount}`
        }
      );

      await sock.sendMessage(
        remoteJid,
        {
          text:
            `🔗 @${jidToNumber(
              senderJid
            )} Link পাঠানো নিষিদ্ধ।\n\n` +
            `⚠️ Warning: ${warningCount}`,
          mentions: [
            senderJid
          ]
        }
      );
    }

    return moderationResult(
      deleted,
      "link"
    );
  }

  /* =======================================================
     MENTION SPAM
  ======================================================= */

  const mentionCount =
    countMentions(message);

  if (
    isModerationEnabled(
      remoteJid,
      "mentions"
    ) &&
    mentionCount >=
      MENTION_LIMIT
  ) {
    const deleted =
      await deleteMessage(
        remoteJid,
        message.key
      );

    if (deleted) {
      incrementStat(
        remoteJid,
        "deleted"
      );

      incrementStat(
        remoteJid,
        "mentions"
      );

      let warningCount = 0;

      if (
        isModerationEnabled(
          remoteJid,
          "warnings"
        )
      ) {
        warningCount =
          addWarning(
            remoteJid,
            senderJid,
            "Mention spam"
          );

        incrementStat(
          remoteJid,
          "warnings"
        );
      }

      addActivity(
        remoteJid,
        "Mention spam",
        {
          user:
            formatUserMention(
              senderJid
            ),
          reason:
            `${mentionCount} mentions`
        }
      );

      await sock.sendMessage(
        remoteJid,
        {
          text:
            `📢 @${jidToNumber(
              senderJid
            )} অতিরিক্ত Mention করা যাবে না।\n\n` +
            `⚠️ Warning: ${warningCount}`,
          mentions: [
            senderJid
          ]
        }
      );
    }

    return moderationResult(
      deleted,
      "mention_spam"
    );
  }

  /* =======================================================
     FLOOD
  ======================================================= */

  if (
    isModerationEnabled(
      remoteJid,
      "flood"
    ) &&
    isFlood(
      remoteJid,
      senderJid
    )
  ) {
    const deleted =
      await deleteMessage(
        remoteJid,
        message.key
      );

    if (deleted) {
      incrementStat(
        remoteJid,
        "deleted"
      );

      incrementStat(
        remoteJid,
        "flood"
      );

      let warningCount = 0;

      if (
        isModerationEnabled(
          remoteJid,
          "warnings"
        )
      ) {
        warningCount =
          addWarning(
            remoteJid,
            senderJid,
            "Flood spam"
          );

        incrementStat(
          remoteJid,
          "warnings"
        );
      }

      addActivity(
        remoteJid,
        "Flood detected",
        {
          user:
            formatUserMention(
              senderJid
            ),
          reason:
            `Warning ${warningCount}`
        }
      );

      await sock.sendMessage(
        remoteJid,
        {
          text:
            `🌊 @${jidToNumber(
              senderJid
            )} খুব দ্রুত অনেক মেসেজ পাঠাচ্ছেন।\n\n` +
            `⚠️ Warning: ${warningCount}`,
          mentions: [
            senderJid
          ]
        }
      );
    }

    return moderationResult(
      deleted,
      "flood"
    );
  }

  /* =======================================================
     DUPLICATE SPAM
  ======================================================= */

  if (
    isModerationEnabled(
      remoteJid,
      "spam"
    ) &&
    isDuplicateSpam(
      remoteJid,
      senderJid,
      trimmedText
    )
  ) {
    const deleted =
      await deleteMessage(
        remoteJid,
        message.key
      );

    if (deleted) {
      incrementStat(
        remoteJid,
        "deleted"
      );

      incrementStat(
        remoteJid,
        "spam"
      );

      let warningCount = 0;

      if (
        isModerationEnabled(
          remoteJid,
          "warnings"
        )
      ) {
        warningCount =
          addWarning(
            remoteJid,
            senderJid,
            "Duplicate spam"
          );

        incrementStat(
          remoteJid,
          "warnings"
        );
      }

      addActivity(
        remoteJid,
        "Duplicate spam",
        {
          user:
            formatUserMention(
              senderJid
            ),
          reason:
            `Warning ${warningCount}`
        }
      );

      await sock.sendMessage(
        remoteJid,
        {
          text:
            `🔁 @${jidToNumber(
              senderJid
            )} একই মেসেজ বারবার পাঠানো যাবে না।\n\n` +
            `⚠️ Warning: ${warningCount}`,
          mentions: [
            senderJid
          ]
        }
      );
    }

    return moderationResult(
      deleted,
      "duplicate_spam"
    );
  }

  return moderationResult();
}

/* =========================================================
   COMMAND PARSER
========================================================= */

function parseCommand(text) {
  const value =
    String(text || "").trim();

  if (!value.startsWith("/")) {
    return null;
  }

  const parts =
    value.split(/\s+/);

  const rawCommand =
    parts.shift();

  const command =
    getCanonicalCommand(
      rawCommand
    );

  const args =
    parts;

  return {
    rawCommand,
    command,
    args,
    text: args.join(" ")
  };
}

/* =========================================================
   ADMIN COMMAND CHECK
========================================================= */

function isAdminOnlyCommand(
  command
) {
  return ADMIN_ONLY_COMMANDS.includes(
    getCanonicalCommand(command)
  );
}

function isProtectedCommand(
  command
) {
  return PROTECTED_COMMANDS.includes(
    getCanonicalCommand(command)
  );
}

/* =========================================================
   COMMAND DISABLED MESSAGE
========================================================= */

async function sendCommandDisabled(
  jid,
  command,
  quoted = null
) {
  await sock.sendMessage(
    jid,
    {
      text:
        `🚫 /${command} বর্তমানে এই Group-এ বন্ধ আছে।`
    },
    { quoted }
  );
}

/* =========================================================
   ADMIN REQUIRED MESSAGE
========================================================= */

async function sendAdminRequired(
  jid,
  quoted = null
) {
  await sock.sendMessage(
    jid,
    {
      text:
        "🔐 এই Command ব্যবহার করতে হলে আপনাকে Group Admin হতে হবে।"
    },
    { quoted }
  );
}

/* =========================================================
   BOT ADMIN REQUIRED
========================================================= */

async function sendBotAdminRequired(
  jid,
  quoted = null
) {
  await sock.sendMessage(
    jid,
    {
      text:
        "⚠️ Bot-কে Group Admin করুন, তারপর এই Command ব্যবহার করুন।"
    },
    { quoted }
  );
}
/* =========================================================
   COMMAND RESPONSES
========================================================= */

async function sendAdminList(remoteJid) {
  const { admins } = await getAdminData(remoteJid);

  if (!admins.length) {
    await sock.sendMessage(remoteJid, {
      text: "👑 কোনো Admin পাওয়া যায়নি।"
    });
    return;
  }

  const lines = [];
  const mentions = [];

  admins.forEach((admin, index) => {
    const role = admin.owner
      ? "⭐ *Group Owner*"
      : "👑 *Admin*";

    if (isPhoneJid(admin.jid)) {
      const phone = admin.jid.split("@")[0];

      mentions.push(admin.jid);

      lines.push(
        `${index + 1}️⃣ @${phone} ${role}`
      );
    } else {
      lines.push(
        `${index + 1}️⃣ ${admin.name} ${role}`
      );
    }
  });

  await sock.sendMessage(remoteJid, {
    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       👑 *GROUP ADMINS*
╰━━━━━━━━━━━━━━━━━━━━╯

${lines.join("\n\n")}

👥 *মোট Admin:* ${admins.length} জন

🤍 *Piyas*
`,
    mentions
  });
}

async function sendDealNotice(remoteJid) {
  const { admins } =
    await getAdminData(remoteJid);

  const lines = [];
  const mentions = [];

  admins.forEach((admin, index) => {
    const role = admin.owner
      ? "⭐ *Group Owner*"
      : "👑 *Admin*";

    if (isPhoneJid(admin.jid)) {
      mentions.push(admin.jid);

      lines.push(
        `${index + 1}️⃣ @${admin.jid.split("@")[0]} ${role}`
      );
    } else {
      lines.push(
        `${index + 1}️⃣ ${admin.name} ${role}`
      );
    }
  });

  await sock.sendMessage(remoteJid, {
    text:
      DEAL_NOTICE_TOP +
      (
        lines.join("\n\n") ||
        "⚠️ কোনো Admin পাওয়া যায়নি।"
      ) +
      `\n\n👥 *মোট Admin:* ${admins.length} জন\n\n` +
      DEAL_NOTICE_BOTTOM,
    mentions
  });
}

async function sendCommandList(remoteJid) {
  const status =
    getGroupStatus(remoteJid);

  const lines =
    COMMAND_DEFINITIONS.map(item =>
      `${
        status.disabledCommands.includes(
          item.key
        )
          ? "🔴 OFF"
          : "🟢 ON"
      } ${item.command}`
    );

  await sock.sendMessage(remoteJid, {
    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
      📋 *COMMAND STATUS*
╰━━━━━━━━━━━━━━━━━━━━╯

${lines.join("\n")}

━━━━━━━━━━━━━━━━━━━━

🤖 BOT:
${isBotEnabled(remoteJid)
  ? "🟢 ON"
  : "🔴 OFF"}

🛡️ Bad Word:
${status.moderation.badWords
  ? "🟢 ON"
  : "🔴 OFF"}

🔗 Link:
${status.moderation.links
  ? "🟢 ON"
  : "🔴 OFF"}

🚨 Spam:
${status.moderation.spam
  ? "🟢 ON"
  : "🔴 OFF"}

🌊 Flood:
${status.moderation.flood
  ? "🟢 ON"
  : "🔴 OFF"}

📣 Mention:
${status.moderation.mentions
  ? "🟢 ON"
  : "🔴 OFF"}

⚠️ Warning:
${status.moderation.warnings
  ? "🟢 ON"
  : "🔴 OFF"}
`
  });
}

async function sendModerationStatus(remoteJid) {
  const status =
    getGroupStatus(remoteJid);

  await sock.sendMessage(remoteJid, {
    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
        🛠️ *MOD STATUS*
╰━━━━━━━━━━━━━━━━━━━━╯

🛡️ Bad Word:
${status.moderation.badWords
  ? "🟢 ON"
  : "🔴 OFF"}

🔗 Link:
${status.moderation.links
  ? "🟢 ON"
  : "🔴 OFF"}

🚨 Duplicate Spam:
${status.moderation.spam
  ? "🟢 ON"
  : "🔴 OFF"}

🌊 Anti-Flood:
${status.moderation.flood
  ? "🟢 ON"
  : "🔴 OFF"}

📣 Mention Spam:
${status.moderation.mentions
  ? "🟢 ON"
  : "🔴 OFF"}

⚠️ Warning:
${status.moderation.warnings
  ? "🟢 ON"
  : "🔴 OFF"}

🚫 Member Remove: OFF
🚫 Kick/Ban: OFF
`
  });
}

async function sendStats(remoteJid) {
  const s =
    getStats(remoteJid);

  await sock.sendMessage(remoteJid, {
    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       📊 *GROUP STATS*
╰━━━━━━━━━━━━━━━━━━━━╯

💬 Messages: ${s.messages}
⚙️ Commands: ${s.commands}
🗑️ Deleted: ${s.deleted}

🚫 Bad Word: ${s.badWords}
🔗 Links: ${s.links}
🚨 Spam: ${s.spam}
🌊 Flood: ${s.flood}
📣 Mention Spam: ${s.mentions}
⚠️ Warnings: ${s.warnings}

👋 Joins: ${s.joins}
🚪 Leaves: ${s.leaves}

🤍 *Piyas Bot*
`
  });
}

async function sendActivity(remoteJid) {
  const list =
    activity[remoteJid] || [];

  const lines =
    list
      .slice(-15)
      .reverse()
      .map(
        (item, i) =>
          `${i + 1}. ${
            item.type || "event"
          } — ${
            item.reason ||
            item.member ||
            ""
          }`
      );

  await sock.sendMessage(remoteJid, {
    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       📋 *ACTIVITY LOG*
╰━━━━━━━━━━━━━━━━━━━━╯

${
  lines.length
    ? lines.join("\n")
    : "কোনো activity নেই।"
}
`
  });
}

async function sendSettings(remoteJid) {
  const s =
    getGroupStatus(remoteJid);

  const lock =
    s.groupLockedUntil;

  await sock.sendMessage(remoteJid, {
    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
        ⚙️ *SETTINGS*
╰━━━━━━━━━━━━━━━━━━━━╯

🤖 Bot:
${s.enabled
  ? "🟢 ON"
  : "🔴 OFF"}

👋 Welcome:
${s.welcome
  ? "🟢 ON"
  : "🔴 OFF"}

🛡️ Bad Word:
${s.moderation.badWords
  ? "🟢"
  : "🔴"}

🔗 Link:
${s.moderation.links
  ? "🟢"
  : "🔴"}

🚨 Spam:
${s.moderation.spam
  ? "🟢"
  : "🔴"}

🌊 Flood:
${s.moderation.flood
  ? "🟢"
  : "🔴"}

📣 Mention:
${s.moderation.mentions
  ? "🟢"
  : "🔴"}

⚠️ Warning:
${s.moderation.warnings
  ? "🟢"
  : "🔴"}

🔒 Group:

${
  typeof lock === "number" &&
  lock > Date.now()
    ? `🔴 CLOSED until ${
        new Date(lock)
          .toLocaleString("en-BD")
      }`
    : "🟢 OPEN"
}

📋 Disabled Commands:

${
  s.disabledCommands.length
    ? s.disabledCommands
        .map(x => "/" + x)
        .join(", ")
    : "None"
}
`
  });
}

async function sendWarnings(
  remoteJid,
  message,
  args
) {
  const target =
    await resolveTargetJid(
      remoteJid,
      message,
      args
    );

  if (!target) {
    await sock.sendMessage(
      remoteJid,
      {
        text:
          "⚠️ Member select করুন — member mention করে বা তার message reply করে `/warnings` লিখুন।"
      }
    );

    return;
  }

  const count =
    getMemberWarningCount(
      remoteJid,
      target
    );

  await sock.sendMessage(
    remoteJid,
    {
      text:
        `⚠️ *WARNING STATUS*\n\n` +
        `👤 @${target.split("@")[0]}\n` +
        `⚠️ Warning: *${count}*`,
      mentions: [target]
    }
  );
}

async function sendUserInfo(
  remoteJid,
  message,
  args
) {
  const target =
    await resolveTargetJid(
      remoteJid,
      message,
      args
    );

  if (!target) {
    await sock.sendMessage(
      remoteJid,
      {
        text:
          "👤 Member mention করুন বা তার message reply করে `/userinfo` লিখুন।"
      }
    );

    return;
  }

  const metadata =
    await sock.groupMetadata(
      remoteJid
    );

  const participant =
    findParticipant(
      metadata?.participants || [],
      target
    );

  const warningsCount =
    getMemberWarningCount(
      remoteJid,
      target
    );

  await sock.sendMessage(
    remoteJid,
    {
      text: `
╭━━━━━━━━━━━━━━━━━━━━╮
        👤 *USER INFO*
╰━━━━━━━━━━━━━━━━━━━━╯

👤 Name:
${
  participant
    ? getDisplayName(
        participant
      )
    : "Unknown"
}

📱 Number:
${target.split("@")[0]}

👑 Admin:
${
  participant &&
  isAdminParticipant(
    participant
  )
    ? "YES"
    : "NO"
}

⭐ Owner:
${
  participant &&
  isOwnerParticipant(
    participant
  )
    ? "YES"
    : "NO"
}

⚠️ Warnings:
${warningsCount}
`,
      mentions: [target]
    }
  );
}

async function sendGroupLink(
  remoteJid
) {
  try {
    const code =
      await sock.groupInviteCode(
        remoteJid
      );

    await sock.sendMessage(
      remoteJid,
      {
        text:
          `🔗 *GROUP INVITE LINK*\n\n` +
          `https://chat.whatsapp.com/${code}`
      }
    );

  } catch (error) {
    await sock.sendMessage(
      remoteJid,
      {
        text:
          "❌ Group invite link পাওয়া যায়নি। Bot-এর Admin permission চেক করুন।"
      }
    );
  }
}

async function sendOwner(
  remoteJid
) {
  const { admins } =
    await getAdminData(
      remoteJid
    );

  const owner =
    admins.find(
      x => x.owner
    );

  if (!owner) {
    await sock.sendMessage(
      remoteJid,
      {
        text:
          "⭐ Group Owner পাওয়া যায়নি।"
      }
    );

    return;
  }

  if (isPhoneJid(owner.jid)) {
    await sock.sendMessage(
      remoteJid,
      {
        text:
          `⭐ *GROUP OWNER*\n\n` +
          `@${owner.jid.split("@")[0]}`,
        mentions: [
          owner.jid
        ]
      }
    );
  } else {
    await sock.sendMessage(
      remoteJid,
      {
        text:
          `⭐ *GROUP OWNER*\n\n${owner.name}`
      }
    );
  }
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    (req, res) => {
      if (
        req.url ===
        "/health"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "application/json; charset=utf-8"
          }
        );

        res.end(
          JSON.stringify({
            status: "online",
            bot: BOT_NAME,
            connected: !!sock
          })
        );

        return;
      }

      res.writeHead(
        200,
        {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      );

      res.end(
        "WhatsApp Bot is running!"
      );
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      `🌐 Server running on port ${PORT}`
    );
  }
);

/* =========================================================
   START BOT
========================================================= */

async function startBot() {
  try {
    let authState =
      await useMultiFileAuthState(
        AUTH_DIR
      );

    let {
      state,
      saveCreds
    } = authState;

    const currentCredPhone =
      getCredentialPhoneNumber(
        state.creds
      );

    const numberChanged =
      PHONE_NUMBER &&
      state.creds.registered &&
      currentCredPhone &&
      currentCredPhone !==
        PHONE_NUMBER;

    if (numberChanged) {
      await resetAuthForNumberChange();

      pairingRequested = false;

      authState =
        await useMultiFileAuthState(
          AUTH_DIR
        );

      state =
        authState.state;

      saveCreds =
        authState.saveCreds;
    }

    sock =
      makeWASocket({
        auth: state,
        logger,
        browser:
          Browsers.ubuntu(
            "Chrome"
          ),
        markOnlineOnConnect:
          false,
        syncFullHistory:
          false,
        generateHighQualityLinkPreview:
          false,
        printQRInTerminal:
          false
      });

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    sock.ev.on(
      "contacts.upsert",
      saveContacts
    );

    sock.ev.on(
      "contacts.update",
      saveContacts
    );

    /* =====================================================
       CONNECTION
    ===================================================== */

    sock.ev.on(
      "connection.update",
      async update => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (
          connection ===
          "connecting"
        ) {
          console.log(
            "🔄 Connecting to WhatsApp..."
          );
        }

        if (
          connection ===
          "open"
        ) {
          console.log(
            "✅ WhatsApp Bot Connected!"
          );

          reconnecting = false;
          pairingRequested = false;

          await checkExpiredGroupLocks();
        }

        if (
          connection ===
          "close"
        ) {
          sock = null;

          const statusCode =
            new Boom(
              lastDisconnect
                ?.error
            )?.output
              ?.statusCode;

          const shouldReconnect =
            statusCode !==
            DisconnectReason.loggedOut;

          console.log(
            `❌ Connection closed. Code: ${statusCode}`
          );

          if (
            shouldReconnect &&
            !reconnecting
          ) {
            reconnecting =
              true;

            setTimeout(
              () => {
                reconnecting =
                  false;

                startBot();
              },
              5000
            );
          }
        }
      }
    );

    /* =====================================================
       PAIRING CODE
    ===================================================== */

    if (
      PHONE_NUMBER &&
      !state.creds.registered
    ) {
      await generatePairingCode(
        state
      );
    }

    console.log(
      "🚀 WhatsApp Bot Starting..."
    );

  } catch (error) {
    console.log(
      "❌ Failed to start bot:",
      error?.message
    );

    sock = null;

    if (!reconnecting) {
      reconnecting = true;

      setTimeout(
        () => {
          reconnecting =
            false;

          startBot();
        },
        5000
      );
    }
  }
}

/* =========================================================
   GLOBAL ERROR HANDLERS
========================================================= */

process.on(
  "uncaughtException",
  error => {
    console.log(
      "❌ Uncaught Exception:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.log(
      "❌ Unhandled Rejection:",
      error
    );
  }
);

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown() {
  console.log(
    "\n🛑 Shutting down bot..."
  );

  try {
    if (sock) {
      sock.end(
        new Error(
          "Bot shutting down"
        )
      );
    }
  } catch {}

  try {
    server.close();
  } catch {}

  process.exit(0);
}

process.on(
  "SIGINT",
  shutdown
);

process.on(
  "SIGTERM",
  shutdown
);

/* =========================================================
   INITIALIZE
========================================================= */

loadBotStatus();
loadWarnings();
loadStats();
loadActivity();

startBot();
