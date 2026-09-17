import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import P from "pino";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import http from "http";

dotenv.config();

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const PHONE_NUMBER = String(
    process.env.PHONE_NUMBER || ""
).trim();

const WEBSITE_URL =
    process.env.WEBSITE_URL ||
    "https://x-cyber-2025.github.io/X-cyber.web/";

const OPENAI_API_KEY =
    process.env.OPENAI_API_KEY || "";

const ALLOWED_GROUPS = (
    process.env.ALLOWED_GROUPS || ""
)
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

const AUTH_DIR = "./auth_info";
const DATA_DIR = "./data";

const PAIRING_FILE = "./pairing_number.txt";

const BOT_NAME = "PIYAS BOT";

/* =========================================================
   DIRECTORIES
========================================================= */

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* =========================================================
   DATA FILES
========================================================= */

const FILES = {
    blacklist: path.join(DATA_DIR, "blacklist.json"),
    botStatus: path.join(DATA_DIR, "bot_status.json"),
    reports: path.join(DATA_DIR, "reports.json"),
    warnings: path.join(DATA_DIR, "warnings.json"),
    settings: path.join(DATA_DIR, "settings.json")
};

function ensureJsonFile(file, defaultValue) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(
            file,
            JSON.stringify(defaultValue, null, 2)
        );
    }
}

ensureJsonFile(FILES.blacklist, {});
ensureJsonFile(FILES.botStatus, {});
ensureJsonFile(FILES.reports, []);
ensureJsonFile(FILES.warnings, {});
ensureJsonFile(FILES.settings, {});

/* =========================================================
   JSON HELPERS
========================================================= */

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            return fallback;
        }

        const data = fs.readFileSync(file, "utf8");

        if (!data.trim()) {
            return fallback;
        }

        return JSON.parse(data);
    } catch {
        return fallback;
    }
}

function writeJson(file, data) {
    try {
        fs.writeFileSync(
            file,
            JSON.stringify(data, null, 2)
        );
    } catch (error) {
        console.log(
            "JSON WRITE ERROR:",
            error?.message || error
        );
    }
}

/* =========================================================
   DATA
========================================================= */

let blacklist = readJson(
    FILES.blacklist,
    {}
);

let botStatus = readJson(
    FILES.botStatus,
    {}
);

let reports = readJson(
    FILES.reports,
    []
);

let warnings = readJson(
    FILES.warnings,
    {}
);

let settings = readJson(
    FILES.settings,
    {}
);

/* =========================================================
   BAD WORD FILTER
========================================================= */

const BAD_WORDS = [
    "সালা",
    "শালা",
    "সালি",
    "সালী",
    "শালি",
    "ষালি",
    "ষালী",
    "খাংকি",
    "খাংকী",
    "খানকি",
    "খানকী",
    "মাগি",
    "মাগী",
    "বেসসা",
    "বেশ্যা",

    "fuck",
    "fucking",
    "fucker",
    "motherfucker",
    "bitch",
    "bastard",
    "asshole",
    "dick",
    "dickhead",
    "pussy",
    "cunt",
    "slut",
    "whore",
    "shit",
    "bullshit",
    "idiot",
    "stupid",
    "nigger",
    "nigga"
];

/* =========================================================
   LINK FILTER
========================================================= */

const LINK_REGEX =
    /(https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/|telegram\.me\/|bit\.ly\/|tinyurl\.com\/)/i;

/* =========================================================
   SPAM CACHE
========================================================= */

const messageCache = new Map();

const duplicateMessages = new Map();

const warnedUsers = new Map();

/* =========================================================
   PHONE NUMBER
========================================================= */

function normalizePhone(number) {
    return String(number || "")
        .replace(/[^\d]/g, "")
        .replace(/^00/, "");
}

function getPhoneNumber() {
    const phone = normalizePhone(PHONE_NUMBER);

    if (!phone) {
        return "";
    }

    return phone;
}

/* =========================================================
   VALIDATE PHONE
========================================================= */

function isValidPhone(phone) {
    return /^\d{8,15}$/.test(phone);
}

/* =========================================================
   GROUP CHECK
========================================================= */

function isGroup(jid) {
    return String(jid || "").endsWith("@g.us");
}

function isAllowedGroup(jid) {
    if (!ALLOWED_GROUPS.length) {
        return true;
    }

    return ALLOWED_GROUPS.includes(jid);
}

/* =========================================================
   BOT STATUS
========================================================= */

function isBotEnabled(groupId) {
    if (!isGroup(groupId)) {
        return true;
    }

    if (
        Object.prototype.hasOwnProperty.call(
            botStatus,
            groupId
        )
    ) {
        return botStatus[groupId] !== false;
    }

    return true;
}

function setBotStatus(groupId, enabled) {
    botStatus[groupId] = enabled;
    writeJson(FILES.botStatus, botStatus);
}

/* =========================================================
   BLACKLIST
========================================================= */

function isBlacklisted(jid) {
    return Boolean(blacklist[jid]);
}

function addBlacklist(jid, reason = "No reason") {
    blacklist[jid] = {
        reason,
        createdAt: new Date().toISOString()
    };

    writeJson(
        FILES.blacklist,
        blacklist
    );
}

function removeBlacklist(jid) {
    delete blacklist[jid];

    writeJson(
        FILES.blacklist,
        blacklist
    );
}

/* =========================================================
   TEXT NORMALIZATION
========================================================= */

