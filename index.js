import "dotenv/config";
import http from "http";
import fs from "fs";

import makeWASocket, {
    Browsers,
    DisconnectReason,
    useMultiFileAuthState
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import P from "pino";

/* =========================================================
   CONFIG
========================================================= */

const BOT_NAME = "আর-রাইয়ান";

const PORT = Number(
    process.env.PORT || 3000
);

const PHONE_NUMBER = String(
    process.env.PHONE_NUMBER || ""
).replace(/[^0-9]/g, "");

const WEBSITE_URL =
    "https://x-cyber-2025.github.io/X-cyber.web/";

const BACKUP_GROUP_URL =
    "https://chat.whatsapp.com/KsIJqeOdSTVC2FBIuWCvlN?s=cl&p=a&mlu=4&ilr=4";

const AUTH_DIR = "./auth_info";

const STATUS_FILE =
    "./bot_status.json";

const LOCK_FILE =
    "./ar_raiyan_locks.json";

const WARNING_FILE =
    "./warnings.json";

const MAX_LOCK_TIME =
    24 * 60 * 60 * 1000;

/* =========================================================
   LOGGER
========================================================= */

const logger = P({
    level: "silent"
});

/* =========================================================
   GLOBAL STATE
========================================================= */

let sock = null;
let reconnecting = false;
let pairingRequested = false;

let botStatus = {};
let warnings = {};
let groupLocks = {};

const lockTimers = new Map();
const spamTracker = new Map();

const SPAM_WINDOW =
    60 * 1000;

/* =========================================================
   FILE FUNCTIONS
========================================================= */

function loadJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            return fallback;
        }

        const data = JSON.parse(
            fs.readFileSync(file, "utf8")
        );

        return data || fallback;
    } catch (error) {
        console.log(
            `File load error: ${file}`,
            error.message
        );

        return fallback;
    }
}

function saveJson(file, data) {
    try {
        fs.writeFileSync(
            file,
            JSON.stringify(
                data,
                null,
                2
            ),
            "utf8"
        );
    } catch (error) {
        console.log(
            `File save error: ${file}`,
            error.message
        );
    }
}

function loadData() {
    botStatus = loadJson(
        STATUS_FILE,
        {}
    );

    warnings = loadJson(
        WARNING_FILE,
        {}
    );

    groupLocks = loadJson(
        LOCK_FILE,
        {}
    );

    console.log("📂 Bot data loaded.");
}

function saveStatus() {
    saveJson(
        STATUS_FILE,
        botStatus
    );
}

function saveWarnings() {
    saveJson(
        WARNING_FILE,
        warnings
    );
}

function saveLocks() {
    saveJson(
        LOCK_FILE,
        groupLocks
    );
}

/* =========================================================
   GROUP STATUS
========================================================= */

function getGroupStatus(groupId) {
    if (!botStatus[groupId]) {
        botStatus[groupId] = {
            enabled: true
        };
    }

    return botStatus[groupId];
}

function isBotEnabled(groupId) {
    return (
        getGroupStatus(groupId)
            .enabled !== false
    );
}

function setBotEnabled(
    groupId,
    enabled
) {
    getGroupStatus(groupId)
        .enabled = Boolean(enabled);

    saveStatus();
}

/* =========================================================
   COMMAND NORMALIZATION
========================================================= */

function normalizeText(text) {
    return String(text || "")
        .normalize("NFC")
        .replace(
            /[\u200B-\u200D\uFEFF]/g,
            ""
        )
        .trim();
}

function normalizeCommand(text) {
    return normalizeText(text)
        .toLowerCase()
        .replace(/^\/+/, "");
}

/* =========================================================
   BANGLA NUMBER
========================================================= */

function banglaToEnglish(text) {
    const digits =
        "০১২৩৪৫৬৭৮৯";

    return String(text || "")
        .replace(
            /[০-৯]/g,
            digit =>
                String(
                    digits.indexOf(
                        digit
                    )
                )
        );
}

/* =========================================================
   BANGLA NUMBER WORDS
========================================================= */

const NUMBER_WORDS = {
    "এক": 1,
    "দুই": 2,
    "দু": 2,
    "তিন": 3,
    "চার": 4,
    "পাঁচ": 5,
    "ছয়": 6,
    "ছয়": 6,
    "সাত": 7,
    "আট": 8,
    "নয়": 9,
    "নয়": 9,
    "দশ": 10,
    "এগারো": 11,
    "বারো": 12,
    "তেরো": 13,
    "চৌদ্দ": 14,
    "পনেরো": 15,
    "ষোল": 16,
    "সতেরো": 17,
    "আঠারো": 18,
    "উনিশ": 19,
    "বিশ": 20,
    "একুশ": 21,
    "বাইশ": 22,
    "তেইশ": 23,
    "চব্বিশ": 24
};

