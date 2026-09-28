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
import { GoogleGenAI } from "@google/genai";

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

const GROUP_ID =
    String(
        process.env.GROUP_ID || ""
    ).trim();

const GEMINI_API_KEY =
    String(
        process.env.GEMINI_API_KEY || ""
    ).trim();

const AI_MODEL =
    String(
        process.env.AI_MODEL ||
        "gemini-2.5-flash-lite"
    ).trim();

const AUTH_DIR =
    "./auth_info";

const CHAT_HISTORY_FILE =
    "./ai_history.json";

const MAX_HISTORY =
    12;

/* =========================================================
   LOGGER
========================================================= */

const logger = P({
    level: "silent"
});

/* =========================================================
   GEMINI AI
========================================================= */

let geminiAI = null;

if (GEMINI_API_KEY) {
    geminiAI = new GoogleGenAI({
        apiKey: GEMINI_API_KEY
    });
}

/* =========================================================
   GLOBAL
========================================================= */

let sock = null;
let reconnecting = false;
let pairingRequested = false;

let chatHistory = {};

/* =========================================================
   FILE SYSTEM
========================================================= */

function loadJson(
    file,
    fallback
) {
    try {
        if (!fs.existsSync(file)) {
            return fallback;
        }

        const data =
            JSON.parse(
                fs.readFileSync(
                    file,
                    "utf8"
                )
            );

        return data || fallback;
    } catch (error) {
        console.log(
            "File load error:",
            error.message
        );

        return fallback;
    }
}

function saveJson(
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
            ),
            "utf8"
        );
    } catch (error) {
        console.log(
            "File save error:",
            error.message
        );
    }
}

function loadHistory() {
    chatHistory =
        loadJson(
            CHAT_HISTORY_FILE,
            {}
        );

    console.log(
        "🧠 AI history loaded."
    );
}

function saveHistory() {
    saveJson(
        CHAT_HISTORY_FILE,
        chatHistory
    );
}

/* =========================================================
   TEXT HELPERS
========================================================= */

function cleanText(text) {
    return String(
        text || ""
    )
        .normalize("NFC")
        .replace(
            /[\u200B-\u200D\uFEFF]/g,
            ""
        )
        .trim();
}

function getMessageText(
    message
) {
    const msg =
        message?.message;

    if (!msg) {
        return "";
    }

    return cleanText(
        msg.conversation ||
        msg.extendedTextMessage
            ?.text ||
        msg.imageMessage
            ?.caption ||
        msg.videoMessage
            ?.caption ||
        msg.documentMessage
            ?.caption ||
        ""
    );
}

/* =========================================================
   CHAT HISTORY
========================================================= */

function getHistoryKey(
    jid
) {
    return String(jid);
}

function getHistory(
    jid
) {
    const key =
        getHistoryKey(jid);

    if (
        !Array.isArray(
            chatHistory[key]
        )
    ) {
        chatHistory[key] = [];
    }

    return chatHistory[key];
}

function addHistory(
    jid,
    role,
    text
) {
    const history =
        getHistory(jid);

    history.push({
        role,
        text: String(text)
    });

    while (
        history.length >
        MAX_HISTORY
    ) {
        history.shift();
    }

    saveHistory();
}

function clearHistory(
    jid
) {
    delete chatHistory[
        getHistoryKey(jid)
    ];

    saveHistory();
}

/* =========================================================
   AI SYSTEM PROMPT
========================================================= */

const SYSTEM_PROMPT = `
তোমার নাম আর-রাইয়ান।

তুমি একটি WhatsApp AI Assistant।

তোমার আচরণ:
- সবসময় ভদ্র, শান্ত এবং সাহায্যকারী হবে।
- ব্যবহারকারীর ভাষা অনুসরণ করবে।
- ব্যবহারকারী বাংলা লিখলে বাংলায় উত্তর দেবে।
- English লিখলে প্রয়োজন অনুযায়ী English-এ উত্তর দিতে পারবে।
- বাংলা উত্তর সহজ এবং স্বাভাবিক রাখবে।
- অপ্রয়োজনীয়ভাবে অনেক বড় উত্তর দেবে না।
- প্রশ্ন বুঝে সরাসরি উত্তর দেবে।
- প্রযুক্তি, Android, WhatsApp, Bot, Node.js,
  JavaScript, GitHub, Termux এবং সাধারণ বিষয়
  নিয়ে সাহায্য করতে পারবে।
- কোনো তথ্য নিশ্চিত না হলে সেটা পরিষ্কারভাবে বলবে।
- নিজের পরিচয় জানতে চাইলে বলবে তুমি আর-রাইয়ান AI।
- ব্যবহারকারীকে সম্মান করে কথা বলবে।
- কোনো API key, password বা private information
  প্রকাশ করতে বলবে না।
`;

