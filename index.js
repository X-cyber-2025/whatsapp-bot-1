import "dotenv/config";

import http from "http";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import P from "pino";

// ======================================================
// CONFIG
// ======================================================

const PORT = process.env.PORT || 3000;

const AUTH_FOLDER = "./auth_info";

const PHONE_NUMBER =
  process.env.PHONE_NUMBER || "";

const GROUP_ID =
  process.env.GROUP_ID || "";

const WEBSITE_URL =
  "https://x-cyber-2025.github.io/X-cyber.web/";

// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end("WhatsApp Bot is running.");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("WhatsApp Bot is Online.");
});

server.listen(PORT, () => {
  console.log(
    `🌐 Server running on port ${PORT}`
  );
});

// ======================================================
// GROUP RULES
// ======================================================

const RULES = `
📜 *গ্রুপের নিয়মাবলি*

1️⃣ সবাইকে সম্মান করে কথা বলুন।

2️⃣ অশ্লীল, আপত্তিকর বা অসম্মানজনক মেসেজ দেওয়া যাবে না।

3️⃣ স্প্যাম বা একই মেসেজ বারবার পাঠানো যাবে না।

4️⃣ অনুমতি ছাড়া কোনো লিংক, বিজ্ঞাপন বা প্রচারণা করা যাবে না।

5️⃣ অন্য কোনো গ্রুপের Invite Link অপ্রয়োজনে শেয়ার করা যাবে না।

6️⃣ সন্দেহজনক Link, APK, File বা Website শেয়ার করা নিষেধ।

7️⃣ কারও ব্যক্তিগত তথ্য, ফোন নম্বর বা Screenshot অনুমতি ছাড়া শেয়ার করবেন না।

8️⃣ Fake Account, Scam বা প্রতারণামূলক কার্যক্রম সম্পূর্ণ নিষিদ্ধ।

9️⃣ Account Buy/Sell করার সময় অবশ্যই সতর্ক থাকুন।

🔟 Google Play Points সংক্রান্ত তথ্য ও আলোচনা গ্রুপে শেয়ার করা যাবে।

1️⃣1️⃣ যেকোনো লেনদেনের আগে Buyer/Seller-এর তথ্য ভালোভাবে যাচাই করুন।

1️⃣2️⃣ বড় ধরনের লেনদেনের ক্ষেত্রে Admin-এর পরামর্শ নেওয়া ভালো।

1️⃣3️⃣ লেনদেনের Screenshot ও প্রয়োজনীয় প্রমাণ সংরক্ষণ করুন।

1️⃣4️⃣ শুধু পরিচিত বা বিশ্বাসের ভিত্তিতে টাকা পাঠাবেন না।

1️⃣5️⃣ অপ্রয়োজনীয় Mention, Tag বা Group Call করা থেকে বিরত থাকুন।

1️⃣6️⃣ ধর্ম, রাজনীতি বা ব্যক্তিগত বিষয় নিয়ে ঝগড়া/বিতর্ক করা যাবে না।

1️⃣7️⃣ Admin-এর সিদ্ধান্ত নিয়ে গ্রুপে অপ্রয়োজনীয় বিশৃঙ্খলা সৃষ্টি করা যাবে না।

1️⃣8️⃣ কোনো সমস্যা, Scam বা সন্দেহজনক কার্যক্রম দেখলে Admin-কে জানান।

1️⃣9️⃣ Private Deal করলে সম্পূর্ণ নিজ দায়িত্বে করবেন।

2️⃣0️⃣ নিয়ম ভঙ্গ করলে Admin প্রয়োজন অনুযায়ী Warning, Message Delete বা Group থেকে Remove করতে পারবেন।

⚠️ *Buy/Sell ও লেনদেনের সতর্কতা:*

যেকোনো Buy/Sell বা লেনদেনের ক্ষেত্রে অবশ্যই Admin-এর মাধ্যমে ডিল করুন।

Admin-এর উপস্থিতি বা পরামর্শ ছাড়া কোনো লেনদেন করলে সম্পূর্ণ দায়ভার আপনার নিজের।

নিজে যাচাই করার পরেও কোনো Scam হলে তার দায়ভার Admin বা গ্রুপ কর্তৃপক্ষ বহন করবে না।

🔒 *তাই নিরাপদে লেনদেন করুন এবং সম্ভব হলে Admin-কে সঙ্গে রাখুন।*

❤️ সবাই নিয়ম মেনে চলুন এবং সুন্দর পরিবেশ বজায় রাখুন।

❤️ *Piyas*
`;