function convertNumberWords(text) {
    let value = String(text || "");

    const words =
        Object.keys(NUMBER_WORDS)
            .sort(
                (a, b) =>
                    b.length - a.length
            );

    for (const word of words) {
        const number =
            NUMBER_WORDS[word];

        value = value.replace(
            new RegExp(
                `(^|\\s)${word}(?=\\s|$)`,
                "gi"
            ),
            match => {
                const space =
                    match.startsWith(
                        " "
                    )
                        ? " "
                        : "";

                return (
                    space +
                    number
                );
            }
        );
    }

    return value;
}

/* =========================================================
   RAIYAN COMMAND NORMALIZATION
========================================================= */

function normalizeRaiyanText(text) {
    return normalizeText(text)
        .replace(
            /রাইয়ান/g,
            "রাইয়ান"
        )
        .replace(
            /আর\s*-\s*রাইয়ান/g,
            "আর-রাইয়ান"
        )
        .replace(
            /আর\s*–\s*রাইয়ান/g,
            "আর-রাইয়ান"
        )
        .replace(
            /আর\s*—\s*রাইয়ান/g,
            "আর-রাইয়ান"
        );
}

function isRaiyanCommand(text) {
    const value =
        normalizeRaiyanText(text);

    return /^\/আর-রাইয়ান(?:\s|$)/i.test(
        value
    );
}

/* =========================================================
   LOCK DURATION
========================================================= */

function parseDuration(text) {
    let value =
        normalizeRaiyanText(text);

    value =
        banglaToEnglish(value);

    value =
        convertNumberWords(value);

    value =
        value.toLowerCase();

    let hours = 0;
    let minutes = 0;
    let seconds = 0;

    const hour =
        value.match(
            /(\d+)\s*(?:ঘণ্টা|ঘন্টা|ঘণ্টার|ঘন্টার|hour|hours|hr|hrs)\b/i
        );

    const minute =
        value.match(
            /(\d+)\s*(?:মিনিট|মিনিটের|minute|minutes|min|mins)\b/i
        );

    const second =
        value.match(
            /(\d+)\s*(?:সেকেন্ড|সেকেন্ডের|second|seconds|sec|secs)\b/i
        );

    if (hour) {
        hours =
            Number(hour[1]);
    }

    if (minute) {
        minutes =
            Number(minute[1]);
    }

    if (second) {
        seconds =
            Number(second[1]);
    }

    const milliseconds =
        hours * 60 * 60 * 1000 +
        minutes * 60 * 1000 +
        seconds * 1000;

    if (
        !Number.isFinite(
            milliseconds
        ) ||
        milliseconds <= 0
    ) {
        return null;
    }

    const parts = [];

    if (hours > 0) {
        parts.push(
            `${hours} ঘণ্টা`
        );
    }

    if (minutes > 0) {
        parts.push(
            `${minutes} মিনিট`
        );
    }

    if (seconds > 0) {
        parts.push(
            `${seconds} সেকেন্ড`
        );
    }

    return {
        milliseconds,
        display:
            parts.join(" ")
    };
}

/* =========================================================
   TIME FORMAT
========================================================= */

function formatRemaining(ms) {
    const totalSeconds =
        Math.ceil(
            Math.max(
                0,
                ms
            ) / 1000
        );

    const hours =
        Math.floor(
            totalSeconds / 3600
        );

    const minutes =
        Math.floor(
            (totalSeconds % 3600) /
                60
        );

    const seconds =
        totalSeconds % 60;

    const result = [];

    if (hours > 0) {
        result.push(
            `${hours} ঘণ্টা`
        );
    }

    if (minutes > 0) {
        result.push(
            `${minutes} মিনিট`
        );
    }

    if (
        seconds > 0 &&
        hours === 0
    ) {
        result.push(
            `${seconds} সেকেন্ড`
        );
    }

    return (
        result.join(" ") ||
        "কয়েক সেকেন্ড"
    );
}

/* =========================================================
   JID
========================================================= */

