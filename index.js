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

const PHONE_NUMBER =
    String(process.env.PHONE_NUMBER || "").trim();

const WEBSITE_URL =
    process.env.WEBSITE_URL ||
    "https://x-cyber-2025.github.io/X-cyber.web/";

const ALLOWED_GROUPS = (
    process.env.ALLOWED_GROUPS || ""
)
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

const PAIRING_FILE =
    "./pairing_number.txt";

/* =========================================================
   DIRECTORIES
========================================================= */

fs.mkdirSync(
    AUTH_DIR,
    {
        recursive: true
    }
);

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
            err?.message || err
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
            err?.message || err
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

/*
 * Same message within 1 minute = spam
 */
const duplicateCache =
    new Map();

/*
 * Simple flood protection
 */
const floodCache =
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
            "");
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

    return Boolean(
        ap &&
        bp &&
        ap === bp
    );
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

            if (
                x === y
            ) {
                return true;
            }

            if (
                x.endsWith("@s.whatsapp.net") &&
                y.endsWith("@s.whatsapp.net") &&
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

        Object.assign(
            existing,
            mergeIdentity(
                existing,
                identity
            )
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
        welcomeStatus[groupId] !== false
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
   GROUP CACHE
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
            `📦 Participant cache loaded: ${groupId}`
        );

    } catch (err) {

        console.log(
            "Participant cache error:",
            err?.message || err
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
            err?.message || err
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

    return Boolean(
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
   MESSAGE TEXT
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
    "সালি",
    "সালী",
    "শালি",
    "ষালি",
    "ষালী",

    "খাংকি",
    "খাংকী",
    "খানকি",
    "খানকী",
    "খানকির",

    "মাগি",
    "মাগী",

    "বেসসা",
    "বেশ্যা",
    "বেশসা",
    "বেস্যা",

    "নটি",
    "নটী",
    "নডি",
    "নডী",

    "লাং",
    "লাঙ্গ",

    "চুদ",
    "চুদা",
    "চুদি",
    "চুদী",
    "চুদির",
    "চুদমু",

    "চোদ",
    "চোদা",
    "চোদি",
    "চোদী",
    "চোদমু",

    "ছোদা",
    "ছোদি",
    "ছোদমু",

    "ছুদা",
    "ছুদি",
    "ছুদমু",
    "ছোডি",

    "বাল",
    "আবাল",

    "বোকাচুদা",
    "বুকাচুদা",
    "বোকাছোদা",
    "বুকাছোদা",
    "বোকাছুদা",
    "বুকাচুধা",

    "মাদারচুদ",
    "মাদারচোদ",
    "মাদারছোদ",
    "মাদারছুদ",
    "মাধারচুদ",

    "মাং শাওয়্যা",
    "শাওয়্যা",
    "সাওয়্যা",
    "সাওয়া",

    "সেক্স",
    "এক্সক্সক্স",

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
    "bullshit"
];

function normalizeText(
    text
) {
    return String(text || "")
        .toLowerCase()
        .normalize("NFKC")
        .replace(
            /[\u200B-\u200D\uFEFF]/g,
            ""
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}

function containsBadWord(
    text
) {
    const normalized =
        normalizeText(text);

    if (!normalized) {
        return false;
    }

    return BAD_WORDS.some(
        word =>
            normalized.includes(
                normalizeText(word)
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

    return /(https?:\/\/|www\.|t\.me\/|wa\.me\/|chat\.whatsapp\.com\/|telegram\.me\/|bit\.ly\/|tinyurl\.com\/)/i.test(
        text
    );
}

/* =========================================================
   DUPLICATE SPAM
   SAME MESSAGE WITHIN 1 MINUTE = SPAM
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

    const normalizedText =
        normalizeText(text);

    if (!normalizedText) {
        return false;
    }

    const key =
        `${groupId}:${cleanJid(sender)}:${normalizedText}`;

    const now =
        Date.now();

    const oldTime =
        duplicateCache.get(
            key
        );

    duplicateCache.set(
        key,
        now
    );

    /*
     * Delete old cache entries periodically.
     */

    if (
        duplicateCache.size > 5000
    ) {

        for (
            const [
                cacheKey,
                cacheTime
            ] of duplicateCache
        ) {

            if (
                now - cacheTime >
                60 * 1000
            ) {

                duplicateCache.delete(
                    cacheKey
                );
            }
        }
    }

    /*
     * Same message within 1 minute
     */

    if (
        oldTime &&
        now - oldTime <=
        60 * 1000
    ) {

        return true;
    }

    return false;
}

/* =========================================================
   FLOOD SPAM
   8 messages within 10 seconds
========================================================= */

function isFloodSpam(
    groupId,
    sender
) {
    if (
        !groupId ||
        !sender
    ) {
        return false;
    }

    const key =
        `${groupId}:${cleanJid(sender)}`;

    const now =
        Date.now();

    let list =
        floodCache.get(
            key
        ) || [];

    list.push(now);

    list =
        list.filter(
            timestamp =>
                now - timestamp <=
                10 * 1000
        );

    floodCache.set(
        key,
        list
    );

    if (
        floodCache.size > 3000
    ) {

        for (
            const [
                cacheKey,
                timestamps
            ] of floodCache
        ) {

            const recent =
                timestamps.filter(
                    timestamp =>
                        now - timestamp <=
                        10 * 1000
                );

            if (!recent.length) {
                floodCache.delete(
                    cacheKey
                );
            }
        }
    }

    return (
        list.length >= 8
    );
}

/* =========================================================
   OPENAI TEXT MODERATION
========================================================= */

async function moderateTextWithOpenAI(
    text
) {
    if (
        !OPENAI_API_KEY ||
        !TEXT_MODERATION_ENABLED ||
        !text
    ) {
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
                "OpenAI text moderation error:",
                response.status
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
            err?.message || err
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
    if (
        !OPENAI_API_KEY ||
        !IMAGE_MODERATION_ENABLED
    ) {
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
                response.status
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
            err?.message || err
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

        if (
            !message?.key?.remoteJid ||
            !message?.key?.id
        ) {
            return false;
        }

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
            err?.message || err
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
            err?.message || err
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
│ /deal /ডিল
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

    if (!admins.length) {
        return "❌ কোনো Admin পাওয়া যায়নি।";
    }

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

            const phone =
                jidToPhone(
                    admin.id
                ) ||
                admin.id;

            text +=
                `${index + 1}️⃣ @${phone}\n`;
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
                err?.message || err
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
            `👋 Welcome sent | User: ${name} | Group: ${groupName}`
        );

    } catch (err) {

        console.log(
            "Welcome error:",
            err?.message || err
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
        `🚫 BLACKLISTED REJOIN: ${
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
            "❌ Bot is not admin. Cannot remove member."
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
            `✅ Blacklisted member removed: ${target}`
        );

        return true;

    } catch (err) {

        console.log(
            `❌ Failed to remove member: ${err?.message || err}`
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

            /*
             * Bot removed
             */

            if (
                authorIsBot
            ) {

                console.log(
                    `🤖 BOT REMOVED: ${participantJid} | NO BLACKLIST`
                );

                continue;
            }

            /*
             * Admin / other person removed
             */

            if (
                author &&
                !authorIsParticipant
            ) {

                console.log(
                    `👑 ADMIN/OTHER USER REMOVED: ${participantJid} | NO BLACKLIST`
                );

                continue;
            }

            /*
             * Self leave
             */

            if (
                authorIsParticipant
            ) {

                const added =
                    addToBlacklist(
                        groupId,
                        participantIdentity,
                        "self_leave"
                    );

                console.log(
                    added
                        ? `🚫 BLACKLIST ADDED: ${participantJid}`
                        : `🚫 ALREADY BLACKLISTED: ${participantJid}`
                );

                continue;
            }

            if (!author) {

                console.log(
                    `⚠️ REMOVE WITHOUT AUTHOR: ${participantJid} | NO BLACKLIST`
                );

                continue;
            }
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
                "❌ যাকে Report করতে চান তাকে @mention করুন.\n\nExample:\n/report @user কারণ",
                message
            );

            return;
        }

        if (!args) {

            await reply(
                sock,
                groupId,
                "❌ Report করার কারণ লিখুন.\n\nExample:\n/report @user Spam করছে",
                message
            );

            return;
        }

        addReport(
            groupId,
            sender,
            mentioned[0],
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
       BOT ON
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

    /* =====================================================
       BOT OFF
    ===================================================== */

    if (
        command === "/off" ||
        command === "/botoff" ||
        command === "/offbot"
    ) {

        if (!admin) {

            await reply(
                sock,
                groupId,
                "⛔ শুধু Admin/Owner এই command ব্যবহার করতে পারবেন।",
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

    /* =====================================================
       FULL BOT STATUS
    ===================================================== */

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

🔁 Duplicate Spam:
🟢 1 minute

🌊 Flood Spam:
🟢 8 messages / 10 seconds

╭━━━━━━━━━━━━━━━━━━━━╮
        ❤️ *PIYAS BOT*
╰━━━━━━━━━━━━━━━━━━━━╯
`.trim(),
            message
        );

        return;
    }

    /* =====================================================
       WELCOME ON
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

    /* =====================================================
       WELCOME OFF
    ===================================================== */

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
       ALLOW BACK
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
                "❌ যাকে Blacklist থেকে বাদ দিতে চান তাকে @mention করুন.\n\nExample:\n/allowback @user",
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

        await reply(
            sock,
            groupId,
            removed
                ? `✅ @${jidToPhone(target) || target} কে Blacklist থেকে সরানো হয়েছে।`
                : "ℹ️ এই সদস্য Blacklist-এ পাওয়া যায়নি।",
            message
        );

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

        if (
            !isBotEnabled(
                groupId
            )
        ) {
            return;
        }

        /*
         * Admin/Owner bypass
         */

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
                    "🔗 Link message deleted."
                );
            }

            return;
        }

        /* =================================================
           DUPLICATE SPAM
           SAME MESSAGE WITHIN 1 MINUTE
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
                    "🚫 Duplicate spam message deleted. Same message within 1 minute."
                );
            }

            return;
        }

        /* =================================================
           FLOOD SPAM
        ================================================= */

        if (
            isFloodSpam(
                groupId,
                sender
            )
        ) {

            const deleted =
                await deleteMessage(
                    sock,
                    message
                );

            if (deleted) {

                console.log(
                    "🚫 Flood spam message deleted."
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
            err?.message || err
        );
    }
}

/* =========================================================
   PAIRING CODE
========================================================= */

let pairingRequested =
    false;

async function requestPairingCode(
    sock,
    state
) {
    if (
        state.creds.registered ||
        pairingRequested
    ) {
        return;
    }

    const phone =
        normalizePhone(
            PHONE_NUMBER
        );

    if (!phone) {

        console.log(
            "❌ PHONE_NUMBER পাওয়া যায়নি।"
        );

        console.log(
            "Example:"
        );

        console.log(
            "PHONE_NUMBER=8801XXXXXXXXX"
        );

        return;
    }

    if (
        !/^\d{8,15}$/.test(
            phone
        )
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

        return;
    }

    pairingRequested =
        true;

    try {

        console.log("");
        console.log(
            "📱 Pairing Number:",
            phone
        );

        console.log(
            "🔐 Requesting WhatsApp Pairing Code..."
        );

        await sleep(
            3000
        );

        if (
            state.creds.registered
        ) {

            pairingRequested =
                false;

            return;
        }

        const code =
            await sock.requestPairingCode(
                phone
            );

        const formattedCode =
            String(code || "")
                .match(
                    /.{1,4}/g
                )
                ?.join("-") ||
            String(code || "");

        console.log("");
        console.log(
            "╔════════════════════════════╗"
        );
        console.log(
            "║      🔐 PAIRING CODE       ║"
        );
        console.log(
            "╠════════════════════════════╣"
        );
        console.log(
            `║  ${formattedCode}`
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
            "⚠️ Pairing codeটি দ্রুত ব্যবহার করুন।"
        );

    } catch (error) {

        pairingRequested =
            false;

        console.log("");
        console.log(
            "❌ PAIRING CODE ERROR:"
        );

        console.log(
            error?.message ||
            error
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
    "0.0.0.0",
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

        /* =================================================
           CREDS
        ================================================= */

        sock.ev.on(
            "creds.update",
            saveCreds
        );

        /* =================================================
           REQUEST PAIRING CODE
           Does NOT wait for QR
        ================================================= */

        if (
            !state.creds.registered
        ) {

            setTimeout(
                () => {

                    requestPairingCode(
                        sock,
                        state
                    );

                },
                4000
            );
        }

        /* =================================================
           CONNECTION
        ================================================= */

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
                        "🤖 PIYAS BOT is online."
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
                            err?.message || err
                        );
                    }
                }

                if (
                    connection === "close"
                ) {

                    const statusCode =
                        new Boom(
                            lastDisconnect?.error
                        )
                            ?.output
                            ?.statusCode;

                    const shouldReconnect =
                        statusCode !==
                        DisconnectReason.loggedOut;

                    pairingRequested =
                        false;

                    console.log("");
                    console.log(
                        `❌ WhatsApp disconnected. Code: ${
                            statusCode ||
                            "UNKNOWN"
                        }`
                    );

                    console.log(
                        `🔄 Reconnect: ${shouldReconnect}`
                    );

                    if (
                        shouldReconnect &&
                        !reconnecting
                    ) {

                        reconnecting =
                            true;

                        setTimeout(
                            () => {

                                startBot()
                                    .catch(
                                        err =>
                                            console.log(
                                                "Reconnect error:",
                                                err?.message || err
                                            )
                                    );

                            },
                            5000
                        );

                    } else if (
                        !shouldReconnect
                    ) {

                        console.log(
                            "❌ Logged out."
                        );

                        console.log(
                            "🧹 Delete auth_info folder and login again."
                        );
                    }
                }
            }
        );

        /* =================================================
           PARTICIPANT UPDATE
        ================================================= */

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
                        err?.message || err
                    );
                }
            }
        );

        /* =================================================
           MESSAGES
        ================================================= */

        sock.ev.on(
            "messages.upsert",
            async ({
                messages,
                type
            }) => {

                if (
                    type &&
                    type !== "notify"
                ) {
                    return;
                }

                for (
                    const message of
                    messages
                ) {

                    /*
                     * Bot's own messages are ignored.
                     * This prevents the bot from moderating
                     * its own replies.
                     */

                    if (
                        message.key?.fromMe
                    ) {
                        continue;
                    }

                    try {

                        await handleIncomingMessage(
                            sock,
                            message
                        );

                    } catch (err) {

                        console.log(
                            "MESSAGE EVENT ERROR:",
                            err?.message || err
                        );
                    }
                }
            }
        );

        /* =================================================
           GROUP SUBJECT UPDATE
        ================================================= */

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

    } catch (err) {

        console.log(
            "❌ START BOT ERROR:",
            err?.message || err
        );

        if (
            !reconnecting
        ) {

            reconnecting =
                true;

            setTimeout(
                () => {

                    reconnecting =
                        false;

                    startBot()
                        .catch(
                            error =>
                                console.log(
                                    "Retry error:",
                                    error?.message || error
                                )
                        );

                },
                5000
            );
        }
    }
}

/* =========================================================
   START
========================================================= */

console.log("");
console.log(
    "======================================"
);
console.log(
    "          PIYAS BOT"
);
console.log(
    "======================================"
);
console.log("");

console.log(
    "🤖 WhatsApp Bot Starting..."
);

console.log(
    `📱 Pairing Number: ${
        normalizePhone(PHONE_NUMBER) ||
        "NOT SET"
    }`
);

console.log(
    `🛡️ Text Moderation: ${
        TEXT_MODERATION_ENABLED
            ? "ON"
            : "OFF"
    }`
);

console.log(
    `🖼️ Image Moderation: ${
        IMAGE_MODERATION_ENABLED
            ? "ON"
            : "OFF"
    }`
);

console.log(
    "🔁 Duplicate Spam: 1 minute"
);

console.log(
    "🌊 Flood Spam: 8 messages / 10 seconds"
);

console.log("");

startBot().catch(
    err => {

        console.log(
            "❌ BOT START ERROR:",
            err?.message || err
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
            err?.message || err
        );
    }
);

process.on(
    "unhandledRejection",
    err => {

        console.log(
            "UNHANDLED REJECTION:",
            err?.message || err
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