// ======================================================
// WELCOME MESSAGE
// ======================================================

const WELCOME = `
🎉 স্বাগতম {member}! ❤️

🌟 আপনাকে আমাদের {group} গ্রুপে স্বাগতম।

👥 আপনি এখন আমাদের পরিবারের একজন সদস্য।
📌 গ্রুপের নিয়ম মেনে চলুন এবং সবার সাথে সুন্দর আচরণ করুন।

💰 Account Buy/Sell ও Google Play Points সংক্রান্ত আপডেট পেতে গ্রুপে থাকুন।

⚠️ *গুরুত্বপূর্ণ সতর্কতা:*

যেকোনো Buy/Sell বা লেনদেনের ক্ষেত্রে অবশ্যই Admin-এর মাধ্যমে ডিল করুন।

Admin-এর উপস্থিতি বা পরামর্শ ছাড়া কোনো লেনদেন করলে সম্পূর্ণ দায়ভার আপনার নিজের।

নিজে যাচাই করার পরেও কোনো Scam হলে তার দায়ভার Admin বা গ্রুপ কর্তৃপক্ষ বহন করবে না।

🌐 প্রয়োজন হলে আমাদের অফিসিয়াল ওয়েবসাইট ভিজিট করুন।
🔗 /website লিখে ওয়েবসাইটের লিংক নিন।

❤️ পাশে থাকার জন্য ধন্যবাদ।

❤️ *Piyas*
`;

// ======================================================
// MENU
// ======================================================

const MENU = `
🤖 *GROUP BOT MENU*

1️⃣ /menu — Bot Menu
2️⃣ /rules — গ্রুপের নিয়ম
3️⃣ /website — Official Website
4️⃣ /ping — Bot Status
5️⃣ /id — Group ID
6️⃣ /groupinfo — Group Information
7️⃣ /members — Member Count

❤️ *Piyas*
`;

// ======================================================
// CONTACT CACHE
// ======================================================

const contactNames = new Map();

// ======================================================
// SAVE CONTACTS
// ======================================================

function saveContacts(contacts = []) {
  if (!Array.isArray(contacts)) {
    return;
  }

  for (const contact of contacts) {
    try {
      if (
        !contact ||
        typeof contact !== "object"
      ) {
        continue;
      }

      const name =
        contact.username ||
        contact.notify ||
        contact.name ||
        contact.verifiedName ||
        contact.pushName ||
        null;

      if (
        typeof name !== "string" ||
        !name.trim()
      ) {
        continue;
      }

      const cleanName =
        name.trim();

      const ids = [
        contact.id,
        contact.lid,
        contact.phoneNumber
      ];

      for (const id of ids) {
        if (
          typeof id === "string" &&
          id.trim()
        ) {
          contactNames.set(
            id,
            cleanName
          );
        }
      }

    } catch (error) {
      console.log(
        "⚠️ Contact Cache Error:",
        error?.message || error
      );
    }
  }
}

// ======================================================
// SAVE PUSH NAME
// ======================================================

function savePushName(
  id,
  pushName
) {
  if (
    typeof id !== "string" ||
    !id
  ) {
    return;
  }

  if (
    typeof pushName === "string" &&
    pushName.trim()
  ) {
    contactNames.set(
      id,
      pushName.trim()
    );
  }
}

// ======================================================
// GET DISPLAY NAME
// ======================================================

function getDisplayName(
  participant
) {
  if (
    !participant ||
    typeof participant !== "object"
  ) {
    return "Unknown Member";
  }

  // ------------------------------------------
  // Check cache
  // ------------------------------------------

  const possibleIds = [
    participant.id,
    participant.lid,
    participant.phoneNumber
  ];

  for (const id of possibleIds) {
    if (
      typeof id === "string" &&
      contactNames.has(id)
    ) {
      const cached =
        contactNames.get(id);

      if (
        typeof cached === "string" &&
        cached.trim()
      ) {
        return cached.trim();
      }
    }
  }

  // ------------------------------------------
  // Check direct names
  // ------------------------------------------

  const possibleNames = [
    participant.username,
    participant.notify,
    participant.name,
    participant.verifiedName,
    participant.pushName
  ];

  for (const name of possibleNames) {
    if (
      typeof name === "string" &&
      name.trim()
    ) {
      return name.trim();
    }
  }

  // ------------------------------------------
  // Phone JID fallback
  // ------------------------------------------

  const id =
    typeof participant.id === "string"
      ? participant.id
      : "";

  if (
    id.includes("@s.whatsapp.net")
  ) {
    return id.split("@")[0];
  }

  return "Unknown Member";
}

