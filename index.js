import "dotenv/config";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import pino from "pino";

const AUTH_DIR = process.env.AUTH_DIR || "./auth_info";

const PHONE_NUMBER = String(
  process.env.PHONE_NUMBER || ""
).replace(/\D/g, "");

const GROUP_ID = process.env.GROUP_ID || "";

const logger = pino({
  level: "silent"
});

let shuttingDown = false;
let socket = null;

const WAIT_AFTER_CLOSE = 30000;
const INITIAL_WAIT = 8000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatPhone(number) {
  if (!number) return "NOT SET";

  if (number.length > 7) {
    return (
      "+" +
      number.slice(0, 3) +
      " " +
      number.slice(3, 6) +
      " " +
      number.slice(6)
    );
  }

  return "+" + number;
}

function printHeader() {
  console.log("");
  console.log("==============================================");
  console.log("          PIYAS WHATSAPP BOT");
  console.log("==============================================");
  console.log("");
  console.log(
    "📱 WhatsApp Number :",
    formatPhone(PHONE_NUMBER)
  );
  console.log(
    "👥 Group ID        :",
    GROUP_ID || "NOT SET"
  );
  console.log(
    "📁 Auth Folder     :",
    AUTH_DIR
  );
  console.log("");
  console.log("==============================================");
  console.log("");
}