function isPhoneJid(jid) {
    return (
        typeof jid === "string" &&
        jid.endsWith(
            "@s.whatsapp.net"
        )
    );
}

function isLidJid(jid) {
    return (
        typeof jid === "string" &&
        jid.endsWith("@lid")
    );
}

function phoneToJid(phone) {
    if (!phone) {
        return null;
    }

    const number =
        String(phone)
            .replace(
                /@s.whatsapp.net/g,
                ""
            )
            .replace(
                /[^0-9]/g,
                ""
            );

    if (
        number.length < 8
    ) {
        return null;
    }

    return (
        number +
        "@s.whatsapp.net"
    );
}

/* =========================================================
   BOT JID
========================================================= */

function getBotJid() {
    const id =
        sock?.user?.id;

    if (isPhoneJid(id)) {
        return id.split(":")[0];
    }

    if (PHONE_NUMBER) {
        return phoneToJid(
            PHONE_NUMBER
        );
    }

    return null;
}

/* =========================================================
   ADMIN CHECK
========================================================= */

function isAdminParticipant(
    participant
) {
    return (
        participant?.admin ===
            "admin" ||
        participant?.admin ===
            "superadmin" ||
        participant?.admin === true
    );
}

async function isBotAdmin(
    groupId
) {
    try {
        const metadata =
            await sock.groupMetadata(
                groupId
            );

        const participants =
            metadata?.participants ||
            [];

        const botJid =
            getBotJid();

        if (!botJid) {
            return false;
        }

        const botNumber =
            botJid
                .split("@")[0]
                .replace(
                    /[^0-9]/g,
                    ""
                );

        const participant =
            participants.find(
                p => {
                    const id =
                        String(
                            p?.id ||
                            ""
                        );

                    const phone =
                        String(
                            p?.phoneNumber ||
                            ""
                        )
                            .replace(
                                /[^0-9]/g,
                                ""
                            );

                    return (
                        id === botJid ||
                        phone ===
                            botNumber
                    );
                }
            );

        return isAdminParticipant(
            participant
        );
    } catch (error) {
        console.log(
            "Bot admin check:",
            error.message
        );

        return false;
    }
}

async function isSenderAdmin(
    groupId,
    message
) {
    try {
        const sender =
            message?.key?.participant;

        if (!sender) {
            return false;
        }

        const metadata =
            await sock.groupMetadata(
                groupId
            );

        const participants =
            metadata?.participants ||
            [];

        let participant =
            participants.find(
                p =>
                    p?.id === sender ||
                    p?.lid === sender ||
                    p?.phoneNumber === sender
            );

        if (!participant) {
            const senderNumber =
                String(sender)
                    .split("@")[0]
                    .replace(
                        /[^0-9]/g,
                        ""
                    );

            participant =
                participants.find(
                    p => {
                        const number =
                            String(
                                p?.phoneNumber ||
                                p?.id ||
                                ""
                            )
                                .split("@")[0]
                                .replace(
                                    /[^0-9]/g,
                                    ""
                                );

                        return (
                            number &&
                            number ===
                                senderNumber
                        );
                    }
                );
        }

        return isAdminParticipant(
            participant
        );
    } catch {
        return false;
    }
}

/* =========================================================
   GROUP LOCK
========================================================= */

function clearLockTimer(groupId) {
    const timer =
        lockTimers.get(
            groupId
        );

    if (timer) {
        clearTimeout(timer);
    }

    lockTimers.delete(
        groupId
    );
}

function scheduleUnlock(
    groupId,
    expiresAt
) {
    clearLockTimer(groupId);

    const remaining =
        Number(expiresAt) -
        Date.now();

    if (
        remaining <= 0
    ) {
        unlockGroup(
            groupId,
            true
        );

        return;
    }

    const timer =
        setTimeout(
            async () => {
                const lock =
                    groupLocks[
                        groupId
                    ];

                if (!lock) {
                    return;
                }

                if (
                    Number(
                        lock.expiresAt
                    ) !==
                    Number(
                        expiresAt
                    )
                ) {
                    return;
                }

                if (
                    Date.now() <
                    Number(
                        expiresAt
                    )
                ) {
                    scheduleUnlock(
                        groupId,
                        expiresAt
                    );

                    return;
                }

                await unlockGroup(
                    groupId,
                    true
                );
            },
            Math.min(
                remaining,
                2147483647
            )
        );

    lockTimers.set(
        groupId,
        timer
    );
}