function normalizeText(text) {
    return String(text || "")
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/* =========================================================
   BAD WORD DETECTION
========================================================= */

function containsBadWord(text) {
    const normalized = normalizeText(text);

    if (!normalized) {
        return null;
    }

    for (const word of BAD_WORDS) {
        const target = normalizeText(word);

        if (!target) {
            continue;
        }

        if (normalized.includes(target)) {
            return word;
        }
    }

    return null;
}

/* =========================================================
   LINK DETECTION
========================================================= */

function containsLink(text) {
    return LINK_REGEX.test(
        String(text || "")
    );
}

/* =========================================================
   MESSAGE EXTRACTION
========================================================= */

function getMessageText(message) {
    if (!message) {
        return "";
    }

    if (
        typeof message.conversation === "string"
    ) {
        return message.conversation;
    }

    if (
        message.extendedTextMessage &&
        typeof message.extendedTextMessage.text === "string"
    ) {
        return message.extendedTextMessage.text;
    }

    if (
        message.imageMessage &&
        typeof message.imageMessage.caption === "string"
    ) {
        return message.imageMessage.caption;
    }

    if (
        message.videoMessage &&
        typeof message.videoMessage.caption === "string"
    ) {
        return message.videoMessage.caption;
    }

    if (
        message.documentMessage &&
        typeof message.documentMessage.caption === "string"
    ) {
        return message.documentMessage.caption;
    }

    return "";
}

/* =========================================================
   SENDER
========================================================= */

function getSender(message, remoteJid) {
    if (!message) {
        return remoteJid;
    }

    return (
        message.key?.participant ||
        message.key?.remoteJid ||
        remoteJid
    );
}

/* =========================================================
   ADMIN CHECK
========================================================= */

async function isAdmin(sock, groupId, userId) {
    try {
        if (!isGroup(groupId)) {
            return false;
        }

        const metadata =
            await sock.groupMetadata(groupId);

        const participant =
            metadata.participants.find(
                p => p.id === userId
            );

        if (!participant) {
            return false;
        }

        return (
            participant.admin === "admin" ||
            participant.admin === "superadmin"
        );
    } catch {
        return false;
    }
}

/* =========================================================
   GROUP METADATA
========================================================= */

async function getGroupMetadata(sock, groupId) {
    try {
        return await sock.groupMetadata(groupId);
    } catch {
        return null;
    }
}

/* =========================================================
   GROUP NAME
========================================================= */

async function getGroupName(sock, groupId) {
    try {
        const metadata =
            await getGroupMetadata(
                sock,
                groupId
            );

        return (
            metadata?.subject ||
            "WhatsApp Group"
        );
    } catch {
        return "WhatsApp Group";
    }
}

/* =========================================================
   MENTION
========================================================= */

function mentionUser(jid) {
    return `@${String(jid)
        .split("@")[0]
        .replace(/[^0-9]/g, "")}`;
}

/* =========================================================
   WARN USER
========================================================= */

function getWarningKey(groupId, userId) {
    return `${groupId}:${userId}`;
}

function addWarning(groupId, userId) {
    const key = getWarningKey(
        groupId,
        userId
    );

    warnings[key] =
        Number(warnings[key] || 0) + 1;

    writeJson(
        FILES.warnings,
        warnings
    );

    return warnings[key];
}

function clearWarning(groupId, userId) {
    const key = getWarningKey(
        groupId,
        userId
    );

    delete warnings[key];

    writeJson(
        FILES.warnings,
        warnings
    );
}

function getWarningCount(groupId, userId) {
    const key = getWarningKey(
        groupId,
        userId
    );

    return Number(
        warnings[key] || 0
    );
}

/* =========================================================
   SEND WARNING
========================================================= */

async function warnUser(
    sock,
    groupId,
    userId,
    reason
) {
    const count =
        addWarning(
            groupId,
            userId
        );

    const text =
`⚠️ *WARNING*

👤 User: ${mentionUser(userId)}
📌 Reason: ${reason}

⚠️ Warning: ${count}/3

Please follow the group rules.`;

    await sock.sendMessage(
        groupId,
        {
            text,
            mentions: [userId]
        }
    );

    return count;
}

/* =========================================================
   REPORT
========================================================= */

function addReport(
    groupId,
    userId,
    reason,
    messageText
) {
    reports.push({
        id: Date.now().toString(),
        groupId,
        userId,
        reason,
        message: messageText || "",
        createdAt:
            new Date().toISOString()
    });

    writeJson(
        FILES.reports,
        reports
    );
}

/* =========================================================
   DUPLICATE SPAM
========================================================= */

function isDuplicateSpam(
    groupId,
    userId,
    text
) {
    const normalized =
        normalizeText(text);

    if (!normalized) {
        return false;
    }

    const key =
        `${groupId}:${userId}`;

    const previous =
        duplicateMessages.get(key);

    const now = Date.now();

    if (
        previous &&
        previous.text === normalized &&
        now - previous.time < 15000
    ) {
        previous.count += 1;
        previous.time = now;

        duplicateMessages.set(
            key,
            previous
        );

        return previous.count >= 3;
    }

    duplicateMessages.set(
        key,
        {
            text: normalized,
            time: now,
            count: 1
        }
    );

    return false;
}

/* =========================================================
   SIMPLE FLOOD SPAM
========================================================= */

function isFloodSpam(
    groupId,
    userId
) {
    const key =
        `${groupId}:${userId}`;

    const now = Date.now();

    let data =
        messageCache.get(key);

    if (!data) {
        data = [];
    }

    data.push(now);

    data = data.filter(
        timestamp =>
            now - timestamp < 10000
    );

    messageCache.set(
        key,
        data
    );

    return data.length >= 8;
}

/* =========================================================
   OPENAI TEXT MODERATION
========================================================= */

async function moderateTextWithAI(text) {
    if (!OPENAI_API_KEY) {
        return {
            flagged: false,
            reason: ""
        };
    }

    if (!text || text.length < 2) {
        return {
            flagged: false,
            reason: ""
        };
    }

    try {
        const response =
            await fetch(
                "https://api.openai.com/v1/moderations",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                        "Authorization":
                            `Bearer ${OPENAI_API_KEY}`
                    },
                    body: JSON.stringify({
                        model:
                            "omni-moderation-latest",
                        input: text
                    })
                }
            );

        if (!response.ok) {
            return {
                flagged: false,
                reason: ""
            };
        }

        const data =
            await response.json();

        const result =
            data?.results?.[0];

        return {
            flagged:
                Boolean(result?.flagged),
            reason:
                result?.flagged
                    ? "AI moderation"
                    : ""
        };
    } catch {
        return {
            flagged: false,
            reason: ""
        };
    }
}