/* =========================================================
   AI REQUEST
========================================================= */

async function askAI(
    jid,
    userText
) {
    if (!geminiAI) {
        return `
❌ AI এখন চালু করা যাচ্ছে না।

কারণ:
Gemini API Key পাওয়া যায়নি।

Admin-কে GEMINI_API_KEY সেট করতে হবে।
`;
    }

    const history =
        getHistory(jid);

    const previousConversation =
        history
            .map(item => {
                const role =
                    item.role === "user"
                        ? "User"
                        : "Assistant";

                return `${role}: ${item.text}`;
            })
            .join("\n");

    const prompt = `
${SYSTEM_PROMPT}

আগের কথোপকথন:
${previousConversation || "(কোনো আগের কথোপকথন নেই)"}

নতুন User Message:
${userText}

এখন User-কে সরাসরি উত্তর দাও।
`;

    try {
        console.log(
            `🧠 AI request: ${userText}`
        );

        const response =
            await geminiAI.models.generateContent(
                {
                    model: AI_MODEL,
                    contents: prompt,
                    config: {
                        temperature: 0.7,
                        maxOutputTokens: 1000
                    }
                }
            );

        let answer =
            response?.text || "";

        answer =
            String(answer).trim();

        if (!answer) {
            answer =
                "দুঃখিত, এখন কোনো উত্তর তৈরি করতে পারলাম না।";
        }

        addHistory(
            jid,
            "user",
            userText
        );

        addHistory(
            jid,
            "assistant",
            answer
        );

        return answer;
    } catch (error) {
        console.log(
            "Gemini error:",
            error
        );

        const message =
            String(
                error?.message ||
                error ||
                ""
            );

        if (
            /API key|api_key|401|403/i.test(
                message
            )
        ) {
            return `
❌ Gemini API Key সমস্যা।

নতুন valid API key দিয়ে
GEMINI_API_KEY আপডেট করুন।
`;
        }

        if (
            /quota|429|resource exhausted/i.test(
                message
            )
        ) {
            return `
⚠️ Gemini API quota শেষ বা সাময়িকভাবে সীমিত।

কিছুক্ষণ পরে আবার চেষ্টা করুন।
`;
        }

        return `
❌ AI উত্তর দিতে পারেনি।

আবার চেষ্টা করুন।
`;
    }
}

/* =========================================================
   COMMAND PARSER
========================================================= */

function getAIQuestion(
    text
) {
    const value =
        cleanText(text);

    if (
        /^\/ai(?:\s|$)/i.test(
            value
        )
    ) {
        return value
            .replace(
                /^\/ai/i,
                ""
            )
            .trim();
    }

    if (
        /^\/ask(?:\s|$)/i.test(
            value
        )
    ) {
        return value
            .replace(
                /^\/ask/i,
                ""
            )
            .trim();
    }

    if (
        /^আর[-–—\s]*রাইয়ান(?:\s|$)/i.test(
            value
        )
    ) {
        return value
            .replace(
                /^আর[-–—\s]*রাইয়ান/i,
                ""
            )
            .trim();
    }

    if (
        /^রাইয়ান(?:\s|$)/i.test(
            value
        )
    ) {
        return value
            .replace(
                /^রাইয়ান/i,
                ""
            )
            .trim();
    }

    return null;
}

/* =========================================================
   BOT JID
========================================================= */

function getBotJid() {
    return (
        sock?.user?.id ||
        ""
    );
}

/* =========================================================
   IS MESSAGE REPLY TO BOT
========================================================= */

function isReplyToBot(
    message
) {
    try {
        const quoted =
            message?.message
                ?.extendedTextMessage
                ?.contextInfo
                ?.participant;

        if (!quoted) {
            return false;
        }

        const botJid =
            getBotJid();

        if (!botJid) {
            return false;
        }

        const botNumber =
            botJid
                .split(":")[0]
                .split("@")[0];

        const quotedNumber =
            String(quoted)
                .split(":")[0]
                .split("@")[0];

        return (
            botNumber &&
            quotedNumber &&
            botNumber ===
                quotedNumber
        );
    } catch {
        return false;
    }
}

