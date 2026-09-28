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

const GROUP_IDS = (process.env.ALLOWED_GROUPS || "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

const PHONE_NUMBER = (process.env.PHONE_NUMBER || "")
  .replace(/[^0-9]/g, "");

const WEBSITE_URL =
  "https://x-cyber-2025.github.io/X-cyber.web/";

const AUTH_DIR = "./auth_info";
const PAIRING_NUMBER_FILE = "./pairing_number.txt";
const BOT_STATUS_FILE = "./bot_status.json";

const DUPLICATE_SPAM_WINDOW = 5 * 60 * 1000;
const WARNING_COOLDOWN = 10 * 1000;

let sock = null;
let reconnecting = false;
let pairingRequested = false;

const contactNames = new Map();
const contactPhoneJids = new Map();
const lidToPhoneJid = new Map();

const duplicateMessageCache = new Map();
const warningCooldown = new Map();

const logger = P({
  level: "silent"
});

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
   SPECIAL ADMIN CONTROLS
========================================================= */

const SPECIAL_ADMIN_CONTROLS = [
  "welcome"
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
  "onbot",
  "offbot",
  "fullbotstatus"
];

/* =========================================================
   PROTECTED COMMANDS
========================================================= */

const PROTECTED_COMMANDS = [
  "adminpanel",
  "cmdlist",
  "on",
  "off",
  "boton",
  "botoff",
  "onbot",
  "offbot",
  "fullbotstatus"
];

/* =========================================================
   BOT STATUS
========================================================= */

let botStatus = {};

function normalizeGroupStatus(value) {
  if (typeof value === "boolean") {
    return {
      enabled: value,
      disabledCommands: [],
      welcomeEnabled: true
    };
  }

  if (!value || typeof value !== "object") {
    return {
      enabled: true,
      disabledCommands: [],
      welcomeEnabled: true
    };
  }

  return {
    enabled: value.enabled !== false,

    disabledCommands:
      Array.isArray(value.disabledCommands)
        ? value.disabledCommands
        : [],

    welcomeEnabled:
      value.welcomeEnabled !== false
  };
}

function loadBotStatus() {
  try {
    if (!fs.existsSync(BOT_STATUS_FILE)) {
      botStatus = {};
      return;
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          BOT_STATUS_FILE,
          "utf8"
        )
      ) || {};

    botStatus = {};

    for (
      const [groupId, value]
      of Object.entries(parsed)
    ) {
      botStatus[groupId] =
        normalizeGroupStatus(value);
    }

    console.log(
      "📂 Bot status loaded."
    );
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
    botStatus[groupId] = {
      enabled: true,
      disabledCommands: [],
      welcomeEnabled: true
    };
  }

  botStatus[groupId] =
    normalizeGroupStatus(
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
  getGroupStatus(groupId).enabled =
    Boolean(enabled);

  saveBotStatus();
}

function isWelcomeEnabled(groupId) {
  return (
    getGroupStatus(groupId)
      .welcomeEnabled !== false
  );
}

function setWelcomeStatus(
  groupId,
  enabled
) {
  getGroupStatus(groupId)
    .welcomeEnabled =
    Boolean(enabled);

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
    normalizeCommandName(command);

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
    getCanonicalCommand(command);

  return (
    COMMAND_DEFINITIONS.find(
      item => item.key === key
    ) || null
  );
}

function isKnownCommand(command) {
  return Boolean(
    getCommandDefinition(command)
  );
}

function isCommandEnabled(
  groupId,
  command
) {
  const name =
    getCanonicalCommand(command);

  if (!name) {
    return true;
  }

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

  if (!name) {
    return false;
  }

  const status =
    getGroupStatus(groupId);

  const list =
    status.disabledCommands;

  const index =
    list.indexOf(name);

  if (enabled) {
    if (index !== -1) {
      list.splice(index, 1);
    }
  } else {
    if (index === -1) {
      list.push(name);
    }
  }

  saveBotStatus();

  return true;
}

function isSpecialAdminControl(command) {
  return SPECIAL_ADMIN_CONTROLS.includes(
    normalizeCommandName(command)
  );
}

loadBotStatus();

/* =========================================================
   HTTP SERVER
========================================================= */

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
            groups:
              GROUP_IDS.length
                ? GROUP_IDS
                : "ALL"
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

    if (GROUP_IDS.length) {
      console.log(
        "🎯 Allowed Groups:",
        GROUP_IDS.join(", ")
      );
    } else {
      console.log(
        "⚠️ Allowed Groups: ALL"
      );
    }
  }
);

