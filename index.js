import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    Browsers
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import P from "pino";
import dotenv from "dotenv";
import fs from "fs";
import http from "http";

dotenv.config();

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const PHONE_NUMBER = String(process.env.PHONE_NUMBER || "")
    .replace(/\D/g, "");

const BOT_NAME = "আর-রাইয়ান";

const WEBSITE_URL =
    "https://x-cyber-2025.github.io/X-cyber.web/";

const BACKUP_GROUP_URL =
    "https://chat.whatsapp.com/KsIJqeOdSTVC2FBIuWCvlN?s=cl&p=a&mlu=4&ilr=4";

const AUTH_DIR = "./auth_info";
const PAIRING_FILE = "./pairing_number.txt";
const STATUS_FILE = "./bot_status.json";
const WARNINGS_FILE = "./warnings.json";

/* =========================================================
   MODERATION DEFAULTS
========================================================= */

const DEFAULT_MODERATION = {
    badWords: true,
    links: true,
    spam: true,
    warnings: true
};

/* =========================================================
   BAD WORDS
========================================================= */

const BAD_WORDS = [
    "fuck",
    "fucking",
    "motherfucker",
    "bitch",
    "bastard",
    "asshole",
    "idiot",
    "stupid",
    "dumb",
    "shit",
    "sex",
    "porn",
    "xxx",

    "চোদা",
    "চোদ",
    "চুদা",
    "চুদ",
    "চুদাচুদি",
    "মাদারচোদ",
    "বাল",
    "বালের",
    "হারামি",
    "হারামজাদা",
    "শালা",
    "শালার",
    "কুত্তা",
    "কুত্তার",
    "বাঞ্চোদ",
    "বাইনচোদ",
    "খানকির",
    "খানকি",
    "মাগি",
    "মাদার",
    "জারজ",
    "নষ্টা",
    "নষ্ট",
    "গালি"
];

/* =========================================================
   COMMANDS
========================================================= */

const ADMIN_ONLY_COMMANDS = new Set([
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
]);

const PROTECTED_COMMANDS = new Set([
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
]);

/* =========================================================
   MEMORY
========================================================= */

let sock = null;
let reconnecting = false;

let botStatus = {};
let warnings = {};

const messageCache = new Map();
const contactCache = new Map();

/* =========================================================
   FILE HELPERS
========================================================= */

function ensureFile(file, defaultValue) {
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(
                file,
                JSON.stringify(defaultValue, null, 2)
            );
        }
    } catch (error) {
        console.error("File create error:", file, error);
    }
}

function loadJSON(file, fallback) {
    try {
        ensureFile(file, fallback);

        const raw = fs.readFileSync(file, "utf8");

        if (!raw.trim()) {
            return fallback;
        }

        return JSON.parse(raw);
    } catch (error) {
        console.error("JSON load error:", file, error);
        return fallback;
    }
}

function saveJSON(file, data) {
    try {
        fs.writeFileSync(
            file,
            JSON.stringify(data, null, 2)
        );
    } catch (error) {
        console.error("JSON save error:", file, error);
    }
}

function loadBotStatus() {
    botStatus = loadJSON(STATUS_FILE, {});
}

function saveBotStatus() {
    saveJSON(STATUS_FILE, botStatus);
}

function loadWarnings() {
    warnings = loadJSON(WARNINGS_FILE, {});
}

function saveWarnings() {
    saveJSON(WARNINGS_FILE, warnings);
}

ensureFile(STATUS_FILE, {});
ensureFile(WARNINGS_FILE, {});

/* =========================================================
   GROUP STATUS
========================================================= */

function getGroupStatus(groupId) {
    if (!botStatus[groupId]) {
        botStatus[groupId] = {
            enabled: true,
            disabledCommands: [],
            moderation: {
                ...DEFAULT_MODERATION
            },
            autoOnAt: null
        };
    }

    if (!botStatus[groupId].moderation) {
        botStatus[groupId].moderation = {
            ...DEFAULT_MODERATION
        };
    }

    if (
        typeof botStatus[groupId].enabled !== "boolean"
    ) {
        botStatus[groupId].enabled = true;
    }

    if (!Array.isArray(botStatus[groupId].disabledCommands)) {
        botStatus[groupId].disabledCommands = [];
    }

    if (
        !Object.prototype.hasOwnProperty.call(
            botStatus[groupId],
            "autoOnAt"
        )
    ) {
        botStatus[groupId].autoOnAt = null;
    }

    return botStatus[groupId];
}

/* =========================================================
   BOT STATUS
========================================================= */

function setBotStatus(groupId, enabled) {
    const status = getGroupStatus(groupId);

    status.enabled = enabled;

    if (!enabled) {
        status.autoOnAt = null;
    }

    saveBotStatus();
}

/* =========================================================
   SAFE DURATION
========================================================= */

const MAX_SAFE_DURATION_MINUTES =
    Number.MAX_SAFE_INTEGER / (60 * 1000);

/* =========================================================
   DURATION PARSER
========================================================= */