// ======================================================
// FIND PARTICIPANT
// ======================================================

function findParticipant(
  participants,
  participantId
) {
  if (
    !Array.isArray(participants) ||
    typeof participantId !== "string"
  ) {
    return null;
  }

  return (
    participants.find(
      participant =>
        participant?.id === participantId
    ) ||

    participants.find(
      participant =>
        participant?.lid === participantId
    ) ||

    participants.find(
      participant =>
        participant?.phoneNumber === participantId
    ) ||

    null
  );
}

// ======================================================
// GET MESSAGE TEXT
// ======================================================

function getMessageText(
  message
) {
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

// ======================================================
// GET SAFE PHONE JID
// ======================================================

function getPhoneJid(
  participant
) {
  if (
    !participant ||
    typeof participant !== "object"
  ) {
    return null;
  }

  // Already a WhatsApp JID
  if (
    typeof participant.phoneNumber === "string" &&
    participant.phoneNumber.includes("@")
  ) {
    return participant.phoneNumber;
  }

  // Numeric phone number
  if (
    typeof participant.phoneNumber === "string"
  ) {
    const phone =
      participant.phoneNumber.replace(
        /[^0-9]/g,
        ""
      );

    if (
      phone.length >= 8
    ) {
      return `${phone}@s.whatsapp.net`;
    }
  }

  // Participant ID
  if (
    typeof participant.id === "string" &&
    participant.id.endsWith(
      "@s.whatsapp.net"
    )
  ) {
    return participant.id;
  }

  return null;
}

// ======================================================
// RECONNECT CONTROL
// ======================================================

let reconnectTimer = null;

let botStarting = false;

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer =
    setTimeout(
      () => {
        reconnectTimer = null;

        console.log(
          "🔄 Restarting WhatsApp Bot..."
        );

        startBot();
      },
      5000
    );
}

// ======================================================
// START BOT
// ======================================================

