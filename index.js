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
const PHONE_NUMBER = process.env.PHONE_NUMBER || "";

const WEBSITE_URL =
    process.env.WEBSITE_URL ||
    "https://x-cyber-2025.github.io/X-cyber.web/";

const ALLOWED_GROUPS = (process.env.ALLOWED_GROUPS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

const OPENAI_API_KEY =
    process.env.OPENAI_API_KEY || "";

const IMAGE_MODERATION_ENABLED =
    String(
        process.env.IMAGE_MODERATION_ENABLED || "true"
    ).toLowerCase() === "true";

const TEXT_MODERATION_ENABLED =
    String(
        process.env.TEXT_MODERATION_ENABLED || "true"
    ).toLowerCase() === "true";

const IMAGE_SEXUAL_SCORE_THRESHOLD =
    Number(
        process.env.IMAGE_SEXUAL_SCORE_THRESHOLD || 0.30
    );

/* =========================================================
   PATHS
========================================================= */

const AUTH_DIR = "./auth_info";
const DATA_DIR = "./data";

const BLACKLIST_FILE =
    path.join(DATA_DIR, "blacklist.json");

const STATUS_FILE =
    path.join(DATA_DIR, "bot_status.json");

const REPORT_FILE =
    path.join(DATA_DIR, "reports.json");

const WELCOME_FILE =
    path.join(DATA_DIR, "welcome_status.json");

fs.mkdirSync(
    DATA_DIR,
    {
        recursive: true
    }
);

/* =========================================================
   JSON HELPERS
========================================================= */

function loadJSON(
    file,
    fallback
) {
    try {

        if (!fs.existsSync(file)) {

            fs.writeFileSync(
                file,
                JSON.stringify(
                    fallback,
                    null,
                    2
                )
            );

            return fallback;
        }

        const data =
            fs.readFileSync(
                file,
                "utf8"
            );

        if (!data.trim()) {
            return fallback;
        }

        return JSON.parse(data);

    } catch (err) {

        console.log(
            `JSON LOAD ERROR: ${file}`,
            err.message
        );

        return fallback;
    }
}

function saveJSON(
    file,
    data
) {
    try {

        fs.writeFileSync(
            file,
            JSON.stringify(
                data,
                null,
                2
            )
        );

    } catch (err) {

        console.log(
            `JSON SAVE ERROR: ${file}`,
            err.message
        );
    }
}

/* =========================================================
   DATA
========================================================= */

let blacklist =
    loadJSON(
        BLACKLIST_FILE,
        {}
    );

let botStatus =
    loadJSON(
        STATUS_FILE,
        {}
    );

let reports =
    loadJSON(
        REPORT_FILE,
        {}
    );

let welcomeStatus =
    loadJSON(
        WELCOME_FILE,
        {}
    );

/* =========================================================
   CACHE
========================================================= */

const participantCache =
    new Map();

const contactCache =
    new Map();

const duplicateCache =
    new Map();

/* =========================================================
   BASIC HELPERS
========================================================= */

function normalizePhone(
    value
) {
    if (!value) {
        return "";
    }

    return String(value)
        .replace(
            /[^0-9]/g,
            ""
        )
        .replace(
            /^0+/,
            ""
        );
}

function jidToPhone(
    jid
) {
    if (!jid) {
        return "";
    }

    const value =
        String(jid);

    if (
        value.endsWith(
            "@s.whatsapp.net"
        )
    ) {

        return normalizePhone(
            value.split("@")[0]
        );
    }

    return "";
}

function cleanJid(
    jid
) {
    if (!jid) {
        return "";
    }

    return String(jid)
        .replace(
            /:\d+(?=@)/,
            ""
        )
        .trim();
}

function sameUser(
    a,
    b
) {
    if (!a || !b) {
        return false;
    }

    const aa =
        cleanJid(a);

    const bb =
        cleanJid(b);

    if (aa === bb) {
        return true;
    }

    const ap =
        jidToPhone(aa);

    const bp =
        jidToPhone(bb);

    if (
        ap &&
        bp &&
        ap === bp
    ) {
        return true;
    }

    return false;
}

function getBotJid(
    sock
) {
    return sock?.user?.id
        ? cleanJid(
            sock.user.id
        )
        : "";
}

function getBotPhone(
    sock
) {
    return jidToPhone(
        getBotJid(sock)
    );
}

function isGroupJid(
    jid
) {
    return (
        typeof jid === "string" &&
        jid.endsWith("@g.us")
    );
}

function isAllowedGroup(
    groupId
) {
    if (
        !ALLOWED_GROUPS.length
    ) {
        return true;
    }

    return ALLOWED_GROUPS.includes(
        groupId
    );
}

function sleep(
    ms
) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

/* =========================================================
   IDENTITY SYSTEM
========================================================= */

function extractUserIdentity(
    input,
    extra = {}
) {
    let jid = "";
    let lid = "";
    let phone = "";
    let username = "";
    let pushName = "";

    if (
        typeof input === "string"
    ) {

        jid =
            cleanJid(input);

        if (
            jid.endsWith(
                "@s.whatsapp.net"
            )
        ) {

            phone =
                jidToPhone(jid);
        }

        if (
            jid.endsWith("@lid")
        ) {

            lid = jid;
        }
    }

    if (
        input &&
        typeof input === "object"
    ) {

        jid =
            cleanJid(
                input.id ||
                input.jid ||
                input.participant ||
                input.pn ||
                ""
            );

        lid =
            cleanJid(
                input.lid ||
                input.lidJid ||
                ""
            );

        phone =
            normalizePhone(
                input.phone ||
                input.phoneNumber ||
                input.authorPn ||
                input.pn ||
                ""
            );

        username =
            input.username ||
            input.userName ||
            "";

        pushName =
            input.pushName ||
            input.name ||
            "";
    }

    if (
        extra &&
        typeof extra === "object"
    ) {

        if (!phone) {

            phone =
                normalizePhone(
                    extra.phone ||
                    extra.authorPn ||
                    extra.pn ||
                    ""
                );
        }

        if (!lid) {

            lid =
                cleanJid(
                    extra.lid ||
                    extra.lidJid ||
                    ""
                );
        }

        if (!username) {

            username =
                extra.username ||
                extra.userName ||
                "";
        }

        if (!pushName) {

            pushName =
                extra.pushName ||
                extra.name ||
                "";
        }
    }

    if (
        !phone &&
        jid.endsWith(
            "@s.whatsapp.net"
        )
    ) {

        phone =
            jidToPhone(jid);
    }

    if (
        !lid &&
        jid.endsWith("@lid")
    ) {

        lid = jid;
    }

    return {
        jid,
        lid,
        phone,
        username:
            String(
                username || ""
            ).trim(),
        pushName:
            String(
                pushName || ""
            ).trim()
    };
}

function mergeIdentity(
    oldData = {},
    newData = {}
) {
    return {
        jid:
            newData.jid ||
            oldData.jid ||
            "",

        lid:
            newData.lid ||
            oldData.lid ||
            "",

        phone:
            newData.phone ||
            oldData.phone ||
            "",

        username:
            newData.username ||
            oldData.username ||
            "",

        pushName:
            newData.pushName ||
            oldData.pushName ||
            ""
    };
}

function cacheIdentity(
    groupId,
    identity
) {
    if (
        !groupId ||
        !identity
    ) {
        return;
    }

    const keys = [
        identity.jid,
        identity.lid,

        identity.phone
            ? `${identity.phone}@s.whatsapp.net`
            : "",

        identity.username
            ? `username:${identity.username.toLowerCase()}`
            : ""
    ].filter(Boolean);

    for (
        const key of keys
    ) {

        contactCache.set(
            `${groupId}:${key}`,
            identity
        );
    }
}

function getCachedIdentity(
    groupId,
    identity
) {
    if (
        !groupId ||
        !identity
    ) {
        return null;
    }

    const keys = [
        identity.jid,
        identity.lid,

        identity.phone
            ? `${identity.phone}@s.whatsapp.net`
            : "",

        identity.username
            ? `username:${identity.username.toLowerCase()}`
            : ""
    ].filter(Boolean);

    for (
        const key of keys
    ) {

        const found =
            contactCache.get(
                `${groupId}:${key}`
            );

        if (found) {
            return found;
        }
    }

    return null;
}

/* =========================================================
   BLACKLIST
========================================================= */

function ensureGroupBlacklist(
    groupId
) {
    if (!blacklist[groupId]) {
        blacklist[groupId] = [];
    }

    if (
        !Array.isArray(
            blacklist[groupId]
        )
    ) {

        blacklist[groupId] = [];
    }

    return blacklist[groupId];
}

function identitiesMatch(
    a,
    b
) {
    if (!a || !b) {
        return false;
    }

    const stableA = [
        cleanJid(a.jid),
        cleanJid(a.lid),
        normalizePhone(a.phone)
    ].filter(Boolean);

    const stableB = [
        cleanJid(b.jid),
        cleanJid(b.lid),
        normalizePhone(b.phone)
    ].filter(Boolean);

    for (
        const x of stableA
    ) {

        for (
            const y of stableB
        ) {

            if (!x || !y) {
                continue;
            }

            if (x === y) {
                return true;
            }

            if (
                /^[0-9]+$/.test(x) &&
                /^[0-9]+$/.test(y) &&
                x === y
            ) {
                return true;
            }

            if (
                x.endsWith(
                    "@s.whatsapp.net"
                ) &&
                y.endsWith(
                    "@s.whatsapp.net"
                ) &&
                jidToPhone(x) &&
                jidToPhone(x) ===
                jidToPhone(y)
            ) {

                return true;
            }
        }
    }

    if (
        a.username &&
        b.username &&
        a.username.toLowerCase() ===
        b.username.toLowerCase()
    ) {

        return true;
    }

    return false;
}

function isBlacklisted(
    groupId,
    identity
) {
    const list =
        ensureGroupBlacklist(
            groupId
        );

    const cached =
        getCachedIdentity(
            groupId,
            identity
        );

    const current =
        mergeIdentity(
            cached || {},
            identity || {}
        );

    return list.some(
        item =>
            identitiesMatch(
                item,
                current
            )
    );
}

function addToBlacklist(
    groupId,
    identity,
    reason = "self_leave"
) {
    if (
        !groupId ||
        !identity
    ) {
        return false;
    }

    const list =
        ensureGroupBlacklist(
            groupId
        );

    const existing =
        list.find(
            item =>
                identitiesMatch(
                    item,
                    identity
                )
        );

    if (existing) {

        const merged =
            mergeIdentity(
                existing,
                identity
            );

        Object.assign(
            existing,
            merged
        );

        existing.reason =
            existing.reason ||
            reason;

        existing.updatedAt =
            new Date().toISOString();

        saveJSON(
            BLACKLIST_FILE,
            blacklist
        );

        return false;
    }

    list.push({
        jid:
            identity.jid || "",

        lid:
            identity.lid || "",

        phone:
            identity.phone || "",

        username:
            identity.username || "",

        pushName:
            identity.pushName || "",

        reason,

        addedAt:
            new Date().toISOString(),

        updatedAt:
            new Date().toISOString()
    });

    saveJSON(
        BLACKLIST_FILE,
        blacklist
    );

    return true;
}

function removeFromBlacklist(
    groupId,
    identity
) {
    const list =
        ensureGroupBlacklist(
            groupId
        );

    const before =
        list.length;

    blacklist[groupId] =
        list.filter(
            item =>
                !identitiesMatch(
                    item,
                    identity
                )
        );

    saveJSON(
        BLACKLIST_FILE,
        blacklist
    );

    return (
        before !==
        blacklist[groupId].length
    );
}

function getBlacklist(
    groupId
) {
    return ensureGroupBlacklist(
        groupId
    );
}

/* =========================================================
   BOT STATUS
========================================================= */

function isBotEnabled(
    groupId
) {
    return (
        botStatus[groupId] !== false
    );
}

function setBotStatus(
    groupId,
    enabled
) {
    botStatus[groupId] =
        enabled;

    saveJSON(
        STATUS_FILE,
        botStatus
    );
}

function isWelcomeEnabled(
    groupId
) {
    return (
        welcomeStatus[groupId] !==
        false
    );
}

function setWelcomeStatus(
    groupId,
    enabled
) {
    welcomeStatus[groupId] =
        enabled;

    saveJSON(
        WELCOME_FILE,
        welcomeStatus
    );
}

/* =========================================================
   GROUP PARTICIPANT CACHE
========================================================= */

async function loadGroupParticipants(
    sock,
    groupId
) {
    try {

        const metadata =
            await sock.groupMetadata(
                groupId
            );

        if (
            !metadata?.participants
        ) {
            return;
        }

        for (
            const participant of
            metadata.participants
        ) {

            const identity =
                extractUserIdentity(
                    participant
                );

            cacheIdentity(
                groupId,
                identity
            );

            participantCache.set(
                `${groupId}:${cleanJid(participant.id)}`,
                participant
            );
        }

        console.log(
            "📦 Group participant cache loaded."
        );

    } catch (err) {

        console.log(
            "Participant cache error:",
            err.message
        );
    }
}

/* =========================================================
   GROUP METADATA
========================================================= */

async function getGroupMetadata(
    sock,
    groupId
) {
    try {

        return await sock.groupMetadata(
            groupId
        );

    } catch (err) {

        console.log(
            "Group metadata error:",
            err.message
        );

        return null;
    }
}

/* =========================================================
   ADMIN CHECK
========================================================= */

async function isGroupAdmin(
    sock,
    groupId,
    jid
) {
    if (!jid) {
        return false;
    }

    const metadata =
        await getGroupMetadata(
            sock,
            groupId
        );

    if (
        !metadata?.participants
    ) {
        return false;
    }

    const target =
        cleanJid(jid);

    const participant =
        metadata.participants.find(
            p =>
                sameUser(
                    p.id,
                    target
                )
        );

    if (!participant) {
        return false;
    }

    return (
        participant.admin === "admin" ||
        participant.admin === "superadmin"
    );
}

async function isBotAdmin(
    sock,
    groupId
) {
    const botJid =
        getBotJid(sock);

    if (!botJid) {
        return false;
    }

    return await isGroupAdmin(
        sock,
        groupId,
        botJid
    );
}

function isOwner(
    jid
) {
    if (
        !PHONE_NUMBER ||
        !jid
    ) {
        return false;
    }

    const configuredPhone =
        normalizePhone(
            PHONE_NUMBER
        );

    const currentPhone =
        jidToPhone(jid);

    return (
        configuredPhone &&
        currentPhone &&
        configuredPhone ===
        currentPhone
    );
}

async function isAdminOrOwner(
    sock,
    groupId,
    jid
) {
    if (
        isOwner(jid)
    ) {
        return true;
    }

    return await isGroupAdmin(
        sock,
        groupId,
        jid
    );
}

/* =========================================================
   TEXT
========================================================= */

function getMessageText(
    message
) {
    if (!message) {
        return "";
    }

    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.buttonsResponseMessage?.selectedDisplayText ||
        message.listResponseMessage?.title ||
        message.templateButtonReplyMessage?.selectedDisplayText ||
        ""
    );
}