function parseGroupOffDuration(text) {
    if (!text) {
        return null;
    }

    const input = String(text)
        .trim()
        .toLowerCase()
        .replace(/,/g, " ");

    if (!input) {
        return null;
    }

    const units = [
        {
            regex: /(years?|yrs?|yr|বছর|বছরের)/gi,
            minutes: 525600
        },
        {
            regex: /(months?|মাস|মাসের)/gi,
            minutes: 43200
        },
        {
            regex: /(weeks?|সপ্তাহ|সপ্তাহের)/gi,
            minutes: 10080
        },
        {
            regex: /(days?|দিন|দিনের)/gi,
            minutes: 1440
        },
        {
            regex: /(hours?|hrs?|hr|ঘন্টা|ঘণ্টা|ঘন্টার|ঘণ্টার)/gi,
            minutes: 60
        },
        {
            regex: /(minutes?|mins?|min|মিনিট|মিনিটের)/gi,
            minutes: 1
        }
    ];

    let totalMinutes = 0;
    let foundUnit = false;
    let cleaned = input;

    for (const unit of units) {
        let match;

        const regex = new RegExp(
            `(\\d+(?:\\.\\d+)?)\\s*${unit.regex.source}`,
            "gi"
        );

        while ((match = regex.exec(input)) !== null) {
            const value = Number(match[1]);

            if (!Number.isFinite(value) || value <= 0) {
                return null;
            }

            totalMinutes += value * unit.minutes;
            foundUnit = true;
        }

        cleaned = cleaned.replace(regex, " ");
    }

    /*
       If no unit was found, a plain number means minutes.
       Example:
       /গ্রুপ বন্ধ 30
    */

    if (!foundUnit) {
        const onlyNumber = input.match(
            /^\s*(\d+(?:\.\d+)?)\s*$/
        );

        if (!onlyNumber) {
            return null;
        }

        totalMinutes = Number(onlyNumber[1]);
    }

    if (
        !Number.isFinite(totalMinutes) ||
        totalMinutes <= 0 ||
        totalMinutes > MAX_SAFE_DURATION_MINUTES
    ) {
        return null;
    }

    return Math.round(totalMinutes);
}

/* =========================================================
   FORMAT DURATION
========================================================= */

function formatGroupDuration(minutes) {
    let remaining = Math.max(
        0,
        Math.round(Number(minutes) || 0)
    );

    const parts = [];

    const years = Math.floor(remaining / 525600);

    if (years > 0) {
        parts.push(`${years} বছর`);
        remaining %= 525600;
    }

    const months = Math.floor(remaining / 43200);

    if (months > 0) {
        parts.push(`${months} মাস`);
        remaining %= 43200;
    }

    const weeks = Math.floor(remaining / 10080);

    if (weeks > 0) {
        parts.push(`${weeks} সপ্তাহ`);
        remaining %= 10080;
    }

    const days = Math.floor(remaining / 1440);

    if (days > 0) {
        parts.push(`${days} দিন`);
        remaining %= 1440;
    }

    const hours = Math.floor(remaining / 60);

    if (hours > 0) {
        parts.push(`${hours} ঘণ্টা`);
        remaining %= 60;
    }

    if (remaining > 0) {
        parts.push(`${remaining} মিনিট`);
    }

    return parts.length
        ? parts.join(" ")
        : "0 মিনিট";
}

/* =========================================================
   GROUP AUTO ON
========================================================= */

function setGroupAutoOn(groupId, minutes) {
    const status = getGroupStatus(groupId);

    const milliseconds =
        Math.round(minutes * 60 * 1000);

    if (
        !Number.isSafeInteger(milliseconds) ||
        milliseconds <= 0
    ) {
        return false;
    }

    status.enabled = false;

    status.autoOnAt =
        Date.now() + milliseconds;

    saveBotStatus();

    return true;
}

/* =========================================================
   CHECK EXPIRED GROUP LOCKS
========================================================= */

async function autoEnableExpiredGroups() {
    if (!sock) {
        return;
    }

    const now = Date.now();
    let changed = false;

    for (const groupId of Object.keys(botStatus)) {
        const status = botStatus[groupId];

        if (!status) {
            continue;
        }

        if (
            status.autoOnAt &&
            Number(status.autoOnAt) <= now
        ) {
            try {
                /*
                   IMPORTANT:
                   This actually enables member messages
                   again in the WhatsApp group.
                */

                await sock.groupSettingUpdate(
                    groupId,
                    "not_announcement"
                );

                status.enabled = true;
                status.autoOnAt = null;

                changed = true;

                await sendSafeMessage(
                    groupId,
                    {
                        text:
                            `🟢 *GROUP ON*\n\n` +
                            `🤖 ${BOT_NAME}\n` +
                            `এই Group-এর সদস্যরা এখন আবার Message পাঠাতে পারবেন।\n\n` +
                            `✅ নির্ধারিত সময় শেষ হয়েছে।\n\n` +
                            `━━━━━━━━━━━━━━\n` +
                            `👑 Admin / Owner\n` +
                            `🤍 ${BOT_NAME}`
                    }
                );

                console.log(
                    `[AUTO ON] ${groupId}`
                );
            } catch (error) {
                console.error(
                    "Auto group ON error:",
                    error
                );
            }
        }
    }

    if (changed) {
        saveBotStatus();
    }
}

setInterval(
    autoEnableExpiredGroups,
    10 * 1000
);

/* =========================================================
   SAFE MESSAGE
========================================================= */

async function sendSafeMessage(jid, content, options = {}) {
    if (!sock) {
        return null;
    }

    try {
        return await sock.sendMessage(
            jid,
            content,
            options
        );
    } catch (error) {
        console.error(
            "Send message error:",
            error
        );

        return null;
    }
}

/* =========================================================
   TEXT HELPERS
========================================================= */

