import "dotenv/config";

import makeWASocket, {
  Browsers,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

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
let pairingCodeCreated = false;
let phoneConnected = false;
let socket = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatNumber(number) {
  if (!number) {
    return "NOT SET";
  }

  return "+" + number;
}

function showInfo() {
  console.log("");
  console.log("==============================================");
  console.log("             PIYAS WHATSAPP BOT");
  console.log("==============================================");
  console.log("");
  console.log(
    "📱 WhatsApp Number :",
    formatNumber(PHONE_NUMBER)
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

async function main() {
  showInfo();

  if (!PHONE_NUMBER) {
    console.log("❌ PHONE_NUMBER is missing in .env");
    console.log("");
    console.log("Example:");
    console.log("PHONE_NUMBER=8801967619812");
    console.log("");

    /*
     * Keep process alive.
     * Do not crash.
     */
    while (!shuttingDown) {
      await sleep(30000);
    }

    return;
  }

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(AUTH_DIR);

  /*
   * Create WhatsApp socket ONLY ONCE.
   */
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

  /*
   * CONNECTION UPDATE
   */
  socket.ev.on(
    "connection.update",
    update => {
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
          "📱 Number:",
          formatNumber(PHONE_NUMBER)
        );

        console.log("");
      }

      if (connection === "open") {
        phoneConnected = true;

        console.log("");
        console.log(
          "=============================================="
        );

        console.log(
          "        🎉 WHATSAPP CONNECTED"
        );

        console.log(
          "=============================================="
        );

        console.log("");

        console.log(
          "📱 Connected Number:",
          formatNumber(PHONE_NUMBER)
        );

        console.log(
          "🤖 Bot Status: ONLINE"
        );

        console.log(
          "🔐 Session: SAVED"
        );

        console.log("");

        console.log(
          "⏳ Bot will continue running..."
        );

        console.log("");
      }

      if (connection === "close") {
        console.log("");
        console.log(
          "❌ WhatsApp connection closed."
        );

        /*
         * IMPORTANT:
         *
         * We DO NOT request another pairing code.
         * We DO NOT restart the socket.
         * We DO NOT call main() again.
         */
        console.log(
          "📱 Number:",
          formatNumber(PHONE_NUMBER)
        );

        console.log("");
        console.log(
          "⏳ Waiting..."
        );

        if (!phoneConnected) {
          console.log(
            "⏳ Phone has NOT been linked yet."
          );

          console.log(
            "🔐 Pairing code will NOT be generated again."
          );

          console.log(
            "⛔ No automatic restart."
          );
        } else {
          console.log(
            "ℹ️ Existing session was disconnected."
          );

          console.log(
            "⛔ No automatic pairing code will be generated."
          );
        }

        console.log("");
      }
    }
  );

  /*
   * EXISTING SESSION
   */
  if (state.creds.registered) {
    console.log("");
    console.log(
      "🔐 Existing WhatsApp session found."
    );

    console.log(
      "📱 Number:",
      formatNumber(PHONE_NUMBER)
    );

    console.log(
      "⏳ Waiting for connection..."
    );

    console.log("");

    /*
     * Keep alive forever.
     */
    while (!shuttingDown) {
      await sleep(10000);
    }

    return;
  }

  /*
   * Give WhatsApp connection some time
   * before creating the ONE pairing code.
   */
  console.log(
    "⏳ Preparing ONE pairing code..."
  );

  await sleep(8000);

  if (shuttingDown) {
    return;
  }

  /*
   * CREATE PAIRING CODE ONLY ONCE
   */
  if (!pairingCodeCreated) {
    try {
      pairingCodeCreated = true;

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
        "📱 Number to connect:"
      );

      console.log(
        "   " + formatNumber(PHONE_NUMBER)
      );

      console.log("");

      const code =
        await socket.requestPairingCode(
          PHONE_NUMBER
        );

      console.log(
        "🔑 Pairing Code:"
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
        "⏳ Enter the code above."
      );

      console.log(
        "⏳ Bot will WAIT for the phone."
      );

      console.log(
        "⛔ No second pairing code will be generated."
      );

      console.log(
        "⛔ No automatic restart will happen."
      );

      console.log("");

    } catch (error) {
      /*
       * Even if code generation fails,
       * do NOT keep generating codes.
       */
      console.log("");
      console.log(
        "❌ Pairing code generation failed."
      );

      console.log(
        "Reason:",
        error?.message || error
      );

      console.log("");

      console.log(
        "⛔ No automatic second pairing code."
      );

      console.log(
        "⏳ Server will remain alive."
      );

      console.log("");
    }
  }

  /*
   * WAIT FOREVER
   *
   * This is the important part.
   *
   * No requestPairingCode()
   * No restart
   * No main()
   * No new code
   */
  console.log(
    "=============================================="
  );

  console.log(
    "⏳ WAITING FOR PHONE CONNECTION"
  );

  console.log(
    "=============================================="
  );

  console.log("");

  console.log(
    "📱 Waiting for:",
    formatNumber(PHONE_NUMBER)
  );

  console.log(
    "🔐 Pairing code already generated:"
  );

  console.log(
    pairingCodeCreated ? "YES" : "NO"
  );

  console.log("");

  while (!shuttingDown) {
    await sleep(10000);

    if (phoneConnected) {
      console.log(
        "✅ WhatsApp is connected."
      );

      console.log(
        "📱 Number:",
        formatNumber(PHONE_NUMBER)
      );

      console.log(
        "🤖 Bot remains online."
      );

      console.log("");

      /*
       * Continue keeping the process alive.
       */
      continue;
    }

    console.log(
      "⏳ Still waiting for:",
      formatNumber(PHONE_NUMBER)
    );

    console.log(
      "🔐 New pairing code: NO"
    );

    console.log("");
  }
}

/*
 * SAFE SHUTDOWN
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
 * Prevent unexpected process termination.
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
main().catch(error => {
  console.log("");
  console.log(
    "❌ Startup error:"
  );

  console.log(
    error?.message || error
  );

  console.log("");

  /*
   * Keep the Node process alive.
   */
  setInterval(() => {
    console.log(
      "⏳ Bot is still waiting..."
    );
  }, 30000);
});