/* =========================================================
   SEND MESSAGE
========================================================= */

async function sendText(
    jid,
    text,
    quoted = null
) {
    try {
        if (!sock) {
            return;
        }

        if (quoted) {
            await sock.sendMessage(
                jid,
                {
                    text
                },
                {
                    quoted
                }
            );
        } else {
            await sock.sendMessage(
                jid,
                {
                    text
                }
            );
        }
    } catch (error) {
        console.log(
            "Send error:",
            error.message
        );
    }
}

/* =========================================================
   HELP
========================================================= */

function getHelp() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
       🤖 *আর-রাইয়ান AI*
╰━━━━━━━━━━━━━━━━━━━━╯

🧠 আমাকে প্রশ্ন করতে:

/ai তোমার প্রশ্ন

অথবা:

/ask তোমার প্রশ্ন

অথবা সরাসরি:

আর-রাইয়ান তোমার প্রশ্ন

━━━━━━━━━━━━━━━━━━━━

💬 উদাহরণ:

/ai বাংলাদেশ সম্পর্কে বলো

/ai JavaScript কী?

/ai আমার জন্য একটি সুন্দর পোস্ট লিখে দাও

আর-রাইয়ান তুমি কেমন আছো?

━━━━━━━━━━━━━━━━━━━━

🧹 Chat Memory মুছতে:

/clear

ℹ️ AI সম্পর্কে:

/about

🏓 Bot Status:

/ping

🤖 *Powered by Gemini AI*
`;
}

/* =========================================================
   ABOUT
========================================================= */

function getAbout() {
    return `
╭━━━━━━━━━━━━━━━━━━━━╮
       🤖 *আর-রাইয়ান AI*
╰━━━━━━━━━━━━━━━━━━━━╯

🧠 AI Engine:
Google Gemini

⚡ Model:
${AI_MODEL}

💬 WhatsApp AI Assistant

📚 Conversation Memory:
ON

🤖 Bot Status:
ONLINE

━━━━━━━━━━━━━━━━━━━━

/ai - AI প্রশ্ন
/ask - AI প্রশ্ন
/clear - Memory Clear
/ping - Bot Status
/help - Help

🤍 *আর-রাইয়ান AI*
`;
}

/* =========================================================
   START WHATSAPP
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
                        "🔄 Connecting to WhatsApp..."
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
                                        3000
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
                                "❌ Pairing error:",
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
                        "✅ আর-রাইয়ান AI CONNECTED!"
                    );

                    console.log(
                        "🤖 WhatsApp AI: ONLINE"
                    );

                    console.log(
                        `🧠 AI Model: ${AI_MODEL}`
                    );

                    if (
                        GEMINI_API_KEY
                    ) {
                        console.log(
                            "🟢 Gemini AI: READY"
                        );
                    } else {
                        console.log(
                            "🔴 Gemini AI: API KEY MISSING"
                        );
                    }

                    if (GROUP_ID) {
                        console.log(
                            `👥 Target Group: ${GROUP_ID}`
                        );
                    }

                    console.log(
                        "━━━━━━━━━━━━━━━━━━━━"
                    );

                    reconnecting =
                        false;

                    pairingRequested =
                        false;
                }

                if (
                    connection ===
                    "close"
                ) {
                    const statusCode =
                        new Boom(
                            lastDisconnect
                                ?.error
                        )
                            ?.output
                            ?.statusCode;

                    const shouldReconnect =
                        statusCode !==
                        DisconnectReason.loggedOut;

                    console.log(
                        `❌ Connection closed. Code: ${statusCode}`
                    );

                    sock = null;

                    pairingRequested =
                        false;

                    if (
                        shouldReconnect &&
                        !reconnecting
                    ) {
                        reconnecting =
                            true;

                        console.log(
                            "🔄 Reconnecting in 5 seconds..."
                        );

                        setTimeout(
                            () => {
                                reconnecting =
                                    false;

                                startBot();
                            },
                            5000
                        );
                    } else if (
                        !shouldReconnect
                    ) {
                        console.log(
                            "🚪 WhatsApp logged out."
                        );
                    }
                }
            }
        );

        /* =========================================
           MESSAGE HANDLER
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
                            !message ||
                            message.key?.fromMe
                        ) {
                            continue;
                        }

                        const jid =
                            message.key
                                ?.remoteJid;

                        if (!jid) {
                            continue;
                        }

                        /*
                         * Group filter.
                         *
                         * If GROUP_ID is set,
                         * AI only works in that group.
                         *
                         * Private chats still work.
                         */

                        const isGroup =
                            jid.endsWith(
                                "@g.us"
                            );

                        if (
                            isGroup &&
                            GROUP_ID &&
                            jid !== GROUP_ID
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
                            `📩 ${jid}: ${text}`
                        );

                        /* =================================
                           HELP
                        ================================= */

                        const command =
                            text
                                .trim()
                                .toLowerCase();

                        if (
                            command ===
                                "/help" ||
                            command ===
                                "/menu"
                        ) {
                            await sendText(
                                jid,
                                getHelp(),
                                message
                            );

                            continue;
                        }

                        /* =================================
                           ABOUT
                        ================================= */

                        if (
                            command ===
                            "/about"
                        ) {
                            await sendText(
                                jid,
                                getAbout(),
                                message
                            );

                            continue;
                        }

                        /* =================================
                           PING
                        ================================= */

                        if (
                            command ===
                            "/ping"
                        ) {
                            await sendText(
                                jid,
                                `