async function startBot() {
  if (botStarting) {
    return;
  }

  botStarting = true;

  try {
    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "🚀 WhatsApp Bot Starting..."
    );
    console.log(
      "=========================================="
    );

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        AUTH_FOLDER
      );

    const sock =
      makeWASocket({
        auth: state,

        logger: P({
          level: "silent"
        }),

        printQRInTerminal: false,

        browser:
          Browsers.ubuntu(
            "Chrome"
          ),

        connectTimeoutMs: 60000,

        keepAliveIntervalMs: 25000,

        retryRequestDelayMs: 2000,

        markOnlineOnConnect: true
      });

    // ==================================================
    // SAVE CREDENTIALS
    // ==================================================

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    // ==================================================
    // CONTACT EVENTS
    // ==================================================

    sock.ev.on(
      "contacts.upsert",
      contacts => {
        saveContacts(
          contacts
        );
      }
    );

    sock.ev.on(
      "contacts.update",
      contacts => {
        saveContacts(
          contacts
        );
      }
    );

    // ==================================================
    // PAIRING CODE
    // ==================================================

    if (
      !state.creds.registered &&
      PHONE_NUMBER
    ) {
      setTimeout(
        async () => {
          try {
            const cleanNumber =
              PHONE_NUMBER.replace(
                /[^0-9]/g,
                ""
              );

            if (
              !cleanNumber
            ) {
              console.log(
                "❌ Invalid PHONE_NUMBER"
              );

              return;
            }

            console.log(
              "🔐 Requesting pairing code..."
            );

            const code =
              await sock.requestPairingCode(
                cleanNumber
              );

            console.log("");
            console.log(
              "=========================================="
            );
            console.log(
              "🔐 WHATSAPP PAIRING CODE"
            );
            console.log(
              "=========================================="
            );
            console.log(
              `📱 Number: ${cleanNumber}`
            );
            console.log(
              `🔑 Pairing Code: ${code}`
            );
            console.log(
              "=========================================="
            );
            console.log("");

          } catch (error) {
            console.log("");
            console.log(
              "❌ Pairing Code Error:"
            );
            console.log(
              error?.message ||
              error
            );
            console.log("");
          }
        },
        3000
      );
    }

    // ==================================================
    // CONNECTION UPDATE
    // ==================================================

    sock.ev.on(
      "connection.update",
      ({
        connection,
        lastDisconnect
      }) => {

        if (
          connection ===
          "connecting"
        ) {
          console.log(
            "🔄 WhatsApp connecting..."
          );
        }

        if (
          connection ===
          "open"
        ) {
          botStarting = false;

          console.log("");
          console.log(
            "=========================================="
          );
          console.log(
            "✅ WhatsApp Bot Connected Successfully!"
          );
          console.log(
            "=========================================="
          );

          console.log(
            `🎯 Bot Group Restriction: ${
              GROUP_ID ||
              "ALL GROUPS"
            }`
          );

          console.log(
            "🟢 Bot Status: ONLINE"
          );

          console.log(
            "=========================================="
          );
          console.log("");
        }

        if (
          connection ===
          "close"
        ) {
          botStarting = false;

          const statusCode =
            new Boom(
              lastDisconnect?.error
            )?.output
              ?.statusCode;

          console.log("");
          console.log(
            "=========================================="
          );
          console.log(
            "❌ WhatsApp Connection Closed"
          );
          console.log(
            "=========================================="
          );

          console.log(
            "Status Code:",
            statusCode
          );

          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {
            console.log(
              "🚪 WhatsApp Logged Out."
            );

            console.log(
              "⚠️ Delete auth_info and pair again."
            );

            return;
          }

          console.log(
            "🔄 Reconnecting in 5 seconds..."
          );

          scheduleReconnect();
        }
      }
    );

    // ==================================================
    // NEW MEMBER WELCOME
    // ==================================================

    sock.ev.on(
      "group-participants.update",
      async update => {

        try {

          // ----------------------------------------------
          // ONLY ADD EVENT
          // ----------------------------------------------

          if (
            update.action !== "add"
          ) {
            return;
          }

          // ----------------------------------------------
          // GROUP ID
          // ----------------------------------------------

          const groupId =
            typeof update.id === "string"
              ? update.id
              : "";

          if (!groupId) {
            return;
          }

          // ----------------------------------------------
          // GROUP RESTRICTION
          // ----------------------------------------------

          if (
            GROUP_ID &&
            groupId !== GROUP_ID
          ) {
            return;
          }

          console.log("");
          console.log(
            "=========================================="
          );
          console.log(
            "🎉 NEW MEMBER EVENT"
          );
          console.log(
            "=========================================="
          );

          // ----------------------------------------------
          // GET GROUP METADATA
          // ----------------------------------------------

          const metadata =
            await sock.groupMetadata(
              groupId
            );

          const groupName =
            typeof metadata?.subject === "string"
              ? metadata.subject
              : "আমাদের গ্রুপ";

          const participants =
            Array.isArray(
              metadata?.participants
            )
              ? metadata.participants
              : [];

          console.log(
            `👥 Group: ${groupName}`
          );

          console.log(
            `👤 New Members: ${
              Array.isArray(
                update.participants
              )
                ? update.participants.length
                : 0
            }`
          );

          // ----------------------------------------------
          // PROCESS MEMBERS
          // ----------------------------------------------

          for (
            const rawParticipant
            of update.participants || []
          ) {

            try {

              // =========================================
              // GET PARTICIPANT ID
              // =========================================

              let participantId =
                null;

              if (
                typeof rawParticipant ===
                "string"
              ) {
                participantId =
                  rawParticipant;
              }

              else if (
                rawParticipant &&
                typeof rawParticipant ===
                  "object"
              ) {

                participantId =
                  typeof rawParticipant.id ===
                  "string"
                    ? rawParticipant.id
                    : typeof rawParticipant.lid ===
                      "string"
                    ? rawParticipant.lid
                    : typeof rawParticipant.phoneNumber ===
                      "string"
                    ? rawParticipant.phoneNumber
                    : null;
              }

              if (
                typeof participantId !==
                  "string" ||
                !participantId
              ) {

                console.log(
                  "⚠️ Invalid participant:"
                );

                console.log(
                  JSON.stringify(
                    rawParticipant,
                    null,
                    2
                  )
                );

                continue;
              }

              // =========================================
              // FIND PARTICIPANT
              // =========================================

              const participant =
                findParticipant(
                  participants,
                  participantId
                );

              // =========================================
              // GET NAME
              // =========================================

              let memberName =
                participant
                  ? getDisplayName(
                      participant
                    )
                  : "Unknown Member";

              // Cache fallback
              if (
                !memberName ||
                memberName ===
                  "Unknown Member"
              ) {

                const cached =
                  contactNames.get(
                    participantId
                  );

                if (
                  typeof cached ===
                    "string" &&
                  cached.trim()
                ) {
                  memberName =
                    cached.trim();
                }
              }

              if (
                !memberName ||
                memberName ===
                  "Unknown Member"
              ) {
                memberName =
                  "New Member";
              }

              memberName =
                String(
                  memberName
                );

              // =========================================
              // SAVE NAME
              // =========================================

              if (
                participant
              ) {

                const ids = [
                  participant.id,
                  participant.lid,
                  participant.phoneNumber
                ];

                for (
                  const id of ids
                ) {
                  if (
                    typeof id ===
                      "string" &&
                    id.trim()
                  ) {
                    contactNames.set(
                      id,
                      memberName
                    );
                  }
                }
              }

              // =========================================
              // CREATE WELCOME MESSAGE
              // =========================================

              const safeGroupName =
                String(
                  groupName
                );

              const displayMember =
                `@${memberName}`;

              const welcomeMessage =
                String(
                  WELCOME
                    .replace(
                      "{member}",
                      displayMember
                    )
                    .replace(
                      "{group}",
                      safeGroupName
                    )
                );

              // =========================================
              // TRY REAL MENTION ONLY WHEN SAFE
              // =========================================

              let sent =
                false;

              const mentionJid =
                getPhoneJid(
                  participant
                );

              if (
                typeof mentionJid ===
                  "string" &&
                mentionJid.endsWith(
                  "@s.whatsapp.net"
                )
              ) {

                try {

                  console.log(
                    "📢 Trying real mention:",
                    mentionJid
                  );

                  await sock.sendMessage(
                    groupId,
                    {
                      text:
                        welcomeMessage,

                      mentions: [
                        mentionJid
                      ]
                    }
                  );

                  console.log(
                    "✅ Welcome sent with real mention."
                  );

                  sent = true;

                } catch (
                  mentionError
                ) {

                  console.log(
                    "⚠️ Real mention failed:"
                  );

                  console.log(
                    mentionError?.message ||
                    mentionError
                  );

                  console.log(
                    "📨 Trying fallback without mention..."
                  );
                }
              }

              // =========================================
              // FALLBACK WITHOUT MENTION
              // =========================================

              if (!sent) {

                const fallbackMessage =
                  String(
                    WELCOME
                      .replace(
                        "{member}",
                        memberName
                      )
                      .replace(
                        "{group}",
                        safeGroupName
                      )
                  );

                await sock.sendMessage(
                  groupId,
                  {
                    text:
                      fallbackMessage
                  }
                );

                console.log(
                  "✅ Welcome sent without mention."
                );

                sent = true;
              }

              // =========================================
              // SUCCESS LOG
              // =========================================

              console.log("");
              console.log(
                "------------------------------------------"
              );

              console.log(
                "🎉 NEW MEMBER JOINED"
              );

              console.log(
                `👤 Name: ${memberName}`
              );

              console.log(
                `🆔 Event ID: ${participantId}`
              );

              console.log(
                `👥 Group: ${safeGroupName}`
              );

              console.log(
                `📨 Status: ${
                  sent
                    ? "WELCOME SENT"
                    : "FAILED"
                }`
              );

              console.log(
                "------------------------------------------"
              );

            } catch (
              memberError
            ) {

              console.log("");
              console.log(
                "❌ Individual Welcome Error:"
              );

              console.log(
                memberError?.message ||
                memberError
              );

              if (
                memberError?.stack
              ) {
                console.log(
                  "📌 Error Stack:"
                );

                console.log(
                  memberError.stack
                );
              }

              console.log("");
            }
          }

          console.log(
            "=========================================="
          );
          console.log("");

        } catch (error) {

          console.log("");
          console.log(
            "❌ Group Welcome Error:"
          );

          console.log(
            error?.message ||
            error
          );

          if (
            error?.stack
          ) {
            console.log(
              "📌 Error Stack:"
            );

            console.log(
              error.stack
            );
          }

          console.log("");
        }
      }
    );

    // ==================================================
    // MESSAGE HANDLER
    // ==================================================

    sock.ev.on(
      "messages.upsert",
      async ({
        messages
      }) => {

        try {

          for (
            const msg
            of messages || []
          ) {

            // ------------------------------------------
            // BASIC VALIDATION
            // ------------------------------------------

            if (
              !msg?.message
            ) {
              continue;
            }

            // Ignore own messages
            if (
              msg.key?.fromMe
            ) {
              continue;
            }

            const remoteJid =
              msg.key?.remoteJid;

            // Only groups
            if (
              typeof remoteJid !==
                "string" ||
              !remoteJid.endsWith(
                "@g.us"
              )
            ) {
              continue;
            }

            // Group restriction
            if (
              GROUP_ID &&
              remoteJid !==
                GROUP_ID
            ) {
              continue;
            }

            // ------------------------------------------
            // GET TEXT
            // ------------------------------------------

            const text =
              getMessageText(
                msg.message
              ).trim();

            if (!text) {
              continue;
            }

            const command =
              text
                .split(
                  /\s+/
                )[0]
                .toLowerCase();

            // ==========================================
            // /MENU
            // ==========================================

            if (
              command ===
              "/menu"
            ) {

              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    MENU
                }
              );

              continue;
            }

            // ==========================================
            // /RULES
            // ==========================================

            if (
              command ===
              "/rules"
            ) {

              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    RULES
                }
              );

              continue;
            }

            // ==========================================
            // /WEBSITE
            // ==========================================

            if (
              command ===
              "/website"
            ) {

              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    `🌐 *Official Website*\n\n${WEBSITE_URL}`
                }
              );

              continue;
            }

            // ==========================================
            // /PING
            // ==========================================

            if (
              command ===
              "/ping"
            ) {

              const start =
                Date.now();

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
                    `🏓 *PONG!*\n\n🟢 Bot Status: ONLINE\n⚡ Response: ${ping}ms\n🤖 WhatsApp Bot is working perfectly.`
                }
              );

              continue;
            }

            // ==========================================
            // /ID
            // ==========================================

            if (
              command ===
              "/id"
            ) {

              await sock.sendMessage(
                remoteJid,
                {
                  text:
                    `🆔 *Group ID*\n\n${remoteJid}`
                }
              );

              continue;
            }

            // ==========================================
            // /GROUPINFO
            // ==========================================

            if (
              command ===
              "/groupinfo"
            ) {

              try {

                const metadata =
                  await sock.groupMetadata(
                    remoteJid
                  );

                const participants =
                  Array.isArray(
                    metadata?.participants
                  )
                    ? metadata.participants
                    : [];

                const admins =
                  participants.filter(
                    participant =>
                      participant?.admin
                  );

                const subject =
                  typeof metadata?.subject ===
                    "string"
                    ? metadata.subject
                    : "Unknown Group";

                const description =
                  typeof metadata?.desc ===
                    "string"
                    ? metadata.desc
                    : "No description";

                const owner =
                  typeof metadata?.owner ===
                    "string"
                    ? metadata.owner
                    : "Unknown";

                const info = `
👥 *GROUP INFORMATION*

📛 Name:
${subject}

👤 Members:
${participants.length}

👑 Admins:
${admins.length}

🆔 Group ID:
${remoteJid}

📌 Owner:
${owner}

📝 Description:
${description}
`;

                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      info
                  }
                );

              } catch (
                error
              ) {

                console.log(
                  "❌ GroupInfo Error:",
                  error?.message ||
                  error
                );

                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      "❌ Group information পাওয়া যায়নি।"
                  }
                );
              }

              continue;
            }

            // ==========================================
            // /MEMBERS
            // ==========================================

            if (
              command ===
              "/members"
            ) {

              try {

                const metadata =
                  await sock.groupMetadata(
                    remoteJid
                  );

                const count =
                  Array.isArray(
                    metadata?.participants
                  )
                    ? metadata.participants.length
                    : 0;

                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      `👥 *Group Members*\n\nমোট সদস্য: *${count} জন*`
                  }
                );

              } catch (
                error
              ) {

                console.log(
                  "❌ Members Error:",
                  error?.message ||
                  error
                );

                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      "❌ Member count পাওয়া যায়নি।"
                  }
                );
              }

              continue;
            }

            // ==========================================
            // /USERS
            // ==========================================

            if (
              command ===
              "/users"
            ) {

              try {

                const metadata =
                  await sock.groupMetadata(
                    remoteJid
                  );

                const participants =
                  Array.isArray(
                    metadata?.participants
                  )
                    ? metadata.participants
                    : [];

                if (
                  participants.length === 0
                ) {

                  await sock.sendMessage(
                    remoteJid,
                    {
                      text:
                        "❌ কোনো সদস্য পাওয়া যায়নি।"
                    }
                  );

                  continue;
                }

                let userList =
                  "👥 *GROUP MEMBERS*\n\n";

                const mentions = [];

                let number = 1;

                for (
                  const participant
                  of participants
                ) {

                  // Only valid WhatsApp JID
                  const id =
                    typeof participant?.id ===
                      "string"
                      ? participant.id
                      : null;

                  if (
                    !id
                  ) {
                    continue;
                  }

                  let name =
                    getDisplayName(
                      participant
                    );

                  if (
                    !name ||
                    name ===
                      "Unknown Member"
                  ) {
                    name =
                      "Member";
                  }

                  name =
                    String(name);

                  userList +=
                    `${number}️⃣ @${name}\n`;

                  // Only add safe JID
                  if (
                    id.endsWith(
                      "@s.whatsapp.net"
                    )
                  ) {
                    mentions.push(
                      id
                    );
                  }

                  number++;
                }

                userList +=
                  `\n👥 Total: ${participants.length}`;

                // ----------------------------------------
                // If safe mentions available
                // ----------------------------------------

                if (
                  mentions.length > 0
                ) {

                  try {

                    await sock.sendMessage(
                      remoteJid,
                      {
                        text:
                          userList,

                        mentions
                      }
                    );

                  } catch (
                    mentionError
                  ) {

                    console.log(
                      "⚠️ /users mention failed:"
                    );

                    console.log(
                      mentionError?.message ||
                      mentionError
                    );

                    await sock.sendMessage(
                      remoteJid,
                      {
                        text:
                          userList
                      }
                    );
                  }

                } else {

                  await sock.sendMessage(
                    remoteJid,
                    {
                      text:
                        userList
                    }
                  );
                }

              } catch (
                error
              ) {

                console.log(
                  "❌ Users Error:",
                  error?.message ||
                  error
                );

                await sock.sendMessage(
                  remoteJid,
                  {
                    text:
                      "❌ Member list পাওয়া যায়নি।"
                  }
                );
              }

              continue;
            }
          }

        } catch (
          error
        ) {

          console.log("");
          console.log(
            "❌ Message Handler Error:"
          );

          console.log(
            error?.message ||
            error
          );

          console.log("");

        }
      }
    );

    // ==================================================
    // BOT STARTED
    // ==================================================

    console.log(
      "📡 WhatsApp connecting..."
    );

  } catch (
    error
  ) {

    botStarting = false;

    console.log("");
    console.log(
      "❌ START BOT ERROR:"
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

    console.log(
      "🔄 Retrying in 5 seconds..."
    );

    scheduleReconnect();
  }
}

// ======================================================
// GLOBAL ERROR HANDLERS
// ======================================================

process.on(
  "uncaughtException",
  error => {

    console.log("");
    console.log(
      "❌ Uncaught Exception:"
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

    console.log("");
  }
);

process.on(
  "unhandledRejection",
  error => {

    console.log("");
    console.log(
      "❌ Unhandled Rejection:"
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

    console.log("");
  }
);

// ======================================================
// SHUTDOWN
// ======================================================

process.on(
  "SIGINT",
  () => {

    console.log(
      "🛑 Bot shutting down..."
    );

    process.exit(0);
  }
);

process.on(
  "SIGTERM",
  () => {

    console.log(
      "🛑 Bot shutting down..."
    );

    process.exit(0);
  }
);

// ======================================================
// START
// ======================================================

startBot();
