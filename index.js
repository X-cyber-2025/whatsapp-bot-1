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

const PHONE_NUMBER = (process.env.PHONE_NUMBER || "")
  .replace(/[^0-9]/g, "");

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

const contactNames = new Map();
const contactPhoneJids = new Map();
const lidToPhoneJid = new Map();

/* =========================================================
   DUPLICATE SPAM MEMORY
========================================================= */

const spamTracker = new Map();

const SPAM_WINDOW_MS = 60 * 1000;

/* =========================================================
   LOGGER
========================================================= */

const logger = P({
  level: "silent"
});

/* =========================================================
   MODERATION CONFIG
========================================================= */

const MODERATION_DEFAULTS = {
  badWords: true,
  links: true,
  spam: true,
  warnings: true
};

/* =========================================================
   BAD WORDS
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
  "চোদা",
  "চোদন",
  "চুদ",
  "চুদা",
  "চুদাচুদি",
  "হারামি",
  "হারামী",
  "হারামজাদা",
  "হারামজাদী",
  "কুত্তা",
  "কুত্তার",
  "শুয়োর",
  "শুয়োর",
  "বাঞ্চোদ",
  "বাল",
  "বালের",
  "ফাক",
  "fuck",
  "fucking",
  "fucker",
  "motherfucker",
  "bitch",
  "bastard",
  "asshole",
  "dick",
  "pussy",
  "sex",
  "porn"
];

/* =========================================================
   MODERATION COMMANDS
========================================================= */

const MODERATION_COMMANDS = [
  "mod",
  "moderation",
  "modstatus"
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

    warnings =
      JSON.parse(
        fs.readFileSync(
          WARNING_FILE,
          "utf8"
        )
      ) || {};

    console.log("📂 Warning data loaded.");
  } catch (error) {
    console.log(
      "⚠️ Warning data load error:",
      error?.message
    );

    warnings = {};
  }
}

function saveWarnings() {
  try {
    fs.writeFileSync(
      WARNING_FILE,
      JSON.stringify(
        warnings,
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.log(
      "⚠️ Warning data save error:",
      error?.message
    );
  }
}

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
  if (!groupId || !memberJid) {
    return 0;
  }

  const groupWarnings =
    getGroupWarningData(
      groupId
    );

  return Number(
    groupWarnings[memberJid] || 0
  );
}

function addWarning(
  groupId,
  memberJid
) {
  if (!groupId || !memberJid) {
    return 0;
  }

  const groupWarnings =
    getGroupWarningData(
      groupId
    );

  groupWarnings[memberJid] =
    getMemberWarningCount(
      groupId,
      memberJid
    ) + 1;

  saveWarnings();

  return groupWarnings[memberJid];
}

function clearWarning(
  groupId,
  memberJid
) {
  if (
    !warnings[groupId] ||
    !warnings[groupId][memberJid]
  ) {
    return;
  }

  delete warnings[groupId][memberJid];

  saveWarnings();
}

/* =========================================================
   BAD WORD CHECK
========================================================= */

function normalizeForBadWordCheck(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\s\-_.,!?()[\]{}:;'"`~|\\/]+/g, "");
}

function containsBadWord(text) {
  if (!text) {
    return null;
  }

  const normalized =
    normalizeForBadWordCheck(
      text
    );

  for (const word of BAD_WORDS) {
    const normalizedWord =
      normalizeForBadWordCheck(
        word
      );

    if (
      normalizedWord &&
      normalized.includes(
        normalizedWord
      )
    ) {
      return word;
    }
  }

  return null;
}

/* =========================================================
   LINK CHECK
========================================================= */

function containsLink(text) {
  if (!text) {
    return false;
  }

  const value =
    String(text);

  const linkPatterns = [
    /https?:\/\/\S+/i,
    /www\.\S+/i,
    /\b[a-z0-9-]+\.(com|net|org|xyz|bd|me|io|co|app|site|online|info|dev|ly|gg)\b/i,
    /\bt\.me\/\S+/i,
    /\bwa\.me\/\S+/i,
    /\bchat\.whatsapp\.com\/\S+/i
  ];

  return linkPatterns.some(
    pattern =>
      pattern.test(value)
  );
}

/* =========================================================
   DUPLICATE SPAM HELPERS
========================================================= */

function normalizeSpamText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getSpamKey(
  groupId,
  memberJid
) {
  return `${groupId}:${memberJid}`;
}

function isDuplicateSpam(
  groupId,
  memberJid,
  text
) {
  if (
    !groupId ||
    !memberJid ||
    !text
  ) {
    return false;
  }

  const normalized =
    normalizeSpamText(
      text
    );

  if (!normalized) {
    return false;
  }

  const key =
    getSpamKey(
      groupId,
      memberJid
    );

  const now =
    Date.now();

  const previous =
    spamTracker.get(key);

  if (
    previous &&
    previous.text === normalized &&
    now - previous.time <
      SPAM_WINDOW_MS
  ) {
    spamTracker.set(
      key,
      {
        text: normalized,
        time: now
      }
    );

    return true;
  }

  spamTracker.set(
    key,
    {
      text: normalized,
      time: now
    }
  );

  return false;
}

/* =========================================================
   CLEAN OLD SPAM TRACKER DATA
========================================================= */

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [
        key,
        data
      ] of spamTracker.entries()
    ) {
      if (
        !data ||
        now - data.time >
          SPAM_WINDOW_MS * 2
      ) {
        spamTracker.delete(
          key
        );
      }
    }
  },
  5 * 60 * 1000
);

/* =========================================================
   MODERATION STATUS
========================================================= */

function getModerationStatus(
  groupId
) {
  const status =
    getGroupStatus(
      groupId
    );

  if (
    typeof status.moderation !==
    "object" ||
    !status.moderation
  ) {
    status.moderation = {
      ...MODERATION_DEFAULTS
    };
  }

  for (
    const [
      key,
      value
    ] of Object.entries(
      MODERATION_DEFAULTS
    )
  ) {
    if (
      typeof status.moderation[key] !==
      "boolean"
    ) {
      status.moderation[key] =
        value;
    }
  }

  return status.moderation;
}

function isModerationEnabled(
  groupId,
  type
) {
  return Boolean(
    getModerationStatus(
      groupId
    )[type]
  );
}

function setModerationStatus(
  groupId,
  type,
  enabled
) {
  const moderation =
    getModerationStatus(
      groupId
    );

  if (
    !Object.prototype.hasOwnProperty.call(
      moderation,
      type
    )
  ) {
    return false;
  }

  moderation[type] =
    Boolean(enabled);

  saveBotStatus();

  return true;
}

/* =========================================================
   DELETE MESSAGE
========================================================= */

async function deleteMessage(
  remoteJid,
  message
) {
  try {
    if (
      !sock ||
      !remoteJid ||
      !message?.key
    ) {
      return false;
    }

    await sock.sendMessage(
      remoteJid,
      {
        delete:
          message.key
      }
    );

    return true;
  } catch (error) {
    console.log(
      "⚠️ Message delete error:",
      error?.message
    );

    return false;
  }
}

/* =========================================================
   MODERATION WARNING
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

🚫 এই Message টি Group Rule
ভঙ্গ করার কারণে Delete করা হয়েছে।

📌 *কারণ:* ${reason}

⚠️ *Warning:* ${warningCount}

❗ বারবার Group Rules ভঙ্গ
না করার অনুরোধ করা হচ্ছে।

🚫 Member Remove/Kick করা হয়নি।

🤍 *Piyas Bot*
`;

    const messageData = {
      text
    };

    if (isPhoneJid(phoneJid)) {
      messageData.mentions = [
        phoneJid
      ];
    }

    await sock.sendMessage(
      remoteJid,
      messageData
    );
  } catch (error) {
    console.log(
      "⚠️ Moderation warning error:",
      error?.message
    );
  }
}

/* =========================================================
   MODERATE MESSAGE
========================================================= */