/* =========================================================
   IMAGE MODERATION
========================================================= */

async function moderateImageWithAI(
    buffer
) {
    if (!OPENAI_API_KEY) {
        return {
            flagged: false,
            reason: ""
        };
    }

    try {
        const base64 =
            buffer.toString("base64");

        const response =
            await fetch(
                "https://api.openai.com/v1/responses",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                        "Authorization":
                            `Bearer ${OPENAI_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: "gpt-4.1-mini",
                        input: [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "input_text",
                                        text:
                                            "Analyze this image for sexual content, nudity, extreme violence, or clearly abusive content. Reply only with SAFE or FLAGGED."
                                    },
                                    {
                                        type: "input_image",
                                        image_url:
                                            `data:image/jpeg;base64,${base64}`
                                    }
                                ]
                            }
                        ]
                    })
                }
            );

        if (!response.ok) {
            return {
                flagged: false,
                reason: ""
            };
        }

        const data =
            await response.json();

        const output =
            JSON.stringify(data)
                .toUpperCase();

        if (
            output.includes("FLAGGED")
        ) {
            return {
                flagged: true,
                reason:
                    "AI image moderation"
            };
        }

        return {
            flagged: false,
            reason: ""
        };
    } catch {
        return {
            flagged: false,
            reason: ""
        };
    }
}

/* =========================================================
   MENU
========================================================= */

function getMenuText() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
       🤖 *${BOT_NAME}*
╰━━━━━━━━━━━━━━━━━━━━╯

📋 *BOT MENU*

/menu
➜ Show bot menu

/bot
➜ Bot status

/rules
➜ Group rules

/admin
➜ Admin list

/members
➜ Group members

/groupinfo
➜ Group information

/id
➜ Show group ID

/ping
➜ Check bot response

/deal
➜ Current deal

/piyas
➜ PIYAS information

/website
➜ Website

/report
➜ Report a user

/reports
➜ View reports

━━━━━━━━━━━━━━━━━━━━
🛡️ *Moderation*

• Bad word filter
• Link filter
• Spam protection
• Duplicate message detection
• AI text moderation
• AI image moderation
• Warning system

━━━━━━━━━━━━━━━━━━━━
💻 *PIYAS SERVICES*
${WEBSITE_URL}
`;
}

/* =========================================================
   RULES
========================================================= */

function getRulesText() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
        📜 *GROUP RULES*
╰━━━━━━━━━━━━━━━━━━━━╯

1️⃣ সবাইকে সম্মান করুন।

2️⃣ অশ্লীল বা গালাগালি করা যাবে না।

3️⃣ অপ্রয়োজনীয় লিংক শেয়ার করা যাবে না।

4️⃣ Spam করা যাবে না।

5️⃣ Scam বা প্রতারণামূলক পোস্ট নিষিদ্ধ।

6️⃣ অন্যের ব্যক্তিগত তথ্য প্রকাশ করা যাবে না।

7️⃣ Admin-এর নির্দেশনা মেনে চলুন।

8️⃣ সন্দেহজনক লিংকে ক্লিক করবেন না।

⚠️ নিয়ম ভঙ্গ করলে Bot warning,
message delete এবং প্রয়োজন হলে
admin action নিতে পারে।
`;
}

/* =========================================================
   ADMIN LIST
========================================================= */

async function getAdminText(
    sock,
    groupId
) {
    const metadata =
        await getGroupMetadata(
            sock,
            groupId
        );

    if (!metadata) {
        return "❌ Group information পাওয়া যায়নি।";
    }

    const admins =
        metadata.participants.filter(
            p =>
                p.admin === "admin" ||
                p.admin === "superadmin"
        );

    if (!admins.length) {
        return "❌ কোনো admin পাওয়া যায়নি।";
    }

    const mentions =
        admins.map(
            p => p.id
        );

    const lines =
        admins.map(
            (p, index) =>
                `${index + 1}. ${mentionUser(p.id)}`
        );

    return {
        text:
`╭━━━━━━━━━━━━━━━━━━━━╮
        👑 *GROUP ADMINS*
╰━━━━━━━━━━━━━━━━━━━━╯

${lines.join("\n")}`,
        mentions
    };
}

/* =========================================================
   GROUP INFO
========================================================= */

async function getGroupInfoText(
    sock,
    groupId
) {
    const metadata =
        await getGroupMetadata(
            sock,
            groupId
        );

    if (!metadata) {
        return {
            text:
                "❌ Group information পাওয়া যায়নি।",
            mentions: []
        };
    }

    const admins =
        metadata.participants.filter(
            p =>
                p.admin === "admin" ||
                p.admin === "superadmin"
        ).length;

    return {
        text:
`╭━━━━━━━━━━━━━━━━━━━━╮
       ℹ️ *GROUP INFO*
╰━━━━━━━━━━━━━━━━━━━━╯

📌 Name:
${metadata.subject || "Unknown"}

👥 Members:
${metadata.participants.length}

👑 Admins:
${admins}

🆔 Group ID:
${groupId}

🤖 Bot:
${BOT_NAME}`,
        mentions: []
    };
}

/* =========================================================
   MEMBERS
========================================================= */

async function getMembersText(
    sock,
    groupId
) {
    const metadata =
        await getGroupMetadata(
            sock,
            groupId
        );

    if (!metadata) {
        return {
            text:
                "❌ Members পাওয়া যায়নি।",
            mentions: []
        };
    }

    const max = 100;

    const members =
        metadata.participants
            .slice(0, max);

    const lines =
        members.map(
            (p, index) => {
                const role =
                    p.admin
                        ? " 👑"
                        : "";

                return `${index + 1}. ${mentionUser(p.id)}${role}`;
            }
        );

    return {
        text:
`╭━━━━━━━━━━━━━━━━━━━━╮
       👥 *GROUP MEMBERS*
╰━━━━━━━━━━━━━━━━━━━━╯

${lines.join("\n")}

📊 Total:
${metadata.participants.length}`,
        mentions:
            members.map(p => p.id)
    };
}

/* =========================================================
   PING
========================================================= */

function getPingText() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
          🏓 *PONG*
╰━━━━━━━━━━━━━━━━━━━━╯

🤖 Bot: Online
⚡ Status: Working
🛡️ Protection: Active
`;
}

/* =========================================================
   BOT STATUS TEXT
========================================================= */

function getBotStatusText(groupId) {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
       🤖 *BOT STATUS*
╰━━━━━━━━━━━━━━━━━━━━╯

📡 Status:
${isBotEnabled(groupId)
    ? "🟢 ENABLED"
    : "🔴 DISABLED"}

🛡️ Moderation:
${isBotEnabled(groupId)
    ? "🟢 ACTIVE"
    : "🔴 INACTIVE"}
`;
}

/* =========================================================
   COMMAND PARSER
========================================================= */

function parseCommand(text) {
    const trimmed =
        String(text || "")
            .trim();

    if (!trimmed) {
        return {
            command: "",
            args: []
        };
    }

    const first =
        trimmed.split(/\s+/)[0];

    const command =
        first
            .replace(/^[/!]/, "")
            .toLowerCase();

    const args =
        trimmed
            .split(/\s+/)
            .slice(1);

    return {
        command,
        args
    };
}

/* =========================================================
   TARGET USER
========================================================= */

function getTargetUser(message) {
    const context =
        message?.extendedTextMessage
            ?.contextInfo;

    if (
        context?.mentionedJid &&
        context.mentionedJid.length
    ) {
        return context.mentionedJid[0];
    }

    if (
        context?.participant
    ) {
        return context.participant;
    }

    return null;
}

/* =========================================================
   WELCOME MESSAGE
========================================================= */

async function sendWelcome(
    sock,
    groupId,
    userId
) {
    const groupName =
        await getGroupName(
            sock,
            groupId
        );

    const text =
`╭━━━━━━━━━━━━━━━━━━━━╮
        🎉 *স্বাগতম*
╰━━━━━━━━━━━━━━━━━━━━╯

🎉 স্বাগতম ${mentionUser(userId)}! ❤️

🌸 আপনাকে *${groupName}* গ্রুপে স্বাগতম।

📜 গ্রুপের নিয়ম দেখতে:
*/rules*

🤖 Bot Menu:
*/menu*

⚠️ সবাইকে সম্মান করুন এবং
গ্রুপের নিয়ম মেনে চলুন।

━━━━━━━━━━━━━━━━━━━━
🤖 ${BOT_NAME}`;

    await sock.sendMessage(
        groupId,
        {
            text,
            mentions: [userId]
        }
    );
}

/* =========================================================
   CONNECTION
========================================================= */

let sock = null;
let starting = false;
let reconnectTimer = null;
let pairingRequested = false;

/* =========================================================
   START BOT
========================================================= */

async function startBot() {
    if (starting) {
        return;
    }

    starting = true;

    try {
        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                AUTH_DIR
            );

        const {
            version
        } =
            await fetchLatestBaileysVersion();

        console.log(
            "Using Baileys version:",
            version.join(".")
        );

        sock =
            makeWASocket({
                version,

                auth: state,

                logger:
                    P({
                        level: "silent"
                    }),

                printQRInTerminal: false,

                /*
                 * IMPORTANT:
                 * Do not use a custom browser name here.
                 * Pairing code can fail with unsupported
                 * custom browser labels.
                 */
                browser: [
                    "Ubuntu",
                    "Chrome",
                    "122.0.0.0"
                ],

                generateHighQualityLinkPreview:
                    false,

                syncFullHistory:
                    false,

                markOnlineOnConnect:
                    false,

                connectTimeoutMs:
                    60000,

                defaultQueryTimeoutMs:
                    60000
            });

        sock.ev.on(
            "creds.update",
            saveCreds
        );

        /*
         * =====================================================
         * CONNECTION UPDATE
         *
         * Pairing code is requested ONLY after WhatsApp
         * sends the QR event.
         * =====================================================
         */

        sock.ev.on(
            "connection.update",
            async update => {
                const {
                    connection,
                    qr,
                    lastDisconnect
                } = update;

                console.log(
                    "Connection update:",
                    connection || "none"
                );

                /*
                 * =================================================
                 * PAIRING CODE
                 * =================================================
                 */

                if (
                    qr &&
                    !state.creds.registered &&
                    !pairingRequested
                ) {
                    pairingRequested = true;

                    try {
                        const phone =
                            getPhoneNumber();

                        if (!phone) {
                            console.log(
                                "❌ PHONE_NUMBER পাওয়া যায়নি।"
                            );

                            console.log(
                                "⚠️ .env ফাইলে দিন:"
                            );

                            console.log(
                                "PHONE_NUMBER=8801XXXXXXXXX"
                            );

                            pairingRequested =
                                false;

                            return;
                        }

                        if (
                            !isValidPhone(phone)
                        ) {
                            console.log(
                                "❌ PHONE_NUMBER invalid."
                            );

                            console.log(
                                "Example:"
                            );

                            console.log(
                                "PHONE_NUMBER=8801XXXXXXXXX"
                            );

                            pairingRequested =
                                false;

                            return;
                        }

                        console.log("");
                        console.log(
                            "📱 Pairing number:",
                            phone
                        );

                        console.log(
                            "🔐 Requesting WhatsApp pairing code..."
                        );

                        const code =
                            await sock.requestPairingCode(
                                phone
                            );

                        const formattedCode =
                            String(code || "")
                                .match(/.{1,4}/g)
                                ?.join("-") ||
                            String(code || "");

                        console.log("");
                        console.log(
                            "╔════════════════════════════╗"
                        );
                        console.log(
                            "║     🔐 PAIRING CODE        ║"
                        );
                        console.log(
                            "╠════════════════════════════╣"
                        );
                        console.log(
                            `║ ${formattedCode}`
                        );
                        console.log(
                            "╚════════════════════════════╝"
                        );
                        console.log("");

                        fs.writeFileSync(
                            PAIRING_FILE,
                            [
                                `Phone: ${phone}`,
                                `Pairing Code: ${formattedCode}`,
                                `Created: ${new Date().toISOString()}`,
                                ""
                            ].join("\n")
                        );

                        console.log(
                            "💾 Pairing code saved to pairing_number.txt"
                        );

                        console.log(
                            "📲 WhatsApp > Linked Devices > Link a device > Link with phone number"
                        );

                        console.log(
                            "⚠️ Codeটি দ্রুত ব্যবহার করুন।"
                        );
                    } catch (error) {
                        console.log("");
                        console.log(
                            "❌ PAIRING CODE ERROR:"
                        );

                        console.log(
                            error?.message ||
                            error
                        );

                        if (
                            error?.stack
                        ) {
                            console.log(
                                error.stack
                            );
                        }

                        pairingRequested =
                            false;
                    }
                }

                /*
                 * =================================================
                 * CONNECTED
                 * =================================================
                 */

                if (
                    connection === "open"
                ) {
                    starting =
                        false;

                    pairingRequested =
                        false;

                    console.log("");
                    console.log(
                        "╔════════════════════════════╗"
                    );
                    console.log(
                        "║   ✅ WHATSAPP CONNECTED    ║"
                    );
                    console.log(
                        "╚════════════════════════════╝"
                    );
                    console.log("");

                    console.log(
                        `🤖 ${BOT_NAME} is online.`
                    );

                    console.log(
                        `🌐 Website: ${WEBSITE_URL}`
                    );

                    console.log(
                        `👥 Allowed Groups: ${
                            ALLOWED_GROUPS.length
                                ? ALLOWED_GROUPS.join(", ")
                                : "ALL"
                        }`
                    );
                }

                /*
                 * =================================================
                 * DISCONNECTED
                 * =================================================
                 */

                if (
                    connection === "close"
                ) {
                    starting =
                        false;

                    pairingRequested =
                        false;

                    const statusCode =
                        new Boom(
                            lastDisconnect?.error
                        )
                            ?.output
                            ?.statusCode;

                    console.log("");
                    console.log(
                        "❌ WhatsApp disconnected."
                    );

                    console.log(
                        "Disconnect code:",
                        statusCode ||
                            "UNKNOWN"
                    );

                    if (
                        statusCode ===
                        DisconnectReason.loggedOut
                    ) {
                        console.log(
                            "❌ WhatsApp logged out."
                        );

                        console.log(
                            "🧹 Delete auth_info folder and login again."
                        );

                        return;
                    }

                    if (
                        reconnectTimer
                    ) {
                        clearTimeout(
                            reconnectTimer
                        );
                    }

                    reconnectTimer =
                        setTimeout(
                            () => {
                                console.log(
                                    "🔄 Reconnecting..."
                                );

                                startBot();
                            },
                            5000
                        );
                }
            }
        );

        /*
         * =====================================================
         * MESSAGES
         * =====================================================
         */

        sock.ev.on(
            "messages.upsert",
            async ({
                messages,
                type
            }) => {
                if (
                    type !== "notify"
                ) {
                    return;
                }

                for (
                    const message
                    of messages
                ) {
                    try {
                        await handleMessage(
                            sock,
                            message
                        );
                    } catch (
                        error
                    ) {
                        console.log(
                            "MESSAGE ERROR:",
                            error?.message ||
                            error
                        );
                    }
                }
            }
        );

        /*
         * =====================================================
         * PARTICIPANT UPDATE
         * =====================================================
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
                        !isAllowedGroup(id)
                    ) {
                        return;
                    }

                    if (
                        action === "add"
                    ) {
                        for (
                            const userId
                            of participants
                        ) {
                            await sendWelcome(
                                sock,
                                id,
                                userId
                            );
                        }
                    }
                } catch (
                    error
                ) {
                    console.log(
                        "PARTICIPANT ERROR:",
                        error?.message ||
                        error
                    );
                }
            }
        );
    } catch (error) {
        starting = false;

        console.log(
            "START BOT ERROR:",
            error?.message ||
            error
        );

        if (
            reconnectTimer
        ) {
            clearTimeout(
                reconnectTimer
            );
        }

        reconnectTimer =
            setTimeout(
                startBot,
                5000
            );
    }
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

async function handleMessage(
    sock,
    message
) {
    if (!message?.message) {
        return;
    }

    if (
        message.key?.fromMe
    ) {
        return;
    }

    const remoteJid =
        message.key?.remoteJid;

    if (!remoteJid) {
        return;
    }

    const group =
        isGroup(remoteJid);

    if (
        group &&
        !isAllowedGroup(remoteJid)
    ) {
        return;
    }

    if (
        group &&
        !isBotEnabled(remoteJid)
    ) {
        return;
    }

    const sender =
        getSender(
            message,
            remoteJid
        );

    if (
        isBlacklisted(sender)
    ) {
        return;
    }

    const messageContent =
        message.message;

    const text =
        getMessageText(
            messageContent
        );

    /*
     * =====================================================
     * COMMANDS
     * =====================================================
     */

    const {
        command,
        args
    } =
        parseCommand(text);

    /*
     * Commands can still work even if moderation
     * is enabled.
     */

    if (
        command
    ) {
        const handled =
            await handleCommand(
                sock,
                message,
                remoteJid,
                sender,
                command,
                args
            );

        if (handled) {
            return;
        }
    }

    /*
     * =====================================================
     * GROUP MODERATION
     * =====================================================
     */

    if (!group) {
        return;
    }

    /*
     * BAD WORD FILTER
     */

    const badWord =
        containsBadWord(text);

    if (badWord) {
        try {
            await sock.sendMessage(
                remoteJid,
                {
                    delete:
                        message.key
                }
            );
        } catch {}

        addReport(
            remoteJid,
            sender,
            `Bad word: ${badWord}`,
            text
        );

        const count =
            await warnUser(
                sock,
                remoteJid,
                sender,
                "অশালীন / গালাগালি ব্যবহার"
            );

        if (
            count >= 3
        ) {
            const botAdmin =
                await isAdmin(
                    sock,
                    remoteJid,
                    sock.user?.id
                );

            if (
                botAdmin
            ) {
                try {
                    await sock.groupParticipantsUpdate(
                        remoteJid,
                        [sender],
                        "remove"
                    );

                    clearWarning(
                        remoteJid,
                        sender
                    );
                } catch {}
            }
        }

        return;
    }

    /*
     * LINK FILTER
     */

    if (
        containsLink(text)
    ) {
        const senderAdmin =
            await isAdmin(
                sock,
                remoteJid,
                sender
            );

        if (!senderAdmin) {
            try {
                await sock.sendMessage(
                    remoteJid,
                    {
                        delete:
                            message.key
                    }
                );
            } catch {}

            addReport(
                remoteJid,
                sender,
                "Unauthorized link",
                text
            );

            await warnUser(
                sock,
                remoteJid,
                sender,
                "অনুমতি ছাড়া লিংক শেয়ার"
            );

            return;
        }
    }

    /*
     * DUPLICATE SPAM
     */

    if (
        text &&
        isDuplicateSpam(
            remoteJid,
            sender,
            text
        )
    ) {
        try {
            await sock.sendMessage(
                remoteJid,
                {
                    delete:
                        message.key
                }
            );
        } catch {}

        await warnUser(
            sock,
            remoteJid,
            sender,
            "Duplicate spam"
        );

        return;
    }

    /*
     * FLOOD SPAM
     */

    if (
        isFloodSpam(
            remoteJid,
            sender
        )
    ) {
        try {
            await sock.sendMessage(
                remoteJid,
                {
                    delete:
                        message.key
                }
            );
        } catch {}

        await warnUser(
            sock,
            remoteJid,
            sender,
            "Spam / flood message"
        );

        return;
    }

    /*
     * AI TEXT MODERATION
     */

    if (
        text &&
        text.length >= 3 &&
        OPENAI_API_KEY
    ) {
        const result =
            await moderateTextWithAI(
                text
            );

        if (
            result.flagged
        ) {
            try {
                await sock.sendMessage(
                    remoteJid,
                    {
                        delete:
                            message.key
                    }
                );
            } catch {}

            addReport(
                remoteJid,
                sender,
                result.reason,
                text
            );

            await warnUser(
                sock,
                remoteJid,
                sender,
                "AI moderation violation"
            );

            return;
        }
    }

    /*
     * AI IMAGE MODERATION
     */

    if (
        messageContent.imageMessage &&
        OPENAI_API_KEY
    ) {
        try {
            const buffer =
                await downloadMediaMessage(
                    message,
                    "buffer",
                    {},
                    {
                        logger:
                            P({
                                level:
                                    "silent"
                            })
                    }
                );

            if (
                buffer
            ) {
                const result =
                    await moderateImageWithAI(
                        buffer
                    );

                if (
                    result.flagged
                ) {
                    try {
                        await sock.sendMessage(
                            remoteJid,
                            {
                                delete:
                                    message.key
                            }
                        );
                    } catch {}

                    addReport(
                        remoteJid,
                        sender,
                        result.reason,
                        "[IMAGE]"
                    );

                    await warnUser(
                        sock,
                        remoteJid,
                        sender,
                        "অনুপযুক্ত ছবি"
                    );
                }
            }
        } catch (
            error
        ) {
            console.log(
                "IMAGE MODERATION ERROR:",
                error?.message ||
                error
            );
        }
    }
}

/* =========================================================
   COMMAND HANDLER
========================================================= */

async function handleCommand(
    sock,
    message,
    remoteJid,
    sender,
    command,
    args
) {
    /*
     * MENU
     */

    if (
        command === "menu" ||
        command === "help"
    ) {
        await sock.sendMessage(
            remoteJid,
            {
                text:
                    getMenuText()
            }
        );

        return true;
    }

    /*
     * PING
     */

    if (
        command === "ping"
    ) {
        await sock.sendMessage(
            remoteJid,
            {
                text:
                    getPingText()
            }
        );

        return true;
    }

    /*
     * BOT STATUS
     */

    if (
        command === "bot"
    ) {
        await sock.sendMessage(
            remoteJid,
            {
                text:
                    getBotStatusText(
                        remoteJid
                    )
            }
        );

        return true;
    }

    /*
     * RULES
     */

    if (
        command === "rules"
    ) {
        await sock.sendMessage(
            remoteJid,
            {
                text:
                    getRulesText()
            }
        );

        return true;
    }

    /*
     * GROUP ID
     */

    if (
        command === "id"
    ) {
        await sock.sendMessage(
            remoteJid,
            {
                text:
`🆔 *Group ID*

${remoteJid}`
            }
        );

        return true;
    }

    /*
     * ADMIN
     */

    if (
        command === "admin"
    ) {
        if (!isGroup(remoteJid)) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "❌ এই command group-এ ব্যবহার করুন।"
                }
            );

            return true;
        }

        const result =
            await getAdminText(
                sock,
                remoteJid
            );

        await sock.sendMessage(
            remoteJid,
            {
                text:
                    result.text,
                mentions:
                    result.mentions
            }
        );

        return true;
    }

    /*
     * MEMBERS
     */

    if (
        command === "members"
    ) {
        if (!isGroup(remoteJid)) {
            return true;
        }

        const result =
            await getMembersText(
                sock,
                remoteJid
            );

        await sock.sendMessage(
            remoteJid,
            {
                text:
                    result.text,
                mentions:
                    result.mentions
            }
        );

        return true;
    }

    /*
     * GROUP INFO
     */

    if (
        command === "groupinfo"
    ) {
        if (!isGroup(remoteJid)) {
            return true;
        }

        const result =
            await getGroupInfoText(
                sock,
                remoteJid
            );

        await sock.sendMessage(
            remoteJid,
            {
                text:
                    result.text,
                mentions:
                    result.mentions
            }
        );

        return true;
    }

    /*
     * WEBSITE
     */

    if (
        command === "website"
    ) {
        await sock.sendMessage(
            remoteJid,
            {
                text:
`🌐 *PIYAS SERVICES*

${WEBSITE_URL}`
            }
        );

        return true;
    }

    /*
     * PIYAS
     */

    if (
        command === "piyas"
    ) {
        await sock.sendMessage(
            remoteJid,
            {
                text:
`╭━━━━━━━━━━━━━━━━━━━━╮
        💻 *PIYAS SERVICES*
╰━━━━━━━━━━━━━━━━━━━━╯

🌐 Website:
${WEBSITE_URL}

🤖 ${BOT_NAME}

📌 Digital Services
📌 Google Play Points
📌 Premium Services
📌 VPN Services
📌 Other Online Services`
            }
        );

        return true;
    }

    /*
     * DEAL
     */

    if (
        command === "deal" ||
        command === "ডিল"
    ) {
        await sock.sendMessage(
            remoteJid,
            {
                text:
`╭━━━━━━━━━━━━━━━━━━━━╮
          🔥 *DEAL*
╰━━━━━━━━━━━━━━━━━━━━╯

📢 Current deals জানতে
PIYAS SERVICES-এ যোগাযোগ করুন।

🌐 ${WEBSITE_URL}`
            }
        );

        return true;
    }

    /*
     * REPORT
     */

    if (
        command === "report"
    ) {
        if (!isGroup(remoteJid)) {
            return true;
        }

        const target =
            getTargetUser(
                message.message
            );

        if (!target) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
`⚠️ একজন user-কে mention করে লিখুন:

/report @user reason`
                }
            );

            return true;
        }

        const reason =
            args.join(" ") ||
            "No reason provided";

        addReport(
            remoteJid,
            target,
            reason,
            ""
        );

        await sock.sendMessage(
            remoteJid,
            {
                text:
`✅ *Report Submitted*

👤 User:
${mentionUser(target)}

📌 Reason:
${reason}

Admin-কে বিষয়টি জানানো হয়েছে।`,
                mentions: [target]
            }
        );

        return true;
    }

    /*
     * REPORTS
     */

    if (
        command === "reports"
    ) {
        if (!isGroup(remoteJid)) {
            return true;
        }

        const admin =
            await isAdmin(
                sock,
                remoteJid,
                sender
            );

        if (!admin) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "❌ শুধু Admin এই command ব্যবহার করতে পারবেন।"
                }
            );

            return true;
        }

        const groupReports =
            reports.filter(
                r =>
                    r.groupId ===
                    remoteJid
            );

        if (
            !groupReports.length
        ) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "✅ কোনো report নেই।"
                }
            );

            return true;
        }

        const recent =
            groupReports.slice(-20);

        const lines =
            recent.map(
                (r, index) =>
                    `${index + 1}. ${mentionUser(r.userId)}
📌 ${r.reason}
🕒 ${r.createdAt}`
            );

        await sock.sendMessage(
            remoteJid,
            {
                text:
`╭━━━━━━━━━━━━━━━━━━━━╮
        📋 *REPORTS*
╰━━━━━━━━━━━━━━━━━━━━╯

${lines.join("\n\n")}`,
                mentions:
                    recent.map(
                        r => r.userId
                    )
            }
        );

        return true;
    }

    /*
     * BOT ON
     */

    if (
        command === "boton"
    ) {
        if (!isGroup(remoteJid)) {
            return true;
        }

        const admin =
            await isAdmin(
                sock,
                remoteJid,
                sender
            );

        if (!admin) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "❌ শুধু Admin এই command ব্যবহার করতে পারবেন।"
                }
            );

            return true;
        }

        setBotStatus(
            remoteJid,
            true
        );

        await sock.sendMessage(
            remoteJid,
            {
                text:
                    "🟢 *BOT ENABLED*\n\nBot এখন আবার active।"
            }
        );

        return true;
    }

    /*
     * BOT OFF
     */

    if (
        command === "botoff"
    ) {
        if (!isGroup(remoteJid)) {
            return true;
        }

        const admin =
            await isAdmin(
                sock,
                remoteJid,
                sender
            );

        if (!admin) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "❌ শুধু Admin এই command ব্যবহার করতে পারবেন।"
                }
            );

            return true;
        }

        setBotStatus(
            remoteJid,
            false
        );

        await sock.sendMessage(
            remoteJid,
            {
                text:
                    "🔴 *BOT DISABLED*\n\nBot এখন inactive।"
            }
        );

        return true;
    }

    /*
     * BLACKLIST ADD
     */

    if (
        command ===
        "blacklist"
    ) {
        if (!isGroup(remoteJid)) {
            return true;
        }

        const admin =
            await isAdmin(
                sock,
                remoteJid,
                sender
            );

        if (!admin) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "❌ Admin only."
                }
            );

            return true;
        }

        const target =
            getTargetUser(
                message.message
            );

        if (!target) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "⚠️ User mention করুন।"
                }
            );

            return true;
        }

        const reason =
            args.join(" ") ||
            "Blacklisted by admin";

        addBlacklist(
            target,
            reason
        );

        await sock.sendMessage(
            remoteJid,
            {
                text:
`🚫 *BLACKLISTED*

👤 ${mentionUser(target)}
📌 ${reason}`,
                mentions: [target]
            }
        );

        return true;
    }

    /*
     * UNBLACKLIST
     */

    if (
        command ===
        "unblacklist"
    ) {
        if (!isGroup(remoteJid)) {
            return true;
        }

        const admin =
            await isAdmin(
                sock,
                remoteJid,
                sender
            );

        if (!admin) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "❌ Admin only."
                }
            );

            return true;
        }

        const target =
            getTargetUser(
                message.message
            );

        if (!target) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "⚠️ User mention করুন।"
                }
            );

            return true;
        }

        removeBlacklist(
            target
        );

        await sock.sendMessage(
            remoteJid,
            {
                text:
`✅ *BLACKLIST REMOVED*

👤 ${mentionUser(target)}`,
                mentions: [target]
            }
        );

        return true;
    }

    /*
     * WARN
     */

    if (
        command === "warn"
    ) {
        if (!isGroup(remoteJid)) {
            return true;
        }

        const admin =
            await isAdmin(
                sock,
                remoteJid,
                sender
            );

        if (!admin) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "❌ Admin only."
                }
            );

            return true;
        }

        const target =
            getTargetUser(
                message.message
            );

        if (!target) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "⚠️ User mention করুন।"
                }
            );

            return true;
        }

        const reason =
            args.join(" ") ||
            "Rule violation";

        await warnUser(
            sock,
            remoteJid,
            target,
            reason
        );

        return true;
    }

    /*
     * CLEAR WARN
     */

    if (
        command === "clearwarn"
    ) {
        if (!isGroup(remoteJid)) {
            return true;
        }

        const admin =
            await isAdmin(
                sock,
                remoteJid,
                sender
            );

        if (!admin) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "❌ Admin only."
                }
            );

            return true;
        }

        const target =
            getTargetUser(
                message.message
            );

        if (!target) {
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "⚠️ User mention করুন।"
                }
            );

            return true;
        }

        clearWarning(
            remoteJid,
            target
        );

        await sock.sendMessage(
            remoteJid,
            {
                text:
`✅ Warning cleared for ${mentionUser(target)}.`,
                mentions: [target]
            }
        );

        return true;
    }

    /*
     * WARNINGS
     */

    if (
        command === "warnings"
    ) {
        if (!isGroup(remoteJid)) {
            return true;
        }

        const target =
            getTargetUser(
                message.message
            ) ||
            sender;

        const count =
            getWarningCount(
                remoteJid,
                target
            );

        await sock.sendMessage(
            remoteJid,
            {
                text:
`⚠️ *WARNING STATUS*

👤 User:
${mentionUser(target)}

📊 Warning:
${count}/3`,
                mentions: [target]
            }
        );

        return true;
    }

    return false;
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
`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
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
    text-align:center;
    border:1px solid #333;
    border-radius:20px;
    background:#101010;
    box-shadow:0 0 30px rgba(255,255,255,.08);
}
h1{
    margin-bottom:10px;
}
.status{
    margin-top:20px;
    padding:15px;
    border-radius:12px;
    background:#181818;
}
</style>
</head>
<body>
<div class="box">
<h1>🤖 ${BOT_NAME}</h1>
<p>WhatsApp Bot Server</p>
<div class="status">
🟢 Server Online
</div>
</div>
</body>
</html>`
            );
        }
    );

server.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `HTTP Server running on port ${PORT}`
        );

        console.log(
            `Allowed Groups: ${
                ALLOWED_GROUPS.length
                    ? ALLOWED_GROUPS.join(", ")
                    : "ALL"
            }`
        );
    }
);

/* =========================================================
   START
========================================================= */

console.log("");
console.log(
    "======================================"
);
console.log(
    `       ${BOT_NAME}`
);
console.log(
    "======================================"
);
console.log("");

console.log(
    "WhatsApp Bot Starting..."
);

console.log(
    "Connecting to WhatsApp..."
);

if (!getPhoneNumber()) {
    console.log("");
    console.log(
        "⚠️ PHONE_NUMBER সেট করা হয়নি।"
    );

    console.log(
        "Pterodactyl Environment Variables-এ:"
    );

    console.log(
        "PHONE_NUMBER=8801XXXXXXXXX"
    );

    console.log(
        "দিতে হবে।"
    );

    console.log("");
} else {
    console.log(
        "📱 Pairing number:",
        getPhoneNumber()
    );
}

startBot();

/* =========================================================
   PROCESS ERROR HANDLERS
========================================================= */

process.on(
    "uncaughtException",
    error => {
        console.log(
            "UNCAUGHT EXCEPTION:",
            error?.message ||
            error
        );
    }
);

process.on(
    "unhandledRejection",
    error => {
        console.log(
            "UNHANDLED REJECTION:",
            error?.message ||
            error
        );
    }
);