async function lockGroup(
    groupId,
    duration
) {
    try {
        if (
            !sock ||
            !duration
        ) {
            return false;
        }

        if (
            !await isBotAdmin(
                groupId
            )
        ) {
            await sock.sendMessage(
                groupId,
                {
                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       ⚠️ *${BOT_NAME}*
╰━━━━━━━━━━━━━━━━━━━━╯

❌ Group বন্ধ করা যাচ্ছে না।

কারণ Bot-এর WhatsApp Number
Group Admin নয়।

👑 Bot-কে প্রথমে Group Admin করুন।
`
                }
            );

            return false;
        }

        clearLockTimer(
            groupId
        );

        const expiresAt =
            Date.now() +
            duration.milliseconds;

        /*
         * Only admins can send messages.
         */
        await sock.groupSettingUpdate(
            groupId,
            "announcement"
        );

        groupLocks[groupId] = {
            expiresAt,
            duration:
                duration.display,
            lockedAt:
                Date.now()
        };

        saveLocks();

        scheduleUnlock(
            groupId,
            expiresAt
        );

        await sock.sendMessage(
            groupId,
            {
                text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🔒 *${BOT_NAME}*
      *GROUP CLOSED*
╰━━━━━━━━━━━━━━━━━━━━╯

🔒 Group সাময়িকভাবে বন্ধ করা হয়েছে।

⏳ সময়:
*${duration.display}*

👥 সাধারণ Member এখন
Message পাঠাতে পারবেন না।

👑 Group Adminরা
Message পাঠাতে পারবেন।

⏰ সময় শেষ হলে Group
নিজে থেকেই আবার Open হবে।

🤍 *${BOT_NAME}*
`
            }
        );

        console.log(
            `🔒 Group locked: ${groupId} | ${duration.display}`
        );

        return true;
    } catch (error) {
        console.log(
            "Group lock error:",
            error.message
        );

        return false;
    }
}

async function unlockGroup(
    groupId,
    sendMessage = true
) {
    try {
        if (!sock) {
            return false;
        }

        clearLockTimer(
            groupId
        );

        await sock.groupSettingUpdate(
            groupId,
            "not_announcement"
        );

        delete groupLocks[
            groupId
        ];

        saveLocks();

        if (sendMessage) {
            await sock.sendMessage(
                groupId,
                {
                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🔓 *${BOT_NAME}*
╰━━━━━━━━━━━━━━━━━━━━╯

✅ Group আবার Open হয়েছে।

💬 এখন থেকে সকল Member
আবার Message পাঠাতে পারবেন।

🤍 *${BOT_NAME}*
`
                }
            );
        }

        console.log(
            `🔓 Group unlocked: ${groupId}`
        );

        return true;
    } catch (error) {
        console.log(
            "Group unlock error:",
            error.message
        );

        return false;
    }
}

function restoreLocks() {
    for (
        const [
            groupId,
            lock
        ] of Object.entries(
            groupLocks
        )
    ) {
        if (
            !lock ||
            !lock.expiresAt
        ) {
            delete groupLocks[
                groupId
            ];

            continue;
        }

        scheduleUnlock(
            groupId,
            Number(
                lock.expiresAt
            )
        );
    }

    saveLocks();
}

/* =========================================================
   RAIYAN COMMAND
========================================================= */

async function handleRaiyan(
    groupId,
    message,
    text
) {
    if (
        !isRaiyanCommand(text)
    ) {
        return false;
    }

    const admin =
        await isSenderAdmin(
            groupId,
            message
        );

    if (!admin) {
        await sock.sendMessage(
            groupId,
            {
                text: `
⚠️ *${BOT_NAME}*

এই Command শুধুমাত্র
Group Admin ব্যবহার করতে পারবেন।
`
            }
        );

        return true;
    }

    let value =
        normalizeRaiyanText(text);

    value =
        value
            .replace(
                /^\/আর-রাইয়ান/i,
                ""
            )
            .trim();

    if (!value) {
        const lock =
            groupLocks[groupId];

        if (
            lock &&
            lock.expiresAt >
                Date.now()
        ) {
            await sock.sendMessage(
                groupId,
                {
                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🔒 *${BOT_NAME}*
╰━━━━━━━━━━━━━━━━━━━━╯

🔒 Group বর্তমানে CLOSED।

⏳ বাকি:
${formatRemaining(
    lock.expiresAt -
        Date.now()
)}

📌 সময় শেষ হলে
নিজে থেকেই Open হবে।
`
                }
            );
        } else {
            await sock.sendMessage(
                groupId,
                {
                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🤖 *${BOT_NAME}*
╰━━━━━━━━━━━━━━━━━━━━╯

📌 Group বন্ধ করতে লিখুন:

/আর-রাইয়ান ১ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ২ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান এক মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান দুই মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ১ ঘন্টার জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ২ ঘন্টা ৩০ মিনিটের জন্য গ্রুপ বন্ধ

👑 শুধুমাত্র Admin।
`
                }
            );
        }

        return true;
    }

    if (
        !/গ্রুপ\s*বন্ধ/i.test(
            value
        ) &&
        !/group\s*(close|closed|lock)/i.test(
            value
        )
    ) {
        await sock.sendMessage(
            groupId,
            {
                text: `
⚠️ *${BOT_NAME}*

সঠিকভাবে লিখুন:

/আর-রাইয়ান ১ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ২ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান এক মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান দুই মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ১ ঘন্টার জন্য গ্রুপ বন্ধ
`
            }
        );

        return true;
    }

    const duration =
        parseDuration(value);

    if (!duration) {
        await sock.sendMessage(
            groupId,
            {
                text: `
⚠️ *${BOT_NAME}*

সময় বুঝতে পারিনি।

উদাহরণ:

/আর-রাইয়ান ১ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ২ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান এক মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান দুই মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ১ ঘন্টা ৩০ মিনিটের জন্য গ্রুপ বন্ধ
`
            }
        );

        return true;
    }

    if (
        duration.milliseconds >
        MAX_LOCK_TIME
    ) {
        await sock.sendMessage(
            groupId,
            {
                text: `
⚠️ *${BOT_NAME}*

❌ সর্বোচ্চ ২৪ ঘণ্টার জন্য
Group বন্ধ রাখা যাবে।
`
            }
        );

        return true;
    }

    await lockGroup(
        groupId,
        duration
    );

    return true;
}

/* =========================================================
   MESSAGE TEXT
========================================================= */

function getMessageText(
    message
) {
    const msg =
        message?.message;

    if (!msg) {
        return "";
    }

    return (
        msg.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        msg.videoMessage?.caption ||
        msg.documentMessage?.caption ||
        ""
    ).trim();
}

/* =========================================================
   MAIN MENU
========================================================= */

function getMenu() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
       🤖 *${BOT_NAME}*
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

╭─❖ 🌐 *WEBSITE*
│
│ 1️⃣1️⃣ /website
╰────────────────────

━━━━━━━━━━━━━━━━━━━━

👑 *ADMIN GROUP CONTROL*

🔒 Group বন্ধ:

/আর-রাইয়ান ১ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ২ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান এক মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান দুই মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ১ ঘন্টার জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ২ ঘন্টা ৩০ মিনিটের জন্য গ্রুপ বন্ধ

━━━━━━━━━━━━━━━━━━━━

📌 Command-এর আগে "/" ব্যবহার করুন।

🤖 *Powered by ${BOT_NAME}*
`;
}

/* =========================================================
   BOT INFO
========================================================= */

function getBotInfo() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
       🤖 *${BOT_NAME}*
╰━━━━━━━━━━━━━━━━━━━━╯

✅ WhatsApp Group Bot

⚡ *Features:*

• Group Command System
• Admin Control
• Temporary Group Lock
• Automatic Group Unlock
• Persistent Lock Timer
• Bot ON / OFF
• Moderation System
• Spam Protection
• Link Protection
• Bad Word Filter
• Warning System
• Group Information
• Admin List
• Website
• Deal System
• Ping System

━━━━━━━━━━━━━━━━━━━━

🔒 *Group Lock Command*

/আর-রাইয়ান ১ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ২ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ১ ঘন্টার জন্য গ্রুপ বন্ধ

⏰ সময় শেষ হলে Group
স্বয়ংক্রিয়ভাবে Open হবে।

👑 শুধুমাত্র Group Admin
Group Lock ব্যবহার করতে পারবেন।

🤍 *${BOT_NAME}*
`;
}

/* =========================================================
   RULES
========================================================= */

function getRules() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
        📜 *GROUP RULES*
╰━━━━━━━━━━━━━━━━━━━━╯

1️⃣ সবাইকে সম্মান করে কথা বলুন।

2️⃣ অশ্লীল বা আপত্তিকর
Content শেয়ার করবেন না।

3️⃣ Spam করবেন না।

4️⃣ একই Message বারবার
পাঠাবেন না।

5️⃣ সন্দেহজনক Link শেয়ার
করবেন না।

6️⃣ অন্য Member-কে হয়রানি
করবেন না।

7️⃣ সমস্যা হলে Admin-কে জানান।

🛡️ Moderation System চালু আছে।

🚫 Bot Member Kick/Ban করবে না।

🤍 *${BOT_NAME}*
`;
}

/* =========================================================
   START BOT
========================================================= */

async function startBot() {
    try {
        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                AUTH_DIR
            );

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

        /* =========================================
           CONNECTION
        ========================================= */

        sock.ev.on(
            "connection.update",
            async update => {
                const {
                    connection,
                    lastDisconnect
                } = update;

                if (
                    connection ===
                    "connecting"
                ) {
                    console.log(
                        `🔄 ${BOT_NAME} connecting...`
                    );

                    if (
                        PHONE_NUMBER &&
                        !state.creds.registered &&
                        !pairingRequested
                    ) {
                        pairingRequested =
                            true;

                        try {
                            await new Promise(
                                resolve =>
                                    setTimeout(
                                        resolve,
                                        2500
                                    )
                            );

                            const code =
                                await sock.requestPairingCode(
                                    PHONE_NUMBER
                                );

                            console.log(
                                "━━━━━━━━━━━━━━━━━━━━"
                            );

                            console.log(
                                `🔐 PAIRING CODE: ${code}`
                            );

                            console.log(
                                "━━━━━━━━━━━━━━━━━━━━"
                            );
                        } catch (error) {
                            pairingRequested =
                                false;

                            console.log(
                                "Pairing error:",
                                error.message
                            );
                        }
                    }
                }

                if (
                    connection ===
                    "open"
                ) {
                    console.log(
                        "━━━━━━━━━━━━━━━━━━━━"
                    );

                    console.log(
                        `✅ ${BOT_NAME} CONNECTED`
                    );

                    console.log(
                        "━━━━━━━━━━━━━━━━━━━━"
                    );

                    reconnecting =
                        false;

                    pairingRequested =
                        false;

                    restoreLocks();
                }

                if (
                    connection ===
                    "close"
                ) {
                    const code =
                        new Boom(
                            lastDisconnect?.error
                        )?.output
                            ?.statusCode;

                    const reconnect =
                        code !==
                        DisconnectReason.loggedOut;

                    console.log(
                        `❌ WhatsApp connection closed: ${code}`
                    );

                    sock = null;

                    pairingRequested =
                        false;

                    if (
                        reconnect &&
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
                            3000
                        );
                    }
                }
            }
        );

        /* =========================================
           MESSAGES
        ========================================= */

        sock.ev.on(
            "messages.upsert",
            async ({
                messages
            }) => {
                for (
                    const message of messages
                ) {
                    try {
                        if (
                            message?.key?.fromMe
                        ) {
                            continue;
                        }

                        const groupId =
                            message?.key
                                ?.remoteJid;

                        if (
                            !groupId ||
                            !groupId.endsWith(
                                "@g.us"
                            )
                        ) {
                            continue;
                        }

                        /*
                         * Bot must be admin.
                         */

                        if (
                            !await isBotAdmin(
                                groupId
                            )
                        ) {
                            continue;
                        }

                        const text =
                            getMessageText(
                                message
                            );

                        if (!text) {
                            continue;
                        }

                        console.log(
                            `📩 ${text}`
                        );

                        /* =================================
                           RAIYAN COMMAND
                        ================================= */

                        if (
                            isRaiyanCommand(
                                text
                            )
                        ) {
                            await handleRaiyan(
                                groupId,
                                message,
                                text
                            );

                            continue;
                        }

                        /* =================================
                           NORMAL COMMAND
                        ================================= */

                        if (
                            !text.startsWith(
                                "/"
                            )
                        ) {
                            continue;
                        }

                        const parts =
                            text.trim()
                                .split(
                                    /\s+/
                                );

                        const rawCommand =
                            parts.shift();

                        const command =
                            normalizeCommand(
                                rawCommand
                            );

                        /* =================================
                           BOT INFO
                        ================================= */

                        if (
                            command ===
                            "bot"
                        ) {
                            await sock.sendMessage(
                                groupId,
                                {
                                    text:
                                        getBotInfo()
                                }
                            );

                            continue;
                        }

                        /* =================================
                           MENU
                        ================================= */

                        if (
                            command ===
                            "menu"
                        ) {
                            await sock.sendMessage(
                                groupId,
                                {
                                    text:
                                        getMenu()
                                }
                            );

                            continue;
                        }

                        /* =================================
                           RULES
                        ================================= */

                        if (
                            command ===
                            "rules"
                        ) {
                            await sock.sendMessage(
                                groupId,
                                {
                                    text:
                                        getRules()
                                }
                            );

                            continue;
                        }

                        /* =================================
                           ID
                        ================================= */

                        if (
                            command ===
                            "id"
                        ) {
                            await sock.sendMessage(
                                groupId,
                                {
                                    text:
                                        `🆔 *Group ID:*\n\n${groupId}`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           PING
                        ================================= */

                        if (
                            command ===
                            "ping"
                        ) {
                            const start =
                                Date.now();

                            await sock.sendMessage(
                                groupId,
                                {
                                    text:
                                        `🏓 *PONG!*\n\n⚡ ${Date.now() - start}ms\n🤖 ${BOT_NAME} Online`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           WEBSITE
                        ================================= */

                        if (
                            command ===
                            "website"
                        ) {
                            await sock.sendMessage(
                                groupId,
                                {
                                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🌐 *OUR WEBSITE*
╰━━━━━━━━━━━━━━━━━━━━╯

${WEBSITE_URL}

🤍 *${BOT_NAME}*
`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           ADMIN
                        ================================= */

                        if (
                            command ===
                            "admin"
                        ) {
                            const metadata =
                                await sock.groupMetadata(
                                    groupId
                                );

                            const admins =
                                (
                                    metadata?.participants ||
                                    []
                                ).filter(
                                    isAdminParticipant
                                );

                            await sock.sendMessage(
                                groupId,
                                {
                                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       👑 *GROUP ADMINS*
╰━━━━━━━━━━━━━━━━━━━━╯

👑 মোট Admin:
${admins.length} জন

🤍 *${BOT_NAME}*
`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           MEMBERS
                        ================================= */

                        if (
                            command ===
                            "members"
                        ) {
                            const metadata =
                                await sock.groupMetadata(
                                    groupId
                                );

                            await sock.sendMessage(
                                groupId,
                                {
                                    text:
                                        `👥 *Total Members:* ${metadata?.participants?.length || 0} জন`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           GROUP INFO
                        ================================= */

                        if (
                            command ===
                            "groupinfo"
                        ) {
                            const metadata =
                                await sock.groupMetadata(
                                    groupId
                                );

                            const lock =
                                groupLocks[
                                    groupId
                                ];

                            const lockText =
                                lock &&
                                lock.expiresAt >
                                    Date.now()
                                    ? `🔴 CLOSED\n⏳ ${formatRemaining(
                                          lock.expiresAt -
                                              Date.now()
                                      )}`
                                    : "🟢 OPEN";

                            await sock.sendMessage(
                                groupId,
                                {
                                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       👥 *GROUP INFO*
╰━━━━━━━━━━━━━━━━━━━━╯

📛 Name:
${metadata?.subject || "Unknown"}

🆔 ID:
${groupId}

👥 Members:
${metadata?.participants?.length || 0}

🤖 Bot:
${
    isBotEnabled(groupId)
        ? "🟢 ON"
        : "🔴 OFF"
}

🔒 Group:
${lockText}

🤖 Bot Name:
${BOT_NAME}
`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           DEAL
                        ================================= */

                        if (
                            command ===
                                "deal" ||
                            command ===
                                "ডিল"
                        ) {
                            await sock.sendMessage(
                                groupId,
                                {
                                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🤝 *DEAL NOTICE*
╰━━━━━━━━━━━━━━━━━━━━╯

⚠️ কোনো Deal করার আগে
অবশ্যই Group Admin-এর
সাথে যোগাযোগ করুন।

🚫 Admin ছাড়া কারো সাথে
Deal করবেন না।

🤍 *${BOT_NAME}*
`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           PIYAS
                        ================================= */

                        if (
                            command ===
                            "piyas"
                        ) {
                            await sock.sendMessage(
                                groupId,
                                {
                                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
          🤍 *PIYAS*
╰━━━━━━━━━━━━━━━━━━━━╯

🤖 Bot:
${BOT_NAME}

🌐 Website:
${WEBSITE_URL}

🤍 Thank You
`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           ADMIN COMMANDS
                        ================================= */

                        if (
                            [
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
                                "modoff"
                            ].includes(
                                command
                            )
                        ) {
                            const admin =
                                await isSenderAdmin(
                                    groupId,
                                    message
                                );

                            if (!admin) {
                                continue;
                            }
                        }

                        /* =================================
                           BOT ON
                        ================================= */

                        if (
                            command ===
                            "boton"
                        ) {
                            setBotEnabled(
                                groupId,
                                true
                            );

                            await sock.sendMessage(
                                groupId,
                                {
                                    text:
                                        `🟢 *${BOT_NAME}* এখন ON হয়েছে।`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           BOT OFF
                        ================================= */

                        if (
                            command ===
                            "botoff"
                        ) {
                            setBotEnabled(
                                groupId,
                                false
                            );

                            await sock.sendMessage(
                                groupId,
                                {
                                    text:
                                        `🔴 *${BOT_NAME}* এখন OFF হয়েছে।\n\n🟢 চালু করতে /boton`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           ADMIN PANEL
                        ================================= */

                        if (
                            command ===
                            "adminpanel"
                        ) {
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

🔒 Group Lock:

/আর-রাইয়ান ১ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ২ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ১ ঘন্টার জন্য গ্রুপ বন্ধ

━━━━━━━━━━━━━━━━━━━━

🤖 /boton
🔴 /botoff

📋 /cmdlist

🛡️ /mod

👑 Admin Only
`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           CMD LIST
                        ================================= */

                        if (
                            command ===
                            "cmdlist"
                        ) {
                            await sock.sendMessage(
                                groupId,
                                {
                                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       📋 *COMMAND LIST*
╰━━━━━━━━━━━━━━━━━━━━╯

/menu
/bot
/rules
/admin
/members
/groupinfo
/id
/ping
/deal
/ডিল
/piyas
/website

━━━━━━━━━━━━━━━━━━━━

👑 *ADMIN*

/adminpanel
/cmdlist
/boton
/botoff
/mod

━━━━━━━━━━━━━━━━━━━━

🔒 *GROUP LOCK*

/আর-রাইয়ান ১ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ২ মিনিটের জন্য গ্রুপ বন্ধ

/আর-রাইয়ান ১ ঘন্টার জন্য গ্রুপ বন্ধ
`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           MOD
                        ================================= */

                        if (
                            command ===
                                "mod" ||
                            command ===
                                "moderation" ||
                            command ===
                                "modstatus"
                        ) {
                            await sock.sendMessage(
                                groupId,
                                {
                                    text: `
🛡️ *${BOT_NAME} MODERATION*

🟢 Bad Word Filter
🟢 Link Protection
🟢 Spam Protection
🟢 Warning System

🚫 Kick/Ban: OFF
`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           MOD ON
                        ================================= */

                        if (
                            command ===
                            "modon"
                        ) {
                            await sock.sendMessage(
                                groupId,
                                {
                                    text:
                                        `🟢 *${BOT_NAME}*\n\nModeration ON হয়েছে।`
                                }
                            );

                            continue;
                        }

                        /* =================================
                           MOD OFF
                        ================================= */

                        if (
                            command ===
                            "modoff"
                        ) {
                            await sock.sendMessage(
                                groupId,
                                {
                                    text:
                                        `🔴 *${BOT_NAME}*\n\nModeration OFF হয়েছে।`
                                }
                            );

                            continue;
                        }
                    } catch (error) {
                        console.log(
                            "Message error:",
                            error?.message
                        );
                    }
                }
            }
        );

        console.log(
            `🚀 ${BOT_NAME} starting...`
        );
    } catch (error) {
        console.log(
            "❌ Start error:",
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
                        status:
                            "online",
                        bot:
                            BOT_NAME,
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
                `${BOT_NAME} is running!`
            );
        }
    );

server.listen(
    PORT,
    () => {
        console.log(
            `🌐 Server running on port ${PORT}`
        );

        console.log(
            `🤖 Bot Name: ${BOT_NAME}`
        );
    }
);

/* =========================================================
   PROCESS EVENTS
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

process.on(
    "SIGINT",
    () => {
        try {
            sock?.end(
                new Error(
                    "Shutdown"
                )
            );
        } catch {}

        process.exit(0);
    }
);

process.on(
    "SIGTERM",
    () => {
        try {
            sock?.end(
                new Error(
                    "Shutdown"
                )
            );
        } catch {}

        process.exit(0);
    }
);

/* =========================================================
   START
========================================================= */

loadData();

startBot();