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

const PHONE_NUMBER = String(
  process.env.PHONE_NUMBER || ""
).replace(/[^0-9]/g, "");

const WEBSITE_URL =
  "https://x-cyber-2025.github.io/X-cyber.web/";

const BACKUP_GROUP_URL =
  "https://chat.whatsapp.com/KsIJqeOdSTVC2FBIuWCvlN?s=cl&p=a&mlu=4&ilr=4";

const AUTH_DIR = "./auth_info";
const PAIRING_NUMBER_FILE = "./pairing_number.txt";
const BOT_STATUS_FILE = "./bot_status.json";
const WARNING_FILE = "./warnings.json";

let sock = null;
let reconnecting = false;
let pairingRequested = false;

const logger = P({ level: "silent" });

const contactNames = new Map();
const contactPhoneJids = new Map();
const lidToPhoneJid = new Map();

const spamTracker = new Map();
const SPAM_WINDOW_MS = 60 * 1000;

/* =========================================================
   MODERATION
========================================================= */

const MODERATION_DEFAULTS = {
  badWords: true,
  links: true,
  spam: true,
  warnings: true
};

const BAD_WORDS = [
  "সালা","শালা","সালি","সালী","শালি","ষালি","ষালী",
  "খাংকি","খাংকী","খানকি","খানকী","মাগি","মাগী",
  "বেসসা","বেশ্যা","চোদা","চোদন","চুদ","চুদা",
  "চুদাচুদি","হারামি","হারামী","হারামজাদা","হারামজাদী",
  "কুত্তা","কুত্তার","শুয়োর","শুয়োর","বাঞ্চোদ",
  "বাল","বালের","ফাক","fuck","fucking","fucker",
  "motherfucker","bitch","bastard","asshole","dick",
  "pussy","sex","porn"
];

let warnings = {};
let botStatus = {};

/* =========================================================
   FILE DATA
========================================================= */

function loadWarnings() {
  try {
    warnings = fs.existsSync(WARNING_FILE)
      ? JSON.parse(fs.readFileSync(WARNING_FILE, "utf8")) || {}
      : {};
  } catch {
    warnings = {};
  }
}

function saveWarnings() {
  try {
    fs.writeFileSync(
      WARNING_FILE,
      JSON.stringify(warnings, null, 2),
      "utf8"
    );
  } catch {}
}

function loadBotStatus() {
  try {
    botStatus = fs.existsSync(BOT_STATUS_FILE)
      ? JSON.parse(fs.readFileSync(BOT_STATUS_FILE, "utf8")) || {}
      : {};

    for (const [id, value] of Object.entries(botStatus)) {
      botStatus[id] = normalizeGroupStatus(
        typeof value === "boolean"
          ? { enabled: value }
          : value
      );
    }
  } catch {
    botStatus = {};
  }
}

function saveBotStatus() {
  try {
    fs.writeFileSync(
      BOT_STATUS_FILE,
      JSON.stringify(botStatus, null, 2),
      "utf8"
    );
  } catch {}
}

function normalizeGroupStatus(status) {
  if (!status || typeof status !== "object") {
    status = {};
  }

  if (typeof status.enabled !== "boolean") {
    status.enabled = true;
  }

  if (!Array.isArray(status.disabledCommands)) {
    status.disabledCommands = [];
  }

  if (!status.moderation || typeof status.moderation !== "object") {
    status.moderation = {};
  }

  for (const [key, value] of Object.entries(MODERATION_DEFAULTS)) {
    if (typeof status.moderation[key] !== "boolean") {
      status.moderation[key] = value;
    }
  }

  if (
    typeof status.autoOnAt !== "number" ||
    !Number.isFinite(status.autoOnAt) ||
    status.autoOnAt <= 0
  ) {
    status.autoOnAt = null;
  }

  return status;
}

function getGroupStatus(groupId) {
  botStatus[groupId] = normalizeGroupStatus(botStatus[groupId]);
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
   WARNING SYSTEM
========================================================= */

function getGroupWarningData(groupId) {
  if (!warnings[groupId]) {
    warnings[groupId] = {};
  }

  return warnings[groupId];
}

function getMemberWarningCount(groupId, jid) {
  if (!groupId || !jid) return 0;

  return Number(
    getGroupWarningData(groupId)[jid] || 0
  );
}

function addWarning(groupId, jid) {
  if (!groupId || !jid) return 0;

  const data = getGroupWarningData(groupId);

  data[jid] =
    getMemberWarningCount(groupId, jid) + 1;

  saveWarnings();

  return data[jid];
}

/* =========================================================
   TEXT / LINK / SPAM
========================================================= */

function normalizeForBadWordCheck(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\s\-_.,!?()[\]{}:;'"`~|\\/]+/g, "");
}

function containsBadWord(text) {
  const normalized = normalizeForBadWordCheck(text);

  if (!normalized) return null;

  for (const word of BAD_WORDS) {
    const w = normalizeForBadWordCheck(word);

    if (w && normalized.includes(w)) {
      return word;
    }
  }

  return null;
}

function containsLink(text) {
  const value = String(text || "");

  return [
    /https?:\/\/\S+/i,
    /www\.\S+/i,
    /\b[a-z0-9-]+\.(com|net|org|xyz|bd|me|io|co|app|site|online|info|dev|ly|gg)\b/i,
    /\bt\.me\/\S+/i,
    /\bwa\.me\/\S+/i,
    /\bchat\.whatsapp\.com\/\S+/i
  ].some(x => x.test(value));
}

function normalizeSpamText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDuplicateSpam(groupId, jid, text) {
  const value = normalizeSpamText(text);

  if (!groupId || !jid || !value) {
    return false;
  }

  const key = `${groupId}:${jid}`;
  const now = Date.now();
  const old = spamTracker.get(key);

  spamTracker.set(key, {
    text: value,
    time: now
  });

  return Boolean(
    old &&
    old.text === value &&
    now - old.time < SPAM_WINDOW_MS
  );
}

setInterval(() => {
  const now = Date.now();

  for (const [key, value] of spamTracker.entries()) {
    if (
      !value ||
      now - value.time > SPAM_WINDOW_MS * 2
    ) {
      spamTracker.delete(key);
    }
  }
}, 5 * 60 * 1000);

/* =========================================================
   MODERATION STATUS
========================================================= */

function getModerationStatus(groupId) {
  return getGroupStatus(groupId).moderation;
}

function isModerationEnabled(groupId, type) {
  return Boolean(
    getModerationStatus(groupId)[type]
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

  getModerationStatus(groupId)[type] = Boolean(enabled);
  saveBotStatus();

  return true;
}

/* =========================================================
   JID HELPERS
========================================================= */

function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") {
    return null;
  }

  return jid.trim();
}

function normalizeJidBase(jid) {
  const value = normalizeJid(jid);

  if (!value) return null;

  return value
    .split(":")[0]
    .toLowerCase();
}

function getJidUserPart(jid) {
  const value = normalizeJidBase(jid);

  if (!value) return null;

  return value
    .split("@")[0]
    .replace(/[^0-9]/g, "");
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
  if (!phone) return null;

  const number = String(phone)
    .replace(/@s.whatsapp.net/g, "")
    .replace(/[^0-9]/g, "");

  if (number.length < 8) return null;

  return `${number}@s.whatsapp.net`;
}

/* =========================================================
   NAME / CONTACT
========================================================= */

function cleanName(name) {
  if (!name) return null;

  const value = String(name)
    .replace(/\s+/g, " ")
    .trim();

  return value ? value.slice(0, 80) : null;
}