async function createConnection() {
  if (shuttingDown) return;

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(AUTH_DIR);

  printHeader();

  console.log("🔐 Session status:");

  if (state.creds.registered) {
    console.log("   ✅ Phone is already registered.");
  } else {
    console.log("   ⏳ Phone is NOT linked yet.");
  }

  console.log("");

  socket = makeWASocket({
    auth: state,

    logger,

    browser: Browsers.macOS("Chrome"),

    printQRInTerminal: false,

    markOnlineOnConnect: false,

    syncFullHistory: false,

    generateHighQualityLinkPreview: false,

    connectTimeoutMs: 120000,

    defaultQueryTimeoutMs: 120000,

    keepAliveIntervalMs: 20000
  });

  socket.ev.on(
    "creds.update",
    saveCreds
  );

  let pairingRequested = false;

  socket.ev.on(
    "connection.update",
    async update => {
      const {
        connection,
        lastDisconnect
      } = update;

      if (connection === "connecting") {
        console.log("");
        console.log(
          "🔄 Connecting to WhatsApp..."
        );
        console.log(
          "📱 Target Number:",
          formatPhone(PHONE_NUMBER)
        );
        console.log("");
      }

      if (connection === "open") {
        console.log("");
        console.log(
          "=============================================="
        );
        console.log(
          "             ✅ CONNECTED"
        );
        console.log(
          "=============================================="
        );
        console.log("");
        console.log(
          "📱 Connected Number:",
          formatPhone(PHONE_NUMBER)
        );

        console.log(
          "🤖 Bot Status: ONLINE"
        );

        if (GROUP_ID) {
          console.log(
            "👥 Target Group:",
            GROUP_ID
          );
        }

        console.log("");
        console.log(
          "🔐 Authentication saved."
        );

        console.log(
          "⏳ Bot will remain running."
        );

        console.log("");
        return;
      }

      if (connection === "close") {
        const statusCode =
          new Boom(lastDisconnect?.error)
            ?.output
            ?.statusCode;

        console.log("");
        console.log(
          "❌ WhatsApp connection closed."
        );

        console.log(
          "📱 Number:",
          formatPhone(PHONE_NUMBER)
        );

        console.log(
          "🔢 Code:",
          statusCode || "unknown"
        );

        console.log("");

        /*
         * Logged out means the saved session
         * is no longer valid.
         */
        if (
          statusCode ===
          DisconnectReason.loggedOut
        ) {
          console.log(
            "🔴 WhatsApp logged out."
          );

          console.log(
            "🧹 Delete auth_info and pair again."
          );

          console.log("");
          return;
        }

        /*
         * If the phone is not registered yet,
         * DO NOT immediately restart.
         */
        if (!state.creds.registered) {
          console.log(
            "⏳ Phone is not linked yet."
          );

          console.log(
            "⏳ Waiting before trying again..."
          );

          console.log(
            `⏳ Next attempt in ${
              WAIT_AFTER_CLOSE / 1000
            } seconds.`
          );

          console.log("");

          await sleep(
            WAIT_AFTER_CLOSE
          );

          if (!shuttingDown) {
            await createConnection();
          }

          return;
        }

        /*
         * Existing linked session.
         * Reconnect slowly.
         */
        if (!shuttingDown) {
          console.log(
            "🔄 Existing session detected."
          );

          console.log(
            "⏳ Reconnecting in 30 seconds..."
          );

          await sleep(
            WAIT_AFTER_CLOSE
          );

          if (!shuttingDown) {
            await createConnection();
          }
        }
      }
    }
  );

  /*
   * Already linked
   */
  if (state.creds.registered) {
    console.log("");
    console.log(
      "=============================================="
    );
    console.log(
      "🔐 EXISTING SESSION FOUND"
    );
    console.log(
      "=============================================="
    );

    console.log(
      "📱 Number:",
      formatPhone(PHONE_NUMBER)
    );

    console.log(
      "⏳ Waiting for WhatsApp connection..."
    );

    console.log("");

    return;
  }

  /*
   * Check phone number
   */
  if (!PHONE_NUMBER) {
    console.log("");
    console.log(
      "❌ PHONE_NUMBER is missing."
    );

    console.log(
      "Add PHONE_NUMBER to .env"
    );

    console.log("");

    /*
     * Keep process alive.
     */
    while (!shuttingDown) {
      await sleep(30000);
    }

    return;
  }

  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    "📱 NUMBER TO BE CONNECTED"
  );
  console.log(
    "=============================================="
  );

  console.log(
    "WhatsApp Number:",
    formatPhone(PHONE_NUMBER)
  );

  console.log(
    "Raw Number:",
    PHONE_NUMBER
  );

  console.log(
    "=============================================="
  );
  console.log("");

  console.log(
    "⏳ Preparing pairing..."
  );

  await sleep(INITIAL_WAIT);

  if (
    shuttingDown ||
    state.creds.registered
  ) {
    return;
  }

  /*
   * Generate ONE pairing code
   */
  try {
    if (!pairingRequested) {
      pairingRequested = true;

      const code =
        await socket.requestPairingCode(
          PHONE_NUMBER
        );

      console.log("");
      console.log(
        "=============================================="
      );
      console.log(
        "             🔐 PAIRING CODE"
      );
      console.log(
        "=============================================="
      );

      console.log("");
      console.log(
        "📱 CONNECT THIS NUMBER:"
      );

      console.log(
        "   " + formatPhone(PHONE_NUMBER)
      );

      console.log("");

      console.log(
        "🔑 PAIRING CODE:"
      );

      console.log(
        "   " + code
      );

      console.log("");

      console.log(
        "=============================================="
      );

      console.log("");
      console.log(
        "📲 WhatsApp → Settings"
      );

      console.log(
        "→ Linked Devices"
      );

      console.log(
        "→ Link a Device"
      );

      console.log(
        "→ Link with phone number instead"
      );

      console.log("");
      console.log(
        "⏳ ENTER THE CODE ABOVE."
      );

      console.log(
        "⏳ BOT WILL WAIT FOR THE PHONE."
      );

      console.log(
        "⛔ Do NOT restart the server."
      );

      console.log("");

      console.log(
        "=============================================="
      );
      console.log("");
    }
  } catch (error) {
    console.log("");
    console.log(
      "❌ Pairing code could not be generated."
    );

    console.log(
      "Reason:",
      error?.message || error
    );

    console.log("");

    console.log(
      "⏳ Bot will wait instead of crashing."
    );

    console.log("");

    /*
     * Keep alive.
     */
    while (!shuttingDown) {
      await sleep(30000);

      console.log(
        "⏳ Still waiting for WhatsApp..."
      );
    }

    return;
  }

  /*
   * WAIT UNTIL PHONE IS LINKED
   */
  while (
    !state.creds.registered &&
    !shuttingDown
  ) {
    await sleep(5000);

    console.log(
      "⏳ Waiting for:",
      formatPhone(PHONE_NUMBER)
    );

    console.log(
      "   Status: NOT CONNECTED"
    );

    console.log("");
  }

  /*
   * Successfully linked
   */
  if (state.creds.registered) {
    console.log("");
    console.log(
      "=============================================="
    );

    console.log(
      "       🎉 PHONE CONNECTED SUCCESSFULLY"
    );

    console.log(
      "=============================================="
    );

    console.log("");

    console.log(
      "📱 Connected Number:",
      formatPhone(PHONE_NUMBER)
    );

    console.log(
      "🤖 Bot Status: ONLINE"
    );

    console.log(
      "🔐 Session: SAVED"
    );

    console.log("");

    console.log(
      "⏳ Bot will keep running..."
    );

    console.log("");
  }

  /*
   * Keep process alive forever
   */
  while (!shuttingDown) {
    await sleep(30000);
  }
}

/*
 * Graceful shutdown
 */
process.on("SIGINT", () => {
  shuttingDown = true;

  console.log("");
  console.log(
    "🛑 Bot stopped manually."
  );

  process.exit(0);
});

process.on("SIGTERM", () => {
  shuttingDown = true;

  console.log("");
  console.log(
    "🛑 Bot stopped manually."
  );

  process.exit(0);
});

/*
 * Prevent unexpected crash
 */
process.on(
  "unhandledRejection",
  error => {
    console.log("");
    console.log(
      "⚠️ Unhandled error:"
    );

    console.log(error);

    console.log("");
  }
);

process.on(
  "uncaughtException",
  error => {
    console.log("");
    console.log(
      "⚠️ Unexpected error:"
    );

    console.log(error);

    console.log("");
  }
);

/*
 * START
 */
createConnection().catch(error => {
  console.log("");
  console.log(
    "❌ Fatal startup error:"
  );

  console.log(
    error?.message || error
  );

  console.log("");

  /*
   * Do not immediately crash.
   */
  setInterval(() => {
    console.log(
      "⏳ Bot is waiting..."
    );
  }, 30000);
});