function normalizeText(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function containsBadWord(text) {
    const normalized = normalizeText(text);

    return BAD_WORDS.some(word => {
        return normalized.includes(
            word.toLowerCase()
        );
    });
}

function containsLink(text) {
    const value = String(text || "");

    const patterns = [
        /https?:\/\/\S+/i,
        /www\.\S+/i,
        /\b[a-z0-9-]+\.(com|net|org|xyz|info|top|site|online|shop|me|io|co|bd)\b/i
    ];

    return patterns.some(
        regex => regex.test(value)
    );
}

/* =========================================================
   MESSAGE TEXT
========================================================= */

function getMessageText(message) {
    if (!message) {
        return "";
    }

    const msg =
        message.message || {};

    if (msg.conversation) {
        return msg.conversation;
    }

    if (msg.extendedTextMessage?.text) {
        return msg.extendedTextMessage.text;
    }

    if (msg.imageMessage?.caption) {
        return msg.imageMessage.caption;
    }

    if (msg.videoMessage?.caption) {
        return msg.videoMessage.caption;
    }

    return "";
}

/* =========================================================
   COMMAND PARSER
========================================================= */

function parseCommand(text) {
    const value = String(text || "").trim();

    if (!value.startsWith("/")) {
        return {
            command: "",
            args: [],
            rawArgs: ""
        };
    }

    const body = value.slice(1).trim();

    if (!body) {
        return {
            command: "",
            args: [],
            rawArgs: ""
        };
    }

    const parts = body.split(/\s+/);

    const command =
        String(parts.shift() || "")
            .toLowerCase();

    return {
        command,
        args: parts,
        rawArgs: parts.join(" ")
    };
}

/* =========================================================
   ADMIN / OWNER HELPERS
========================================================= */

function getParticipantId(participant) {
    if (!participant) {
        return "";
    }

    if (typeof participant === "string") {
        return participant;
    }

    return (
        participant.id ||
        participant.jid ||
        participant.lid ||
        ""
    );
}

function isAdminParticipant(participant) {
    if (!participant) {
        return false;
    }

    return (
        participant.admin === "admin" ||
        participant.admin === "superadmin"
    );
}

function getSenderId(message) {
    return (
        message?.key?.participant ||
        message?.participant ||
        message?.key?.remoteJid ||
        ""
    );
}

function normalizeJid(jid) {
    if (!jid) {
        return "";
    }

    try {
        return jidNormalizedUser(jid);
    } catch {
        return String(jid);
    }
}

/* =========================================================
   GROUP METADATA
========================================================= */

async function getGroupMetadata(groupId) {
    if (!sock) {
        return null;
    }

    try {
        return await sock.groupMetadata(
            groupId
        );
    } catch (error) {
        console.error(
            "Group metadata error:",
            error
        );

        return null;
    }
}

/* =========================================================
   CHECK GROUP ADMIN
========================================================= */

async function isGroupAdmin(groupId, senderId) {
    const metadata =
        await getGroupMetadata(groupId);

    if (!metadata) {
        return false;
    }

    const sender =
        normalizeJid(senderId);

    const participant =
        metadata.participants.find(
            p =>
                normalizeJid(
                    getParticipantId(p)
                ) === sender
        );

    return isAdminParticipant(
        participant
    );
}

/* =========================================================
   CHECK BOT ADMIN
========================================================= */

async function isBotGroupAdmin(groupId) {
    const metadata =
        await getGroupMetadata(groupId);

    if (!metadata || !sock?.user) {
        return false;
    }

    const botJid =
        normalizeJid(sock.user.id);

    const participant =
        metadata.participants.find(
            p =>
                normalizeJid(
                    getParticipantId(p)
                ) === botJid
        );

    return isAdminParticipant(
        participant
    );
}

/* =========================================================
   GROUP INFO
========================================================= */

async function getGroupAdmins(groupId) {
    const metadata =
        await getGroupMetadata(groupId);

    if (!metadata) {
        return [];
    }

    return metadata.participants.filter(
        isAdminParticipant
    );
}

/* =========================================================
   WARNING SYSTEM
========================================================= */

function getWarningKey(
    groupId,
    userId
) {
    return `${groupId}:${normalizeJid(userId)}`;
}

function getWarningCount(
    groupId,
    userId
) {
    const key =
        getWarningKey(
            groupId,
            userId
        );

    return Number(
        warnings[key] || 0
    );
}

function addWarning(
    groupId,
    userId
) {
    const key =
        getWarningKey(
            groupId,
            userId
        );

    warnings[key] =
        getWarningCount(
            groupId,
            userId
        ) + 1;

    saveWarnings();

    return warnings[key];
}

/* =========================================================
   DELETE MESSAGE
========================================================= */

async function deleteMessage(message) {
    try {
        if (!sock) {
            return;
        }

        await sock.sendMessage(
            message.key.remoteJid,
            {
                delete: message.key
            }
        );
    } catch (error) {
        console.error(
            "Delete message error:",
            error
        );
    }
}

/* =========================================================
   MODERATION
========================================================= */

async function moderateMessage(
    message,
    groupId,
    senderId,
    text
) {
    const status =
        getGroupStatus(groupId);

    const moderation =
        status.moderation;

    const admin =
        await isGroupAdmin(
            groupId,
            senderId
        );

    /*
       Admin messages bypass moderation.
    */

    if (admin) {
        return false;
    }

    let reason = "";

    if (
        moderation.badWords &&
        containsBadWord(text)
    ) {
        reason =
            "🚫 খারাপ/অশালীন শব্দ";
    }

    if (
        !reason &&
        moderation.links &&
        containsLink(text)
    ) {
        reason =
            "🔗 অনুমোদনহীন Link";
    }

    /*
       Duplicate spam protection.
    */

    if (
        !reason &&
        moderation.spam
    ) {
        const normalized =
            normalizeText(text);

        const cacheKey =
            `${groupId}:${normalizeJid(senderId)}`;

        const previous =
            messageCache.get(cacheKey);

        const now = Date.now();

        if (
            previous &&
            previous.text === normalized &&
            now - previous.time < 60000
        ) {
            reason =
                "⚠️ একই Message বারবার পাঠানো";
        }

        messageCache.set(
            cacheKey,
            {
                text: normalized,
                time: now
            }
        );
    }

    if (!reason) {
        return false;
    }

    await deleteMessage(message);

    if (moderation.warnings) {
        const count =
            addWarning(
                groupId,
                senderId
            );

        await sendSafeMessage(
            groupId,
            {
                text:
                    `⚠️ *MODERATION WARNING*\n\n` +
                    `👤 সদস্য: @${String(senderId).split("@")[0]}\n` +
                    `📌 কারণ: ${reason}\n` +
                    `⚠️ Warning: ${count}\n\n` +
                    `অনুগ্রহ করে Group Rules মেনে চলুন।`
            },
            {
                mentions: [
                    senderId
                ]
            }
        );
    }

    return true;
}

/* =========================================================
   WELCOME MESSAGE
========================================================= */

async function sendWelcome(
    groupId,
    participant
) {
    const number =
        String(participant || "")
            .split("@")[0];

    await sendSafeMessage(
        groupId,
        {
            text:
                `🎉 *WELCOME TO THE GROUP*\n\n` +
                `👤 @${number}\n\n` +
                `🤖 ${BOT_NAME} আপনাকে স্বাগতম জানাচ্ছে।\n\n` +
                `📌 Group Rules মেনে চলুন।\n` +
                `📖 Rules দেখতে লিখুন: /rules\n` +
                `📋 Menu দেখতে লিখুন: /menu\n\n` +
                `🤍 ${BOT_NAME}`
        },
        {
            mentions: [
                participant
            ]
        }
    );
}

/* =========================================================
   GROUP INFO
========================================================= */

async function sendGroupInfo(
    groupId
) {
    const metadata =
        await getGroupMetadata(groupId);

    if (!metadata) {
        return;
    }

    const admins =
        metadata.participants.filter(
            isAdminParticipant
        );

    const adminLines =
        admins.map(
            (admin, index) => {
                const id =
                    getParticipantId(
                        admin
                    );

                return `${index + 1}. @${String(id).split("@")[0]}`;
            }
        );

    const status =
        getGroupStatus(groupId);

    let autoStatus =
        "❌ কোনো Auto ON timer নেই";

    if (status.autoOnAt) {
        const remaining =
            Math.max(
                0,
                status.autoOnAt -
                Date.now()
            );

        const minutes =
            Math.ceil(
                remaining / 60000
            );

        autoStatus =
            `⏳ Auto ON: ${formatGroupDuration(minutes)}`;
    }

    await sendSafeMessage(
        groupId,
        {
            text:
                `━━━━━━━━━━━━━━━━━━\n` +
                `📌 *GROUP INFORMATION* 📌\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +
                `🏷️ নাম: ${metadata.subject || "Unknown"}\n` +
                `👥 সদস্য: ${metadata.participants.length} জন\n` +
                `👑 মোট Admin: ${admins.length} জন\n\n` +
                `🤖 Bot Status: ${status.enabled ? "🟢 ON" : "🔴 OFF"}\n` +
                `${autoStatus}\n\n` +
                `👑 *GROUP ADMINS*\n` +
                `${adminLines.join("\n") || "কোনো Admin পাওয়া যায়নি"}\n\n` +
                `🤍 ${BOT_NAME}`
        },
        {
            mentions: admins.map(
                getParticipantId
            )
        }
    );
}

/* =========================================================
   MENU
========================================================= */

async function sendMenu(groupId) {
    const status =
        getGroupStatus(groupId);

    const text =
        `━━━━━━━━━━━━━━━━━━\n` +
        `🤖 *${BOT_NAME} MENU*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +

        `📋 *GENERAL COMMANDS*\n\n` +
        `• /menu\n` +
        `• /bot\n` +
        `• /rules\n` +
        `• /admin\n` +
        `• /members\n` +
        `• /groupinfo\n` +
        `• /id\n` +
        `• /ping\n` +
        `• /deal\n` +
        `• /piyas\n` +
        `• /website\n\n` +

        `👑 *ADMIN COMMANDS*\n\n` +
        `• /adminpanel\n` +
        `• /cmdlist\n` +
        `• /boton\n` +
        `• /botoff\n` +
        `• /modstatus\n` +
        `• /modon\n` +
        `• /modoff\n\n` +

        `🔒 *GROUP LOCK*\n\n` +
        `• /গ্রুপ বন্ধ 2 মিনিট\n` +
        `• /গ্রুপ বন্ধ 1 ঘণ্টা\n` +
        `• /গ্রুপ বন্ধ 1 দিন\n` +
        `• /গ্রুপ বন্ধ 1 সপ্তাহ\n` +
        `• /গ্রুপ বন্ধ 1 মাস\n` +
        `• /গ্রুপ বন্ধ 1 বছর\n\n` +

        `⏱️ সময় একাধিক Unit-এও দেওয়া যাবে:\n` +
        `• /গ্রুপ বন্ধ 1 দিন 5 ঘণ্টা 20 মিনিট\n\n` +

        `♾️ ৩০ দিনের কোনো সীমা নেই।\n` +
        `যতক্ষণ প্রয়োজন ততক্ষণ সময় দেওয়া যাবে।\n\n` +

        `━━━━━━━━━━━━━━━━━━\n` +
        `🤖 Status: ${status.enabled ? "🟢 ON" : "🔴 OFF"}\n` +
        `🤍 ${BOT_NAME}\n` +
        `━━━━━━━━━━━━━━━━━━`;

    await sendSafeMessage(
        groupId,
        {
            text
        }
    );
}

/* =========================================================
   BOT INFO
========================================================= */

async function sendBotInfo(groupId) {
    await sendSafeMessage(
        groupId,
        {
            text:
                `🤖 *${BOT_NAME}*\n\n` +
                `⚡ WhatsApp Group Management Bot\n\n` +
                `🛡️ Moderation\n` +
                `🔗 Link Protection\n` +
                `⚠️ Warning System\n` +
                `👑 Admin Control\n` +
                `🔒 Group Lock / Auto Unlock\n` +
                `📊 Group Information\n` +
                `📋 Command Menu\n\n` +
                `🌐 Website:\n${WEBSITE_URL}\n\n` +
                `🤍 Powered by ${BOT_NAME}`
        }
    );
}

/* =========================================================
   RULES
========================================================= */

async function sendRules(groupId) {
    await sendSafeMessage(
        groupId,
        {
            text:
                `📜 *GROUP RULES*\n\n` +
                `1️⃣ সবাইকে সম্মান করুন।\n` +
                `2️⃣ অশালীন ভাষা ব্যবহার করবেন না।\n` +
                `3️⃣ অনুমোদনহীন Link পাঠাবেন না।\n` +
                `4️⃣ Spam করবেন না।\n` +
                `5️⃣ একই Message বারবার পাঠাবেন না।\n` +
                `6️⃣ Admin-এর নির্দেশনা মেনে চলুন।\n` +
                `7️⃣ Group-এর পরিবেশ সুন্দর রাখুন।\n\n` +
                `🤍 ${BOT_NAME}`
        }
    );
}

/* =========================================================
   ADMIN LIST
========================================================= */

async function sendAdminList(groupId) {
    const admins =
        await getGroupAdmins(
            groupId
        );

    const lines =
        admins.map(
            (admin, index) => {
                const id =
                    getParticipantId(
                        admin
                    );

                return `${index + 1}. 👑 @${String(id).split("@")[0]}`;
            }
        );

    await sendSafeMessage(
        groupId,
        {
            text:
                `👑 *GROUP ADMINS*\n\n` +
                lines.join("\n")
        },
        {
            mentions: admins.map(
                getParticipantId
            )
        }
    );
}

/* =========================================================
   MEMBERS
========================================================= */

async function sendMembers(groupId) {
    const metadata =
        await getGroupMetadata(
            groupId
        );

    if (!metadata) {
        return;
    }

    const lines =
        metadata.participants
            .slice(0, 150)
            .map(
                (member, index) => {
                    const id =
                        getParticipantId(
                            member
                        );

                    const role =
                        isAdminParticipant(
                            member
                        )
                            ? " 👑"
                            : "";

                    return `${index + 1}. @${String(id).split("@")[0]}${role}`;
                }
            );

    await sendSafeMessage(
        groupId,
        {
            text:
                `👥 *GROUP MEMBERS*\n\n` +
                `মোট সদস্য: ${metadata.participants.length}\n\n` +
                lines.join("\n")
        },
        {
            mentions:
                metadata.participants
                    .slice(0, 150)
                    .map(
                        getParticipantId
                    )
        }
    );
}

/* =========================================================
   ADMIN PANEL
========================================================= */

async function sendAdminPanel(groupId) {
    const status =
        getGroupStatus(groupId);

    const moderation =
        status.moderation;

    await sendSafeMessage(
        groupId,
        {
            text:
                `━━━━━━━━━━━━━━━━━━\n` +
                `👑 *ADMIN PANEL*\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +

                `🤖 Bot: ${status.enabled ? "🟢 ON" : "🔴 OFF"}\n\n` +

                `🛡️ *MODERATION*\n` +
                `Bad Words: ${moderation.badWords ? "🟢 ON" : "🔴 OFF"}\n` +
                `Links: ${moderation.links ? "🟢 ON" : "🔴 OFF"}\n` +
                `Spam: ${moderation.spam ? "🟢 ON" : "🔴 OFF"}\n` +
                `Warnings: ${moderation.warnings ? "🟢 ON" : "🔴 OFF"}\n\n` +

                `🔒 *GROUP LOCK*\n` +
                `/গ্রুপ বন্ধ 2 মিনিট\n` +
                `/গ্রুপ বন্ধ 1 ঘণ্টা\n` +
                `/গ্রুপ বন্ধ 1 দিন\n` +
                `/গ্রুপ বন্ধ 1 বছর\n\n` +

                `🟢 খুলতে:\n` +
                `/boton\n\n` +

                `🔴 Permanent Bot OFF:\n` +
                `/botoff\n\n` +

                `━━━━━━━━━━━━━━━━━━\n` +
                `🤍 ${BOT_NAME}`
        }
    );
}

/* =========================================================
   COMMAND LIST
========================================================= */

async function sendCommandList(groupId) {
    await sendSafeMessage(
        groupId,
        {
            text:
                `📋 *COMMAND LIST*\n\n` +
                `🌐 Public:\n` +
                `/menu\n` +
                `/bot\n` +
                `/rules\n` +
                `/admin\n` +
                `/members\n` +
                `/groupinfo\n` +
                `/id\n` +
                `/ping\n` +
                `/deal\n` +
                `/ডিল\n` +
                `/piyas\n` +
                `/website\n\n` +

                `👑 Admin:\n` +
                `/adminpanel\n` +
                `/cmdlist\n` +
                `/boton\n` +
                `/botoff\n` +
                `/modstatus\n` +
                `/modon\n` +
                `/modoff\n` +
                `/গ্রুপ বন্ধ <সময়>\n\n` +

                `⏱️ Example:\n` +
                `/গ্রুপ বন্ধ 30 মিনিট\n` +
                `/গ্রুপ বন্ধ 2 ঘণ্টা\n` +
                `/গ্রুপ বন্ধ 1 দিন\n` +
                `/গ্রুপ বন্ধ 1 সপ্তাহ\n` +
                `/গ্রুপ বন্ধ 1 মাস\n` +
                `/গ্রুপ বন্ধ 1 বছর\n` +
                `/গ্রুপ বন্ধ 1 দিন 5 ঘণ্টা 20 মিনিট`
        }
    );
}

/* =========================================================
   MODERATION STATUS
========================================================= */

async function sendModerationStatus(
    groupId
) {
    const moderation =
        getGroupStatus(
            groupId
        ).moderation;

    await sendSafeMessage(
        groupId,
        {
            text:
                `🛡️ *MODERATION STATUS*\n\n` +
                `🚫 Bad Words: ${moderation.badWords ? "🟢 ON" : "🔴 OFF"}\n` +
                `🔗 Link Protection: ${moderation.links ? "🟢 ON" : "🔴 OFF"}\n` +
                `⚠️ Spam Protection: ${moderation.spam ? "🟢 ON" : "🔴 OFF"}\n` +
                `📢 Warnings: ${moderation.warnings ? "🟢 ON" : "🔴 OFF"}`
        }
    );
}

/* =========================================================
   DEAL
========================================================= */

async function sendDeal(groupId) {
    await sendSafeMessage(
        groupId,
        {
            text:
                `🔥 *DEAL / OFFER*\n\n` +
                `📢 নতুন Deal বা Offer জানতে Admin-এর সাথে যোগাযোগ করুন।\n\n` +
                `🤍 ${BOT_NAME}`
        }
    );
}

/* =========================================================
   PIYAS
========================================================= */

async function sendPiyas(groupId) {
    await sendSafeMessage(
        groupId,
        {
            text:
                `💙 *PIYAS*\n\n` +
                `🤖 ${BOT_NAME}\n` +
                `🌐 ${WEBSITE_URL}\n\n` +
                `🤍 Thank you`
        }
    );
}

/* =========================================================
   WEBSITE
========================================================= */

async function sendWebsite(groupId) {
    await sendSafeMessage(
        groupId,
        {
            text:
                `🌐 *WEBSITE*\n\n` +
                `${WEBSITE_URL}\n\n` +
                `🔗 Website visit করতে উপরের Link ব্যবহার করুন।`
        }
    );
}

/* =========================================================
   PING
========================================================= */

async function sendPing(
    groupId,
    startedAt
) {
    const ms =
        Date.now() - startedAt;

    await sendSafeMessage(
        groupId,
        {
            text:
                `🏓 *PONG!*\n\n` +
                `⚡ Response: ${ms}ms\n` +
                `🤖 ${BOT_NAME}`
        }
    );
}

/* =========================================================
   ID
========================================================= */

async function sendId(
    groupId,
    senderId
) {
    await sendSafeMessage(
        groupId,
        {
            text:
                `🆔 *YOUR ID*\n\n` +
                `${senderId}`
        }
    );
}

/* =========================================================
   GROUP LOCK
========================================================= */

async function lockGroup(
    groupId,
    minutes,
    senderId
) {
    /*
       First make sure the bot is Admin.
    */

    const botAdmin =
        await isBotGroupAdmin(
            groupId
        );

    if (!botAdmin) {
        await sendSafeMessage(
            groupId,
            {
                text:
                    `❌ *BOT ADMIN REQUIRED*\n\n` +
                    `এই Group-এর Message বন্ধ করতে হলে আমাকে Group Admin করতে হবে।`
            }
        );

        return;
    }

    /*
       Actually close the WhatsApp group
       for normal members.
    */

    try {
        await sock.groupSettingUpdate(
            groupId,
            "announcement"
        );
    } catch (error) {
        console.error(
            "Group lock error:",
            error
        );

        await sendSafeMessage(
            groupId,
            {
                text:
                    `❌ Group বন্ধ করা যায়নি।\n\n` +
                    `নিশ্চিত করুন Bot Group Admin আছে।`
            }
        );

        return;
    }

    /*
       Save timer.
       Reusing the command replaces
       the previous timer.
    */

    const saved =
        setGroupAutoOn(
            groupId,
            minutes
        );

    if (!saved) {
        /*
           Try to restore group if timer
           could not be stored.
        */

        try {
            await sock.groupSettingUpdate(
                groupId,
                "not_announcement"
            );
        } catch {}

        await sendSafeMessage(
            groupId,
            {
                text:
                    `❌ সময়টি ব্যবহার করা যাচ্ছে না।`
            }
        );

        return;
    }

    const durationText =
        formatGroupDuration(
            minutes
        );

    await sendSafeMessage(
        groupId,
        {
            text:
                `━━━━━━━━━━━━━━━━━━\n` +
                `🔴 *GROUP OFF*\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +

                `🤖 এই Group-এর সদস্যদের জন্য\n` +
                `Message পাঠানো বন্ধ করা হয়েছে।\n\n` +

                `⏰ *সময়:* ${durationText}\n\n` +

                `🟢 নির্ধারিত সময় শেষ হলে\n` +
                `Bot নিজে থেকেই Group আবার ON করবে। ✅\n\n` +

                `📌 নতুন সময় দিতে চাইলে:\n` +
                `/গ্রুপ বন্ধ <সময়>\n\n` +

                `📌 উদাহরণ:\n` +
                `/গ্রুপ বন্ধ 30 মিনিট\n` +
                `/গ্রুপ বন্ধ 1 ঘণ্টা\n` +
                `/গ্রুপ বন্ধ 1 দিন\n` +
                `/গ্রুপ বন্ধ 1 বছর\n\n` +

                `👑 Admin / Owner\n` +
                `🤍 ${BOT_NAME}`
        }
    );
}

/* =========================================================
   UNLOCK GROUP
========================================================= */

async function unlockGroup(
    groupId
) {
    const botAdmin =
        await isBotGroupAdmin(
            groupId
        );

    if (!botAdmin) {
        await sendSafeMessage(
            groupId,
            {
                text:
                    `❌ Bot-কে Group Admin করতে হবে।`
            }
        );

        return;
    }

    try {
        await sock.groupSettingUpdate(
            groupId,
            "not_announcement"
        );

        const status =
            getGroupStatus(
                groupId
            );

        status.enabled = true;
        status.autoOnAt = null;

        saveBotStatus();

        await sendSafeMessage(
            groupId,
            {
                text:
                    `🟢 *GROUP ON*\n\n` +
                    `এখন Group-এর সকল সদস্য আবার Message পাঠাতে পারবেন। ✅\n\n` +
                    `🤖 ${BOT_NAME}`
            }
        );
    } catch (error) {
        console.error(
            "Group unlock error:",
            error
        );

        await sendSafeMessage(
            groupId,
            {
                text:
                    `❌ Group ON করা যায়নি।\n\n` +
                    `Bot Admin আছে কিনা চেক করুন।`
            }
        );
    }
}

/* =========================================================
   CONNECTION
========================================================= */

async function startBot() {
    if (reconnecting) {
        return;
    }

    reconnecting = true;

    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(
                AUTH_DIR,
                {
                    recursive: true
                }
            );
        }

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(
            AUTH_DIR
        );

        const {
            version
        } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: P({
                level: "silent"
            }),
            printQRInTerminal: false,
            browser: Browsers.ubuntu(
                "Chrome"
            ),
            markOnlineOnConnect: false,
            syncFullHistory: false
        });

        sock.ev.on(
            "creds.update",
            saveCreds
        );

        sock.ev.on(
            "connection.update",
            async update => {
                const {
                    connection,
                    lastDisconnect
                } = update;

                if (connection === "open") {
                    reconnecting = false;

                    console.log(
                        `\n🤖 ${BOT_NAME} connected successfully.\n`
                    );

                    /*
                       Recover expired timers after reconnect.
                    */

                    await autoEnableExpiredGroups();

                    /*
                       If a group is still within its timer,
                       keep it locked.
                    */

                    for (
                        const groupId of Object.keys(
                            botStatus
                        )
                    ) {
                        const status =
                            botStatus[groupId];

                        if (
                            status?.autoOnAt &&
                            status.autoOnAt >
                                Date.now()
                        ) {
                            try {
                                await sock.groupSettingUpdate(
                                    groupId,
                                    "announcement"
                                );
                            } catch {}
                        }
                    }
                }

                if (
                    connection ===
                    "close"
                ) {
                    reconnecting = false;

                    const statusCode =
                        new Boom(
                            lastDisconnect?.error
                        )?.output
                            ?.statusCode;

                    const shouldReconnect =
                        statusCode !==
                        DisconnectReason.loggedOut;

                    console.log(
                        "Connection closed:",
                        statusCode
                    );

                    if (shouldReconnect) {
                        setTimeout(
                            () => {
                                startBot();
                            },
                            5000
                        );
                    } else {
                        console.log(
                            "Logged out. Delete auth_info and pair again."
                        );
                    }
                }
            }
        );

        /*
           Pairing code.
        */

        if (
            !state.creds.registered &&
            PHONE_NUMBER
        ) {
            try {
                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            3000
                        )
                );

                const pairingCode =
                    await sock.requestPairingCode(
                        PHONE_NUMBER
                    );

                console.log(
                    "\n================================"
                );

                console.log(
                    "PAIRING CODE:",
                    pairingCode
                );

                console.log(
                    "================================\n"
                );

                try {
                    fs.writeFileSync(
                        PAIRING_FILE,
                        String(
                            pairingCode
                        )
                    );
                } catch {}
            } catch (error) {
                console.error(
                    "Pairing code error:",
                    error
                );
            }
        }

        /*
           Group participants update.
        */

        sock.ev.on(
            "group-participants.update",
            async update => {
                try {
                    const {
                        id,
                        participants,
                        action
                    } = update;

                    if (
                        action ===
                        "add"
                    ) {
                        for (
                            const participant
                            of participants
                        ) {
                            await sendWelcome(
                                id,
                                participant
                            );
                        }
                    }
                } catch (error) {
                    console.error(
                        "Participant update error:",
                        error
                    );
                }
            }
        );

        /*
           Incoming messages.
        */

        sock.ev.on(
            "messages.upsert",
            async ({ messages }) => {
                try {
                    for (
                        const message
                        of messages
                    ) {
                        await handleMessage(
                            message
                        );
                    }
                } catch (error) {
                    console.error(
                        "Message handler error:",
                        error
                    );
                }
            }
        );

    } catch (error) {
        reconnecting = false;

        console.error(
            "Start bot error:",
            error
        );

        setTimeout(
            () => {
                startBot();
            },
            5000
        );
    }
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