function saveLidMapping(lid, pn) {
  const lidJid = normalizeJid(lid);
  let phoneJid = normalizeJid(pn);

  if (!isLidJid(lidJid)) return;

  if (!isPhoneJid(phoneJid)) {
    phoneJid = phoneNumberToJid(phoneJid);
  }

  if (!phoneJid) return;

  lidToPhoneJid.set(lidJid, phoneJid);
  contactPhoneJids.set(lidJid, phoneJid);
}

async function resolveLidToPhoneJid(lid) {
  if (!lid) return null;

  if (isPhoneJid(lid)) return lid;
  if (!isLidJid(lid)) return null;

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

      const phoneJid =
        isPhoneJid(pn)
          ? pn
          : phoneNumberToJid(pn);

      if (phoneJid) {
        saveLidMapping(lid, phoneJid);
        return phoneJid;
      }
    }
  } catch {}

  return null;
}

function getDisplayName(participant = {}) {
  const ids = [
    participant.id,
    participant.lid,
    participant.phoneNumber
  ].filter(Boolean);

  for (const id of ids) {
    const cached = contactNames.get(id);

    if (cached) return cached;
  }

  const name = cleanName(
    participant.username ||
    participant.notify ||
    participant.name ||
    participant.verifiedName ||
    participant.pushName
  );

  if (name) return name;

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

function saveContacts(contacts = []) {
  for (const contact of contacts) {
    if (!contact) continue;

    const id = normalizeJid(contact.id);
    const lid = normalizeJid(contact.lid);

    let phoneJid = null;

    if (contact.phoneNumber) {
      phoneJid =
        isPhoneJid(contact.phoneNumber)
          ? contact.phoneNumber
          : phoneNumberToJid(contact.phoneNumber);
    }

    if (!phoneJid && isPhoneJid(id)) {
      phoneJid = id;
    }

    if (phoneJid && isLidJid(id)) {
      saveLidMapping(id, phoneJid);
    }

    if (phoneJid && isLidJid(lid)) {
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
    return isPhoneJid(participant.phoneNumber)
      ? participant.phoneNumber
      : phoneNumberToJid(participant.phoneNumber);
  }

  if (isPhoneJid(participant.id)) {
    return participant.id;
  }

  return null;
}

async function getPhoneJid(participant = {}) {
  const direct = getDirectPhoneJid(participant);

  if (direct) return direct;

  for (const id of [
    participant.id,
    participant.lid
  ].filter(Boolean)) {
    const cached =
      contactPhoneJids.get(id) ||
      lidToPhoneJid.get(id);

    if (isPhoneJid(cached)) {
      return cached;
    }

    if (isLidJid(id)) {
      const resolved =
        await resolveLidToPhoneJid(id);

      if (resolved) return resolved;
    }
  }

  return null;
}

async function cacheParticipants(participants = []) {
  for (const participant of participants) {
    if (!participant) continue;

    const name = getDisplayName(participant);

    let phoneJid =
      getDirectPhoneJid(participant);

    if (!phoneJid && participant.id) {
      phoneJid =
        await resolveLidToPhoneJid(
          participant.id
        );
    }

    if (!phoneJid && participant.lid) {
      phoneJid =
        await resolveLidToPhoneJid(
          participant.lid
        );
    }

    if (phoneJid && participant.id) {
      contactPhoneJids.set(
        participant.id,
        phoneJid
      );
    }

    if (phoneJid && participant.lid) {
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

    if (name && name !== "Member") {
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

/* =========================================================
   GROUP ADMIN
========================================================= */

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

function findParticipant(participants = [], jid) {
  if (!jid) return null;

  const target = normalizeJidBase(jid);

  for (const participant of participants) {
    for (const id of [
      participant?.id,
      participant?.lid,
      participant?.phoneNumber
    ].filter(Boolean)) {
      if (
        normalizeJidBase(id) === target
      ) {
        return participant;
      }
    }
  }

  return null;
}

function getBotPhoneJid() {
  try {
    const ownId =
      normalizeJid(sock?.user?.id);

    const ownLid =
      normalizeJid(sock?.user?.lid);

    if (isPhoneJid(ownId)) {
      return ownId.split(":")[0];
    }

    if (isPhoneJid(ownLid)) {
      return ownLid.split(":")[0];
    }

    if (isLidJid(ownId)) {
      const cached =
        lidToPhoneJid.get(ownId) ||
        contactPhoneJids.get(ownId);

      if (isPhoneJid(cached)) {
        return cached;
      }
    }

    if (isLidJid(ownLid)) {
      const cached =
        lidToPhoneJid.get(ownLid) ||
        contactPhoneJids.get(ownLid);

      if (isPhoneJid(cached)) {
        return cached;
      }
    }

    return PHONE_NUMBER
      ? phoneNumberToJid(PHONE_NUMBER)
      : null;
  } catch {
    return null;
  }
}

async function getBotIdentityList() {
  const identities = [];

  const ownId =
    normalizeJid(sock?.user?.id);

  const ownLid =
    normalizeJid(sock?.user?.lid);

  const phone =
    getBotPhoneJid();

  if (ownId) identities.push(ownId);
  if (ownLid) identities.push(ownLid);
  if (phone) identities.push(phone);

  for (const id of [ownId, ownLid]) {
    if (isLidJid(id)) {
      const resolved =
        await resolveLidToPhoneJid(id);

      if (resolved) {
        identities.push(resolved);
      }
    }
  }

  return [
    ...new Set(
      identities.filter(Boolean)
    )
  ];
}

async function isBotAdminInGroup(groupId) {
  try {
    if (
      !sock ||
      !groupId ||
      !groupId.endsWith("@g.us")
    ) {
      return false;
    }

    const metadata =
      await sock.groupMetadata(groupId);

    const participants =
      metadata?.participants || [];

    if (!participants.length) {
      return false;
    }

    await cacheParticipants(participants);

    const identities =
      await getBotIdentityList();

    let botParticipant = null;

    for (const identity of identities) {
      botParticipant =
        findParticipant(
          participants,
          identity
        );

      if (botParticipant) break;
    }

    if (!botParticipant) {
      const botNumber =
        getJidUserPart(
          getBotPhoneJid()
        );

      if (botNumber) {
        botParticipant =
          participants.find(
            participant =>
              [
                participant?.phoneNumber,
                participant?.id,
                participant?.lid
              ]
                .filter(Boolean)
                .some(
                  value =>
                    isPhoneJid(value) &&
                    getJidUserPart(value) ===
                      botNumber
                )
          );
      }
    }

    if (!botParticipant) {
      for (const participant of participants) {
        for (const id of [
          participant?.id,
          participant?.lid
        ].filter(Boolean)) {
          if (!isLidJid(id)) continue;

          const resolved =
            await resolveLidToPhoneJid(id);

          if (!resolved) continue;

          if (
            identities.some(
              identity =>
                isPhoneJid(identity) &&
                normalizeJidBase(identity) ===
                  normalizeJidBase(resolved)
            )
          ) {
            botParticipant = participant;
            break;
          }
        }

        if (botParticipant) break;
      }
    }

    if (!botParticipant) {
      return false;
    }

    return isAdminParticipant(
      botParticipant
    );
  } catch (error) {
    console.log(
      "⚠️ Bot admin check error:",
      error?.message
    );

    return false;
  }
}

async function isGroupAllowed(groupId) {
  return Boolean(
    groupId &&
    groupId.endsWith("@g.us") &&
    await isBotAdminInGroup(groupId)
  );
}

async function isSenderAdmin(remoteJid, message) {
  try {
    const participantJid =
      message?.key?.participant;

    if (!participantJid) return false;

    const metadata =
      await sock.groupMetadata(remoteJid);

    const participants =
      metadata?.participants || [];

    await cacheParticipants(participants);

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

    return sender
      ? isAdminParticipant(sender)
      : false;
  } catch {
    return false;
  }
}

/* =========================================================
   COMMANDS
========================================================= */

const COMMAND_DEFINITIONS = [
  ["menu", "/menu"],
  ["bot", "/bot"],
  ["rules", "/rules"],
  ["admin", "/admin"],
  ["members", "/members"],
  ["groupinfo", "/groupinfo"],
  ["id", "/id"],
  ["ping", "/ping"],
  ["deal", "/deal"],
  ["piyas", "/piyas"],
  ["website", "/website"]
].map(([key, command]) => ({
  key,
  command
}));

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
  "গ্রুপ"
];

const PROTECTED_COMMANDS = [
  ...ADMIN_ONLY_COMMANDS
];

function normalizeCommandName(command) {
  return String(command || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "");
}

function getCanonicalCommand(command) {
  const name =
    normalizeCommandName(command);

  return COMMAND_ALIASES[name] || name;
}

function isKnownCommand(command) {
  const name =
    getCanonicalCommand(command);

  return COMMAND_DEFINITIONS.some(
    item => item.key === name
  );
}

function isCommandEnabled(groupId, command) {
  const name =
    getCanonicalCommand(command);

  return !getGroupStatus(
    groupId
  ).disabledCommands.includes(name);
}

function setCommandStatus(
  groupId,
  command,
  enabled
) {
  const name =
    getCanonicalCommand(command);

  if (!name) return false;

  const list =
    getGroupStatus(
      groupId
    ).disabledCommands;

  const index =
    list.indexOf(name);

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
   GROUP MESSAGE LOCK
========================================================= */

function normalizeDurationDigits(value) {
  return String(value || "")
    .replace(/০/g, "0")
    .replace(/১/g, "1")
    .replace(/২/g, "2")
    .replace(/৩/g, "3")
    .replace(/৪/g, "4")
    .replace(/৫/g, "5")
    .replace(/৬/g, "6")
    .replace(/৭/g, "7")
    .replace(/৮/g, "8")
    .replace(/৯/g, "9");
}

const DURATION_UNITS = [
  {
    names: [
      "বছর","বছরের","year","years","yr","yrs","y"
    ],
    ms: 365 * 24 * 60 * 60 * 1000
  },
  {
    names: [
      "মাস","মাসের","month","months","mo","mos"
    ],
    ms: 30 * 24 * 60 * 60 * 1000
  },
  {
    names: [
      "সপ্তাহ","সপ্তাহের","week","weeks","wk","wks","w"
    ],
    ms: 7 * 24 * 60 * 60 * 1000
  },
  {
    names: [
      "দিন","দিনের","day","days","d"
    ],
    ms: 24 * 60 * 60 * 1000
  },
  {
    names: [
      "ঘণ্টা","ঘন্টা","ঘণ্টার","ঘন্টার",
      "hour","hours","hr","hrs","h"
    ],
    ms: 60 * 60 * 1000
  },
  {
    names: [
      "মিনিট","মিনিটের","minute","minutes",
      "min","mins","m"
    ],
    ms: 60 * 1000
  },
  {
    names: [
      "সেকেন্ড","সেকেন্ডের","second","seconds",
      "sec","secs","s"
    ],
    ms: 1000
  }
];

function getDurationUnit(value) {
  const name =
    String(value || "")
      .trim()
      .toLowerCase();

  return (
    DURATION_UNITS.find(
      unit =>
        unit.names.includes(name)
    ) || null
  );
}

function parseGroupOffDuration(args = []) {
  if (!Array.isArray(args) || !args.length) {
    return null;
  }

  const input =
    args
      .map(x =>
        normalizeDurationDigits(x)
          .trim()
          .toLowerCase()
      )
      .join(" ");

  let total = 0;
  let found = false;

  const names =
    DURATION_UNITS
      .flatMap(x => x.names)
      .sort((a, b) => b.length - a.length)
      .map(
        x =>
          x.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )
      )
      .join("|");

  const regex =
    new RegExp(
      `(\\d+(?:\\.\\d+)?)\\s*(${names})(?=\\s|$|[^a-zA-Z0-9])`,
      "gi"
    );

  let match;

  while ((match = regex.exec(input)) !== null) {
    const amount = Number(match[1]);
    const unit = getDurationUnit(match[2]);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !unit
    ) {
      return null;
    }

    const value =
      amount * unit.ms;

    if (
      !Number.isFinite(value) ||
      value <= 0
    ) {
      return null;
    }

    total += value;
    found = true;

    if (
      !Number.isSafeInteger(
        Math.round(total)
      )
    ) {
      return null;
    }
  }

  if (
    !found &&
    args.length === 1 &&
    /^\d+(?:\.\d+)?$/.test(
      normalizeDurationDigits(args[0])
    )
  ) {
    total =
      Number(
        normalizeDurationDigits(args[0])
      ) *
      60 *
      1000;

    found = true;
  }

  if (
    !found ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }

  const max =
    Number.MAX_SAFE_INTEGER -
    Date.now() -
    1000;

  if (total > max) {
    return null;
  }

  return Math.round(total);
}

function formatGroupDuration(ms) {
  let seconds =
    Math.floor(ms / 1000);

  const years =
    Math.floor(
      seconds / (365 * 24 * 60 * 60)
    );

  seconds -=
    years * 365 * 24 * 60 * 60;

  const months =
    Math.floor(
      seconds / (30 * 24 * 60 * 60)
    );

  seconds -=
    months * 30 * 24 * 60 * 60;

  const days =
    Math.floor(
      seconds / (24 * 60 * 60)
    );

  seconds -=
    days * 24 * 60 * 60;

  const hours =
    Math.floor(
      seconds / (60 * 60)
    );

  seconds -=
    hours * 60 * 60;

  const minutes =
    Math.floor(seconds / 60);

  seconds -=
    minutes * 60;

  const result = [];

  if (years) result.push(`${years} বছর`);
  if (months) result.push(`${months} মাস`);
  if (days) result.push(`${days} দিন`);
  if (hours) result.push(`${hours} ঘণ্টা`);
  if (minutes) result.push(`${minutes} মিনিট`);

  if (seconds || !result.length) {
    result.push(`${seconds} সেকেন্ড`);
  }

  return result.join(" ");
}

function getGroupLockRemaining(groupId) {
  const value =
    getGroupStatus(groupId).autoOnAt;

  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return 0;
  }

  return Math.max(
    0,
    value - Date.now()
  );
}

async function lockGroupForDuration(
  groupId,
  durationMs
) {
  try {
    if (
      !sock ||
      !groupId.endsWith("@g.us") ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0
    ) {
      return false;
    }

    if (
      !(await isBotAdminInGroup(groupId))
    ) {
      await sock.sendMessage(
        groupId,
        {
          text:
            "❌ আমাকে Group Admin করতে হবে।"
        }
      );

      return false;
    }

    await sock.groupSettingUpdate(
      groupId,
      "announcement"
    );

    getGroupStatus(
      groupId
    ).autoOnAt =
      Date.now() + durationMs;

    saveBotStatus();

    await sock.sendMessage(
      groupId,
      {
        text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🔒 *GROUP MESSAGE OFF*
╰━━━━━━━━━━━━━━━━━━━━╯

🚫 সাধারণ Member-এর Message
সাময়িকভাবে বন্ধ করা হয়েছে।

👑 এখন শুধু Admin Message
পাঠাতে পারবেন।

⏱️ সময়: ${formatGroupDuration(durationMs)}

🟢 সময় শেষ হলে Automatically ON হবে।

⚡ আগে ON করতে:
/boton

🤍 *Piyas Bot*
`
      }
    );

    console.log(
      `🔒 Group locked: ${groupId}`
    );

    return true;
  } catch (error) {
    console.log(
      "❌ Group lock error:",
      error?.message
    );

    try {
      await sock.sendMessage(
        groupId,
        {
          text:
            "❌ Group Message বন্ধ করা যায়নি। Bot Admin permission পরীক্ষা করুন।"
        }
      );
    } catch {}

    return false;
  }
}

async function unlockGroupNow(
  groupId,
  reason = "manual"
) {
  try {
    if (
      !sock ||
      !groupId.endsWith("@g.us")
    ) {
      return false;
    }

    if (
      !(await isBotAdminInGroup(groupId))
    ) {
      return false;
    }

    await sock.groupSettingUpdate(
      groupId,
      "not_announcement"
    );

    getGroupStatus(
      groupId
    ).autoOnAt = null;

    saveBotStatus();

    if (
      reason === "manual" ||
      reason === "timer"
    ) {
      await sock.sendMessage(
        groupId,
        {
          text:
            reason === "timer"
              ? `
🔓 *GROUP MESSAGE ON*

⏰ নির্ধারিত সময় শেষ হয়েছে।

🟢 এখন থেকে সাধারণ Member-রাও
Message পাঠাতে পারবেন।

🤍 *Piyas Bot*
`
              : `
🔓 *GROUP MESSAGE ON*

🟢 এখন থেকে সাধারণ Member-রাও
Message পাঠাতে পারবেন।

🤍 *Piyas Bot*
`
        }
      );
    }

    return true;
  } catch (error) {
    console.log(
      "❌ Group unlock error:",
      error?.message
    );

    return false;
  }
}

async function autoEnableExpiredGroups() {
  if (!sock) return;

  const now = Date.now();

  for (const [groupId, status] of Object.entries(botStatus)) {
    if (
      !status ||
      typeof status.autoOnAt !== "number"
    ) {
      continue;
    }

    if (status.autoOnAt <= now) {
      await unlockGroupNow(
        groupId,
        "timer"
      );
    }
  }
}

async function restoreActiveGroupLocks() {
  if (!sock) return;

  const now = Date.now();

  for (const [groupId, status] of Object.entries(botStatus)) {
    try {
      if (
        !status ||
        typeof status.autoOnAt !== "number"
      ) {
        continue;
      }

      if (status.autoOnAt <= now) {
        await unlockGroupNow(
          groupId,
          "timer"
        );

        continue;
      }

      if (
        await isBotAdminInGroup(groupId)
      ) {
        await sock.groupSettingUpdate(
          groupId,
          "announcement"
        );
      }
    } catch (error) {
      console.log(
        "⚠️ Lock restore error:",
        error?.message
      );
    }
  }
}

setInterval(
  autoEnableExpiredGroups,
  10 * 1000
);

/* =========================================================
   COPY BUTTON
========================================================= */

function makeCopyButton(command) {
  return {
    name: "cta_copy",
    buttonParamsJson: JSON.stringify({
      display_text: "📋 Copy",
      id:
        "copy_" +
        normalizeCommandName(command),
      copy_code: command
    })
  };
}

async function sendCopyButton(
  remoteJid,
  command
) {
  try {
    const message =
      generateWAMessageFromContent(
        remoteJid,
        {
          viewOnceMessage: {
            message: {
              interactiveMessage:
                proto.Message.InteractiveMessage.create(
                  {
                    body:
                      proto.Message.InteractiveMessage.Body.create(
                        {
                          text:
                            `📋 *Copy Command*\n\n${command}`
                        }
                      ),
                    footer:
                      proto.Message.InteractiveMessage.Footer.create(
                        {
                          text:
                            "🤖 PIYAS BOT"
                        }
                      ),
                    nativeFlowMessage:
                      proto.Message.InteractiveMessage.NativeFlowMessage.create(
                        {
                          buttons: [
                            makeCopyButton(
                              command
                            )
                          ]
                        }
                      )
                  }
                )
            }
          }
        },
        {
          userJid:
            sock?.user?.id
        }
      );

    await sock.relayMessage(
      remoteJid,
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

    return false;
  }
}

async function sendCopyButtons(
  remoteJid,
  commands
) {
  for (
    const command of [
      ...new Set(
        commands.filter(Boolean)
      )
    ]
  ) {
    await sendCopyButton(
      remoteJid,
      command
    );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          200
        )
    );
  }
}

/* =========================================================
   MESSAGE DELETE
========================================================= */

async function deleteMessage(
  remoteJid,
  message
) {
  try {
    await sock.sendMessage(
      remoteJid,
      {
        delete: message.key
      }
    );

    return true;
  } catch {
    return false;
  }
}

/* =========================================================
   MODERATION
========================================================= */

async function sendModerationWarning(
  remoteJid,
  message,
  reason,
  warningCount
) {
  try {
    const participant =
      message?.key?.participant;

    const phoneJid =
      participant
        ? await getPhoneJid({
            id: participant
          })
        : null;

    const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
       ⚠️ *MODERATION*
╰━━━━━━━━━━━━━━━━━━━━╯

🚫 Message টি Group Rule
ভঙ্গ করার কারণে Delete করা হয়েছে।

📌 কারণ: ${reason}
⚠️ Warning: ${warningCount}

🚫 Member Remove/Kick করা হয়নি।

🤍 *Piyas Bot*
`;

    await sock.sendMessage(
      remoteJid,
      {
        text,
        ...(isPhoneJid(phoneJid)
          ? { mentions: [phoneJid] }
          : {})
      }
    );
  } catch {}
}

async function moderateMessage(
  remoteJid,
  message,
  text
) {
  if (
    !isBotEnabled(remoteJid)
  ) {
    return false;
  }

  const sender =
    message?.key?.participant;

  if (
    sender &&
    await isSenderAdmin(
      remoteJid,
      message
    )
  ) {
    return false;
  }

  if (
    isModerationEnabled(
      remoteJid,
      "badWords"
    )
  ) {
    const bad =
      containsBadWord(text);

    if (bad) {
      if (
        await deleteMessage(
          remoteJid,
          message
        )
      ) {
        const jid =
          await getPhoneJid({
            id: sender
          });

        const count =
          isModerationEnabled(
            remoteJid,
            "warnings"
          )
            ? addWarning(
                remoteJid,
                jid || sender
              )
            : 0;

        if (
          isModerationEnabled(
            remoteJid,
            "warnings"
          )
        ) {
          await sendModerationWarning(
            remoteJid,
            message,
            `Bad Word: ${bad}`,
            count
          );
        }
      }

      return true;
    }
  }

  if (
    isModerationEnabled(
      remoteJid,
      "links"
    ) &&
    containsLink(text)
  ) {
    if (
      await deleteMessage(
        remoteJid,
        message
      )
    ) {
      const jid =
        await getPhoneJid({
          id: sender
        });

      const count =
        isModerationEnabled(
          remoteJid,
          "warnings"
        )
          ? addWarning(
              remoteJid,
              jid || sender
            )
          : 0;

      if (
        isModerationEnabled(
          remoteJid,
          "warnings"
        )
      ) {
        await sendModerationWarning(
          remoteJid,
          message,
          "Link / URL",
          count
        );
      }
    }

    return true;
  }

  if (
    sender &&
    isModerationEnabled(
      remoteJid,
      "spam"
    )
  ) {
    const jid =
      await getPhoneJid({
        id: sender
      });

    if (
      isDuplicateSpam(
        remoteJid,
        jid || sender,
        text
      )
    ) {
      if (
        await deleteMessage(
          remoteJid,
          message
        )
      ) {
        const count =
          isModerationEnabled(
            remoteJid,
            "warnings"
          )
            ? addWarning(
                remoteJid,
                jid || sender
              )
            : 0;

        if (
          isModerationEnabled(
            remoteJid,
            "warnings"
          )
        ) {
          await sendModerationWarning(
            remoteJid,
            message,
            "Duplicate Spam",
            count
          );
        }
      }

      return true;
    }
  }

  return false;
}

/* =========================================================
   TEXT
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

/* =========================================================
   MENU / INFO TEXT
========================================================= */

function buildMenuText(groupId) {
  const line = (key, command) =>
    isCommandEnabled(groupId, key)
      ? `│ 🟢 ${command}`
      : `│ 🔴 ${command} OFF`;

  return `
╭━━━━━━━━━━━━━━━━━━━━╮
        🤖 *BOT MENU*
╰━━━━━━━━━━━━━━━━━━━━╯

👥 *GROUP COMMANDS*
${line("menu", "/menu")}
${line("bot", "/bot")}
${line("rules", "/rules")}
${line("admin", "/admin")}
${line("members", "/members")}
${line("groupinfo", "/groupinfo")}
${line("id", "/id")}

⚙️ *UTILITY*
${line("ping", "/ping")}

💰 *DEAL*
${line("deal", "/deal")}
│ 🟢 /ডিল

🤍 *PIYAS*
${line("piyas", "/piyas")}

🌐 *WEBSITE*
${line("website", "/website")}

━━━━━━━━━━━━━━━━━━━━
📌 সব Command-এর আগে "/" ব্যবহার করতে হবে।
`;
}

async function sendPublicMenu(groupId) {
  await sock.sendMessage(
    groupId,
    {
      text:
        buildMenuText(groupId)
    }
  );

  await sendCopyButtons(
    groupId,
    [
      "/menu",
      "/bot",
      "/rules",
      "/admin",
      "/members",
      "/groupinfo",
      "/id",
      "/ping",
      "/deal",
      "/ডিল",
      "/piyas",
      "/website"
    ]
  );
}

async function sendAdminPanel(groupId) {
  const moderation =
    getModerationStatus(groupId);

  const remaining =
    getGroupLockRemaining(groupId);

  await sock.sendMessage(
    groupId,
    {
      text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       👑 *ADMIN PANEL*
╰━━━━━━━━━━━━━━━━━━━━╯

🤖 Bot:
${
  isBotEnabled(groupId)
    ? "🟢 ON"
    : "🔴 OFF"
}

🔒 Group Message:
${
  remaining > 0
    ? `🔴 OFF\n⏱️ ${formatGroupDuration(remaining)}`
    : "🟢 ON"
}

🛡️ Moderation:
${
  moderation.badWords
    ? "🟢"
    : "🔴"
} Bad Word

${
  moderation.links
    ? "🟢"
    : "🔴"
} Links

${
  moderation.spam
    ? "🟢"
    : "🔴"
} Spam

${
  moderation.warnings
    ? "🟢"
    : "🔴"
} Warnings

╭─❖ 🔒 GROUP MESSAGE
│ /গ্রুপ বন্ধ 2 মিনিট
│ /গ্রুপ বন্ধ 30 মিনিট
│ /গ্রুপ বন্ধ 2 ঘণ্টা
│ /গ্রুপ বন্ধ 1 দিন
│ /boton
╰────────────────────

╭─❖ 🤖 BOT
│ /boton
│ /botoff
╰────────────────────

╭─❖ ⚙️ COMMAND
│ /on <command>
│ /off <command>
│ /cmdlist
╰────────────────────

╭─❖ 🛡️ MODERATION
│ /mod
│ /modon
│ /modoff
╰────────────────────

👑 Admin / Owner Only
`
    }
  );

  await sendCopyButtons(
    groupId,
    [
      "/adminpanel",
      "/গ্রুপ বন্ধ 2 মিনিট",
      "/গ্রুপ বন্ধ 30 মিনিট",
      "/গ্রুপ বন্ধ 2 ঘণ্টা",
      "/boton",
      "/botoff",
      "/cmdlist",
      "/mod",
      "/modon",
      "/modoff"
    ]
  );
}

async function sendCommandList(groupId) {
  const status =
    COMMAND_DEFINITIONS
      .map(
        item =>
          `${
            isCommandEnabled(
              groupId,
              item.key
            )
              ? "🟢"
              : "🔴"
          } ${item.command}`
      )
      .join("\n");

  await sock.sendMessage(
    groupId,
    {
      text: `
╭━━━━━━━━━━━━━━━━━━━━╮
      📋 *COMMAND STATUS*
╰━━━━━━━━━━━━━━━━━━━━╯

${status}

🤖 Bot:
${
  isBotEnabled(groupId)
    ? "🟢 ON"
    : "🔴 OFF"
}

👑 Admin / Owner Only
`
    }
  );
}

async function sendModerationStatus(groupId) {
  const m =
    getModerationStatus(groupId);

  await sock.sendMessage(
    groupId,
    {
      text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🛡️ *MODERATION*
╰━━━━━━━━━━━━━━━━━━━━╯

${m.badWords ? "🟢" : "🔴"} Bad Word: ${m.badWords ? "ON" : "OFF"}
${m.links ? "🟢" : "🔴"} Links: ${m.links ? "ON" : "OFF"}
${m.spam ? "🟢" : "🔴"} Duplicate Spam: ${m.spam ? "ON" : "OFF"}
${m.warnings ? "🟢" : "🔴"} Warnings: ${m.warnings ? "ON" : "OFF"}

🚫 Member Remove: OFF
🚫 Kick/Ban: OFF

🟢 /modon
🔴 /modoff
`
    }
  );

  await sendCopyButtons(
    groupId,
    [
      "/mod",
      "/modon",
      "/modoff"
    ]
  );
}

/* =========================================================
   RULES / WEBSITE / PIYAS
========================================================= */

const GROUP_RULES = `
╭━━━━━━━━━━━━━━━━━━━━╮
        📜 *GROUP RULES*
╰━━━━━━━━━━━━━━━━━━━━╯

1️⃣ সবাইকে সম্মান করে কথা বলুন।
2️⃣ অশ্লীল কনটেন্ট শেয়ার করবেন না।
3️⃣ Spam বা একই Message বারবার পাঠাবেন না।
4️⃣ সন্দেহজনক Link শেয়ার করবেন না।
5️⃣ অন্য সদস্যকে হয়রানি করবেন না।
6️⃣ Deal করার আগে Admin-এর সাথে যোগাযোগ করুন।
7️⃣ কোনো সমস্যায় Admin-কে জানান।

🛡️ Bad Word, Link এবং Duplicate Spam
ধরা পড়লে Message Delete হতে পারে।

🚫 Member Remove/Kick/Ban করা হবে না।
`;

const WEBSITE_TEXT = `
╭━━━━━━━━━━━━━━━━━━━━╮
      🌐 *OUR WEBSITE*
╰━━━━━━━━━━━━━━━━━━━━╯

${WEBSITE_URL}

🤍 *Piyas*
`;

const PIYAS_INFO = `
╭━━━━━━━━━━━━━━━━━━╮
       🤍 *PIYAS*
╰━━━━━━━━━━━━━━━━━━╯

👤 Name: মোঃ আল আমিন
🌐 English Name: MD. AL AMIN

👨‍👦 Father: মোঃ মোশারফ হোসেন
👩‍👦 Mother: মোসাম্মৎ রীপা বেগম

🎂 Date of Birth: ০৯ জানুয়ারি ২০০৬
🩸 Blood Group: A+
💍 Marital Status: Unmarried

🏠 Address:
গ্রাম/রাস্তা: বলদার চর, নান্দাইল
ডাকঘর: হেমগঞ্জ বাজার - ২২৯০
নান্দাইল, ময়মনসিংহ

🤍 Thank You
`;

const BOT_OFF_TEXT = `
🔴 *BOT OFF*

বট এখন সাময়িকভাবে বন্ধ করা হয়েছে।

🟢 /boton
`;

const BOT_ON_TEXT = `
🟢 *BOT ON*

বট এখন পুনরায় চালু করা হয়েছে। ✅
`;

const DEAL_TEXT = `
╭━━━━━━━━━━━━━━━━━━━━╮
        🤝 *DEAL NOTICE*
╰━━━━━━━━━━━━━━━━━━━━╯

⚠️ কোনো Account Buy/Sell,
Google Play Points অথবা অন্য
কোনো Deal করার আগে অবশ্যই
Group Admin-এর সাথে যোগাযোগ করুন।

🚫 Admin ছাড়া কারো সাথে Deal করবেন না।

🤍 *PIYAS*
`;

/* =========================================================
   ADMIN LIST
========================================================= */

async function getAdminData(groupId) {
  const metadata =
    await sock.groupMetadata(groupId);

  const participants =
    metadata?.participants || [];

  await cacheParticipants(
    participants
  );

  const admins =
    participants.filter(
      isAdminParticipant
    );

  const result = [];

  for (const participant of admins) {
    const jid =
      await getPhoneJid(
        participant
      );

    result.push({
      jid:
        jid ||
        participant.id ||
        participant.lid,
      name:
        getDisplayName(
          participant
        ),
      owner:
        isOwnerParticipant(
          participant
        )
    });
  }

  return result;
}

async function sendAdminList(groupId) {
  const admins =
    await getAdminData(groupId);

  if (!admins.length) {
    await sock.sendMessage(
      groupId,
      {
        text:
          "👑 কোনো Admin পাওয়া যায়নি।"
      }
    );

    return;
  }

  const mentions = [];
  const lines = [];

  let n = 1;

  for (const admin of admins) {
    if (isPhoneJid(admin.jid)) {
      const phone =
        admin.jid.split("@")[0];

      mentions.push(admin.jid);

      lines.push(
        `${n}️⃣ @${phone} ${
          admin.owner
            ? "⭐ Group Owner"
            : "👑 Admin"
        }`
      );
    } else {
      lines.push(
        `${n}️⃣ ${admin.name} ${
          admin.owner
            ? "⭐ Group Owner"
            : "👑 Admin"
        }`
      );
    }

    n++;
  }

  await sock.sendMessage(
    groupId,
    {
      text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       👑 *GROUP ADMINS*
╰━━━━━━━━━━━━━━━━━━━━╯

${lines.join("\n\n")}

👥 মোট Admin: ${admins.length} জন
`,
      mentions
    }
  );
}

async function sendDealNotice(groupId) {
  const admins =
    await getAdminData(groupId);

  if (!admins.length) {
    await sock.sendMessage(
      groupId,
      {
        text:
          DEAL_TEXT
      }
    );

    return;
  }

  const mentions = [];
  const lines = [];

  let n = 1;

  for (const admin of admins) {
    if (isPhoneJid(admin.jid)) {
      const phone =
        admin.jid.split("@")[0];

      mentions.push(admin.jid);

      lines.push(
        `${n}️⃣ @${phone} ${
          admin.owner
            ? "⭐ Group Owner"
            : "👑 Admin"
        }`
      );
    } else {
      lines.push(
        `${n}️⃣ ${admin.name} ${
          admin.owner
            ? "⭐ Group Owner"
            : "👑 Admin"
        }`
      );
    }

    n++;
  }

  await sock.sendMessage(
    groupId,
    {
      text:
        DEAL_TEXT +
        "\n\n" +
        lines.join("\n\n"),
      mentions
    }
  );
}

/* =========================================================
   WELCOME
========================================================= */

async function sendWelcome(
  groupId,
  participant
) {
  try {
    const metadata =
      await sock.groupMetadata(
        groupId
      );

    const member =
      findParticipant(
        metadata?.participants || [],
        participant?.id
      ) ||
      participant;

    const name =
      getDisplayName(member);

    const groupName =
      cleanName(
        metadata?.subject
      ) ||
      "এই গ্রুপ";

    const phone =
      await getPhoneJid(member);

    const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
        🎉 *স্বাগতম*
╰━━━━━━━━━━━━━━━━━━━━╯

🎉 স্বাগতম @${name} ❤️

🌸 আপনাকে *${groupName}*
গ্রুপে স্বাগতম।

📌 Rules:
/rules

🌐 Website:
/website

🔰 Backup Group:
${BACKUP_GROUP_URL}

🤍 *Piyas*
`;

    await sock.sendMessage(
      groupId,
      {
        text,
        ...(isPhoneJid(phone)
          ? { mentions: [phone] }
          : {})
      }
    );
  } catch (error) {
    console.log(
      "❌ Welcome error:",
      error?.message
    );
  }
}

/* =========================================================
   PAIRING
========================================================= */

function savePairingNumber(number) {
  try {
    fs.writeFileSync(
      PAIRING_NUMBER_FILE,
      number,
      "utf8"
    );
  } catch {}
}

function getCredentialPhoneNumber(creds) {
  const id = creds?.me?.id;

  if (!id) return "";

  return id
    .split(":")[0]
    .split("@")[0]
    .replace(/[^0-9]/g, "");
}

async function resetAuthForNumberChange() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      await fs.promises.rm(
        AUTH_DIR,
        {
          recursive: true,
          force: true
        }
      );
    }
  } catch {}
}

async function generatePairingCode(state) {
  try {
    if (
      !PHONE_NUMBER ||
      state.creds.registered ||
      pairingRequested
    ) {
      return;
    }

    pairingRequested = true;

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          2500
        )
    );

    if (
      !sock ||
      state.creds.registered
    ) {
      pairingRequested = false;
      return;
    }

    const code =
      await sock.requestPairingCode(
        PHONE_NUMBER
      );

    savePairingNumber(
      PHONE_NUMBER
    );

    console.log(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );

    console.log(
      `🔐 PAIRING CODE: ${code}`
    );

    console.log(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );
  } catch (error) {
    pairingRequested = false;

    console.log(
      "❌ Pairing code error:",
      error?.message
    );
  }
}

/* =========================================================
   START BOT
========================================================= */

async function startBot() {
  try {
    let auth =
      await useMultiFileAuthState(
        AUTH_DIR
      );

    let {
      state,
      saveCreds
    } = auth;

    const oldNumber =
      getCredentialPhoneNumber(
        state.creds
      );

    if (
      PHONE_NUMBER &&
      state.creds.registered &&
      oldNumber &&
      oldNumber !== PHONE_NUMBER
    ) {
      await resetAuthForNumberChange();

      pairingRequested = false;

      auth =
        await useMultiFileAuthState(
          AUTH_DIR
        );

      state =
        auth.state;

      saveCreds =
        auth.saveCreds;
    }

    sock =
      makeWASocket({
        auth: state,
        logger,
        browser:
          Browsers.ubuntu(
            "Chrome"
          ),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        printQRInTerminal: false
      });

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    sock.ev.on(
      "lid-mapping.update",
      mapping => {
        try {
          const list =
            Array.isArray(mapping)
              ? mapping
              : mapping?.mappings ||
                [mapping];

          for (const item of list) {
            if (!item) continue;

            const lid =
              item.lid ||
              item.lidJid ||
              item.lid_jid;

            const pn =
              item.pn ||
              item.pnJid ||
              item.pn_jid ||
              item.phone ||
              item.phoneNumber;

            if (lid && pn) {
              saveLidMapping(
                lid,
                pn
              );
            }
          }
        } catch {}
      }
    );

    sock.ev.on(
      "contacts.upsert",
      contacts =>
        saveContacts(contacts)
    );

    sock.ev.on(
      "contacts.update",
      contacts =>
        saveContacts(contacts)
    );

    /* =====================================================
       GROUP PARTICIPANTS
    ===================================================== */

    sock.ev.on(
      "group-participants.update",
      async event => {
        try {
          const groupId =
            event?.id;

          if (!groupId) return;

          if (
            !(await isGroupAllowed(
              groupId
            ))
          ) {
            return;
          }

          if (
            event.action === "add"
          ) {
            for (
              const participant of
                event.participants || []
            ) {
              await sendWelcome(
                groupId,
                participant
              );
            }
          }
        } catch (error) {
          console.log(
            "❌ Participant event error:",
            error?.message
          );
        }
      }
    );

    /* =====================================================
       CONNECTION
    ===================================================== */

    sock.ev.on(
      "connection.update",
      async update => {
        try {
          const {
            connection,
            lastDisconnect
          } = update;

          if (
            connection === "connecting"
          ) {
            console.log(
              "🔄 Connecting to WhatsApp..."
            );

            if (
              PHONE_NUMBER &&
              !state.creds.registered
            ) {
              await generatePairingCode(
                state
              );
            }
          }

          if (
            connection === "open"
          ) {
            console.log(
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            );

            console.log(
              "✅ WhatsApp Bot Connected Successfully!"
            );

            console.log(
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            );

            reconnecting = false;
            pairingRequested = false;

            try {
              const groups =
                await sock.groupFetchAllParticipating();

              for (
                const group of
                  Object.values(
                    groups || {}
                  )
              ) {
                await cacheParticipants(
                  group?.participants || []
                );
              }

              await restoreActiveGroupLocks();
              await autoEnableExpiredGroups();
            } catch (error) {
              console.log(
                "⚠️ Group restore error:",
                error?.message
              );
            }
          }

          if (
            connection === "close"
          ) {
            const statusCode =
              new Boom(
                lastDisconnect?.error
              )?.output?.statusCode;

            const shouldReconnect =
              statusCode !==
              DisconnectReason.loggedOut;

            console.log(
              `❌ WhatsApp connection closed. Code: ${statusCode}`
            );

            sock = null;
            pairingRequested = false;

            if (
              shouldReconnect &&
              !reconnecting
            ) {
              reconnecting = true;

              setTimeout(
                () => {
                  reconnecting = false;
                  startBot();
                },
                3000
              );
            }
          }
        } catch (error) {
          console.log(
            "❌ Connection error:",
            error?.message
          );
        }
      }
    );

    /* =====================================================
       MESSAGES
    ===================================================== */

    sock.ev.on(
      "messages.upsert",
      async ({
        messages
      }) => {
        for (
          const message of
            messages || []
        ) {
          try {
            if (
              !message ||
              message.key?.fromMe
            ) {
              continue;
            }

            const remoteJid =
              message.key?.remoteJid;

            if (
              !remoteJid ||
              !remoteJid.endsWith(
                "@g.us"
              )
            ) {
              continue;
            }

            if (
              !(await isGroupAllowed(
                remoteJid
              ))
            ) {
              continue;
            }

            const text =
              getMessageText(
                message
              );

            if (!text) continue;

            if (
              await moderateMessage(
                remoteJid,
                message,
                text
              )
            ) {
              continue;
            }

            const trimmed =
              text.trim();

            if (
              !trimmed.startsWith("/")
            ) {
              continue;
            }

            const parts =
              trimmed.split(/\s+/);

            const raw =
              parts.shift() || "";

            const command =
              normalizeCommandName(
                raw
              );

            const args =
              parts;

            if (!command) continue;

            /* =============================================
               ADMIN CHECK
            ============================================= */

            if (
              ADMIN_ONLY_COMMANDS.includes(
                command
              )
            ) {
              const admin =
                await isSenderAdmin(
                  remoteJid,
                  message
                );

              if (!admin) {
                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      "❌ এই Command শুধুমাত্র Group Admin / Owner ব্যবহার করতে পারবেন।"
                  }
                );

                continue;
              }
            }

            /* =============================================
               GROUP LOCK
            ============================================= */

            if (
              command === "গ্রুপ"
            ) {
              const action =
                normalizeCommandName(
                  args[0] || ""
                );

              if (
                action !== "বন্ধ"
              ) {
                await sock.sendMessage(
                  remoteJid,
                  {
                    text: `
🔒 *GROUP MESSAGE CONTROL*

ব্যবহার:

/গ্রুপ বন্ধ 2 মিনিট

উদাহরণ:

/গ্রুপ বন্ধ 30 মিনিট
/গ্রুপ বন্ধ 2 ঘণ্টা
/গ্রুপ বন্ধ 1 দিন
/গ্রুপ বন্ধ 1 সপ্তাহ
/গ্রুপ বন্ধ 1 মাস
/গ্রুপ বন্ধ 1 বছর

🟢 আগে ON করতে:
/boton
`
                  }
                );

                continue;
              }

              const duration =
                parseGroupOffDuration(
                  args.slice(1)
                );

              if (!duration) {
                await sock.sendMessage(
                  remoteJid,
                  {
                    text: `
❌ *সময় সঠিক নয়।*

সঠিক উদাহরণ:

/গ্রুপ বন্ধ 2 মিনিট
/গ্রুপ বন্ধ 30 মিনিট
/গ্রুপ বন্ধ 2 ঘণ্টা
/গ্রুপ বন্ধ 1 দিন
/গ্রুপ বন্ধ 1 সপ্তাহ
/গ্রুপ বন্ধ 1 মাস
/গ্রুপ বন্ধ 1 বছর

শুধু সংখ্যা দিলে সেটি মিনিট হবে:

/গ্রুপ বন্ধ 10
`
                  }
                );

                continue;
              }

              await lockGroupForDuration(
                remoteJid,
                duration
              );

              continue;
            }

            /* =============================================
               BOT OFF
            ============================================= */

            if (
              command === "botoff"
            ) {
              if (
                !isBotEnabled(
                  remoteJid
                )
              ) {
                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      "🔴 *BOT STATUS*\n\nবট ইতোমধ্যে OFF আছে।"
                  }
                );

                continue;
              }

              setBotStatus(
                remoteJid,
                false
              );

              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    BOT_OFF_TEXT
                }
              );

              continue;
            }

            /* =============================================
               BOT ON
            ============================================= */

            if (
              command === "boton"
            ) {
              const remaining =
                getGroupLockRemaining(
                  remoteJid
                );

              if (
                remaining > 0
              ) {
                await unlockGroupNow(
                  remoteJid,
                  "manual"
                );

                setBotStatus(
                  remoteJid,
                  true
                );

                continue;
              }

              if (
                isBotEnabled(
                  remoteJid
                )
              ) {
                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      "🟢 *BOT STATUS*\n\nবট ইতোমধ্যে ON আছে।"
                  }
                );

                continue;
              }

              setBotStatus(
                remoteJid,
                true
              );

              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    BOT_ON_TEXT
                }
              );

              continue;
            }

            /* =============================================
               ADMIN PANEL
            ============================================= */

            if (
              command === "adminpanel"
            ) {
              await sendAdminPanel(
                remoteJid
              );

              continue;
            }

            /* =============================================
               MODERATION
            ============================================= */

            if (
              command === "mod" ||
              command === "moderation" ||
              command === "modstatus"
            ) {
              await sendModerationStatus(
                remoteJid
              );

              continue;
            }

            if (
              command === "modon"
            ) {
              for (
                const type of
                  Object.keys(
                    MODERATION_DEFAULTS
                  )
              ) {
                setModerationStatus(
                  remoteJid,
                  type,
                  true
                );
              }

              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    "🛡️ *MODERATION ON*\n\n🟢 Bad Word\n🟢 Links\n🟢 Duplicate Spam\n🟢 Warnings"
                }
              );

              continue;
            }

            if (
              command === "modoff"
            ) {
              for (
                const type of
                  Object.keys(
                    MODERATION_DEFAULTS
                  )
              ) {
                setModerationStatus(
                  remoteJid,
                  type,
                  false
                );
              }

              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    "🛡️ *MODERATION OFF*\n\n🔴 Bad Word\n🔴 Links\n🔴 Duplicate Spam\n🔴 Warnings"
                }
              );

              continue;
            }

            /* =============================================
               ON / OFF COMMAND
            ============================================= */

            if (
              command === "on" ||
              command === "off"
            ) {
              const target =
                getCanonicalCommand(
                  args[0] || ""
                );

              if (
                !target ||
                !isKnownCommand(
                  target
                )
              ) {
                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      "⚠️ ব্যবহার করুন:\n\n/on <command>\n/off <command>\n\nউদাহরণ:\n/on admin\n/off admin"
                  }
                );

                continue;
              }

              if (
                PROTECTED_COMMANDS.includes(
                  target
                )
              ) {
                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      "⚠️ এই Admin Control Command বন্ধ করা যাবে না।"
                  }
                );

                continue;
              }

              const enable =
                command === "on";

              setCommandStatus(
                remoteJid,
                target,
                enable
              );

              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    `${enable ? "🟢" : "🔴"} */${target}* ${
                      enable
                        ? "ON"
                        : "OFF"
                    } করা হয়েছে।`
                }
              );

              continue;
            }

            /* =============================================
               COMMAND LIST
            ============================================= */

            if (
              command === "cmdlist"
            ) {
              await sendCommandList(
                remoteJid
              );

              continue;
            }

            /* =============================================
               BOT OFF
            ============================================= */

            if (
              !isBotEnabled(
                remoteJid
              )
            ) {
              continue;
            }

            const canonical =
              getCanonicalCommand(
                command
              );

            if (
              !isKnownCommand(
                canonical
              )
            ) {
              continue;
            }

            if (
              !isCommandEnabled(
                remoteJid,
                canonical
              )
            ) {
              continue;
            }

            /* =============================================
               MENU
            ============================================= */

            if (
              canonical === "menu" ||
              canonical === "bot"
            ) {
              await sendPublicMenu(
                remoteJid
              );

              continue;
            }

            /* =============================================
               RULES
            ============================================= */

            if (
              canonical === "rules"
            ) {
              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    GROUP_RULES
                }
              );

              await sendCopyButton(
                remoteJid,
                "/rules"
              );

              continue;
            }

            /* =============================================
               WEBSITE
            ============================================= */

            if (
              canonical === "website"
            ) {
              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    WEBSITE_TEXT
                }
              );

              await sendCopyButton(
                remoteJid,
                "/website"
              );

              continue;
            }

            /* =============================================
               DEAL
            ============================================= */

            if (
              canonical === "deal"
            ) {
              await sendDealNotice(
                remoteJid
              );

              continue;
            }

            /* =============================================
               ADMIN
            ============================================= */

            if (
              canonical === "admin"
            ) {
              await sendAdminList(
                remoteJid
              );

              continue;
            }

            /* =============================================
               MEMBERS
            ============================================= */

            if (
              canonical === "members"
            ) {
              const metadata =
                await sock.groupMetadata(
                  remoteJid
                );

              const participants =
                metadata?.participants ||
                [];

              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    `👥 *GROUP MEMBERS*\n\nমোট Member: ${participants.length} জন`
                }
              );

              continue;
            }

            /* =============================================
               GROUP INFO
            ============================================= */

            if (
              canonical === "groupinfo"
            ) {
              const metadata =
                await sock.groupMetadata(
                  remoteJid
                );

              const participants =
                metadata?.participants ||
                [];

              const admins =
                participants.filter(
                  isAdminParticipant
                );

              const remaining =
                getGroupLockRemaining(
                  remoteJid
                );

              const moderation =
                getModerationStatus(
                  remoteJid
                );

              await sock.sendMessage(
                remoteJid,
                {
                  text: `
╭━━━━━━━━━━━━━━━━━━╮
       👥 *GROUP INFO*
╰━━━━━━━━━━━━━━━━━━╯

📛 Name: ${
                    metadata?.subject ||
                    "Unknown"
                  }

🆔 ID: ${remoteJid}

👥 Members: ${
                    participants.length
                  }

👑 Admins: ${
                    admins.length
                  }

🤖 Bot: ${
                    isBotEnabled(
                      remoteJid
                    )
                      ? "🟢 ON"
                      : "🔴 OFF"
                  }

🔒 Member Message: ${
                    remaining > 0
                      ? "🔴 OFF"
                      : "🟢 ON"
                  }

${
  remaining > 0
    ? `⏱️ Remaining: ${formatGroupDuration(remaining)}`
    : ""
}

🛡️ Bad Word: ${
                    moderation.badWords
                      ? "🟢 ON"
                      : "🔴 OFF"
                  }

🔗 Link Protection: ${
                    moderation.links
                      ? "🟢 ON"
                      : "🔴 OFF"
                  }

🚨 Duplicate Spam: ${
                    moderation.spam
                      ? "🟢 ON"
                      : "🔴 OFF"
                  }

⚠️ Warning: ${
                    moderation.warnings
                      ? "🟢 ON"
                      : "🔴 OFF"
                  }

🚫 Kick/Ban: OFF
`
                }
              );

              continue;
            }

            /* =============================================
               ID
            ============================================= */

            if (
              canonical === "id"
            ) {
              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    `🆔 *GROUP ID*\n\n${remoteJid}`
                }
              );

              continue;
            }

            /* =============================================
               PING
            ============================================= */

            if (
              canonical === "ping"
            ) {
              const start =
                Date.now();

              const msg =
                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      "🏓 Checking Bot..."
                  }
                );

              const ping =
                Date.now() -
                start;

              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    `🏓 *PONG!*\n\n⚡ Response: ${ping}ms\n🤖 Bot: Online`,
                  quoted: msg
                }
              );

              continue;
            }

            /* =============================================
               PIYAS
            ============================================= */

            if (
              canonical === "piyas"
            ) {
              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    PIYAS_INFO
                }
              );

              continue;
            }
          } catch (error) {
            console.log(
              "⚠️ Message error:",
              error?.message
            );
          }
        }
      }
    );

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
          reconnecting = false;
          startBot();
        },
        5000
      );
    }
  }
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    (req, res) => {
      if (
        req.url === "/health"
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
            bot:
              "WhatsApp Group Bot",
            connected:
              Boolean(sock)
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
   START
========================================================= */

loadBotStatus();
loadWarnings();
startBot();