🏓 *PONG!*

🤖 আর-রাইয়ান AI: ONLINE
🧠 Model: ${AI_MODEL}
🟢 Gemini: ${
    geminiAI
        ? "READY"
        : "API KEY MISSING"
}
`,
                                message
                            );

                            continue;
                        }

                        /* =================================
                           CLEAR MEMORY
                        ================================= */

                        if (
                            command ===
                            "/clear"
                        ) {
                            clearHistory(
                                jid
                            );

                            await sendText(
                                jid,
                                `
🧹 *Memory Cleared*

এই Chat-এর AI conversation
memory মুছে দেওয়া হয়েছে।

এখন থেকে নতুন conversation
শুরু হবে। 🤍
`,
                                message
                            );

                            continue;
                        }

                        /* =================================
                           AI QUESTION
                        ================================= */

                        let question =
                            getAIQuestion(
                                text
                            );

                        /*
                         * Reply to AI:
                         *
                         * কোনো Member যদি
                         * Bot-এর আগের message-এ
                         * Reply করে, AI উত্তর দেবে।
                         */

                        if (
                            !question &&
                            isReplyToBot(
                                message
                            )
                        ) {
                            question =
                                text;
                        }

                        if (
                            !question
                        ) {
                            continue;
                        }

                        /* =================================
                           EMPTY QUESTION
                        ================================= */

                        if (
                            !question.trim()
                        ) {
                            await sendText(
                                jid,
                                `
🤖 আমাকে কী জানতে চান?

উদাহরণ:

/ai তুমি কেমন আছো?

অথবা:

আর-রাইয়ান বাংলাদেশের রাজধানী কী?
`,
                                message
                            );

                            continue;
                        }

                        /* =================================
                           AI THINKING MESSAGE
                        ================================= */

                        await sendText(
                            jid,
                            "🧠 একটু ভাবছি...",
                            message
                        );

                        /* =================================
                           ASK GEMINI
                        ================================= */

                        const answer =
                            await askAI(
                                jid,
                                question
                            );

                        /* =================================
                           SEND AI ANSWER
                        ================================= */

                        await sendText(
                            jid,
                            `🤖 *${BOT_NAME}*\n\n${answer}`,
                            message
                        );

                    } catch (error) {
                        console.log(
                            "❌ Message error:",
                            error?.message
                        );
                    }
                }
            }
        );

        console.log(
            "🚀 আর-রাইয়ান AI starting..."
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
                        ai:
                            Boolean(
                                geminiAI
                            ),
                        model:
                            AI_MODEL,
                        whatsapp:
                            Boolean(
                                sock
                            )
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
                `${BOT_NAME} AI is running!`
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
            `🤖 Bot: ${BOT_NAME}`
        );

        console.log(
            `🧠 AI Model: ${AI_MODEL}`
        );
    }
);

/* =========================================================
   ERROR HANDLERS
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

loadHistory();

startBot();