async function moderateMessage(
  remoteJid,
  message,
  text
) {
  try {
    if (
      !remoteJid ||
      !message ||
      !text
    ) {
      return false;
    }

    if (
      !isBotEnabled(
        remoteJid
      )
    ) {
      return false;
    }

    const sender =
      message?.key?.participant;

    if (sender) {
      const admin =
        await isSenderAdmin(
          remoteJid,
          message
        );

      if (admin) {
        return false;
      }
    }

    if (
      isModerationEnabled(
        remoteJid,
        "badWords"
      )
    ) {
      const badWord =
        containsBadWord(
          text
        );

      if (badWord) {
        const deleted =
          await deleteMessage(
            remoteJid,
            message
          );

        if (deleted) {
          let warningCount = 0;

          if (
            isModerationEnabled(
              remoteJid,
              "warnings"
            ) &&
            sender
          ) {
            const memberJid =
              await getPhoneJid({
                id: sender
              });

            const warningJid =
              memberJid ||
              sender;

            warningCount =
              addWarning(
                remoteJid,
                warningJid
              );
          }

          if (
            isModerationEnabled(
              remoteJid,
              "warnings"
            )
          ) {
            await sendModerationWarning(
              remoteJid,
              message,
              `Bad Word: ${badWord}`,
              warningCount
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
      const deleted =
        await deleteMessage(
          remoteJid,
          message
        );

      if (deleted) {
        let warningCount = 0;

        if (
          isModerationEnabled(
            remoteJid,
            "warnings"
          ) &&
          sender
        ) {
          const memberJid =
            await getPhoneJid({
              id: sender
            });

          const warningJid =
            memberJid ||
            sender;

          warningCount =
            addWarning(
              remoteJid,
              warningJid
            );
        }

        await sendModerationWarning(
          remoteJid,
          message,
          "Link / URL",
          warningCount
        );
      }

      return true;
    }

    if (
      isModerationEnabled(
        remoteJid,
        "spam"
      ) &&
      sender
    ) {
      const memberJid =
        await getPhoneJid({
          id: sender
        });

      const spamJid =
        memberJid ||
        sender;

      const duplicate =
        isDuplicateSpam(
          remoteJid,
          spamJid,
          text
        );

      if (duplicate) {
        const deleted =
          await deleteMessage(
            remoteJid,
            message
          );

        if (deleted) {
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
                spamJid
              );
          }

          if (
            isModerationEnabled(
              remoteJid,
              "warnings"
            )
          ) {
            await sendModerationWarning(
              remoteJid,
              message,
              "Duplicate Spam: একই Message ১ মিনিটের মধ্যে পুনরায় পাঠানো হয়েছে",
              warningCount
            );
          }
        }

        return true;
      }
    }

    return false;
  } catch (error) {
    console.log(
      "⚠️ Moderation error:",
      error?.message
    );

    return false;
  }
}

/* =========================================================
   COMMAND DEFINITIONS
========================================================= */

const COMMAND_DEFINITIONS = [
  {
    key: "menu",
    command: "/menu",
    title: "Main Menu",
    category: "group"
  },
  {
    key: "bot",
    command: "/bot",
    title: "Bot Menu",
    category: "group"
  },
  {
    key: "rules",
    command: "/rules",
    title: "Group Rules",
    category: "group"
  },
  {
    key: "admin",
    command: "/admin",
    title: "Admin List",
    category: "group"
  },
  {
    key: "members",
    command: "/members",
    title: "Group Members",
    category: "group"
  },
  {
    key: "groupinfo",
    command: "/groupinfo",
    title: "Group Info",
    category: "group"
  },
  {
    key: "id",
    command: "/id",
    title: "Group ID",
    category: "group"
  },
  {
    key: "ping",
    command: "/ping",
    title: "Ping",
    category: "utility"
  },
  {
    key: "deal",
    command: "/deal",
    title: "Buy / Sell Deal",
    category: "deal"
  },
  {
    key: "piyas",
    command: "/piyas",
    title: "Piyas Info",
    category: "piyas"
  },
  {
    key: "website",
    command: "/website",
    title: "Official Website",
    category: "website"
  }
];

/* =========================================================
   COMMAND ALIASES
========================================================= */

const COMMAND_ALIASES = {
  "ডিল": "deal"
};

/* =========================================================
   ADMIN ONLY COMMANDS
========================================================= */

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

/* =========================================================
   PROTECTED ADMIN COMMANDS
========================================================= */

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

/* =========================================================
   BOT STATUS
========================================================= */

let botStatus = {};

function normalizeLoadedGroupStatus(status) {
  if (
    !status ||
    typeof status !== "object"
  ) {
    status = {
      enabled: true,
      disabledCommands: [],
      moderation: {
        ...MODERATION_DEFAULTS
      },
      autoOnAt: null
    };
  }

  if (
    typeof status.enabled !== "boolean"
  ) {
    status.enabled = true;
  }

  if (
    !Array.isArray(
      status.disabledCommands
    )
  ) {
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

  for (
    const [
      key,
      defaultValue
    ] of Object.entries(
      MODERATION_DEFAULTS
    )
  ) {
    if (
      typeof status.moderation[key] !==
      "boolean"
    ) {
      status.moderation[key] =
        defaultValue;
    }
  }

  if (
    status.autoOnAt !== null &&
    (
      typeof status.autoOnAt !== "number" ||
      !Number.isFinite(status.autoOnAt) ||
      status.autoOnAt <= 0
    )
  ) {
    status.autoOnAt = null;
  }

  if (
    !Object.prototype.hasOwnProperty.call(
      status,
      "autoOnAt"
    )
  ) {
    status.autoOnAt = null;
  }

  return status;
}

function loadBotStatus() {
  try {
    if (!fs.existsSync(BOT_STATUS_FILE)) {
      botStatus = {};
      return;
    }

    botStatus =
      JSON.parse(
        fs.readFileSync(
          BOT_STATUS_FILE,
          "utf8"
        )
      ) || {};

    for (
      const [groupId, value]
      of Object.entries(botStatus)
    ) {
      if (typeof value === "boolean") {
        botStatus[groupId] =
          normalizeLoadedGroupStatus({
            enabled: value
          });
      } else {
        botStatus[groupId] =
          normalizeLoadedGroupStatus(
            value
          );
      }
    }

    console.log("📂 Bot status loaded.");
  } catch (error) {
    console.log(
      "⚠️ Bot status load error:",
      error?.message
    );

    botStatus = {};
  }
}

function saveBotStatus() {
  try {
    fs.writeFileSync(
      BOT_STATUS_FILE,
      JSON.stringify(
        botStatus,
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.log(
      "⚠️ Bot status save error:",
      error?.message
    );
  }
}

function getGroupStatus(groupId) {
  if (!botStatus[groupId]) {
    botStatus[groupId] =
      normalizeLoadedGroupStatus({});
  }

  botStatus[groupId] =
    normalizeLoadedGroupStatus(
      botStatus[groupId]
    );

  return botStatus[groupId];
}

function isBotEnabled(groupId) {
  return (
    getGroupStatus(groupId).enabled !== false
  );
}

function setBotStatus(
  groupId,
  enabled
) {
  getGroupStatus(
    groupId
  ).enabled = Boolean(enabled);

  saveBotStatus();
}

function normalizeCommandName(command) {
  if (!command) {
    return "";
  }

  return String(command)
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "");
}

function getCanonicalCommand(command) {
  const normalized =
    normalizeCommandName(
      command
    );

  if (!normalized) {
    return "";
  }

  return (
    COMMAND_ALIASES[normalized] ||
    normalized
  );
}

function getCommandDefinition(command) {
  const key =
    getCanonicalCommand(
      command
    );

  return (
    COMMAND_DEFINITIONS.find(
      item =>
        item.key === key
    ) || null
  );
}

function isKnownCommand(command) {
  return Boolean(
    getCommandDefinition(
      command
    )
  );
}

function isCommandEnabled(
  groupId,
  command
) {
  const name =
    getCanonicalCommand(
      command
    );

  if (!name) {
    return true;
  }

  return !getGroupStatus(
    groupId
  ).disabledCommands.includes(
    name
  );
}

function setCommandStatus(
  groupId,
  command,
  enabled
) {
  const name =
    getCanonicalCommand(
      command
    );

  if (!name) {
    return false;
  }

  const status =
    getGroupStatus(
      groupId
    );

  const list =
    status.disabledCommands;

  const index =
    list.indexOf(name);

  if (enabled) {
    if (index !== -1) {
      list.splice(
        index,
        1
      );
    }
  } else {
    if (index === -1) {
      list.push(name);
    }
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

const GROUP_DURATION_UNITS = [
  {
    names: [
      "বছর",
      "বছরের",
      "year",
      "years",
      "yr",
      "yrs",
      "y"
    ],
    ms:
      365 *
      24 *
      60 *
      60 *
      1000
  },
  {
    names: [
      "মাস",
      "মাসের",
      "month",
      "months",
      "mo",
      "mos"
    ],
    ms:
      30 *
      24 *
      60 *
      60 *
      1000
  },
  {
    names: [
      "সপ্তাহ",
      "সপ্তাহের",
      "week",
      "weeks",
      "wk",
      "wks",
      "w"
    ],
    ms:
      7 *
      24 *
      60 *
      60 *
      1000
  },
  {
    names: [
      "দিন",
      "দিনের",
      "day",
      "days",
      "d"
    ],
    ms:
      24 *
      60 *
      60 *
      1000
  },
  {
    names: [
      "ঘণ্টা",
      "ঘন্টা",
      "ঘণ্টার",
      "ঘন্টার",
      "hour",
      "hours",
      "hr",
      "hrs",
      "h"
    ],
    ms:
      60 *
      60 *
      1000
  },
  {
    names: [
      "মিনিট",
      "মিনিটের",
      "minute",
      "minutes",
      "min",
      "mins",
      "m"
    ],
    ms:
      60 *
      1000
  },
  {
    names: [
      "সেকেন্ড",
      "সেকেন্ডের",
      "second",
      "seconds",
      "sec",
      "secs",
      "s"
    ],
    ms: 1000
  }
];

function getDurationUnit(unitText) {
  const normalized =
    String(unitText || "")
      .trim()
      .toLowerCase();

  for (
    const unit of GROUP_DURATION_UNITS
  ) {
    if (
      unit.names.includes(
        normalized
      )
    ) {
      return unit;
    }
  }

  return null;
}

function parseGroupOffDuration(
  args = []
) {
  if (!Array.isArray(args) || !args.length) {
    return null;
  }

  const normalizedArgs =
    args.map(item =>
      normalizeDurationDigits(
        item
      )
        .trim()
        .toLowerCase()
    );

  const joined =
    normalizedArgs.join(" ");

  let totalMs = 0;
  let found = false;

  /*
   * Supports:
   * 2 মিনিট
   * 2মিনিট
   * 2 hours
   * 1 দিন 5 ঘণ্টা 20 মিনিট
   * 2h
   * 30m
   * 7d
   * 1w
   * 1mo
   * 1y
   */

  const unitNames =
    GROUP_DURATION_UNITS
      .flatMap(unit =>
        unit.names
      )
      .sort(
        (a, b) =>
          b.length -
          a.length
      )
      .map(
        name =>
          name.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )
      );

  const unitPattern =
    unitNames.join("|");

  const pattern =
    new RegExp(
      `(\\d+(?:\\.\\d+)?)\\s*(${unitPattern})(?=\\s|$|[^a-zA-Z0-9])`,
      "gi"
    );

  let match;

  while (
    (match = pattern.exec(joined)) !== null
  ) {
    const amount =
      Number(match[1]);

    const unit =
      getDurationUnit(
        match[2]
      );

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

    totalMs += value;
    found = true;

    if (
      !Number.isSafeInteger(
        Math.round(totalMs)
      )
    ) {
      return null;
    }
  }

  /*
   * If only a number is given,
   * treat it as minutes.
   */
  if (
    !found &&
    normalizedArgs.length === 1 &&
    /^\d+(?:\.\d+)?$/.test(
      normalizedArgs[0]
    )
  ) {
    const minutes =
      Number(
        normalizedArgs[0]
      );

    totalMs =
      minutes *
      60 *
      1000;

    found = true;
  }

  if (
    !found ||
    !Number.isFinite(totalMs) ||
    totalMs <= 0
  ) {
    return null;
  }

  /*
   * Keep timestamp safely inside
   * JavaScript's safe integer range.
   */
  const maxSafeDuration =
    Number.MAX_SAFE_INTEGER -
    Date.now() -
    1000;

  if (
    totalMs >
    maxSafeDuration
  ) {
    return null;
  }

  return Math.round(
    totalMs
  );
}

function formatGroupDuration(
  durationMs
) {
  let seconds =
    Math.floor(
      durationMs / 1000
    );

  const years =
    Math.floor(
      seconds /
        (365 * 24 * 60 * 60)
    );

  seconds -=
    years *
    365 *
    24 *
    60 *
    60;

  const months =
    Math.floor(
      seconds /
        (30 * 24 * 60 * 60)
    );

  seconds -=
    months *
    30 *
    24 *
    60 *
    60;

  const days =
    Math.floor(
      seconds /
        (24 * 60 * 60)
    );

  seconds -=
    days *
    24 *
    60 *
    60;

  const hours =
    Math.floor(
      seconds /
        (60 * 60)
    );

  seconds -=
    hours *
    60 *
    60;

  const minutes =
    Math.floor(
      seconds / 60
    );

  seconds -=
    minutes * 60;

  const parts = [];

  if (years > 0) {
    parts.push(
      `${years} বছর`
    );
  }

  if (months > 0) {
    parts.push(
      `${months} মাস`
    );
  }

  if (days > 0) {
    parts.push(
      `${days} দিন`
    );
  }

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

  if (
    seconds > 0 ||
    parts.length === 0
  ) {
    parts.push(
      `${seconds} সেকেন্ড`
    );
  }

  return parts.join(" ");
}

function getGroupLockRemaining(
  groupId
) {
  const autoOnAt =
    getGroupStatus(
      groupId
    ).autoOnAt;

  if (
    typeof autoOnAt !== "number" ||
    !Number.isFinite(autoOnAt)
  ) {
    return 0;
  }

  return Math.max(
    0,
    autoOnAt - Date.now()
  );
}

async function lockGroupForDuration(
  groupId,
  durationMs
) {
  try {
    if (
      !sock ||
      !groupId ||
      !groupId.endsWith("@g.us")
    ) {
      return false;
    }

    const botAdmin =
      await isBotAdminInGroup(
        groupId
      );

    if (!botAdmin) {
      await sock.sendMessage(
        groupId,
        {
          text: `
❌ *BOT ADMIN REQUIRED*

এই Group-এর Message বন্ধ করতে হলে
আমাকে Group Admin করতে হবে।

👑 আমাকে Group Admin করার পর আবার লিখুন:

/গ্রুপ বন্ধ 2 মিনিট
`
        }
      );

      return false;
    }

    if (
      !Number.isFinite(durationMs) ||
      durationMs <= 0
    ) {
      return false;
    }

    /*
     * WhatsApp:
     * announcement = only admins can send
     */
    await sock.groupSettingUpdate(
      groupId,
      "announcement"
    );

    const autoOnAt =
      Date.now() +
      durationMs;

    const status =
      getGroupStatus(
        groupId
      );

    /*
     * Existing timer will be replaced.
     */
    status.autoOnAt =
      autoOnAt;

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

👑 এখন শুধু Group Admin
Message পাঠাতে পারবেন।

⏱️ *সময়:* ${formatGroupDuration(durationMs)}

🕐 সময় শেষ হলে সাধারণ Member-এর
Message Automatically ON হবে।

⚡ আগে চালু করতে:
*/boton*

🤍 *Piyas Bot*
`
      }
    );

    console.log(
      `🔒 Group locked: ${groupId} | ${formatGroupDuration(durationMs)} | Auto ON: ${autoOnAt}`
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
          text: `
❌ *GROUP MESSAGE OFF FAILED*

Group Message বন্ধ করা যায়নি।

সম্ভব কারণ:
• Bot Admin permission সমস্যা
• WhatsApp Group Setting update ব্যর্থ
• Bot session সমস্যা

আবার চেষ্টা করুন।
`
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
      !groupId ||
      !groupId.endsWith("@g.us")
    ) {
      return false;
    }

    const botAdmin =
      await isBotAdminInGroup(
        groupId
      );

    if (!botAdmin) {
      console.log(
        `🚫 Cannot unlock group because bot is not admin: ${groupId}`
      );

      return false;
    }

    await sock.groupSettingUpdate(
      groupId,
      "not_announcement"
    );

    const status =
      getGroupStatus(
        groupId
      );

    status.autoOnAt =
      null;

    saveBotStatus();

    if (
      reason === "manual"
    ) {
      await sock.sendMessage(
        groupId,
        {
          text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🔓 *GROUP MESSAGE ON*
╰━━━━━━━━━━━━━━━━━━━━╯

🟢 এখন থেকে সাধারণ Member-রাও
আবার Message পাঠাতে পারবেন।

🤍 *Piyas Bot*
`
        }
      );
    } else if (
      reason === "timer"
    ) {
      await sock.sendMessage(
        groupId,
        {
          text: `
╭━━━━━━━━━━━━━━━━━━━━╮
      🔓 *GROUP MESSAGE ON*
╰━━━━━━━━━━━━━━━━━━━━╯

⏰ নির্ধারিত সময় শেষ হয়েছে।

🟢 এখন থেকে সাধারণ Member-রাও
আবার Message পাঠাতে পারবেন।

🤍 *Piyas Bot*
`
        }
      );
    }

    console.log(
      `🔓 Group unlocked: ${groupId} | Reason: ${reason}`
    );

    return true;
  } catch (error) {
    console.log(
      "❌ Group unlock error:",
      error?.message
    );

    return false;
  }
}

/* =========================================================
   AUTO ENABLE EXPIRED GROUPS
========================================================= */

async function autoEnableExpiredGroups() {
  if (!sock) {
    return;
  }

  const now =
    Date.now();

  for (
    const [
      groupId,
      status
    ] of Object.entries(
      botStatus
    )
  ) {
    try {
      if (
        !status ||
        typeof status !== "object"
      ) {
        continue;
      }

      const autoOnAt =
        status.autoOnAt;

      if (
        typeof autoOnAt !== "number" ||
        !Number.isFinite(autoOnAt)
      ) {
        continue;
      }

      if (
        autoOnAt > now
      ) {
        continue;
      }

      console.log(
        `⏰ Group lock expired: ${groupId}`
      );

      await unlockGroupNow(
        groupId,
        "timer"
      );
    } catch (error) {
      console.log(
        `⚠️ Auto group unlock error: ${groupId}`,
        error?.message
      );
    }
  }
}

/*
 * Check every 10 seconds.
 * This avoids setTimeout's 32-bit limit and
 * also allows timers to survive bot restart.
 */
setInterval(
  () => {
    autoEnableExpiredGroups();
  },
  10 * 1000
);

/* =========================================================
   RESTORE ACTIVE GROUP LOCKS
========================================================= */

async function restoreActiveGroupLocks() {
  if (!sock) {
    return;
  }

  const now =
    Date.now();

  for (
    const [
      groupId,
      status
    ] of Object.entries(
      botStatus
    ) 
  ) {
    try {
      if (
        !status ||
        typeof status !== "object"
      ) {
        continue;
      }

      const autoOnAt =
        status.autoOnAt;

      if (
        typeof autoOnAt !== "number" ||
        !Number.isFinite(autoOnAt)
      ) {
        continue;
      }

      if (
        autoOnAt <= now
      ) {
        await unlockGroupNow(
          groupId,
          "timer"
        );

        continue;
      }

      const botAdmin =
        await isBotAdminInGroup(
          groupId
        );

      if (!botAdmin) {
        console.log(
          `⚠️ Cannot restore group lock; bot is not admin: ${groupId}`
        );

        continue;
      }

      await sock.groupSettingUpdate(
        groupId,
        "announcement"
      );

      console.log(
        `🔒 Active group lock restored: ${groupId} | Remaining: ${formatGroupDuration(autoOnAt - now)}`
      );
    } catch (error) {
      console.log(
        `⚠️ Active group lock restore error: ${groupId}`,
        error?.message
      );
    }
  }
}

/* =========================================================
   HTTP SERVER
========================================================= */

loadBotStatus();
loadWarnings();

const server =
  http.createServer(
    (req, res) => {
      if (req.url === "/health") {
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
            bot: "WhatsApp Group Bot",
            connected: !!sock,
            access:
              "Bot works automatically in groups where connected number is Admin"
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

    console.log(
      "🎯 Group Access: Connected WhatsApp Number must be Group Admin"
    );
  }
);

/* =========================================================
   PAIRING NUMBER
========================================================= */

function readSavedPairingNumber() {
  try {
    if (
      !fs.existsSync(
        PAIRING_NUMBER_FILE
      )
    ) {
      return "";
    }

    return fs
      .readFileSync(
        PAIRING_NUMBER_FILE,
        "utf8"
      )
      .trim()
      .replace(
        /[^0-9]/g,
        ""
      );
  } catch (error) {
    console.log(
      "⚠️ Pairing number read error:",
      error?.message
    );

    return "";
  }
}

function savePairingNumber(number) {
  try {
    fs.writeFileSync(
      PAIRING_NUMBER_FILE,
      number,
      "utf8"
    );
  } catch (error) {
    console.log(
      "⚠️ Pairing number save error:",
      error?.message
    );
  }
}

function getCredentialPhoneNumber(creds) {
  const id =
    creds?.me?.id;

  if (
    !id ||
    typeof id !== "string"
  ) {
    return "";
  }

  return id
    .split(":")[0]
    .split("@")[0]
    .replace(
      /[^0-9]/g,
      ""
    );
}

async function resetAuthForNumberChange() {
  try {
    if (
      fs.existsSync(AUTH_DIR)
    ) {
      await fs.promises.rm(
        AUTH_DIR,
        {
          recursive: true,
          force: true
        }
      );

      console.log(
        "🗑️ Old WhatsApp session removed."
      );
    }
  } catch (error) {
    console.log(
      "❌ Failed to remove old session:",
      error?.message
    );
  }
}

/* =========================================================
   JID HELPERS
========================================================= */

function normalizeJid(jid) {
  if (
    !jid ||
    typeof jid !== "string"
  ) {
    return null;
  }

  return jid.trim();
}

function normalizeJidBase(jid) {
  const value =
    normalizeJid(
      jid
    );

  if (!value) {
    return null;
  }

  return value
    .split(":")[0]
    .toLowerCase();
}

function getJidUserPart(jid) {
  const normalized =
    normalizeJidBase(
      jid
    );

  if (!normalized) {
    return null;
  }

  return normalized
    .split("@")[0]
    .replace(
      /[^0-9]/g,
      ""
    );
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

  if (number.length < 8) {
    return null;
  }

  return (
    number +
    "@s.whatsapp.net"
  );
}

/* =========================================================
   NAME HELPERS
========================================================= */

function cleanName(name) {
  if (!name) {
    return null;
  }

  const value =
    String(name)
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (!value) {
    return null;
  }

  return value.slice(
    0,
    80
  );
}

function getDisplayName(
  participant = {}
) {
  const ids = [
    participant.id,
    participant.lid,
    participant.phoneNumber
  ].filter(Boolean);

  for (
    const id of ids
  ) {
    const cached =
      contactNames.get(id);

    if (cached) {
      return cached;
    }
  }

  const directName =
    cleanName(
      participant.username ||
      participant.notify ||
      participant.name ||
      participant.verifiedName ||
      participant.pushName
    );

  if (directName) {
    return directName;
  }

  if (participant.phoneNumber) {
    const phone =
      String(
        participant.phoneNumber
      )
        .replace(
          /@s.whatsapp.net/g,
          ""
        )
        .replace(
          /[^0-9]/g,
          ""
        );

    if (phone) {
      return phone;
    }
  }

  if (participant.id) {
    const idPart =
      String(
        participant.id
      ).split("@")[0];

    if (idPart) {
      return idPart;
    }
  }

  return "Member";
}

/* =========================================================
   LID MAPPING
========================================================= */

function saveLidMapping(
  lid,
  pn
) {
  const lidJid =
    normalizeJid(lid);

  let phoneJid =
    normalizeJid(pn);

  if (!isLidJid(lidJid)) {
    return;
  }

  if (!isPhoneJid(phoneJid)) {
    phoneJid =
      phoneNumberToJid(
        phoneJid
      );
  }

  if (!isPhoneJid(phoneJid)) {
    return;
  }

  lidToPhoneJid.set(
    lidJid,
    phoneJid
  );

  contactPhoneJids.set(
    lidJid,
    phoneJid
  );
}

async function resolveLidToPhoneJid(lid) {
  if (!lid) {
    return null;
  }

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
      sock?.signalRepository
        ?.lidMapping;

    if (
      mapping &&
      typeof mapping.getPNForLID ===
        "function"
    ) {
      const pn =
        await mapping.getPNForLID(
          lid
        );

      const phoneJid =
        isPhoneJid(pn)
          ? pn
          : phoneNumberToJid(pn);

      if (phoneJid) {
        saveLidMapping(
          lid,
          phoneJid
        );

        return phoneJid;
      }
    }
  } catch (error) {
    console.log(
      "⚠️ LID → Phone mapping error:",
      error?.message
    );
  }

  return null;
}

/* =========================================================
   CONTACT CACHE
========================================================= */

function saveContacts(
  contacts = []
) {
  for (
    const contact of contacts
  ) {
    if (!contact) {
      continue;
    }

    const id =
      normalizeJid(
        contact.id
      );

    const lid =
      normalizeJid(
        contact.lid
      );

    let phoneJid = null;

    if (contact.phoneNumber) {
      phoneJid =
        isPhoneJid(
          contact.phoneNumber
        )
          ? contact.phoneNumber
          : phoneNumberToJid(
              contact.phoneNumber
            );
    }

    if (
      !phoneJid &&
      isPhoneJid(id)
    ) {
      phoneJid = id;
    }

    if (
      phoneJid &&
      isLidJid(id)
    ) {
      saveLidMapping(
        id,
        phoneJid
      );
    }

    if (
      phoneJid &&
      lid
    ) {
      saveLidMapping(
        lid,
        phoneJid
      );
    }

    const name =
      cleanName(
        contact.username ||
        contact.notify ||
        contact.name ||
        contact.verifiedName ||
        contact.pushName
      );

    if (name) {
      if (id) {
        contactNames.set(
          id,
          name
        );
      }

      if (lid) {
        contactNames.set(
          lid,
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

/* =========================================================
   PHONE JID
========================================================= */

function getDirectPhoneJid(
  participant = {}
) {
  if (participant.phoneNumber) {
    const jid =
      isPhoneJid(
        participant.phoneNumber
      )
        ? participant.phoneNumber
        : phoneNumberToJid(
            participant.phoneNumber
          );

    if (jid) {
      return jid;
    }
  }

  if (
    isPhoneJid(
      participant.id
    )
  ) {
    return participant.id;
  }

  return null;
}

async function getPhoneJid(
  participant = {}
) {
  const direct =
    getDirectPhoneJid(
      participant
    );

  if (direct) {
    return direct;
  }

  const ids = [
    participant.id,
    participant.lid
  ].filter(Boolean);

  for (
    const id of ids
  ) {
    const cached =
      contactPhoneJids.get(id) ||
      lidToPhoneJid.get(id);

    if (isPhoneJid(cached)) {
      return cached;
    }

    if (isLidJid(id)) {
      const resolved =
        await resolveLidToPhoneJid(
          id
        );

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
  for (
    const participant of participants
  ) {
    if (!participant) {
      continue;
    }

    const name =
      getDisplayName(
        participant
      );

    let phoneJid =
      getDirectPhoneJid(
        participant
      );

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
      isLidJid(
        participant.id
      )
    ) {
      saveLidMapping(
        participant.id,
        phoneJid
      );
    }

    if (
      phoneJid &&
      isLidJid(
        participant.lid
      )
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

/* =========================================================
   GROUP HELPERS
========================================================= */

function isAdminParticipant(
  participant = {}
) {
  return (
    participant.admin === "admin" ||
    participant.admin === "superadmin" ||
    participant.admin === true ||
    participant.isAdmin === true ||
    participant.isSuperAdmin === true
  );
}

function isOwnerParticipant(
  participant = {}
) {
  return (
    participant.admin === "superadmin" ||
    participant.isSuperAdmin === true
  );
}

function findParticipant(
  participants = [],
  jid
) {
  if (!jid) {
    return null;
  }

  const normalizedTarget =
    normalizeJidBase(
      jid
    );

  for (
    const participant of participants
  ) {
    const ids = [
      participant?.id,
      participant?.lid,
      participant?.phoneNumber
    ].filter(Boolean);

    for (
      const id of ids
    ) {
      if (
        normalizeJidBase(
          id
        ) ===
        normalizedTarget
      ) {
        return participant;
      }
    }
  }

  return null;
}

/* =========================================================
   BOT OWN JID
========================================================= */

function getBotPhoneJid() {
  try {
    const ownId =
      normalizeJid(
        sock?.user?.id
      );

    const ownLid =
      normalizeJid(
        sock?.user?.lid
      );

    if (isPhoneJid(ownId)) {
      return (
        ownId.split(":")[0]
      );
    }

    if (isPhoneJid(ownLid)) {
      return (
        ownLid.split(":")[0]
      );
    }

    if (isLidJid(ownId)) {
      const cached =
        lidToPhoneJid.get(
          ownId
        ) ||
        contactPhoneJids.get(
          ownId
        );

      if (isPhoneJid(cached)) {
        return cached;
      }
    }

    if (isLidJid(ownLid)) {
      const cached =
        lidToPhoneJid.get(
          ownLid
        ) ||
        contactPhoneJids.get(
          ownLid
        );

      if (isPhoneJid(cached)) {
        return cached;
      }
    }

    if (PHONE_NUMBER) {
      return phoneNumberToJid(
        PHONE_NUMBER
      );
    }

    return null;
  } catch {
    return null;
  }
}

/* =========================================================
   GET ALL BOT IDENTITIES
========================================================= */

async function getBotIdentityList() {
  const identities = [];

  const ownId =
    normalizeJid(
      sock?.user?.id
    );

  const ownLid =
    normalizeJid(
      sock?.user?.lid
    );

  const phoneJid =
    getBotPhoneJid();

  if (ownId) {
    identities.push(
      ownId
    );
  }

  if (ownLid) {
    identities.push(
      ownLid
    );
  }

  if (phoneJid) {
    identities.push(
      phoneJid
    );
  }

  if (
    ownId &&
    isLidJid(ownId)
  ) {
    const resolved =
      await resolveLidToPhoneJid(
        ownId
      );

    if (resolved) {
      identities.push(
        resolved
      );
    }
  }

  if (
    ownLid &&
    isLidJid(ownLid)
  ) {
    const resolved =
      await resolveLidToPhoneJid(
        ownLid
      );

    if (resolved) {
      identities.push(
        resolved
      );
    }
  }

  return [
    ...new Set(
      identities.filter(Boolean)
    )
  ];
}

/* =========================================================
   CHECK BOT IS GROUP ADMIN
========================================================= */

async function isBotAdminInGroup(
  groupId
) {
  try {
    if (
      !sock ||
      !groupId ||
      !groupId.endsWith("@g.us")
    ) {
      return false;
    }

    const metadata =
      await sock.groupMetadata(
        groupId
      );

    const participants =
      metadata?.participants ||
      [];

    if (!participants.length) {
      return false;
    }

    await cacheParticipants(
      participants
    );

    /*
     * IMPORTANT:
     * WhatsApp now supports LID-based groups.
     * A participant can have:
     *
     * id          = xxx@lid
     * phoneNumber = xxx@s.whatsapp.net
     *
     * while sock.user.id may also be a LID.
     *
     * Therefore we compare every available
     * Bot identity instead of checking only
     * one JID.
     */

    const botIdentities =
      await getBotIdentityList();

    console.log(
      `🤖 Bot identities: ${botIdentities.join(", ")}`
    );

    let botParticipant = null;

    /* =============================================
       1. Exact / normalized JID match
    ============================================= */

    for (
      const identity of botIdentities
    ) {
      botParticipant =
        findParticipant(
          participants,
          identity
        );

      if (botParticipant) {
        break;
      }
    }

    /* =============================================
       2. Phone number match
    ============================================= */

    if (!botParticipant) {
      const botPhoneJid =
        getBotPhoneJid();

      const botNumber =
        getJidUserPart(
          botPhoneJid
        );

      if (botNumber) {
        botParticipant =
          participants.find(
            participant => {
              const values = [
                participant?.phoneNumber,
                participant?.id,
                participant?.lid
              ].filter(Boolean);

              return values.some(
                value =>
                  isPhoneJid(value) &&
                  getJidUserPart(
                    value
                  ) ===
                    botNumber
              );
            }
          );
      }
    }

    /* =============================================
       3. LID → Phone resolution
    ============================================= */

    if (!botParticipant) {
      for (
        const participant of participants
      ) {
        const ids = [
          participant?.id,
          participant?.lid
        ].filter(Boolean);

        for (
          const id of ids
        ) {
          if (!isLidJid(id)) {
            continue;
          }

          const resolved =
            await resolveLidToPhoneJid(
              id
            );

          if (!resolved) {
            continue;
          }

          for (
            const identity of botIdentities
          ) {
            if (
              isPhoneJid(identity) &&
              normalizeJidBase(
                identity
              ) ===
                normalizeJidBase(
                  resolved
                )
            ) {
              botParticipant =
                participant;

              break;
            }
          }

          if (botParticipant) {
            break;
          }
        }

        if (botParticipant) {
          break;
        }
      }
    }

    if (!botParticipant) {
      console.log(
        `🚫 Bot participant not found: ${groupId}`
      );

      console.log(
        "👤 Group participants:",
        participants.map(
          participant => ({
            id:
              participant?.id,
            lid:
              participant?.lid,
            phoneNumber:
              participant?.phoneNumber,
            admin:
              participant?.admin
          })
        )
      );

      return false;
    }

    const admin =
      isAdminParticipant(
        botParticipant
      );

    console.log(
      `${admin ? "👑" : "🚫"} Bot Admin Status: ${groupId} → ${
        admin
          ? "ADMIN"
          : "NOT ADMIN"
      }`
    );

    console.log(
      "🤖 Matched Bot Participant:",
      {
        id:
          botParticipant?.id,
        lid:
          botParticipant?.lid,
        phoneNumber:
          botParticipant?.phoneNumber,
        admin:
          botParticipant?.admin,
        isAdmin:
          botParticipant?.isAdmin,
        isSuperAdmin:
          botParticipant?.isSuperAdmin
      }
    );

    return admin;
  } catch (error) {
    console.log(
      "⚠️ Bot admin check error:",
      error?.message
    );

    return false;
  }
}

/* =========================================================
   GROUP ACCESS
========================================================= */

async function isGroupAllowed(
  groupId
) {
  if (
    !groupId ||
    !groupId.endsWith("@g.us")
  ) {
    return false;
  }

  return await isBotAdminInGroup(
    groupId
  );
}

/* =========================================================
   ADMIN CHECK
========================================================= */

async function isSenderAdmin(
  remoteJid,
  message
) {
  try {
    if (
      !sock ||
      !remoteJid
    ) {
      return false;
    }

    const participantJid =
      message?.key?.participant;

    if (!participantJid) {
      return false;
    }

    const metadata =
      await sock.groupMetadata(
        remoteJid
      );

    const participants =
      metadata?.participants ||
      [];

    await cacheParticipants(
      participants
    );

    let sender =
      findParticipant(
        participants,
        participantJid
      );

    if (!sender) {
      const senderPhone =
        await resolveLidToPhoneJid(
          participantJid
        );

      if (senderPhone) {
        sender =
          findParticipant(
            participants,
            senderPhone
          );
      }
    }

    if (!sender) {
      sender =
        participants.find(
          participant =>
            participant?.id ===
              participantJid ||
            participant?.lid ===
              participantJid ||
            participant?.phoneNumber ===
              participantJid
        );
    }

    if (!sender) {
      return false;
    }

    return isAdminParticipant(
      sender
    );
  } catch (error) {
    console.log(
      "⚠️ Admin check error:",
      error?.message
    );

    return false;
  }
}

/* =========================================================
   COPY BUTTON
========================================================= */

function makeCopyButton(
  command
) {
  return {
    name: "cta_copy",

    buttonParamsJson:
      JSON.stringify({
        display_text:
          "📋 Copy",

        id:
          "copy_" +
          normalizeCommandName(
            command
          ),

        copy_code:
          command
      })
  };
}

async function sendCopyButton(
  remoteJid,
  command
) {
  try {
    const button =
      makeCopyButton(
        command
      );

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
                            button
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
      `⚠️ Copy button failed: ${command}`,
      error?.message
    );

    return false;
  }
}

async function sendCopyButtons(
  remoteJid,
  commands
) {
  const uniqueCommands = [
    ...new Set(
      commands.filter(Boolean)
    )
  ];

  for (
    const command of uniqueCommands
  ) {
    await sendCopyButton(
      remoteJid,
      command
    );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          250
        )
    );
  }
}

/* =========================================================
   PUBLIC MENU
========================================================= */

function buildMenuText(
  remoteJid
) {
  const statusCommand =
    (
      number,
      key,
      command
    ) => {
      if (
        isCommandEnabled(
          remoteJid,
          key
        )
      ) {
        return `│ ${number} ${command}`;
      }

      return `│ ${number} 🔴 ${command} OFF`;
    };

  return `
╭━━━━━━━━━━━━━━━━━━━━╮
        🤖 *BOT MENU*
╰━━━━━━━━━━━━━━━━━━━━╯

╭─❖ 👥 *GROUP COMMANDS*
│
${statusCommand("1️⃣", "menu", "/menu")}
${statusCommand("2️⃣", "bot", "/bot")}
${statusCommand("3️⃣", "rules", "/rules")}
${statusCommand("4️⃣", "admin", "/admin")}
${statusCommand("5️⃣", "members", "/members")}
${statusCommand("6️⃣", "groupinfo", "/groupinfo")}
${statusCommand("7️⃣", "id", "/id")}
╰────────────────────

╭─❖ ⚙️ *UTILITY*
│
${statusCommand("8️⃣", "ping", "/ping")}
╰────────────────────

╭─❖ 💰 *BUY / SELL*
│
${
  isCommandEnabled(
    remoteJid,
    "deal"
  )
    ? "│ 9️⃣ /deal /ডিল"
    : "│ 9️⃣ 🔴 /deal /ডিল OFF"
}
╰────────────────────

╭─❖ 🤍 *PIYAS*
│
${
  isCommandEnabled(
    remoteJid,
    "piyas"
  )
    ? "│ 🔟 /piyas"
    : "│ 🔟 🔴 /piyas OFF"
}
╰────────────────────

╭─❖ 🌐 *OUR WEBSITE*
│
${
  isCommandEnabled(
    remoteJid,
    "website"
  )
    ? "│ 1️⃣1️⃣ /website"
    : "│ 1️⃣1️⃣ 🔴 /website OFF"
}
╰────────────────────

━━━━━━━━━━━━━━━━━━━━
📌 সব Command-এর আগে "/" ব্যবহার করতে হবে।
━━━━━━━━━━━━━━━━━━━━
`;
}

async function sendPublicMenu(
  remoteJid
) {
  try {
    await sock.sendMessage(
      remoteJid,
      {
        text:
          buildMenuText(
            remoteJid
          )
      }
    );

    const copyCommands = [
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
    ];

    const enabledCommands =
      copyCommands.filter(
        command =>
          isCommandEnabled(
            remoteJid,
            command
          )
      );

    await sendCopyButtons(
      remoteJid,
      enabledCommands
    );
  } catch (error) {
    console.log(
      "❌ Public menu error:",
      error?.message
    );
  }
}

/* =========================================================
   ADMIN PANEL
========================================================= */

async function sendAdminPanel(
  remoteJid
) {
  try {
    const disabled =
      getGroupStatus(
        remoteJid
      ).disabledCommands ||
      [];

    const commandStatus =
      COMMAND_DEFINITIONS
        .map(item => {
          const enabled =
            !disabled.includes(
              item.key
            );

          return `│ ${
            enabled
              ? "🟢"
              : "🔴"
          } ${item.command} ${
            enabled
              ? "ON"
              : "OFF"
          }`;
        })
        .join("\n");

    const moderation =
      getModerationStatus(
        remoteJid
      );

    const lockRemaining =
      getGroupLockRemaining(
        remoteJid
      );

    const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
       👑 *ADMIN PANEL*
╰━━━━━━━━━━━━━━━━━━━━╯

🔐 *শুধুমাত্র Group Owner ও Admin-এর জন্য*

╭─❖ 🤖 *BOT STATUS*
│
│ ${
      isBotEnabled(
        remoteJid
      )
        ? "🟢 Bot: ON"
        : "🔴 Bot: OFF"
    }
╰────────────────────

╭─❖ 🔒 *GROUP MESSAGE*
│
│ ${
      lockRemaining > 0
        ? "🔴 Member Message: OFF"
        : "🟢 Member Message: ON"
    }
${
  lockRemaining > 0
    ? `│ ⏱️ Remaining: ${formatGroupDuration(lockRemaining)}`
    : ""
}
╰────────────────────

╭─❖ ⚙️ *COMMAND STATUS*
│
${commandStatus}
╰────────────────────

╭─❖ 🛡️ *MODERATION STATUS*
│
│ ${
      moderation.badWords
        ? "🟢"
        : "🔴"
    } Bad Word Filter: ${
      moderation.badWords
        ? "ON"
        : "OFF"
    }
│ ${
      moderation.links
        ? "🟢"
        : "🔴"
    } Link Protection: ${
      moderation.links
        ? "ON"
        : "OFF"
    }
│ ${
      moderation.spam
        ? "🟢"
        : "🔴"
    } Duplicate Spam: ${
      moderation.spam
        ? "ON"
        : "OFF"
    }
│ ${
      moderation.warnings
        ? "🟢"
        : "🔴"
    } Warning System: ${
      moderation.warnings
        ? "ON"
        : "OFF"
    }
│ 🚫 Member Remove: DISABLED
│ 🚫 Kick/Ban: DISABLED
╰────────────────────

╭─❖ 🛠️ *BOT CONTROL*
│
│ 🟢 /boton
│ 🔴 /botoff
╰────────────────────

╭─❖ 🔒 *GROUP MESSAGE CONTROL*
│
│ 🔒 /গ্রুপ বন্ধ 2 মিনিট
│ 🔒 /গ্রুপ বন্ধ 30 মিনিট
│ 🔒 /গ্রুপ বন্ধ 2 ঘণ্টা
│ 🔓 /boton
╰────────────────────

╭─❖ ⚙️ *COMMAND CONTROL*
│
│ 🟢 /on <command>
│ 🔴 /off <command>
│ 📋 /cmdlist
╰────────────────────

╭─❖ 🛡️ *MODERATION CONTROL*
│
│ 📊 /mod
│ 🟢 /modon
│ 🔴 /modoff
╰────────────────────

━━━━━━━━━━━━━━━━━━━━
       👑 *ADMIN ONLY*
━━━━━━━━━━━━━━━━━━━━
`;

    await sock.sendMessage(
      remoteJid,
      {
        text
      }
    );

    await sendCopyButtons(
      remoteJid,
      [
        "/adminpanel",
        "/boton",
        "/botoff",
        "/গ্রুপ বন্ধ 2 মিনিট",
        "/গ্রুপ বন্ধ 30 মিনিট",
        "/গ্রুপ বন্ধ 2 ঘণ্টা",
        "/cmdlist",
        "/on admin",
        "/off admin",
        "/on deal",
        "/off deal",
        "/on rules",
        "/off rules",
        "/on website",
        "/off website",
        "/mod",
        "/modon",
        "/modoff"
      ]
    );
  } catch (error) {
    console.log(
      "❌ Admin panel error:",
      error?.message
    );
  }
}

/* =========================================================
   COMMAND LIST
========================================================= */

async function sendCommandList(
  remoteJid
) {
  const disabled =
    getGroupStatus(
      remoteJid
    ).disabledCommands ||
    [];

  const commandLines =
    COMMAND_DEFINITIONS
      .map(item => {
        const enabled =
          !disabled.includes(
            item.key
          );

        return `${
          enabled
            ? "🟢 ON "
            : "🔴 OFF"
        } ${item.command}`;
      });

  const moderation =
    getModerationStatus(
      remoteJid
    );

  const onCount =
    COMMAND_DEFINITIONS.filter(
      item =>
        !disabled.includes(
          item.key
        )
    ).length;

  const offCount =
    COMMAND_DEFINITIONS.length -
    onCount;

  const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
      📋 *COMMAND STATUS*
╰━━━━━━━━━━━━━━━━━━━━╯

${commandLines.join("\n")}

━━━━━━━━━━━━━━━━━━━━

🟢 *ON:* ${onCount}
🔴 *OFF:* ${offCount}

━━━━━━━━━━━━━━━━━━━━

🤖 *BOT STATUS:*
${
  isBotEnabled(
    remoteJid
  )
    ? "🟢 ON"
    : "🔴 OFF"
}

━━━━━━━━━━━━━━━━━━━━

🛡️ *MODERATION:*

${
  moderation.badWords
    ? "🟢"
    : "🔴"
} Bad Word Filter: ${
    moderation.badWords
      ? "ON"
      : "OFF"
  }

${
  moderation.links
    ? "🟢"
    : "🔴"
} Link Protection: ${
    moderation.links
      ? "ON"
      : "OFF"
  }

${
  moderation.spam
    ? "🟢"
    : "🔴"
} Duplicate Spam: ${
    moderation.spam
      ? "ON"
      : "OFF"
  }

${
  moderation.warnings
    ? "🟢"
    : "🔴"
} Warning System: ${
    moderation.warnings
      ? "ON"
      : "OFF"
  }

🚫 Member Remove: OFF
🚫 Kick/Ban: OFF

━━━━━━━━━━━━━━━━━━━━

📌 Duplicate Spam:
একই Member একই Message
১ মিনিটের মধ্যে পুনরায় পাঠালে
Spam হিসেবে Delete হবে।

📌 সব Command-এর আগে "/" আবশ্যক।

👑 শুধুমাত্র Admin ও Owner
এই Status দেখতে পারবেন।
`;

  await sock.sendMessage(
    remoteJid,
    {
      text
    }
  );

  await sendCopyButtons(
    remoteJid,
    [
      "/cmdlist",
      ...COMMAND_DEFINITIONS.map(
        item =>
          item.command
      )
    ]
  );
}

/* =========================================================
   MODERATION STATUS
========================================================= */

async function sendModerationStatus(
  remoteJid
) {
  const moderation =
    getModerationStatus(
      remoteJid
    );

  const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
       🛡️ *MODERATION*
╰━━━━━━━━━━━━━━━━━━━━╯

🛡️ *Moderation Status*

${
  moderation.badWords
    ? "🟢"
    : "🔴"
} Bad Word Filter:
${
  moderation.badWords
    ? "ON"
    : "OFF"
  }

${
  moderation.links
    ? "🟢"
    : "🔴"
} Link Protection:
${
  moderation.links
    ? "ON"
    : "OFF"
  }

${
  moderation.spam
    ? "🟢"
    : "🔴"
} Duplicate Spam:
${
  moderation.spam
    ? "ON"
    : "OFF"
  }

${
  moderation.warnings
    ? "🟢"
    : "🔴"
} Warning System:
${
  moderation.warnings
    ? "ON"
    : "OFF"
  }

━━━━━━━━━━━━━━━━━━━━

📌 *Spam Rule:*

একই Member একই Message
১ মিনিটের মধ্যে আবার পাঠালে
দ্বিতীয় Message Delete হবে
এবং Warning দেওয়া হবে।

🚫 Member Remove:
🔴 DISABLED

🚫 Kick:
🔴 DISABLED

🚫 Ban:
🔴 DISABLED

━━━━━━━━━━━━━━━━━━━━

👑 *Admin Controls*

🟢 /modon
🔴 /modoff

━━━━━━━━━━━━━━━━━━━━

📌 /modon দিলে Moderation ON
📌 /modoff দিলে Moderation OFF

🤍 *Piyas Bot*
`;

  await sock.sendMessage(
    remoteJid,
    {
      text
    }
  );

  await sendCopyButtons(
    remoteJid,
    [
      "/mod",
      "/modon",
      "/modoff"
    ]
  );
}

/* =========================================================
   RULES
========================================================= */

const GROUP_RULES = `
╭━━━━━━━━━━━━━━━━━━━━╮
        📜 *GROUP RULES*
╰━━━━━━━━━━━━━━━━━━━━╯

1️⃣ সবাইকে সম্মান করে কথা বলুন।

2️⃣ অশ্লীল বা আপত্তিকর কোনো
কনটেন্ট শেয়ার করবেন না।

3️⃣ Spam বা একই মেসেজ
বারবার পাঠাবেন না।

4️⃣ একই Message ১ মিনিটের
মধ্যে পুনরায় পাঠালে Spam
হিসেবে Delete হতে পারে।

5️⃣ সন্দেহজনক বা প্রতারণামূলক
লিংক শেয়ার করবেন না।

6️⃣ অন্য সদস্যকে হয়রানি
বা বিরক্ত করবেন না।

7️⃣ Account Buy/Sell ও
Google Play Points সম্পর্কিত
বিষয়ে সবাই সতর্ক থাকুন।

8️⃣ কোনো সমস্যায় পড়লে
সরাসরি Admin-কে জানান।

🛡️ *Moderation System:*

Bad Word, Link এবং Duplicate
Spam শনাক্ত হলে Message
Delete হতে পারে।

⚠️ Admin/Owner-এর Message
Moderation থেকে বাদ থাকবে।

🚫 Member Remove/Kick/Ban
করা হবে না।

🤍 সবাই মিলে গ্রুপের
পরিবেশ সুন্দর রাখুন।
`;

/* =========================================================
   WEBSITE
========================================================= */

const WEBSITE_TEXT = `
╭━━━━━━━━━━━━━━━━━━━━╮
      🌐 *OUR WEBSITE*
╰━━━━━━━━━━━━━━━━━━━━╯

🌐 *Official Website:*

${WEBSITE_URL}

🎁 এখানে Account Buy/Sell,
Google Play Points এবং
অন্যান্য earning সম্পর্কিত
তথ্য পাওয়া যাবে।

🤍 *Piyas*
`;

/* =========================================================
   PIYAS
========================================================= */

const PIYAS_INFO = `
╭━━━━━━━━━━━━━━━━━━╮
       🤍 *PIYAS*
╰━━━━━━━━━━━━━━━━━━╯

☪️ *আমার সবচেয়ে বড় পরিচয়: আমি একজন মুসলিম এবং মহানবী হযরত মুহাম্মাদ (সা.)-এর উম্মত।* 🤍

👤 *Name:* মোঃ আল আমিন
🌐 *English Name:* MD. AL AMIN

👨‍👦 *Father:* মোঃ মোশারফ হোসেন
👩‍👦 *Mother:* মোসাম্মৎ রীপা বেগম

🎂 *Date of Birth:* ০৯ জানুয়ারি ২০০৬
🩸 *Blood Group:* A+

💍 *Marital Status:* Unmarried

🏠 *Address:*
গ্রাম/রাস্তা: বলদার চর, নান্দাইল
ডাকঘর: হেমগঞ্জ বাজার - ২২৯০
নান্দাইল, ময়মনসিংহ

🤍 *Thank You*
`;

/* =========================================================
   BOT OFF / ON
========================================================= */

const BOT_OFF_TEXT = `
╭━━━━━━━━━━━━━━━━━━━━╮
       🔴 *BOT OFF*
╰━━━━━━━━━━━━━━━━━━━━╯

বট এখন সাময়িকভাবে বন্ধ করা হয়েছে।

👑 শুধুমাত্র Admin / Owner
আবার চালু করতে পারবেন।

🟢 /boton
`;

const BOT_ON_TEXT = `
╭━━━━━━━━━━━━━━━━━━━━╮
        🟢 *BOT ON*
╰━━━━━━━━━━━━━━━━━━━━╯

বট এখন পুনরায় চালু করা হয়েছে। ✅

🤖 এখন সব Command ব্যবহার করা যাবে।

🤍 *Piyas*
`;

const BOT_ALREADY_OFF_TEXT = `
🔴 *BOT STATUS*

বট ইতোমধ্যে OFF আছে।
`;

const BOT_ALREADY_ON_TEXT = `
🟢 *BOT STATUS*

বট ইতোমধ্যে ON আছে।
`;

/* =========================================================
   DEAL
========================================================= */

const DEAL_NOTICE_TOP = `
╭━━━━━━━━━━━━━━━━━━━━╮
        🤝 *DEAL NOTICE*
╰━━━━━━━━━━━━━━━━━━━━╯

⚠️ *গুরুত্বপূর্ণ সতর্কতা!*

কোনো ধরনের Account Buy/Sell,
Google Play Points অথবা অন্য
কোনো Deal করার আগে অবশ্যই
Group-এর Admin-এর সাথে
যোগাযোগ করুন।

🚫 *Admin ছাড়া কারো সাথে
কোনো Deal করবেন না।*

⚠️ Admin-এর অনুমতি ছাড়া
কোনো Deal করলে তার সম্পূর্ণ
দায়ভার সংশ্লিষ্ট ব্যক্তির।

❌ Admin ছাড়া করা কোনো Deal-এর
জন্য Group Admin কোনোভাবেই
দায়ী থাকবে না।

👑 *Deal করার জন্য Group Admin:*

`;

const DEAL_NOTICE_BOTTOM = `
📌 নিরাপদ থাকতে সবসময়
Admin-এর মাধ্যমে Deal করুন।

🤍 *PIYAS*
`;

/* =========================================================
   ADMIN DATA
========================================================= */

async function getAdminData(
  remoteJid
) {
  try {
    const metadata =
      await sock.groupMetadata(
        remoteJid
      );

    const participants =
      metadata?.participants ||
      [];

    await cacheParticipants(
      participants
    );

    const adminParticipants =
      participants.filter(
        isAdminParticipant
      );

    const result = [];
    const usedJids =
      new Set();

    for (
      const participant of
        adminParticipants
    ) {
      const phoneJid =
        await getPhoneJid(
          participant
        );

      let name =
        getDisplayName(
          participant
        );

      if (
        !name ||
        name === "Member"
      ) {
        name = "Admin";
      }

      if (
        phoneJid &&
        usedJids.has(
          phoneJid
        )
      ) {
        continue;
      }

      if (phoneJid) {
        usedJids.add(
          phoneJid
        );
      }

      result.push({
        jid:
          phoneJid ||
          participant.id ||
          participant.lid ||
          null,

        name,

        owner:
          isOwnerParticipant(
            participant
          )
      });
    }

    return {
      admins: result,
      result
    };
  } catch (error) {
    console.log(
      "❌ getAdminData error:",
      error?.message
    );

    return {
      admins: [],
      result: []
    };
  }
}

/* =========================================================
   ADMIN LIST
========================================================= */

async function sendAdminList(
  remoteJid
) {
  const {
    admins
  } =
    await getAdminData(
      remoteJid
    );

  if (!admins.length) {
    await sock.sendMessage(
      remoteJid,
      {
        text:
          "👑 এই গ্রুপে কোনো Admin পাওয়া যায়নি।"
      }
    );

    return;
  }

  const lines = [];
  const mentions = [];

  let number = 1;

  for (
    const admin of admins
  ) {
    const role =
      admin.owner
        ? "⭐ *Group Owner*"
        : "👑 *Admin*";

    if (
      isPhoneJid(
        admin.jid
      )
    ) {
      const phone =
        admin.jid
          .split("@")[0]
          .replace(
            /[^0-9]/g,
            ""
          );

      mentions.push(
        admin.jid
      );

      lines.push(
        `${number}️⃣ @${phone} ${role}`
      );
    } else {
      lines.push(
        `${number}️⃣ ${admin.name} ${role}`
      );
    }

    number++;
  }

  const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
       👑 *GROUP ADMINS*
╰━━━━━━━━━━━━━━━━━━━━╯

${lines.join("\n\n")}

━━━━━━━━━━━━━━━━━━━━

👥 *মোট Admin:* ${admins.length} জন

🤍 *Piyas*
`;

  await sock.sendMessage(
    remoteJid,
    {
      text,
      mentions
    }
  );
}

/* =========================================================
   DEAL MESSAGE
========================================================= */

async function sendDealNotice(
  remoteJid
) {
  const {
    admins
  } =
    await getAdminData(
      remoteJid
    );

  if (!admins.length) {
    await sock.sendMessage(
      remoteJid,
      {
        text:
          DEAL_NOTICE_TOP +
          "⚠️ বর্তমানে কোনো Admin পাওয়া যায়নি.\n\n" +
          DEAL_NOTICE_BOTTOM
      }
    );

    return;
  }

  const lines = [];
  const mentions = [];

  let number = 1;

  for (
    const admin of admins
  ) {
    const role =
      admin.owner
        ? "⭐ *Group Owner*"
        : "👑 *Admin*";

    if (
      isPhoneJid(
        admin.jid
      )
    ) {
      const phone =
        admin.jid
          .split("@")[0]
          .replace(
            /[^0-9]/g,
            ""
          );

      mentions.push(
        admin.jid
      );

      lines.push(
        `${number}️⃣ @${phone} ${role}`
      );
    } else {
      lines.push(
        `${number}️⃣ ${admin.name} ${role}`
      );
    }

    number++;
  }

  const text =
    DEAL_NOTICE_TOP +
    lines.join("\n\n") +
    `\n\n👥 *মোট Admin:* ${admins.length} জন\n\n` +
    DEAL_NOTICE_BOTTOM;

  await sock.sendMessage(
    remoteJid,
    {
      text,
      mentions
    }
  );
}

/* =========================================================
   WELCOME
========================================================= */

function getWelcomeText(
  name,
  groupName
) {
  const safeName =
    cleanName(name) ||
    "Member";

  const safeGroupName =
    cleanName(groupName) ||
    "এই গ্রুপ";

  return `
╭━━━━━━━━━━━━━━━━━━━━╮
        🎉 *স্বাগতম*
╰━━━━━━━━━━━━━━━━━━━━╯

🎉 *স্বাগতম @${safeName}* ❤️

🌸 আপনাকে *${safeGroupName}*
গ্রুপে স্বাগতম।

💬 এখানে সবাই একে অপরকে সহযোগিতা করবেন।

📌 গ্রুপের নিয়ম দেখতে লিখুন:
*/rules*

🌐 Website দেখতে লিখুন:
*/website*

⚡ Account Buy/Sell ও Google Play Points সম্পর্কিত তথ্য এখানে শেয়ার করা হয়।

⚠️ *বিশেষ সতর্কতা:*

যেকোনো সমস্যায় পড়লে সরাসরি Admin-কে জানাবেন।

কোনো ধরনের প্রতারণা বা সন্দেহজনক বিষয় দেখলে Admin-কে জানান।

🌐 আমাদের Website:
${WEBSITE_URL}

🔰 *ব্যাকআপ গ্রুপে যুক্ত থাকুন:*
${BACKUP_GROUP_URL}

❤️ *Piyas*
`;
}

async function sendWelcome(
  groupId,
  participant
) {
  try {
    if (
      !sock ||
      !isBotEnabled(groupId)
    ) {
      return;
    }

    let metadata = null;

    try {
      metadata =
        await sock.groupMetadata(
          groupId
        );

      await cacheParticipants(
        metadata?.participants ||
          []
      );
    } catch {}

    let member =
      findParticipant(
        metadata?.participants ||
          [],
        participant?.id
      );

    if (!member) {
      member =
        findParticipant(
          metadata?.participants ||
            [],
          participant?.lid
        );
    }

    if (!member) {
      member =
        participant;
    }

    const name =
      getDisplayName(
        member
      );

    const groupName =
      cleanName(
        metadata?.subject
      ) ||
      "এই গ্রুপ";

    const phoneJid =
      await getPhoneJid(
        member
      );

    const welcomeText =
      getWelcomeText(
        name,
        groupName
      );

    if (
      isPhoneJid(
        phoneJid
      )
    ) {
      await sock.sendMessage(
        groupId,
        {
          text:
            welcomeText,
          mentions: [
            phoneJid
          ]
        }
      );
    } else {
      await sock.sendMessage(
        groupId,
        {
          text:
            welcomeText.replace(
              `@${name}`,
              name
            )
        }
      );
    }
  } catch (error) {
    console.log(
      "❌ Welcome send error:",
      error?.message
    );
  }
}

/* =========================================================
   LID EVENT
========================================================= */

function handleLidMappingUpdate(
  mapping
) {
  try {
    if (!mapping) {
      return;
    }

    const mappings =
      Array.isArray(mapping)
        ? mapping
        : Array.isArray(
            mapping?.mappings
          )
          ? mapping.mappings
          : [mapping];

    for (
      const item of mappings
    ) {
      if (!item) {
        continue;
      }

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

      if (
        lid &&
        pn
      ) {
        saveLidMapping(
          lid,
          pn
        );
      }
    }
  } catch (error) {
    console.log(
      "⚠️ LID mapping update error:",
      error?.message
    );
  }
}

/* =========================================================
   PAIRING CODE
========================================================= */

async function generatePairingCode(
  state
) {
  try {
    if (!PHONE_NUMBER) {
      console.log(
        "❌ PHONE_NUMBER is missing in .env"
      );

      return;
    }

    if (
      state.creds.registered
    ) {
      console.log(
        "✅ Existing WhatsApp session found."
      );

      return;
    }

    if (pairingRequested) {
      return;
    }

    pairingRequested = true;

    console.log(
      `📱 Pairing Number: ${PHONE_NUMBER}`
    );

    console.log(
      "🔐 Generating WhatsApp Pairing Code..."
    );

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

    console.log(
      "📲 WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead"
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
    msg.buttonsResponseMessage
      ?.selectedButtonId ||
    msg.listResponseMessage
      ?.singleSelectReply
      ?.selectedRowId ||
    ""
  ).trim();
}

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
      console.log(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

      console.log(
        "🔄 PHONE NUMBER CHANGED"
      );

      console.log(
        `Old: ${currentCredPhone}`
      );

      console.log(
        `New: ${PHONE_NUMBER}`
      );

      console.log(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

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

    /* =====================================================
       SOCKET
    ===================================================== */

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

    /* =====================================================
       CREDENTIALS
    ===================================================== */

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    /* =====================================================
       LID
    ===================================================== */

    sock.ev.on(
      "lid-mapping.update",
      handleLidMappingUpdate
    );

    /* =====================================================
       CONTACTS
    ===================================================== */

    sock.ev.on(
      "contacts.upsert",
      contacts => {
        try {
          saveContacts(
            contacts
          );
        } catch (error) {
          console.log(
            "⚠️ contacts.upsert error:",
            error?.message
          );
        }
      }
    );

    sock.ev.on(
      "contacts.update",
      contacts => {
        try {
          saveContacts(
            contacts
          );
        } catch (error) {
          console.log(
            "⚠️ contacts.update error:",
            error?.message
          );
        }
      }
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

          const action =
            event?.action;

          const participants =
            event?.participants ||
            [];

          if (!groupId) {
            return;
          }

          const botIsAdmin =
            await isGroupAllowed(
              groupId
            );

          if (!botIsAdmin) {
            console.log(
              `🚫 Bot is not Admin: ${groupId}`
            );

            return;
          }

          console.log(
            `👥 Group update: ${action} | ${groupId} | ${participants.length} participant(s)`
          );

          if (
            action === "add"
          ) {
            for (
              const participant of
                participants
            ) {
              await sendWelcome(
                groupId,
                participant
              );
            }
          }

          if (
            action === "promote" ||
            action === "demote"
          ) {
            await cacheParticipants(
              participants
            );
          }
        } catch (error) {
          console.log(
            "❌ Group participant event error:",
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
            connection ===
            "connecting"
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
                const group of Object.values(
                  groups || {}
                )
              ) {
                await cacheParticipants(
                  group?.participants ||
                    []
                );
              }

              console.log(
                "📦 Group participant cache loaded."
              );

              let adminGroupCount = 0;

              for (
                const group of Object.values(
                  groups || {}
                )
              ) {
                const groupId =
                  group?.id;

                if (!groupId) {
                  continue;
                }

                const admin =
                  await isBotAdminInGroup(
                    groupId
                  );

                if (admin) {
                  adminGroupCount++;
                }
              }

              console.log(
                `👑 Bot Admin Groups: ${adminGroupCount}`
              );

              /*
               * Restore timed Group Message locks
               * after reconnect/restart.
               */
              await restoreActiveGroupLocks();

              /*
               * Immediately open expired groups.
               */
              await autoEnableExpiredGroups();
            } catch (error) {
              console.log(
                "⚠️ Group cache error:",
                error?.message
              );
            }

            return;
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
              `❌ WhatsApp connection closed. Code: ${statusCode}`
            );

            sock = null;

            pairingRequested = false;

            if (
              shouldReconnect &&
              !reconnecting
            ) {
              reconnecting = true;

              console.log(
                "🔄 Reconnecting..."
              );

              setTimeout(
                () => {
                  reconnecting = false;
                  startBot();
                },
                3000
              );
            } else if (
              !shouldReconnect
            ) {
              console.log(
                "🚪 WhatsApp session logged out."
              );

              console.log(
                "ℹ️ New number দিলে নতুন Pairing Code generate হবে."
              );
            }
          }
        } catch (error) {
          console.log(
            "❌ Connection update error:",
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
        try {
          if (
            !Array.isArray(
              messages
            )
          ) {
            return;
          }

          for (
            const message of messages
          ) {
            try {
              if (!message) {
                continue;
              }

              if (
                message.key?.fromMe
              ) {
                continue;
              }

              const remoteJid =
                message.key
                  ?.remoteJid;

              if (
                !remoteJid ||
                !remoteJid.endsWith(
                  "@g.us"
                )
              ) {
                continue;
              }

              /* =========================================
                 GROUP ACCESS
              ========================================= */

              const botIsAdmin =
                await isGroupAllowed(
                  remoteJid
                );

              if (!botIsAdmin) {
                console.log(
                  `🚫 Bot is not Group Admin: ${remoteJid}`
                );

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
                `📩 MESSAGE: ${text}`
              );

              console.log(
                `👥 GROUP: ${remoteJid}`
              );

              /* =========================================
                 MODERATION
              ========================================= */

              const moderated =
                await moderateMessage(
                  remoteJid,
                  message,
                  text
                );

              if (moderated) {
                console.log(
                  "🛡️ Message moderated."
                );

                continue;
              }

              /* =========================================
                 "/" বাধ্যতামূলক
              ========================================= */

              const trimmedText =
                text.trim();

              if (
                !trimmedText.startsWith("/")
              ) {
                console.log(
                  `ℹ️ Not a command: ${text}`
                );

                continue;
              }

              const parts =
                trimmedText
                  .split(
                    /\s+/
                  );

              const rawCommand =
                parts.shift() ||
                "";

              const command =
                normalizeCommandName(
                  rawCommand
                );

              const args =
                parts;

              if (!command) {
                continue;
              }

              console.log(
                `🤖 COMMAND: /${command}`
              );

              /* =============================================
                 ADMIN ONLY COMMAND
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
                  console.log(
                    `🚫 NON-ADMIN: /${command}`
                  );

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
                 GROUP MESSAGE OFF
              ============================================= */

              if (
                command ===
                "গ্রুপ"
              ) {
                const action =
                  normalizeCommandName(
                    args[0] ||
                    ""
                  );

                if (
                  action !== "বন্ধ"
                ) {
                  await sock.sendMessage(
                    remoteJid,
                    {
                      text: `
╭━━━━━━━━━━━━━━━━━━━━╮
      🔒 *GROUP MESSAGE CONTROL*
╰━━━━━━━━━━━━━━━━━━━━╯

🔴 সাধারণ Member-এর Message
বন্ধ করতে:

/গ্রুপ বন্ধ 2 মিনিট

💡 উদাহরণ:

/গ্রুপ বন্ধ 30 মিনিট
/গ্রুপ বন্ধ 2 ঘণ্টা
/গ্রুপ বন্ধ 1 দিন
/গ্রুপ বন্ধ 1 সপ্তাহ
/গ্রুপ বন্ধ 1 মাস
/গ্রুপ বন্ধ 1 বছর

🟢 আবার আগে চালু করতে:

/boton
`
                    }
                  );

                  continue;
                }

                const durationArgs =
                  args.slice(1);

                const durationMs =
                  parseGroupOffDuration(
                    durationArgs
                  );

                if (
                  !durationMs
                ) {
                  await sock.sendMessage(
                    remoteJid,
                    {
                      text: `
❌ *সময় সঠিক নয়।*

সঠিকভাবে লিখুন:

/গ্রুপ বন্ধ 2 মিনিট

অথবা:

/গ্রুপ বন্ধ 30 মিনিট
/গ্রুপ বন্ধ 2 ঘণ্টা
/গ্রুপ বন্ধ 1 দিন
/গ্রুপ বন্ধ 1 সপ্তাহ
/গ্রুপ বন্ধ 1 মাস
/গ্রুপ বন্ধ 1 বছর

💡 শুধু সংখ্যা দিলে সেটি মিনিট হিসেবে ধরা হবে:

/গ্রুপ বন্ধ 10
`
                    }
                  );

                  continue;
                }

                await lockGroupForDuration(
                  remoteJid,
                  durationMs
                );

                continue;
              }

              /* =============================================
                 BOT OFF
              ============================================= */

              if (
                command ===
                "botoff"
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
                        BOT_ALREADY_OFF_TEXT
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
                command ===
                "boton"
              ) {
                /*
                 * If Group Message Lock is active,
                 * /boton means open the Group immediately.
                 */
                const lockRemaining =
                  getGroupLockRemaining(
                    remoteJid
                  );

                if (
                  lockRemaining > 0
                ) {
                  const unlocked =
                    await unlockGroupNow(
                      remoteJid,
                      "manual"
                    );

                  if (unlocked) {
                    /*
                     * Keep Bot ON.
                     */
                    setBotStatus(
                      remoteJid,
                      true
                    );
                  }

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
                        BOT_ALREADY_ON_TEXT
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
                command ===
                "adminpanel"
              ) {
                await sendAdminPanel(
                  remoteJid
                );

                continue;
              }

              /* =============================================
                 MODERATION STATUS
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

              /* =============================================
                 MODERATION ON
              ============================================= */

              if (
                command === "modon"
              ) {
                setModerationStatus(
                  remoteJid,
                  "badWords",
                  true
                );

                setModerationStatus(
                  remoteJid,
                  "links",
                  true
                );

                setModerationStatus(
                  remoteJid,
                  "spam",
                  true
                );

                setModerationStatus(
                  remoteJid,
                  "warnings",
                  true
                );

                await sock.sendMessage(
                  remoteJid,
                  {
                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🛡️ *MODERATION ON*
╰━━━━━━━━━━━━━━━━━━━━╯

🟢 Bad Word Filter: ON
🟢 Link Protection: ON
🟢 Duplicate Spam: ON
🟢 Warning System: ON

📌 Same Message ১ মিনিটের
মধ্যে পুনরায় পাঠালে Spam হবে।

🚫 Member Remove: OFF
🚫 Kick/Ban: OFF

✅ Moderation System চালু হয়েছে।
`
                  }
                );

                continue;
              }

              /* =============================================
                 MODERATION OFF
              ============================================= */

              if (
                command === "modoff"
              ) {
                setModerationStatus(
                  remoteJid,
                  "badWords",
                  false
                );

                setModerationStatus(
                  remoteJid,
                  "links",
                  false
                );

                setModerationStatus(
                  remoteJid,
                  "spam",
                  false
                );

                setModerationStatus(
                  remoteJid,
                  "warnings",
                  false
                );

                await sock.sendMessage(
                  remoteJid,
                  {
                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🛡️ *MODERATION OFF*
╰━━━━━━━━━━━━━━━━━━━━╯

🔴 Bad Word Filter: OFF
🔴 Link Protection: OFF
🔴 Duplicate Spam: OFF
🔴 Warning System: OFF

🚫 Member Remove: OFF
🚫 Kick/Ban: OFF

❌ Moderation System বন্ধ হয়েছে।
`
                  }
                );

                continue;
              }

              /* =============================================
                 ON / OFF
              ============================================= */

              if (
                command === "on" ||
                command === "off"
              ) {
                const targetRaw =
                  args[0] ||
                  "";

                const target =
                  getCanonicalCommand(
                    targetRaw
                  );

                if (!target) {
                  await sock.sendMessage(
                    remoteJid,
                    {
                      text: `
╭━━━━━━━━━━━━━━━━━━━━╮
      ⚙️ *COMMAND CONTROL*
╰━━━━━━━━━━━━━━━━━━━━╯

🟢 *ON করতে:*

/on <command>

🔴 *OFF করতে:*

/off <command>

💡 *উদাহরণ:*

/on admin
/off admin

/on deal
/off deal

/on rules
/off rules

/on website
/off website
`
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

                if (
                  !isKnownCommand(
                    target
                  )
                ) {
                  await sock.sendMessage(
                    remoteJid,
                    {
                      text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       ⚠️ *UNKNOWN COMMAND*
╰━━━━━━━━━━━━━━━━━━━━╯

❌ */${target}* নামে কোনো Command নেই।

📋 Available Commands:

${COMMAND_DEFINITIONS
  .map(
    item =>
      `• ${item.command}`
  )
  .join("\n")}
`
                    }
                  );

                  continue;
                }

                if (
                  command ===
                  "off"
                ) {
                  if (
                    !isCommandEnabled(
                      remoteJid,
                      target
                    )
                  ) {
                    await sock.sendMessage(
                      remoteJid,
                      {
                        text:
                          `🔴 */${target}* ইতোমধ্যে OFF আছে।`
                      }
                    );

                    continue;
                  }

                  setCommandStatus(
                    remoteJid,
                    target,
                    false
                  );

                  await sock.sendMessage(
                    remoteJid,
                    {
                      text: `
╭━━━━━━━━━━━━━━━━━━━━╮
       🔴 *COMMAND OFF*
╰━━━━━━━━━━━━━━━━━━━━╯

⚙️ *Command:*
/${target}

❌ এখন থেকে এই Command
কাজ করবে না।

🟢 আবার চালু করতে:

/on ${target}
`
                    }
                  );

                  await sendCopyButton(
                    remoteJid,
                    `/on ${target}`
                  );

                  continue;
                }

                if (
                  command ===
                  "on"
                ) {
                  if (
                    isCommandEnabled(
                      remoteJid,
                      target
                    )
                  ) {
                    await sock.sendMessage(
                      remoteJid,
                      {
                        text:
                          `🟢 */${target}* ইতোমধ্যে ON আছে।`
                      }
                    );

                    continue;
                  }

                  setCommandStatus(
                    remoteJid,
                    target,
                    true
                  );

                  await sock.sendMessage(
                    remoteJid,
                    {
                      text: `
╭━━━━━━━━━━━━━━━━━━━━╮
        🟢 *COMMAND ON*
╰━━━━━━━━━━━━━━━━━━━━╯

⚙️ *Command:*
/${target}

✅ এখন থেকে এই Command
আবার কাজ করবে।
`
                    }
                  );

                  await sendCopyButton(
                    remoteJid,
                    `/off ${target}`
                  );

                  continue;
                }
              }

              /* =============================================
                 COMMAND LIST
              ============================================= */

              if (
                command ===
                "cmdlist"
              ) {
                await sendCommandList(
                  remoteJid
                );

                continue;
              }

              /* =============================================
                 BOT OFF হলে সাধারণ Command বন্ধ
              ============================================= */

              if (
                !isBotEnabled(
                  remoteJid
                )
              ) {
                console.log(
                  `🔴 BOT OFF: /${command}`
                );

                continue;
              }

              /* =============================================
                 CANONICAL COMMAND
              ============================================= */

              const commandAlias =
                getCanonicalCommand(
                  command
                );

              /* =============================================
                 UNKNOWN COMMAND
              ============================================= */

              if (
                !isKnownCommand(
                  commandAlias
                )
              ) {
                continue;
              }

              /* =============================================
                 COMMAND OFF CHECK
              ============================================= */

              if (
                !isCommandEnabled(
                  remoteJid,
                  commandAlias
                )
              ) {
                console.log(
                  `🔴 COMMAND OFF: /${commandAlias}`
                );

                continue;
              }

              /* =============================================
                 MENU
              ============================================= */

              if (
                commandAlias === "menu" ||
                commandAlias === "bot"
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
                commandAlias ===
                "rules"
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
                commandAlias ===
                "website"
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
                commandAlias ===
                "deal"
              ) {
                await sendDealNotice(
                  remoteJid
                );

                await sendCopyButtons(
                  remoteJid,
                  [
                    "/deal",
                    "/ডিল"
                  ]
                );

                continue;
              }

              /* =============================================
                 ADMIN
              ============================================= */

              if (
                commandAlias ===
                "admin"
              ) {
                await sendAdminList(
                  remoteJid
                );

                await sendCopyButton(
                  remoteJid,
                  "/admin"
                );

                continue;
              }

              /* =============================================
                 MEMBERS
              ============================================= */

              if (
                commandAlias ===
                "members"
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
                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
        👥 *GROUP MEMBERS*
╰━━━━━━━━━━━━━━━━━━━━╯

👥 *মোট Member:* ${participants.length} জন
`
                  }
                );

                await sendCopyButton(
                  remoteJid,
                  "/members"
                );

                continue;
              }

              /* =============================================
                 GROUP INFO
              ============================================= */

              if (
                commandAlias ===
                "groupinfo"
              ) {
                const metadata =
                  await sock.groupMetadata(
                    remoteJid
                  );

                const participants =
                  metadata?.participants ||
                  [];

                await cacheParticipants(
                  participants
                );

                const admins =
                  participants.filter(
                    isAdminParticipant
                  );

                const created =
                  metadata?.creation
                    ? new Date(
                        Number(
                          metadata.creation
                        ) * 1000
                      ).toLocaleString(
                        "en-BD"
                      )
                    : "Unknown";

                const moderation =
                  getModerationStatus(
                    remoteJid
                  );

                const lockRemaining =
                  getGroupLockRemaining(
                    remoteJid
                  );

                await sock.sendMessage(
                  remoteJid,
                  {
                    text: `
╭━━━━━━━━━━━━━━━━━━╮
       👥 *GROUP INFO*
╰━━━━━━━━━━━━━━━━━━╯

📛 *Name:* ${
                      metadata?.subject ||
                      "Unknown"
                    }

🆔 *ID:* ${remoteJid}

👥 *Members:* ${
                      participants.length
                    }

👑 *Admins:* ${
                      admins.length
                    }

📅 *Created:* ${
                      created
                    }

🤖 *Bot:* ${
                      isBotEnabled(
                        remoteJid
                      )
                        ? "🟢 ON"
                        : "🔴 OFF"
                    }

🔒 *Member Message:* ${
                      lockRemaining > 0
                        ? "🔴 OFF"
                        : "🟢 ON"
                    }

${
  lockRemaining > 0
    ? `⏱️ *Remaining:* ${formatGroupDuration(lockRemaining)}`
    : ""
}

🛡️ *Bad Word:* ${
                      moderation.badWords
                        ? "🟢 ON"
                        : "🔴 OFF"
                    }

🔗 *Link Protection:* ${
                      moderation.links
                        ? "🟢 ON"
                        : "🔴 OFF"
                    }

🚨 *Duplicate Spam:* ${
                      moderation.spam
                        ? "🟢 ON"
                        : "🔴 OFF"
                    }

⚠️ *Warning:* ${
                      moderation.warnings
                        ? "🟢 ON"
                        : "🔴 OFF"
                    }

🚫 *Kick/Ban:* OFF

🤍 *Powered by Piyas*
`
                  }
                );

                await sendCopyButton(
                  remoteJid,
                  "/groupinfo"
                );

                continue;
              }

              /* =============================================
                 ID
              ============================================= */

              if (
                commandAlias ===
                "id"
              ) {
                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      `🆔 *GROUP ID*\n\n${remoteJid}`
                  }
                );

                await sendCopyButton(
                  remoteJid,
                  "/id"
                );

                continue;
              }

              /* =============================================
                 PING
              ============================================= */

              if (
                commandAlias ===
                "ping"
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
                    quoted:
                      msg
                  }
                );

                await sendCopyButton(
                  remoteJid,
                  "/ping"
                );

                continue;
              }

              /* =============================================
                 PIYAS
              ============================================= */

              if (
                commandAlias ===
                "piyas"
              ) {
                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      PIYAS_INFO
                  }
                );

                await sendCopyButton(
                  remoteJid,
                  "/piyas"
                );

                continue;
              }
            } catch (messageError) {
              console.log(
                "⚠️ Single message error:",
                messageError?.message
              );

              console.log(
                messageError?.stack ||
                  ""
              );
            }
          }
        } catch (error) {
          console.log(
            "⚠️ Message handler error:",
            error?.message
          );

          console.log(
            error?.stack || ""
          );
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

    console.log(
      error?.stack || ""
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
   GLOBAL ERRORS
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
```0