function getMentionedJids(
    msg
) {
    return (
        msg?.extendedTextMessage
            ?.contextInfo
            ?.mentionedJid ||
        []
    );
}

/* =========================================================
   BAD WORD FILTER
========================================================= */

const BAD_WORDS = [
    "সালা",
    "শালা",
    "শালার",
    "খানকি",
    "খানকির",
    "খানকী",
    "মাগি",
    "মাগী",
    "বেশ্যা",
    "হারামি",
    "হারামজাদা",
    "হারামজাদি",
    "চোদা",
    "চোদন",
    "চুদ",
    "চুদা",
    "চুদির",
    "fuck",
    "fucking",
    "motherfucker",
    "bitch",
    "asshole",
    "slut",
    "whore"
];

function containsBadWord(
    text
) {
    if (!text) {
        return false;
    }

    const lower =
        text.toLowerCase();

    return BAD_WORDS.some(
        word =>
            lower.includes(
                word.toLowerCase()
            )
    );
}

/* =========================================================
   LINK DETECTOR
========================================================= */

function containsLink(
    text
) {
    if (!text) {
        return false;
    }

    return /(https?:\/\/|www\.|t\.me\/|wa\.me\/|chat\.whatsapp\.com\/|telegram\.me\/)/i.test(
        text
    );
}

