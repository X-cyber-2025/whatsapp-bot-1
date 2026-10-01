import "dotenv/config";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import pino from "pino";
import readline from "readline";

const AUTH_DIR = process.env.AUTH_DIR || "./auth_info";
const PHONE_NUMBER = (process.env.PHONE_NUMBER || "").replace(/\D/g, "");

const logger = pino({
  level: "silent"
});

let sock = null;
let shuttingDown = false;
let connected = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getPhoneNumber() {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(
      "WhatsApp number with country code: ",
      answer => {
        rl.close();
        resolve(String(answer).replace(/\D/g, ""));
      }
    );
  });
}

async function start() {
  console.log("");
  console.log("========================================");
  console.log("        PIYAS WHATSAPP BOT");
  console.log("        PAIRING WAIT MODE");
  console.log("========================================");
  console.log("");

  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,

    logger,

    browser: Browsers.macOS("Chrome"),

    printQRInTerminal: false,

    markOnlineOnConnect: false,

    syncFullHistory: false,

    connectTimeoutMs: 120000,

    defaultQueryTimeoutMs: 120000,

    keepAliveIntervalMs: 20000,

    generateHighQualityLinkPreview: false
  });

  sock.ev.on("creds.update", saveCreds);

  /*
   * CONNECTION EVENTS
   */
  sock.ev.on("connection.update", async update => {
    const {
      connection,
      lastDisconnect
    } = update;

    if (connection === "connecting") {
      console.log("🔄 Connecting to WhatsApp...");
    }

    if (connection === "open") {
      connected = true;

      console.log("");
      console.log("========================================");
      console.log("✅ WHATSAPP CONNECTED");
      console.log("✅ BOT IS ONLINE");
      console.log("========================================");
      console.log("");
    }

    if (connection === "close") {
      const statusCode =
        new Boom(lastDisconnect?.error)
          ?.output
          ?.statusCode;

      console.log("");
      console.log(
        `❌ WhatsApp connection closed. Code: ${
          statusCode || "unknown"
        }`
      );
      console.log("");

      /*
       * If the phone has already been linked,
       * reconnect automatically.
       */
      if (
        statusCode !== DisconnectReason.loggedOut &&
        state.creds.registered &&
        !shuttingDown
      ) {
        console.log(
          "🔄 Existing session found."
        );

        console.log(
          "⏳ Reconnecting in 15 seconds..."
        );

        await sleep(15000);

        if (!shuttingDown) {
          process.exit(0);
        }

        return;
      }

      /*
       * IMPORTANT:
       *
       * If the phone has NOT been linked yet,
       * DO NOT generate another pairing code.
       *
       * Keep the process alive and wait.
       */
      if (
        !state.creds.registered &&
        !shuttingDown
      ) {
        console.log("");
        console.log(
          "⏳ PHONE IS NOT LINKED YET."
        );
        console.log(
          "⏳ Bot will keep waiting."
        );
        console.log(
          "⚠️ No new pairing code will be generated automatically."
        );
        console.log("");

        while (
          !state.creds.registered &&
          !shuttingDown
        ) {
          await sleep(5000);
        }
      }
    }
  });

  /*
   * ALREADY LINKED
   */
  if (state.creds.registered) {
    console.log(
      "🔐 Existing WhatsApp session found."
    );

    console.log(
      "⏳ Waiting for WhatsApp connection..."
    );

    /*
     * Keep process alive forever.
     */
    while (!shuttingDown) {
      await sleep(10000);
    }

    return;
  }

  /*
   * WAIT BEFORE REQUESTING PAIRING CODE
   */
  console.log(
    "⏳ Preparing WhatsApp connection..."
  );

  await sleep(8000);

  if (shuttingDown) {
    return;
  }

  /*
   * GET PHONE NUMBER
   */
  let number = PHONE_NUMBER;

  if (!number) {
    number = await getPhoneNumber();
  }

  if (!number || number.length < 8) {
    console.log("");
    console.log(
      "❌ Invalid WhatsApp phone number."
    );

    console.log(
      "Set PHONE_NUMBER correctly in .env"
    );

    console.log("");
    return;
  }

  /*
   * CREATE ONLY ONE PAIRING CODE
   */
  try {
    console.log("");
    console.log(
      "🔐 Requesting pairing code..."
    );

    const code =
      await sock.requestPairingCode(number);

    console.log("");
    console.log("========================================");
    console.log("🔐 WHATSAPP PAIRING CODE");
    console.log("");
    console.log(`        ${code}`);
    console.log("");
    console.log("========================================");
    console.log("");

    console.log(
      "📱 WhatsApp:"
    );

    console.log(
      "Settings → Linked devices → Link a device"
    );

    console.log(
      "→ Link with phone number instead"
    );

    console.log("");
    console.log(
      "➡️ Enter the code shown above."
    );

    console.log("");
    console.log(
      "⏳ WAITING FOR PHONE TO CONNECT..."
    );

    console.log(
      "⏳ The bot will NOT create another code."
    );

    console.log(
      "⏳ Keep this server running."
    );

    console.log("");

  } catch (error) {
    console.log("");
    console.log(
      "❌ Could not generate pairing code."
    );

    console.log(
      error?.message || error
    );

    console.log("");

    /*
     * DO NOT LOOP.
     * Keep the server alive instead.
     */
    console.log(
      "⏳ Bot will remain running."
    );

    console.log(
      "⏳ Fix the connection and restart manually if necessary."
    );

    while (!shuttingDown) {
      await sleep(10000);
    }

    return;
  }

  /*
   * WAIT FOREVER UNTIL PHONE IS LINKED
   */
  while (
    !state.creds.registered &&
    !shuttingDown
  ) {
    await sleep(3000);

    console.log(
      "⏳ Waiting for WhatsApp phone connection..."
    );
  }

  /*
   * LINKED
   */
  if (state.creds.registered) {
    console.log("");
    console.log("========================================");
    console.log("🎉 PHONE LINKED SUCCESSFULLY");
    console.log("🎉 WHATSAPP BOT IS CONNECTED");
    console.log("========================================");
    console.log("");

    /*
     * Keep server alive.
     */
    while (!shuttingDown) {
      await sleep(30000);
    }
  }
}

/*
 * SAFE SHUTDOWN
 */
process.on("SIGINT", () => {
  shuttingDown = true;

  console.log("");
  console.log(
    "🛑 Stopping bot..."
  );

  process.exit(0);
});

process.on("SIGTERM", () => {
  shuttingDown = true;

  console.log("");
  console.log(
    "🛑 Stopping bot..."
  );

  process.exit(0);
});

/*
 * Prevent unexpected process crash
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
 * START BOT
 */
start().catch(error => {
  console.log("");
  console.log(
    "❌ Startup error:"
  );
  console.log(error);
  console.log("");

  /*
   * Keep server alive instead of crashing.
   */
  setInterval(() => {
    console.log(
      "⏳ Bot is still waiting..."
    );
  }, 30000);
});