async function handleMessage(
    message
) {
    if (!message) {
        return;
    }

    if (message.key?.fromMe) {
        return;
    }

    const remoteJid =
        message.key?.remoteJid;

    if (!remoteJid) {
        return;
    }

    /*
       Only groups.
    */

    if (
        !remoteJid.endsWith(
            "@g.us"
        )
    ) {
        return;
    }

    const groupId =
        remoteJid;

    const senderId =
        getSenderId(message);

    const text =
        getMessageText(message);

    if (!text) {
        return;
    }

    const {
        command,
        args,
        rawArgs
    } = parseCommand(text);

    /*
       Determine admin before status check.
    */

    const senderAdmin =
        await isGroupAdmin(
            groupId,
            senderId
        );

    /*
       Moderation runs for normal messages.
       Commands are handled separately.
    */

    if (!command) {
        const status =
            getGroupStatus(
                groupId
            );

        /*
           When bot is disabled because of
           timed group lock, normal member
           messages are impossible anyway.
        */

        if (
            !status.enabled &&
            status.autoOnAt
        ) {
            return;
        }

        await moderateMessage(
            message,
            groupId,
            senderId,
            text
        );

        return;
    }

    /*
       Admin-only command protection.
    */

    if (
        ADMIN_ONLY_COMMANDS.has(
            command
        ) &&
        !senderAdmin
    ) {
        await sendSafeMessage(
            groupId,
            {
                text:
                    `❌ *ADMIN ONLY*\n\n` +
                    `এই Command শুধুমাত্র Group Admin / Owner ব্যবহার করতে পারবেন।`
            }
        );

        return;
    }

    /*
       Disabled command protection.
    */

    const groupStatus =
        getGroupStatus(
            groupId
        );

    if (
        groupStatus.disabledCommands.includes(
            command
        ) &&
        !senderAdmin
    ) {
        return;
    }

    /* =====================================================
       GENERAL COMMANDS
    ===================================================== */

    if (command === "menu") {
        await sendMenu(
            groupId
        );
        return;
    }

    if (command === "bot") {
        await sendBotInfo(
            groupId
        );
        return;
    }

    if (command === "rules") {
        await sendRules(
            groupId
        );
        return;
    }

    if (command === "admin") {
        await sendAdminList(
            groupId
        );
        return;
    }

    if (command === "members") {
        await sendMembers(
            groupId
        );
        return;
    }

    if (
        command === "groupinfo"
    ) {
        await sendGroupInfo(
            groupId
        );
        return;
    }

    if (command === "id") {
        await sendId(
            groupId,
            senderId
        );
        return;
    }

    if (command === "ping") {
        await sendPing(
            groupId,
            Date.now()
        );
        return;
    }

    if (command === "deal") {
        await sendDeal(
            groupId
        );
        return;
    }

    if (command === "ডিল") {
        await sendDeal(
            groupId
        );
        return;
    }

    if (command === "piyas") {
        await sendPiyas(
            groupId
        );
        return;
    }

    if (command === "website") {
        await sendWebsite(
            groupId
        );
        return;
    }

    /* =====================================================
       ADMIN PANEL
    ===================================================== */

    if (
        command ===
        "adminpanel"
    ) {
        await sendAdminPanel(
            groupId
        );
        return;
    }

    if (
        command ===
        "cmdlist"
    ) {
        await sendCommandList(
            groupId
        );
        return;
    }

    /* =====================================================
       BOT ON
    ===================================================== */

    if (
        command === "boton" ||
        command === "on"
    ) {
        await unlockGroup(
            groupId
        );

        return;
    }

    /* =====================================================
       BOT OFF
    ===================================================== */

    if (
        command === "botoff" ||
        command === "off"
    ) {
        /*
           Permanent Bot OFF.
           Any previous timed auto-on is cancelled.
        */

        setBotStatus(
            groupId,
            false
        );

        await sendSafeMessage(
            groupId,
            {
                text:
                    `🔴 *BOT OFF*\n\n` +
                    `🤖 ${BOT_NAME} এই Group-এ এখন OFF করা হয়েছে।\n\n` +
                    `🟢 আবার চালু করতে:\n` +
                    `/boton\n\n` +
                    `👑 Admin / Owner`
            }
        );

        return;
    }

    /* =====================================================
       MODERATION STATUS
    ===================================================== */

    if (
        command ===
            "modstatus" ||
        command ===
            "moderation"
    ) {
        await sendModerationStatus(
            groupId
        );

        return;
    }

    /* =====================================================
       MOD ON
    ===================================================== */

    if (
        command === "modon"
    ) {
        groupStatus.moderation =
            {
                badWords: true,
                links: true,
                spam: true,
                warnings: true
            };

        saveBotStatus();

        await sendSafeMessage(
            groupId,
            {
                text:
                    `🛡️ *MODERATION ON*\n\n` +
                    `সব Moderation Protection ON করা হয়েছে।`
            }
        );

        return;
    }

    /* =====================================================
       MOD OFF
    ===================================================== */

    if (
        command === "modoff"
    ) {
        groupStatus.moderation =
            {
                badWords: false,
                links: false,
                spam: false,
                warnings: false
            };

        saveBotStatus();

        await sendSafeMessage(
            groupId,
            {
                text:
                    `🔴 *MODERATION OFF*\n\n` +
                    `সব Moderation Protection OFF করা হয়েছে।`
            }
        );

        return;
    }

    /* =====================================================
       GROUP LOCK COMMAND
    ===================================================== */

    if (
        command === "গ্রুপ"
    ) {
        /*
           Expected:
           /গ্রুপ বন্ধ 2 মিনিট

           args:
           ["বন্ধ", "2", "মিনিট"]
        */

        if (
            args.length < 2 ||
            String(args[0])
                .toLowerCase() !==
                "বন্ধ"
        ) {
            await sendSafeMessage(
                groupId,
                {
                    text:
                        `📌 *ব্যবহারের নিয়ম*\n\n` +
                        `/গ্রুপ বন্ধ <সময়>\n\n` +

                        `উদাহরণ:\n` +
                        `/গ্রুপ বন্ধ 2 মিনিট\n` +
                        `/গ্রুপ বন্ধ 30 মিনিট\n` +
                        `/গ্রুপ বন্ধ 2 ঘণ্টা\n` +
                        `/গ্রুপ বন্ধ 1 দিন\n` +
                        `/গ্রুপ বন্ধ 1 সপ্তাহ\n` +
                        `/গ্রুপ বন্ধ 1 মাস\n` +
                        `/গ্রুপ বন্ধ 1 বছর\n\n` +

                        `একাধিক সময়ও দেওয়া যাবে:\n` +
                        `/গ্রুপ বন্ধ 1 দিন 5 ঘণ্টা 20 মিনিট\n\n` +

                        `♾️ ৩০ দিনের কোনো সীমা নেই।`
                }
            );

            return;
        }

        const durationText =
            args
                .slice(1)
                .join(" ");

        const minutes =
            parseGroupOffDuration(
                durationText
            );

        if (
            !minutes ||
            minutes <= 0
        ) {
            await sendSafeMessage(
                groupId,
                {
                    text:
                        `❌ *ভুল সময়*\n\n` +
                        `সঠিক উদাহরণ:\n` +
                        `/গ্রুপ বন্ধ 2 মিনিট\n` +
                        `/গ্রুপ বন্ধ 2 ঘণ্টা\n` +
                        `/গ্রুপ বন্ধ 1 দিন\n` +
                        `/গ্রুপ বন্ধ 1 বছর\n\n` +
                        `অথবা:\n` +
                        `/গ্রুপ বন্ধ 1 দিন 5 ঘণ্টা 20 মিনিট`
                }
            );

            return;
        }

        await lockGroup(
            groupId,
            minutes,
            senderId
        );

        return;
    }
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server =
    http.createServer(
        (req, res) => {
            res.writeHead(
                200,
                {
                    "Content-Type":
                        "text/html; charset=utf-8"
                }
            );

            res.end(
                `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BOT_NAME}</title>
<style>
body{
    margin:0;
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    background:#050505;
    color:#fff;
    font-family:Arial,sans-serif;
}
.box{
    width:90%;
    max-width:600px;
    padding:30px;
    border:1px solid #444;
    border-radius:20px;
    text-align:center;
    background:#111;
}
h1{
    margin-bottom:10px;
}
p{
    color:#aaa;
}
.status{
    display:inline-block;
    margin-top:15px;
    padding:10px 20px;
    border-radius:30px;
    background:#164d2e;
    color:#6cff9a;
}
</style>
</head>
<body>
<div class="box">
<h1>🤖 ${BOT_NAME}</h1>
<p>WhatsApp Group Management Bot</p>
<div class="status">🟢 Server Online</div>
</div>
</body>
</html>
                `
            );
        }
    );

server.listen(
    PORT,
    () => {
        console.log(
            `HTTP server running on port ${PORT}`
        );
    }
);

/* =========================================================
   LOAD DATA
========================================================= */

loadBotStatus();
loadWarnings();

/* =========================================================
   START
========================================================= */

startBot();

/* =========================================================
   PROCESS ERROR HANDLING
========================================================= */

process.on(
    "uncaughtException",
    error => {
        console.error(
            "Uncaught Exception:",
            error
        );
    }
);

process.on(
    "unhandledRejection",
    error => {
        console.error(
            "Unhandled Rejection:",
            error
        );
    }
);