/* =========================================================
   DUPLICATE SPAM
========================================================= */

function isDuplicateSpam(
    groupId,
    sender,
    text
) {
    if (
        !groupId ||
        !sender ||
        !text
    ) {
        return false;
    }

    const key =
        `${groupId}:${cleanJid(sender)}:${text.trim().toLowerCase()}`;

    const now =
        Date.now();

    const old =
        duplicateCache.get(
            key
        );

    duplicateCache.set(
        key,
        now
    );

    if (
        old &&
        now - old <=
        5 * 60 * 1000
    ) {
        return true;
    }

    return false;
}

/* =========================================================
   OPENAI TEXT MODERATION
========================================================= */

async function moderateTextWithOpenAI(
    text
) {
    if (!OPENAI_API_KEY) {
        return false;
    }

    if (!text) {
        return false;
    }

    if (!TEXT_MODERATION_ENABLED) {
        return false;
    }

    try {

        const response =
            await fetch(
                "https://api.openai.com/v1/moderations",
                {
                    method:
                        "POST",

                    headers: {
                        "Content-Type":
                            "application/json",

                        Authorization:
                            `Bearer ${OPENAI_API_KEY}`
                    },

                    body:
                        JSON.stringify({
                            model:
                                "omni-moderation-latest",

                            input:
                                text
                        })
                }
            );

        if (!response.ok) {

            console.log(
                "OpenAI moderation error:",
                response.status,
                await response.text()
            );

            return false;
        }

        const data =
            await response.json();

        return Boolean(
            data?.results?.[0]?.flagged
        );

    } catch (err) {

        console.log(
            "OpenAI text moderation error:",
            err.message
        );

        return false;
    }
}

/* =========================================================
   OPENAI IMAGE MODERATION
========================================================= */

async function moderateImageWithOpenAI(
    sock,
    message
) {
    if (!OPENAI_API_KEY) {
        return false;
    }

    if (!IMAGE_MODERATION_ENABLED) {
        return false;
    }

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
                        }),

                    reuploadRequest:
                        sock.updateMediaMessage
                }
            );

        if (!buffer) {
            return false;
        }

        const base64 =
            Buffer.from(
                buffer
            ).toString(
                "base64"
            );

        const mime =
            message.message
                ?.imageMessage
                ?.mimetype ||
            "image/jpeg";

        const dataUrl =
            `data:${mime};base64,${base64}`;

        const response =
            await fetch(
                "https://api.openai.com/v1/moderations",
                {
                    method:
                        "POST",

                    headers: {
                        "Content-Type":
                            "application/json",

                        Authorization:
                            `Bearer ${OPENAI_API_KEY}`
                    },

                    body:
                        JSON.stringify({
                            model:
                                "omni-moderation-latest",

                            input: [
                                {
                                    type:
                                        "image_url",

                                    image_url: {
                                        url:
                                            dataUrl
                                    }
                                }
                            ]
                        })
                }
            );

        if (!response.ok) {

            console.log(
                "OpenAI image moderation error:",
                response.status,
                await response.text()
            );

            return false;
        }

        const data =
            await response.json();

        const result =
            data?.results?.[0];

        if (!result) {
            return false;
        }

        const categories =
            result.categories || {};

        const scores =
            result.category_scores || {};

        if (
            categories[
                "sexual/minors"
            ]
        ) {
            return true;
        }

        const sexualScore =
            Number(
                scores[
                    "sexual"
                ] || 0
            );

        return (
            sexualScore >=
            IMAGE_SEXUAL_SCORE_THRESHOLD
        );

    } catch (err) {

        console.log(
            "OpenAI image moderation error:",
            err.message
        );

        return false;
    }
}

/* =========================================================
   DELETE MESSAGE
========================================================= */

async function deleteMessage(
    sock,
    message
) {
    try {

        await sock.sendMessage(
            message.key.remoteJid,
            {
                delete: {
                    remoteJid:
                        message.key.remoteJid,

                    fromMe:
                        false,

                    id:
                        message.key.id,

                    participant:
                        message.key.participant
                }
            }
        );

        return true;

    } catch (err) {

        console.log(
            "Delete message error:",
            err.message
        );

        return false;
    }
}

/* =========================================================
   REPLY
========================================================= */

async function reply(
    sock,
    jid,
    text,
    quoted
) {
    try {

        return await sock.sendMessage(
            jid,
            {
                text
            },
            {
                quoted
            }
        );

    } catch (err) {

        console.log(
            "Reply error:",
            err.message
        );
    }
}

/* =========================================================
   MENU
========================================================= */

function menuText() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
        🤖 *BOT MENU*
╰━━━━━━━━━━━━━━━━━━━━╯

╭─❖ 👥 *GROUP COMMANDS*
│
│ 1️⃣ /menu
│ 2️⃣ /bot
│ 3️⃣ /rules
│ 4️⃣ /admin
│ 5️⃣ /members
│ 6️⃣ /groupinfo
│ 7️⃣ /id
╰────────────────────

╭─❖ ⚙️ *UTILITY*
│
│ 8️⃣ /ping
╰────────────────────

╭─❖ 💰 *BUY / SELL*
│
│ 9️⃣ /deal /ডিল
╰────────────────────

╭─❖ 🤍 *PIYAS*
│
│ 🔟 /piyas
╰────────────────────

╭─❖ 🌐 *OUR WEBSITE*
│
│ 1️⃣1️⃣ /website
╰────────────────────