/* =========================================================
   PAIRING NUMBER
========================================================= */

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
      fs.existsSync(
        AUTH_DIR
      )
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

  if (
    participant.phoneNumber
  ) {
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

  if (
    participant.id
  ) {
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

  if (
    !isLidJid(lidJid)
  ) {
    return;
  }

  if (
    !isPhoneJid(phoneJid)
  ) {
    phoneJid =
      phoneNumberToJid(
        phoneJid
      );
  }

  if (
    !isPhoneJid(phoneJid)
  ) {
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

  if (
    isPhoneJid(lid)
  ) {
    return lid;
  }

  if (
    !isLidJid(lid)
  ) {
    return null;
  }

  const cached =
    lidToPhoneJid.get(lid) ||
    contactPhoneJids.get(lid);

  if (
    isPhoneJid(cached)
  ) {
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

    let phoneJid =
      null;

    if (
      contact.phoneNumber
    ) {
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
  if (
    participant.phoneNumber
  ) {
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

    if (
      isPhoneJid(cached)
    ) {
      return cached;
    }

    if (
      isLidJid(id)
    ) {
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
      if (
        participant.id
      ) {
        contactNames.set(
          participant.id,
          name
        );
      }

      if (
        participant.lid
      ) {
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

function isGroupAllowed(jid) {
  if (
    !jid ||
    !jid.endsWith("@g.us")
  ) {
    return false;
  }

  if (
    GROUP_IDS.length === 0
  ) {
    return true;
  }

  return GROUP_IDS.includes(jid);
}

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

  return (
    participants.find(
      participant =>
        participant?.id === jid ||
        participant?.lid === jid ||
        participant?.phoneNumber === jid
    ) || null
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
   BOT ADMIN CHECK
========================================================= */

async function isBotAdmin(
  remoteJid
) {
  try {
    if (
      !sock?.user?.id
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

    const botId =
      sock.user.id;

    const botPhone =
      botId
        .split(":")[0]
        .split("@")[0];

    const botPhoneJid =
      phoneNumberToJid(
        botPhone
      );

    const botParticipant =
      participants.find(
        participant =>
          participant?.id === botId ||
          participant?.id === botPhoneJid ||
          participant?.phoneNumber === botPhoneJid ||
          participant?.lid === botId
      );

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
        display_text: "📋 Copy",

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
${statusCommand(
  "1️⃣",
  "menu",
  "/menu"
)}
${statusCommand(
  "2️⃣",
  "bot",
  "/bot"
)}
${statusCommand(
  "3️⃣",
  "rules",
  "/rules"
)}
${statusCommand(
  "4️⃣",
  "admin",
  "/admin"
)}
${statusCommand(
  "5️⃣",
  "members",
  "/members"
)}
${statusCommand(
  "6️⃣",
  "groupinfo",
  "/groupinfo"
)}
${statusCommand(
  "7️⃣",
  "id",
  "/id"
)}
╰────────────────────

╭─❖ ⚙️ *UTILITY*
│
${statusCommand(
  "8️⃣",
  "ping",
  "/ping"
)}
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
          } ${item.command}`;
        })
        .join("\n");

    const welcomeStatus =
      isWelcomeEnabled(
        remoteJid
      )
        ? "🟢 ON"
        : "🔴 OFF";

    const botAdmin =
      await isBotAdmin(
        remoteJid
      );

    const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
       👑 *ADMIN PANEL*
╰━━━━━━━━━━━━━━━━━━━━╯

🔐 *শুধুমাত্র Group Admin / Owner*

╭─❖ 🤖 *BOT STATUS*
│
│ ${
      isBotEnabled(
        remoteJid
      )
        ? "🟢 Bot: ON"
        : "🔴 Bot: OFF"
    }
│
│ ${
      botAdmin
        ? "🟢 Bot Admin: YES"
        : "🔴 Bot Admin: NO"
    }
╰────────────────────

╭─❖ 👋 *WELCOME STATUS*
│
│ 👋 Welcome: ${welcomeStatus}
╰────────────────────

╭─❖ ⚙️ *COMMAND STATUS*
│
${commandStatus}
╰────────────────────

╭─❖ 🛠️ *BOT CONTROL*
│
│ 🟢 /boton
│ 🔴 /botoff
╰────────────────────

╭─❖ 👋 *WELCOME CONTROL*
│
│ 🟢 /on welcome
│ 🔴 /off welcome
╰────────────────────

╭─❖ ⚙️ *COMMAND CONTROL*
│
│ 🟢 /on <command>
│ 🔴 /off <command>
│ 📋 /cmdlist
╰────────────────────

╭─❖ 💡 *EXAMPLE*
│
│ /on welcome
│ /off welcome
│ /on deal
│ /off deal
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
        "/on welcome",
        "/off welcome",
        "/cmdlist"
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

  const lines =
    COMMAND_DEFINITIONS
      .map(item => {
        const enabled =
          !disabled.includes(
            item.key
          );

        return `${
          enabled
            ? "🟢"
            : "🔴"
        } ${item.command}`;
      })
      .join("\n");

  const text = `
╭━━━━━━━━━━━━━━━━━━━━╮
      📋 *COMMAND STATUS*
╰━━━━━━━━━━━━━━━━━━━━╯

${lines}

━━━━━━━━━━━━━━━━━━━━

🤖 *BOT:* ${
    isBotEnabled(
      remoteJid
    )
      ? "🟢 ON"
      : "🔴 OFF"
  }

👋 *WELCOME:* ${
    isWelcomeEnabled(
      remoteJid
    )
      ? "🟢 ON"
      : "🔴 OFF"
  }

━━━━━━━━━━━━━━━━━━━━

👑 শুধুমাত্র Admin / Owner
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
      "/on welcome",
      "/off welcome"
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

4️⃣ সন্দেহজনক বা প্রতারণামূলক
লিংক শেয়ার করবেন না।

5️⃣ অন্য সদস্যকে হয়রানি
বা বিরক্ত করবেন না।

6️⃣ Account Buy/Sell ও
Google Play Points সম্পর্কিত
বিষয়ে সবাই সতর্ক থাকুন।

7️⃣ কোনো সমস্যায় পড়লে
সরাসরি Admin-কে জানান।

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

👋 Welcome Message
আলাদাভাবে ON/OFF করা যাবে।

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
   WELCOME STATUS TEXT
========================================================= */

const WELCOME_ON_TEXT = `
╭━━━━━━━━━━━━━━━━━━━━╮
       🟢 *WELCOME ON*
╰━━━━━━━━━━━━━━━━━━━━╯

👋 নতুন Member Group-এ Join করলে
এখন থেকে Welcome Message যাবে।

🤍 *Piyas Bot*
`;

const WELCOME_OFF_TEXT = `
╭━━━━━━━━━━━━━━━━━━━━╮
       🔴 *WELCOME OFF*
╰━━━━━━━━━━━━━━━━━━━━╯

👋 নতুন Member Join করলে
আর Welcome Message যাবে না।

🤍 *Piyas Bot*
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

  if (
    !admins.length
  ) {
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

  if (
    !admins.length
  ) {
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

function getWelcomeText(name) {
  return `
╭━━━━━━━━━━━━━━━━━━━━╮
        🎉 *স্বাগতম*
╰━━━━━━━━━━━━━━━━━━━━╯

🎉 *স্বাগতম @${name}!* ❤️

🌸 আপনাকে *Play point League*
গ্রুপে স্বাগতম।

💬 এখানে সবাই একে অপরকে
সহযোগিতা করবেন।

📌 গ্রুপের নিয়ম দেখতে লিখুন:
*/rules*

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

🤍 *Piyas*
`;
}

async function sendWelcome(
  groupId,
  participant
) {
  try {
    if (
      !sock ||
      !isWelcomeEnabled(
        groupId
      )
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
        metadata?.participants || []
      );
    } catch {}

    let member =
      findParticipant(
        metadata?.participants || [],
        participant?.id
      );

    if (!member) {
      member =
        findParticipant(
          metadata?.participants || [],
          participant?.lid
        );
    }

    if (!member) {
      member = participant;
    }

    const name =
      getDisplayName(member);

    const phoneJid =
      await getPhoneJid(member);

    if (
      isPhoneJid(phoneJid)
    ) {
      await sock.sendMessage(
        groupId,
        {
          text:
            getWelcomeText(name),
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
            getWelcomeText(name)
              .replace(
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

    if (
      pairingRequested
    ) {
      return;
    }

    pairingRequested = true;

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

function getMessageText(message) {
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
   LINK DETECTOR
========================================================= */

function containsLink(text = "") {
  if (!text) {
    return false;
  }

  const linkRegex =
    /(?:https?:\/\/|www\.|(?:wa\.me|chat\.whatsapp\.com|t\.me|telegram\.me|youtu\.be|youtube\.com|facebook\.com|fb\.me|instagram\.com|tiktok\.com|bit\.ly|tinyurl\.com)\/|\b[a-zA-Z0-9-]+\.(?:com|net|org|io|me|co|bd|xyz|site|online|shop|app|dev)(?:\/[^\s]*)?)/i;

  return linkRegex.test(
    String(text)
  );
}

/* =========================================================
   MESSAGE SENDER
========================================================= */

function getMessageSenderId(
  message
) {
  return (
    message?.key?.participant ||
    message?.participant ||
    ""
  );
}

/* =========================================================
   NORMALIZE SPAM TEXT
========================================================= */

function normalizeSpamText(
  text = ""
) {
  return String(text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================================================
   DELETE GROUP MESSAGE
   IMPORTANT:
   - Bot must be Group Admin
   - Keep original message.key
   - Preserve participant/LID
========================================================= */

async function deleteGroupMessage(
  remoteJid,
  message
) {
  try {
    if (
      !sock ||
      !message?.key ||
      !remoteJid
    ) {
      console.log(
        "❌ Delete failed: message key/group missing."
      );

      return false;
    }

    const originalKey =
      message.key;

    const deleteKey = {
      remoteJid:
        originalKey.remoteJid ||
        remoteJid,

      fromMe:
        Boolean(
          originalKey.fromMe
        ),

      id:
        originalKey.id,

      participant:
        originalKey.participant
    };

    if (
      !deleteKey.id
    ) {
      console.log(
        "❌ Delete failed: message ID missing."
      );

      return false;
    }

    const botAdmin =
      await isBotAdmin(
        remoteJid
      );

    if (!botAdmin) {
      console.log(
        "❌ DELETE FAILED: Bot is NOT Group Admin."
      );

      console.log(
        `📌 Group: ${remoteJid}`
      );

      return false;
    }

    console.log(
      "🗑️ Trying to delete message..."
    );

    console.log(
      `📌 Message ID: ${deleteKey.id}`
    );

    console.log(
      `📌 Participant: ${deleteKey.participant || "unknown"}`
    );

    await sock.sendMessage(
      remoteJid,
      {
        delete:
          deleteKey
      }
    );

    console.log(
      "✅ Message delete request sent successfully."
    );

    return true;
  } catch (error) {
    console.log(
      "❌ Message delete error:",
      error?.message
    );

    console.log(
      "❌ Delete stack:",
      error?.stack || ""
    );

    return false;
  }
}

/* =========================================================
   SPAM WARNING
========================================================= */

async function sendSpamWarning(
  remoteJid,
  senderJid,
  type = "duplicate"
) {
  try {
    if (
      !senderJid ||
      !sock
    ) {
      return;
    }

    const cooldownKey =
      `${remoteJid}:${senderJid}`;

    const now =
      Date.now();

    const lastWarning =
      warningCooldown.get(
        cooldownKey
      ) || 0;

    if (
      now - lastWarning <
      WARNING_COOLDOWN
    ) {
      return;
    }

    warningCooldown.set(
      cooldownKey,
      now
    );

    let warningText;

    if (
      type === "link"
    ) {
      warningText = `
╭━━━━━━━━━━━━━━━━━━━━╮
       ⚠️ *LINK WARNING*
╰━━━━━━━━━━━━━━━━━━━━╯

🔗 সাধারণ Member-এর Link পাঠানো
এই Group-এ অনুমোদিত নয়।

🗑️ আপনার Link Message
সাথে সাথে Remove করা হয়েছে।

👑 Link পাঠাতে হলে
Admin-এর অনুমতি নিন।

🤍 *PIYAS BOT*
`;
    } else {
      warningText = `
╭━━━━━━━━━━━━━━━━━━━━╮
       ⚠️ *SPAM WARNING*
╰━━━━━━━━━━━━━━━━━━━━╯

🚫 একই Message বারবার পাঠানো
অনুমোদিত নয়।

🗑️ আপনার Spam Message
সাথে সাথে Remove করা হয়েছে।

⏱️ একই Message ৫ মিনিটের মধ্যে
আবার পাঠালে Spam হিসেবে
ধরা হবে।

⚠️ আবার Spam করলে Admin
প্রয়োজনীয় ব্যবস্থা নিতে পারেন।

🤍 *PIYAS BOT*
`;
    }

    const phoneJid =
      isPhoneJid(senderJid)
        ? senderJid
        : await resolveLidToPhoneJid(
            senderJid
          );

    if (phoneJid) {
      await sock.sendMessage(
        remoteJid,
        {
          text:
            warningText +
            `\n👤 @${phoneJid.split("@")[0]}`,
          mentions: [
            phoneJid
          ]
        }
      );
    } else {
      await sock.sendMessage(
        remoteJid,
        {
          text:
            warningText
        }
      );
    }
  } catch (error) {
    console.log(
      "⚠️ Spam warning error:",
      error?.message
    );
  }
}

/* =========================================================
   DUPLICATE SPAM CHECK
========================================================= */

function isDuplicateSpam(
  remoteJid,
  senderJid,
  text
) {
  if (
    !remoteJid ||
    !senderJid ||
    !text
  ) {
    return false;
  }

  const normalizedText =
    normalizeSpamText(text);

  if (!normalizedText) {
    return false;
  }

  const now =
    Date.now();

  if (
    !duplicateMessageCache.has(
      remoteJid
    )
  ) {
    duplicateMessageCache.set(
      remoteJid,
      new Map()
    );
  }

  const groupCache =
    duplicateMessageCache.get(
      remoteJid
    );

  if (
    !groupCache.has(
      senderJid
    )
  ) {
    groupCache.set(
      senderJid,
      new Map()
    );
  }

  const senderCache =
    groupCache.get(
      senderJid
    );

  for (
    const [
      messageHash,
      messageTime
    ]
    of senderCache
  ) {
    if (
      now - messageTime >
      DUPLICATE_SPAM_WINDOW
    ) {
      senderCache.delete(
        messageHash
      );
    }
  }

  const previousTime =
    senderCache.get(
      normalizedText
    );

  if (
    previousTime &&
    now - previousTime <
    DUPLICATE_SPAM_WINDOW
  ) {
    senderCache.set(
      normalizedText,
      now
    );

    return true;
  }

  senderCache.set(
    normalizedText,
    now
  );

  return false;
}

/* =========================================================
   MODERATION
========================================================= */

async function moderateGroupMessage(
  remoteJid,
  message,
  text
) {
  try {
    if (
      !sock ||
      !remoteJid ||
      !message
    ) {
      return false;
    }

    if (
      message.key?.fromMe
    ) {
      return false;
    }

    const senderJid =
      getMessageSenderId(
        message
      );

    if (!senderJid) {
      return false;
    }

    /* =====================================================
       ADMIN / OWNER BYPASS
    ===================================================== */

    const senderIsAdmin =
      await isSenderAdmin(
        remoteJid,
        message
      );

    if (
      senderIsAdmin
    ) {
      console.log(
        "👑 Admin/Owner message - moderation skipped."
      );

      return false;
    }

    /* =====================================================
       LINK BLOCK
    ===================================================== */

    if (
      containsLink(text)
    ) {
      console.log(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

      console.log(
        "🔗 LINK DETECTED"
      );

      console.log(
        `👥 GROUP: ${remoteJid}`
      );

      console.log(
        `👤 SENDER: ${senderJid}`
      );

      console.log(
        `🔗 TEXT: ${text}`
      );

      console.log(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

      const deleted =
        await deleteGroupMessage(
          remoteJid,
          message
        );

      if (deleted) {
        await sendSpamWarning(
          remoteJid,
          senderJid,
          "link"
        );
      } else {
        console.log(
          "⚠️ Link detected but message could not be deleted."
        );
      }

      return true;
    }

    /* =====================================================
       DUPLICATE SPAM
    ===================================================== */

    const duplicate =
      isDuplicateSpam(
        remoteJid,
        senderJid,
        text
      );

    if (duplicate) {
      console.log(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

      console.log(
        "🚫 DUPLICATE SPAM DETECTED"
      );

      console.log(
        `👥 GROUP: ${remoteJid}`
      );

      console.log(
        `👤 SENDER: ${senderJid}`
      );

      console.log(
        `📝 TEXT: ${text}`
      );

      console.log(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

      const deleted =
        await deleteGroupMessage(
          remoteJid,
          message
        );

      if (deleted) {
        await sendSpamWarning(
          remoteJid,
          senderJid,
          "duplicate"
        );
      } else {
        console.log(
          "⚠️ Spam detected but message could not be deleted."
        );
      }

      return true;
    }

    return false;
  } catch (error) {
    console.log(
      "⚠️ Message moderation error:",
      error?.message
    );

    console.log(
      error?.stack || ""
    );

    return false;
  }
}

/* =========================================================
   SPAM CACHE CLEANUP
========================================================= */

setInterval(
  () => {
    try {
      const now =
        Date.now();

      for (
        const [
          groupId,
          groupCache
        ]
        of duplicateMessageCache
      ) {
        for (
          const [
            senderJid,
            senderCache
          ]
          of groupCache
        ) {
          for (
            const [
              messageHash,
              messageTime
            ]
            of senderCache
          ) {
            if (
              now - messageTime >
              DUPLICATE_SPAM_WINDOW
            ) {
              senderCache.delete(
                messageHash
              );
            }
          }

          if (
            senderCache.size === 0
          ) {
            groupCache.delete(
              senderJid
            );
          }
        }

        if (
          groupCache.size === 0
        ) {
          duplicateMessageCache.delete(
            groupId
          );
        }
      }

      for (
        const [
          key,
          warningTime
        ]
        of warningCooldown
      ) {
        if (
          now - warningTime >
          WARNING_COOLDOWN
        ) {
          warningCooldown.delete(
            key
          );
        }
      }
    } catch (error) {
      console.log(
        "⚠️ Spam cache cleanup error:",
        error?.message
      );
    }
  },
  60 * 1000
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

    if (
      numberChanged
    ) {
      console.log(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

      console.log(
        "🔄 PHONE NUMBER CHANGED"
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
            event?.participants || [];

          if (!groupId) {
            return;
          }

          if (
            !isGroupAllowed(
              groupId
            )
          ) {
            return;
          }

          console.log(
            `👥 Group update: ${action} | ${groupId} | ${participants.length} participant(s)`
          );

          if (
            action === "add" &&
            isWelcomeEnabled(groupId)
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
                  group?.participants || []
                );
              }

              console.log(
                "📦 Group participant cache loaded."
              );
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

              if (
                !isGroupAllowed(
                  remoteJid
                )
              ) {
                console.log(
                  `🚫 Group not allowed: ${remoteJid}`
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

              /* =============================================
                 LINK + SPAM PROTECTION
              ============================================= */

              const moderationHandled =
                await moderateGroupMessage(
                  remoteJid,
                  message,
                  text
                );

              if (
                moderationHandled
              ) {
                continue;
              }

              /* =============================================
                 COMMAND PROCESSING
              ============================================= */

              const parts =
                text
                  .trim()
                  .split(
                    /\s+/
                  );

              const rawCommand =
                parts.shift() || "";

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
                 ADMIN CHECK
              ============================================= */

              let senderIsAdmin = false;

              if (
                ADMIN_ONLY_COMMANDS.includes(
                  command
                )
              ) {
                senderIsAdmin =
                  await isSenderAdmin(
                    remoteJid,
                    message
                  );

                if (!senderIsAdmin) {
                  console.log(
                    `🚫 NON-ADMIN: /${command}`
                  );

                  continue;
                }
              }

              /* =============================================
                 BOT OFF
              ============================================= */

              if (
                command ===
                  "botoff" ||
                command ===
                  "offbot"
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
                  "boton" ||
                command ===
                  "onbot"
              ) {
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
                 FULL BOT STATUS
              ============================================= */

              if (
                command ===
                "fullbotstatus"
              ) {
                const botAdmin =
                  await isBotAdmin(
                    remoteJid
                  );

                await sock.sendMessage(
                  remoteJid,
                  {
                    text: `
╭━━━━━━━━━━━━━━━━━━━━╮
      🤖 *BOT STATUS*
╰━━━━━━━━━━━━━━━━━━━━╯

🤖 Bot:
${
  isBotEnabled(
    remoteJid
  )
    ? "🟢 ON"
    : "🔴 OFF"
}

👋 Welcome:
${
  isWelcomeEnabled(
    remoteJid
  )
    ? "🟢 ON"
    : "🔴 OFF"
}

👑 Bot Admin:
${
  botAdmin
    ? "🟢 YES"
    : "🔴 NO"
}

━━━━━━━━━━━━━━━━━━━━
`
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
                 ON / OFF
              ============================================= */

              if (
                command === "on" ||
                command === "off"
              ) {
                const targetRaw =
                  args[0] || "";

                const target =
                  normalizeCommandName(
                    targetRaw
                  );

                /* ===========================================
                   WELCOME CONTROL
                =========================================== */

                if (
                  target ===
                  "welcome"
                ) {
                  if (
                    command === "on"
                  ) {
                    if (
                      isWelcomeEnabled(
                        remoteJid
                      )
                    ) {
                      await sock.sendMessage(
                        remoteJid,
                        {
                          text:
                            "🟢 *Welcome* ইতোমধ্যে ON আছে।"
                        }
                      );

                      continue;
                    }

                    setWelcomeStatus(
                      remoteJid,
                      true
                    );

                    await sock.sendMessage(
                      remoteJid,
                      {
                        text:
                          WELCOME_ON_TEXT
                      }
                    );

                    await sendCopyButton(
                      remoteJid,
                      "/off welcome"
                    );

                    continue;
                  }

                  if (
                    command === "off"
                  ) {
                    if (
                      !isWelcomeEnabled(
                        remoteJid
                      )
                    ) {
                      await sock.sendMessage(
                        remoteJid,
                        {
                          text:
                            "🔴 *Welcome* ইতোমধ্যে OFF আছে।"
                        }
                      );

                      continue;
                    }

                    setWelcomeStatus(
                      remoteJid,
                      false
                    );

                    await sock.sendMessage(
                      remoteJid,
                      {
                        text:
                          WELCOME_OFF_TEXT
                      }
                    );

                    await sendCopyButton(
                      remoteJid,
                      "/on welcome"
                    );

                    continue;
                  }
                }

                if (!target) {
                  await sock.sendMessage(
                    remoteJid,
                    {
                      text: `
╭━━━━━━━━━━━━━━━━━━━━╮
      ⚙️ *COMMAND CONTROL*
╰━━━━━━━━━━━━━━━━━━━━╯

🟢 /on <command>

🔴 /off <command>

👋 Welcome:
 /on welcome
 /off welcome
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

👋 Welcome-এর জন্য:

• /on welcome
• /off welcome
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
                 
                 Moderation এই জায়গার আগেই
                 handle হয়েছে।
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

👋 *Welcome:* ${
                      isWelcomeEnabled(
                        remoteJid
                      )
                        ? "🟢 ON"
                        : "🔴 OFF"
                    }

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
                messageError?.stack || ""
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

startBot();