╭─❖ 🛡️ *REPORT*
│
│ 1️⃣2️⃣ /report @user কারণ
│ 1️⃣3️⃣ /reports
╰────────────────────

╭━━━━━━━━━━━━━━━━━━━━╮
        ❤️ *PIYAS BOT*
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim();
}

function commandListText() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
       ⚙️ *COMMAND LIST*
╰━━━━━━━━━━━━━━━━━━━━╯

╭─❖ 👥 *GROUP*
│
│ /menu
│ /bot
│ /rules
│ /admin
│ /members
│ /groupinfo
│ /id
╰────────────────────

╭─❖ ⚙️ *UTILITY*
│
│ /ping
╰────────────────────

╭─❖ 💰 *BUY / SELL*
│
│ /deal
│ /ডিল
╰────────────────────

╭─❖ 🤍 *PIYAS*
│
│ /piyas
╰────────────────────

╭─❖ 🌐 *WEBSITE*
│
│ /website
╰────────────────────

╭─❖ 🛡️ *REPORT*
│
│ /report @user কারণ
│ /reports
╰────────────────────

╭─❖ 👑 *ADMIN*
│
│ /adminpanel
│ /cmdlist
│ /on
│ /off
│ /boton
│ /botoff
│ /onbot
│ /offbot
│ /fullbotstatus
│ /welcomeon
│ /welcomeoff
│ /allowback @user
│ /unleave @user
╰────────────────────

╭━━━━━━━━━━━━━━━━━━━━╮
        ❤️ *PIYAS BOT*
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim();
}

function adminPanelText() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
       👑 *ADMIN PANEL*
╰━━━━━━━━━━━━━━━━━━━━╯

╭─❖ 🤖 *BOT CONTROL*
│
│ /on
│ /off
│ /boton
│ /botoff
│ /onbot
│ /offbot
│ /fullbotstatus
╰────────────────────

╭─❖ 👋 *WELCOME*
│
│ /welcomeon
│ /welcomeoff
╰────────────────────

╭─❖ 🚫 *BLACKLIST*
│
│ /allowback @user
│ /unleave @user
╰────────────────────

╭─❖ 📋 *COMMANDS*
│
│ /cmdlist
╰────────────────────

╭━━━━━━━━━━━━━━━━━━━━╮
        ❤️ *PIYAS BOT*
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim();
}

/* =========================================================
   RULES
========================================================= */

function rulesText() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
        📜 *GROUP RULES*
╰━━━━━━━━━━━━━━━━━━━━╯

1️⃣ অশালীন ভাষা ব্যবহার করবেন না।
2️⃣ অপ্রয়োজনীয় Link/Spam পাঠাবেন না।
3️⃣ 18+ বা Sexual Content পাঠানো নিষেধ।
4️⃣ অন্য সদস্যকে হয়রানি করবেন না।
5️⃣ প্রতারণামূলক তথ্য/লিংক শেয়ার করবেন না।
6️⃣ Group Admin-এর নির্দেশনা মেনে চলুন।
7️⃣ Buy/Sell deal করার সময় সতর্ক থাকুন।

╭━━━━━━━━━━━━━━━━━━━━╮
        ❤️ *PIYAS BOT*
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim();
}

/* =========================================================
   PIYAS
========================================================= */

function piyasText() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
          🤍 *PIYAS*
╰━━━━━━━━━━━━━━━━━━━━╯

🌐 Website:
${WEBSITE_URL}

✨ Digital Service & Community Support

╭━━━━━━━━━━━━━━━━━━━━╮
        ❤️ *PIYAS BOT*
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim();
}

/* =========================================================
   GROUP INFO
========================================================= */

async function groupInfoText(
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

    const participants =
        metadata.participants || [];

    const admins =
        participants.filter(
            p =>
                p.admin === "admin" ||
                p.admin === "superadmin"
        ).length;

    return `
╭━━━━━━━━━━━━━━━━━━━━╮
       👥 *GROUP INFO*
╰━━━━━━━━━━━━━━━━━━━━╯

📌 Name:
${metadata.subject || "Unknown"}

🆔 ID:
${groupId}

👥 Members:
${participants.length}

👑 Admins:
${admins}

📅 Created:
${
    metadata.creation
        ? new Date(
            metadata.creation * 1000
        ).toLocaleString()
        : "Unknown"
}

╭━━━━━━━━━━━━━━━━━━━━╮
        ❤️ *PIYAS BOT*
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim();
}

/* =========================================================
   ADMIN LIST
========================================================= */

async function adminText(
    sock,
    groupId
) {
    const metadata =
        await getGroupMetadata(
            sock,
            groupId
        );

    if (!metadata) {
        return "❌ Admin list পাওয়া যায়নি।";
    }

    const admins =
        metadata.participants.filter(
            p =>
                p.admin === "admin" ||
                p.admin === "superadmin"
        );

    let text = `
╭━━━━━━━━━━━━━━━━━━━━╮
        👑 *GROUP ADMINS*
╰━━━━━━━━━━━━━━━━━━━━╯

`;

    admins.forEach(
        (
            admin,
            index
        ) => {

            text +=
                `${index + 1}️⃣ @${jidToPhone(admin.id) || admin.id}\n`;
        }
    );

    text += `
╭━━━━━━━━━━━━━━━━━━━━╮
        ❤️ *PIYAS BOT*
╰━━━━━━━━━━━━━━━━━━━━╯`;

    return text.trim();
}

/* =========================================================
   MEMBERS
========================================================= */

async function membersText(
    sock,
    groupId
) {
    const metadata =
        await getGroupMetadata(
            sock,
            groupId
        );

    if (!metadata) {
        return "❌ Member list পাওয়া যায়নি।";
    }

    const participants =
        metadata.participants || [];

    let text = `
╭━━━━━━━━━━━━━━━━━━━━╮
        👥 *MEMBERS*
╰━━━━━━━━━━━━━━━━━━━━╯

Total Members: *${participants.length}*

`;

    participants
        .slice(
            0,
            100
        )
        .forEach(
            (
                member,
                index
            ) => {

                const phone =
                    jidToPhone(
                        member.id
                    ) ||
                    member.id;

                text +=
                    `${index + 1}. @${phone}\n`;
            }
        );

    return text.trim();
}

/* =========================================================
   REPORT SYSTEM
========================================================= */

function addReport(
    groupId,
    reporter,
    target,
    reason
) {
    if (!reports[groupId]) {
        reports[groupId] = [];
    }

    reports[groupId].push({
        reporter,
        target,
        reason,
        createdAt:
            new Date().toISOString()
    });

    saveJSON(
        REPORT_FILE,
        reports
    );
}

function getReportsText(
    groupId
) {
    const list =
        reports[groupId] || [];

    if (!list.length) {
        return `
╭━━━━━━━━━━━━━━━━━━━━╮
        🛡️ *REPORTS*
╰━━━━━━━━━━━━━━━━━━━━╯

✅ বর্তমানে কোনো Report নেই。
`.trim();
    }

    let text = `
╭━━━━━━━━━━━━━━━━━━━━╮
        🛡️ *REPORTS*
╰━━━━━━━━━━━━━━━━━━━━╯

`;

    list
        .slice(-20)
        .forEach(
            (
                report,
                index
            ) => {

                text +=
                    `${index + 1}️⃣ Target: ${report.target}\n` +
                    `👤 Reporter: ${report.reporter}\n` +
                    `📝 Reason: ${report.reason}\n` +
                    `🕐 ${report.createdAt}\n\n`;
            }
        );

    return text.trim();
}

/* =========================================================
   WELCOME
   DYNAMIC GROUP NAME
========================================================= */

async function sendWelcome(
    sock,
    groupId,
    participant
) {
    if (
        !isWelcomeEnabled(
            groupId
        )
    ) {
        return;
    }

    try {

        /* Get current group name */
        let groupName =
            "আমাদের গ্রুপ";

        try {

            const metadata =
                await sock.groupMetadata(
                    groupId
                );

            if (
                metadata?.subject
            ) {
                groupName =
                    metadata.subject;
            }

        } catch (err) {

            console.log(
                "Group name fetch error:",
                err.message
            );
        }

        const identity =
            extractUserIdentity(
                participant
            );

        const mention =
            identity.jid ||
            participant;

        const name =
            identity.pushName ||
            "নতুন সদস্য";

        const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
        🎉 *স্বাগতম*
╰━━━━━━━━━━━━━━━━━━━━╯

🎉 *স্বাগতম @${name}!* ❤️

🌸 আপনাকে *${groupName}*
গ্রুপে স্বাগতম।

💬 এখানে সবাই একে অপরকে
সহযোগিতা করবেন।

📌 গ্রুপের নিয়ম দেখতে লিখুন:
*/rules*

🤖 Bot Menu দেখতে লিখুন:
*/menu*

🌐 Website দেখতে লিখুন:
*/website*

⚡ Account Buy/Sell ও
Google Play Points সম্পর্কিত
তথ্য এখানে শেয়ার করা হয়।

⚠️ *বিশেষ সতর্কতা:*

যেকোনো সমস্যায় পড়লে
সরাসরি Admin-কে জানাবেন।

কোনো ধরনের প্রতারণা বা
সন্দেহজনক বিষয় দেখলে
Admin-কে জানান।

🌐 *Our Official Website:*
${WEBSITE_URL}

╭━━━━━━━━━━━━━━━━━━━━╮
        ❤️ *PIYAS BOT*
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim();

        await sock.sendMessage(
            groupId,
            {
                text,

                mentions: [
                    mention
                ]
            }
        );

        console.log(
            `👋 Welcome sent | User: ${name} | Group: ${groupName} | Group ID: ${groupId}`
        );

    } catch (err) {

        console.log(
            "Welcome error:",
            err.message
        );
    }
}

/* =========================================================
   BLACKLIST REJOIN
========================================================= */

async function handleBlacklistedJoin(
    sock,
    groupId,
    participant
) {
    const identity =
        extractUserIdentity(
            participant
        );

    const cached =
        getCachedIdentity(
            groupId,
            identity
        );

    const finalIdentity =
        mergeIdentity(
            cached || {},
            identity
        );

    if (
        !isBlacklisted(
            groupId,
            finalIdentity
        )
    ) {
        return false;
    }

    console.log(
        `🚫 BLACKLISTED MEMBER REJOINED: ${
            finalIdentity.jid ||
            participant
        }`
    );

    if (
        !(await isBotAdmin(
            sock,
            groupId
        ))
    ) {

        console.log(
            "❌ Bot is not admin. Cannot remove blacklisted member."
        );

        return true;
    }

    try {

        await sleep(500);

        const target =
            finalIdentity.jid ||
            participant;

        await sock.groupParticipantsUpdate(
            groupId,
            [
                target
            ],
            "remove"
        );

        console.log(
            `✅ BLACKLISTED MEMBER REMOVED AGAIN: ${target}`
        );

        return true;

    } catch (err) {

        console.log(
            `❌ Failed to remove blacklisted member: ${err.message}`
        );

        return true;
    }
}

/* =========================================================
   PARTICIPANT UPDATE
========================================================= */

async function handleParticipantUpdate(
    sock,
    update
) {
    const {
        id: groupId,
        participants = [],
        action,
        author,
        authorPn
    } = update;

    if (
        !isGroupJid(groupId)
    ) {
        return;
    }

    if (
        !isAllowedGroup(groupId)
    ) {
        return;
    }

    console.log(
        `👥 Group update: ${action} | ${groupId} | ${participants.length} participant(s)`
    );

    console.log(
        `👤 EVENT AUTHOR: ${author || "NONE"}`
    );

    console.log(
        `📱 AUTHOR PN: ${authorPn || "NONE"}`
    );

    /* =====================================================
       CACHE PARTICIPANTS
    ===================================================== */

    for (
        const participant of
        participants
    ) {

        const identity =
            extractUserIdentity(
                participant
            );

        cacheIdentity(
            groupId,
            identity
        );
    }

    /* =====================================================
       ADD
    ===================================================== */

    if (
        action === "add"
    ) {

        for (
            const participant of
            participants
        ) {

            const identity =
                extractUserIdentity(
                    participant
                );

            const cachedIdentity =
                getCachedIdentity(
                    groupId,
                    identity
                );

            const finalIdentity =
                mergeIdentity(
                    cachedIdentity || {},
                    identity
                );

            if (
                await handleBlacklistedJoin(
                    sock,
                    groupId,
                    finalIdentity
                )
            ) {
                continue;
            }

            await sendWelcome(
                sock,
                groupId,
                finalIdentity
            );
        }

        return;
    }

    /* =====================================================
       REMOVE
    ===================================================== */

    if (
        action === "remove"
    ) {

        const botJid =
            getBotJid(sock);

        const botPhone =
            getBotPhone(sock);

        for (
            const participant of
            participants
        ) {

            const participantIdentity =
                extractUserIdentity(
                    participant
                );

            const participantJid =
                participantIdentity.jid ||
                participant?.id ||
                "";

            const participantPhone =
                participantIdentity.phone ||
                "";

            const participantLid =
                participantIdentity.lid ||
                "";

            cacheIdentity(
                groupId,
                participantIdentity
            );

            const authorIdentity =
                extractUserIdentity(
                    author,
                    {
                        phone:
                            authorPn
                    }
                );

            let authorIsParticipant =
                false;

            /* JID comparison */

            if (
                authorIdentity.jid &&
                participantJid &&
                sameUser(
                    authorIdentity.jid,
                    participantJid
                )
            ) {

                authorIsParticipant =
                    true;
            }

            /* LID comparison */

            if (
                !authorIsParticipant &&
                authorIdentity.lid &&
                participantLid &&
                cleanJid(
                    authorIdentity.lid
                ) ===
                cleanJid(
                    participantLid
                )
            ) {

                authorIsParticipant =
                    true;
            }

            /* Phone comparison */

            if (
                !authorIsParticipant &&
                authorIdentity.phone &&
                participantPhone &&
                normalizePhone(
                    authorIdentity.phone
                ) ===
                normalizePhone(
                    participantPhone
                )
            ) {

                authorIsParticipant =
                    true;
            }

            /* authorPn comparison */

            if (
                !authorIsParticipant &&
                authorPn &&
                participantPhone &&
                normalizePhone(
                    authorPn
                ) ===
                normalizePhone(
                    participantPhone
                )
            ) {

                authorIsParticipant =
                    true;
            }

            /* =================================================
               BOT REMOVAL CHECK
            ================================================= */

            let authorIsBot =
                false;

            if (
                authorIdentity.jid &&
                botJid &&
                sameUser(
                    authorIdentity.jid,
                    botJid
                )
            ) {

                authorIsBot =
                    true;
            }

            if (
                !authorIsBot &&
                authorIdentity.phone &&
                botPhone &&
                normalizePhone(
                    authorIdentity.phone
                ) ===
                normalizePhone(
                    botPhone
                )
            ) {

                authorIsBot =
                    true;
            }

            if (
                !authorIsBot &&
                authorPn &&
                botPhone &&
                normalizePhone(
                    authorPn
                ) ===
                normalizePhone(
                    botPhone
                )
            ) {

                authorIsBot =
                    true;
            }

            console.log(
                `🔎 REMOVE CHECK | participant=${participantJid} | author=${author || "NONE"} | authorPn=${authorPn || "NONE"} | self=${authorIsParticipant} | bot=${authorIsBot}`
            );

            /* =================================================
               BOT REMOVED
               NO BLACKLIST
            ================================================= */

            if (
                authorIsBot
            ) {

                console.log(
                    `🤖 BOT REMOVED: ${participantJid} | NO BLACKLIST`
                );

                continue;
            }

            /* =================================================
               ADMIN / OTHER PERSON REMOVED
               NO BLACKLIST
            ================================================= */

            if (
                author &&
                !authorIsParticipant
            ) {

                console.log(
                    `👑 ADMIN/OTHER USER REMOVED: ${participantJid} | AUTHOR=${author} | NO BLACKLIST`
                );

                continue;
            }

            /* =================================================
               SELF LEAVE
            ================================================= */

            if (
                authorIsParticipant
            ) {

                const added =
                    addToBlacklist(
                        groupId,
                        participantIdentity,
                        "self_leave"
                    );

                if (added) {

                    console.log(
                        `🚫 BLACKLIST ADDED (SELF LEAVE): ${participantJid}`
                    );

                } else {

                    console.log(
                        `🚫 ALREADY BLACKLISTED (SELF LEAVE): ${participantJid}`
                    );
                }

                continue;
            }

            /* =================================================
               NO AUTHOR
            ================================================= */

            if (!author) {

                console.log(
                    `⚠️ REMOVE EVENT WITHOUT AUTHOR: ${participantJid} | NO BLACKLIST`
                );

                continue;
            }

            console.log(
                `ℹ️ REMOVE EVENT FINISHED: ${participantJid} | NO BLACKLIST`
            );
        }
    }
}

/* =========================================================
   COMMAND PARSER
========================================================= */

function parseCommand(
    text
) {
    if (!text) {

        return {
            command: "",
            args: ""
        };
    }

    const trimmed =
        text.trim();

    if (
        !trimmed.startsWith("/")
    ) {

        return {
            command: "",
            args: ""
        };
    }

    const parts =
        trimmed.split(
            /\s+/
        );

    const command =
        parts
            .shift()
            .toLowerCase();

    const args =
        parts.join(" ");

    return {
        command,
        args
    };
}

/* =========================================================
   HANDLE COMMAND
========================================================= */

async function handleCommand(
    sock,
    message,
    groupId,
    sender,
    text
) {
    const {
        command,
        args
    } =
        parseCommand(text);

    if (!command) {
        return;
    }

    const admin =
        await isAdminOrOwner(
            sock,
            groupId,
            sender
        );

    /* =====================================================
       PUBLIC
    ===================================================== */

    if (
        command === "/menu" ||
        command === "/bot"
    ) {

        await reply(
            sock,
            groupId,
            menuText(),
            message
        );

        return;
    }

    if (
        command === "/rules"
    ) {

        await reply(
            sock,
            groupId,
            rulesText(),
            message
        );

        return;
    }

    if (
        command === "/admin"
    ) {

        await reply(
            sock,
            groupId,
            await adminText(
                sock,
                groupId
            ),
            message
        );

        return;
    }

    if (
        command === "/members"
    ) {

        await reply(
            sock,
            groupId,
            await membersText(
                sock,
                groupId
            ),
            message
        );

        return;
    }

    if (
        command === "/groupinfo"
    ) {

        await reply(
            sock,
            groupId,
            await groupInfoText(
                sock,
                groupId
            ),
            message
        );

        return;
    }

    if (
        command === "/id"
    ) {

        await reply(
            sock,
            groupId,
            `🆔 *Group ID:*\n\n${groupId}`,
            message
        );

        return;
    }

    if (
        command === "/ping"
    ) {

        const start =
            Date.now();

        const sent =
            await sock.sendMessage(
                groupId,
                {
                    text:
                        "🏓 Pong..."
                },
                {
                    quoted:
                        message
                }
            );

        const ms =
            Date.now() -
            start;

        if (sent) {

            await sock.sendMessage(
                groupId,
                {
                    text:
                        `🏓 *PONG!*\n\n⚡ Response: ${ms}ms`
                },
                {
                    quoted:
                        message
                }
            );
        }

        return;
    }

    if (
        command === "/deal" ||
        command === "/ডিল"
    ) {

        await reply(
            sock,
            groupId,
            `
╭━━━━━━━━━━━━━━━━━━━━╮
          💰 *DEAL*
╰━━━━━━━━━━━━━━━━━━━━╯

📌 Buy/Sell deal করার আগে
সব তথ্য ভালোভাবে যাচাই করুন।

⚠️ কোনো Admin বা Bot
কোনো ব্যক্তিগত লেনদেনের
দায় নেবে না।

╭━━━━━━━━━━━━━━━━━━━━╮
        ❤️ *PIYAS BOT*
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim(),
            message
        );

        return;
    }

    if (
        command === "/piyas"
    ) {

        await reply(
            sock,
            groupId,
            piyasText(),
            message
        );

        return;
    }

    if (
        command === "/website"
    ) {

        await reply(
            sock,
            groupId,
            `🌐 *OUR WEBSITE*\n\n${WEBSITE_URL}`,
            message
        );

        return;
    }

    /* =====================================================
       REPORT
    ===================================================== */

    if (
        command === "/report"
    ) {

        const mentioned =
            getMentionedJids(
                message.message
            );

        if (
            !mentioned.length
        ) {

            await reply(
                sock,
                groupId,
                "❌ যাকে Report করতে চান তাকে @mention করুন।\n\nExample:\n/report @user কারণ",
                message
            );

            return;
        }

        if (!args) {

            await reply(
                sock,
                groupId,
                "❌ Report করার কারণ লিখুন।\n\nExample:\n/report @user Spam করছে",
                message
            );

            return;
        }

        const target =
            mentioned[0];

        addReport(
            groupId,
            sender,
            target,
            args
        );

        await reply(
            sock,
            groupId,
            "✅ Report সফলভাবে জমা হয়েছে।",
            message
        );

        return;
    }

    if (
        command === "/reports"
    ) {

        if (!admin) {

            await reply(
                sock,
                groupId,
                "❌ এই command শুধু Admin/Owner ব্যবহার করতে পারবেন।",
                message
            );

            return;
        }

        await reply(
            sock,
            groupId,
            getReportsText(
                groupId
            ),
            message
        );

        return;
    }

    /* =====================================================
       ADMIN PANEL
    ===================================================== */

    if (
        command === "/adminpanel"
    ) {

        if (!admin) {

            await reply(
                sock,
                groupId,
                "❌ শুধু Group Admin/Owner এই command ব্যবহার করতে পারবেন।",
                message
            );

            return;
        }

        await reply(
            sock,
            groupId,
            adminPanelText(),
            message
        );

        return;
    }

    if (
        command === "/cmdlist"
    ) {

        if (!admin) {

            await reply(
                sock,
                groupId,
                "❌ শুধু Group Admin/Owner এই command ব্যবহার করতে পারবেন।",
                message
            );

            return;
        }

        await reply(
            sock,
            groupId,
            commandListText(),
            message
        );

        return;
    }

    /* =====================================================
       BOT ON/OFF
    ===================================================== */

    if (
        command === "/on" ||
        command === "/boton" ||
        command === "/onbot"
    ) {

        if (!admin) {

            await reply(
                sock,
                groupId,
                "❌ শুধু Admin/Owner এই command ব্যবহার করতে পারবেন।",
                message
            );

            return;
        }

        setBotStatus(
            groupId,
            true
        );

        await reply(
            sock,
            groupId,
            "✅ *Bot ON করা হয়েছে।*",
            message
        );

        return;
    }

    if (
        command === "/off" ||
        command === "/botoff" ||
        command === "/offbot"
    ) {

        if (!admin) {

            await reply(
                sock,
                groupId,
                "❌ শুধু Admin/Owner এই command ব্যবহার করতে পারবেন।",
                message
            );

            return;
        }

        setBotStatus(
            groupId,
            false
        );

        await reply(
            sock,
            groupId,
            "⛔ *Bot OFF করা হয়েছে।*",
            message
        );

        return;
    }

    if (
        command === "/fullbotstatus"
    ) {

        if (!admin) {

            await reply(
                sock,
                groupId,
                "❌ শুধু Admin/Owner এই command ব্যবহার করতে পারবেন।",
                message
            );

            return;
        }

        const enabled =
            isBotEnabled(
                groupId
            );

        const welcome =
            isWelcomeEnabled(
                groupId
            );

        const list =
            getBlacklist(
                groupId
            );

        await reply(
            sock,
            groupId,
            `
╭━━━━━━━━━━━━━━━━━━━━╮
      🤖 *BOT STATUS*
╰━━━━━━━━━━━━━━━━━━━━╯

🤖 Bot:
${enabled ? "🟢 ON" : "🔴 OFF"}

👋 Welcome:
${welcome ? "🟢 ON" : "🔴 OFF"}

🚫 Blacklist:
${list.length} জন

🛡️ Text Moderation:
${TEXT_MODERATION_ENABLED ? "🟢 ON" : "🔴 OFF"}

🖼️ Image Moderation:
${IMAGE_MODERATION_ENABLED ? "🟢 ON" : "🔴 OFF"}

╭━━━━━━━━━━━━━━━━━━━━╮
        ❤️ *PIYAS BOT*
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim(),
            message
        );

        return;
    }

    /* =====================================================
       WELCOME ON/OFF
    ===================================================== */

    if (
        command === "/welcomeon"
    ) {

        if (!admin) {

            await reply(
                sock,
                groupId,
                "❌ শুধু Admin/Owner এই command ব্যবহার করতে পারবেন।",
                message
            );

            return;
        }

        setWelcomeStatus(
            groupId,
            true
        );

        await reply(
            sock,
            groupId,
            "✅ *Welcome ON করা হয়েছে।*",
            message
        );

        return;
    }

    if (
        command === "/welcomeoff"
    ) {

        if (!admin) {

            await reply(
                sock,
                groupId,
                "❌ শুধু Admin/Owner এই command ব্যবহার করতে পারবেন।",
                message
            );

            return;
        }

        setWelcomeStatus(
            groupId,
            false
        );

        await reply(
            sock,
            groupId,
            "⛔ *Welcome OFF করা হয়েছে।*",
            message
        );

        return;
    }

    /* =====================================================
       ALLOW BACK / UNLEAVE
    ===================================================== */

    if (
        command === "/allowback" ||
        command === "/unleave"
    ) {

        if (!admin) {

            await reply(
                sock,
                groupId,
                "❌ শুধু Admin/Owner এই command ব্যবহার করতে পারবেন।",
                message
            );

            return;
        }

        const mentioned =
            getMentionedJids(
                message.message
            );

        if (
            !mentioned.length
        ) {

            await reply(
                sock,
                groupId,
                "❌ যাকে Blacklist থেকে বাদ দিতে চান তাকে @mention করুন।\n\nExample:\n/allowback @user",
                message
            );

            return;
        }

        const target =
            mentioned[0];

        const identity =
            extractUserIdentity(
                target
            );

        const removed =
            removeFromBlacklist(
                groupId,
                identity
            );

        if (removed) {

            await reply(
                sock,
                groupId,
                `✅ @${jidToPhone(target) || target} কে Blacklist থেকে সরানো হয়েছে। এখন সে আবার Group-এ Join করতে পারবে।`,
                message
            );

        } else {

            await reply(
                sock,
                groupId,
                "ℹ️ এই সদস্য Blacklist-এ পাওয়া যায়নি।",
                message
            );
        }

        return;
    }
}

/* =========================================================
   MESSAGE MODERATION
========================================================= */

async function handleIncomingMessage(
    sock,
    message
) {
    try {

        if (!message?.message) {
            return;
        }

        const groupId =
            message.key?.remoteJid;

        if (
            !isGroupJid(groupId)
        ) {
            return;
        }

        if (
            !isAllowedGroup(groupId)
        ) {
            return;
        }

        const sender =
            cleanJid(
                message.key?.participant ||
                message.participant ||
                ""
            );

        const pushName =
            message.pushName ||
            "";

        if (sender) {

            const identity =
                extractUserIdentity(
                    sender,
                    {
                        pushName
                    }
                );

            cacheIdentity(
                groupId,
                identity
            );
        }

        const text =
            getMessageText(
                message.message
            );

        console.log(
            `✉️ MESSAGE: ${text || "[MEDIA]"}`
        );

        console.log(
            `👥 GROUP: ${groupId}`
        );

        const senderIsAdmin =
            sender &&
            await isAdminOrOwner(
                sock,
                groupId,
                sender
            );

        if (
            senderIsAdmin
        ) {

            console.log(
                "👑 Admin/Owner message - moderation skipped."
            );
        }

        /* =================================================
           COMMANDS
        ================================================= */

        if (
            text.startsWith("/") &&
            isBotEnabled(groupId)
        ) {

            await handleCommand(
                sock,
                message,
                groupId,
                sender,
                text
            );

            return;
        }

        /* =================================================
           ADMIN COMMANDS WHEN BOT OFF
        ================================================= */

        if (
            text.startsWith("/") &&
            !isBotEnabled(groupId)
        ) {

            const {
                command
            } =
                parseCommand(
                    text
                );

            const adminCommands = [
                "/on",
                "/off",
                "/boton",
                "/botoff",
                "/onbot",
                "/offbot",
                "/fullbotstatus",
                "/adminpanel",
                "/cmdlist",
                "/welcomeon",
                "/welcomeoff",
                "/allowback",
                "/unleave",
                "/reports"
            ];

            if (
                adminCommands.includes(
                    command
                )
            ) {

                await handleCommand(
                    sock,
                    message,
                    groupId,
                    sender,
                    text
                );
            }

            return;
        }

        /* =================================================
           BOT OFF
        ================================================= */

        if (
            !isBotEnabled(
                groupId
            )
        ) {
            return;
        }

        /* =================================================
           ADMIN BYPASS
        ================================================= */

        if (
            senderIsAdmin
        ) {
            return;
        }

        /* =================================================
           BAD WORD
        ================================================= */

        if (
            TEXT_MODERATION_ENABLED &&
            containsBadWord(text)
        ) {

            const deleted =
                await deleteMessage(
                    sock,
                    message
                );

            if (deleted) {

                console.log(
                    "🗑️ Bad word message deleted."
                );
            }

            return;
        }

        /* =================================================
           LINK
        ================================================= */

        if (
            containsLink(text)
        ) {

            const deleted =
                await deleteMessage(
                    sock,
                    message
                );

            if (deleted) {

                console.log(
                    "🔗 Non-admin link removed."
                );
            }

            return;
        }

        /* =================================================
           DUPLICATE SPAM
        ================================================= */

        if (
            isDuplicateSpam(
                groupId,
                sender,
                text
            )
        ) {

            const deleted =
                await deleteMessage(
                    sock,
                    message
                );

            if (deleted) {

                console.log(
                    "🚫 Duplicate spam message deleted."
                );
            }

            return;
        }

        /* =================================================
           OPENAI TEXT
        ================================================= */

        if (
            OPENAI_API_KEY &&
            TEXT_MODERATION_ENABLED &&
            text
        ) {

            const flagged =
                await moderateTextWithOpenAI(
                    text
                );

            if (flagged) {

                const deleted =
                    await deleteMessage(
                        sock,
                        message
                    );

                if (deleted) {

                    console.log(
                        "🤖 OpenAI flagged text - message deleted."
                    );
                }

                return;
            }
        }

        /* =================================================
           OPENAI IMAGE
        ================================================= */

        const imageMessage =
            message.message
                ?.imageMessage;

        if (
            imageMessage &&
            OPENAI_API_KEY &&
            IMAGE_MODERATION_ENABLED
        ) {

            console.log(
                "🖼️ Image received - checking moderation..."
            );

            const flagged =
                await moderateImageWithOpenAI(
                    sock,
                    message
                );

            if (flagged) {

                const deleted =
                    await deleteMessage(
                        sock,
                        message
                    );

                if (deleted) {

                    console.log(
                        "🔞 Sexual/18+ image removed."
                    );
                }

                return;
            }
        }

    } catch (err) {

        console.log(
            "MESSAGE HANDLER ERROR:",
            err.message
        );
    }
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server =
    http.createServer(
        (
            req,
            res
        ) => {

            res.writeHead(
                200,
                {
                    "Content-Type":
                        "text/plain; charset=utf-8"
                }
            );

            res.end(
                "WhatsApp Bot Running Successfully!"
            );
        }
    );

server.listen(
    PORT,
    () => {

        console.log(
            `🌐 HTTP Server running on port ${PORT}`
        );

        console.log(
            `🎯 Allowed Groups: ${
                ALLOWED_GROUPS.length
                    ? ALLOWED_GROUPS.join(", ")
                    : "ALL GROUPS"
            }`
        );
    }
);

/* =========================================================
   WHATSAPP CONNECTION
========================================================= */

let reconnecting =
    false;

async function startBot() {

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
        `📱 Using Baileys version: ${version.join(".")}`
    );

    console.log(
        "🚀 WhatsApp Bot Starting..."
    );

    console.log(
        "🔄 Connecting to WhatsApp..."
    );

    const sock =
        makeWASocket({
            version,

            auth:
                state,

            logger:
                P({
                    level:
                        "silent"
                }),

            printQRInTerminal:
                false,

            browser: [
                "PIYAS BOT",
                "Chrome",
                "1.0.0"
            ],

            generateHighQualityLinkPreview:
                false,

            syncFullHistory:
                false,

            markOnlineOnConnect:
                false
        });

    /* =====================================================
       CREDS
    ===================================================== */

    sock.ev.on(
        "creds.update",
        saveCreds
    );

    /* =====================================================
       CONNECTION
    ===================================================== */

    sock.ev.on(
        "connection.update",
        async ({
            connection,
            lastDisconnect
        }) => {

            if (
                connection === "open"
            ) {

                reconnecting =
                    false;

                console.log(
                    "✅ WhatsApp Bot Connected Successfully!"
                );

                try {

                    const groups =
                        await sock.groupFetchAllParticipating();

                    for (
                        const groupId of
                        Object.keys(groups)
                    ) {

                        if (
                            isAllowedGroup(
                                groupId
                            )
                        ) {

                            await loadGroupParticipants(
                                sock,
                                groupId
                            );
                        }
                    }

                } catch (err) {

                    console.log(
                        "Group cache load error:",
                        err.message
                    );
                }
            }

            if (
                connection === "close"
            ) {

                const statusCode =
                    new Boom(
                        lastDisconnect?.error
                    )?.output
                        ?.statusCode;

                const shouldReconnect =
                    statusCode !==
                    DisconnectReason.loggedOut;

                console.log(
                    `❌ WhatsApp disconnected. Reconnect: ${shouldReconnect}`
                );

                if (
                    shouldReconnect &&
                    !reconnecting
                ) {

                    reconnecting =
                        true;

                    setTimeout(
                        () => {
                            startBot();
                        },
                        3000
                    );

                } else if (
                    !shouldReconnect
                ) {

                    console.log(
                        "❌ Logged out. Please login again."
                    );
                }
            }
        }
    );

    /* =====================================================
       PARTICIPANT UPDATE
    ===================================================== */

    sock.ev.on(
        "group-participants.update",
        async update => {

            try {

                await handleParticipantUpdate(
                    sock,
                    update
                );

            } catch (err) {

                console.log(
                    "GROUP UPDATE ERROR:",
                    err.message
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
                messages
            ) {

                if (
                    message.key?.fromMe
                ) {
                    continue;
                }

                await handleIncomingMessage(
                    sock,
                    message
                );
            }
        }
    );

    /* =====================================================
       GROUP SUBJECT UPDATE
    ===================================================== */

    sock.ev.on(
        "groups.update",
        updates => {

            for (
                const update of
                updates
            ) {

                if (
                    update.subject
                ) {

                    console.log(
                        `📝 Group name updated: ${update.subject}`
                    );
                }
            }
        }
    );

    return sock;
}

/* =========================================================
   START
========================================================= */

startBot().catch(
    err => {

        console.log(
            "❌ BOT START ERROR:",
            err
        );
    }
);

/* =========================================================
   PROCESS HANDLERS
========================================================= */

process.on(
    "uncaughtException",
    err => {

        console.log(
            "UNCAUGHT EXCEPTION:",
            err.message
        );
    }
);

process.on(
    "unhandledRejection",
    err => {

        console.log(
            "UNHANDLED REJECTION:",
            err
        );
    }
);

process.on(
    "SIGINT",
    () => {

        console.log(
            "🛑 Bot shutting down..."
        );

        server.close();

        process.exit(0);
    }
);

process.on(
    "SIGTERM",
    () => {

        console.log(
            "🛑 Bot shutting down..."
        );

        server.close();

        process.exit(0);
    }
);