import "dotenv/config";
import pino from "pino";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import readline from "readline";

const AUTH_DIR = process.env.AUTH_DIR || "./auth_info";
const RETRY_DELAY = 15000;

let socket = null;
let stopping = false;
let starting = false;

const logger = pino({
  level: process.env.LOG_LEVEL || "info"
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanNumber(number) {
  return String(number || "").replace(/\D/g, "");
}

function askPhoneNumber() {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(
      "Enter WhatsApp number with country code (example: 8801XXXXXXXXX): ",
      answer => {
        rl.close();
        resolve(cleanNumber(answer));
      }
    );
  });
}

async function waitForRegistration(state) {
  console.log("");
  console.log("Waiting for phone connection...");
  console.log("Keep this server running.");
  console.log("Do NOT restart the server while entering the code.");
  console.log("");

  while (!stopping && !state.creds.registered) {
    await sleep(3000);
  }

  if (state.creds.registered) {
    console.log("");
    console.log("========================================");
    console.log(" WhatsApp phone linked successfully!");
    console.log(" Authentication saved.");
    console.log("========================================");
    console.log("");
  }
}

async function startBot() {
  if (stopping || starting) return;

  starting = true;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    socket = makeWASocket({
      auth: state,

      logger,

      browser: Browsers.macOS("Chrome"),

      printQRInTerminal: false,

      markOnlineOnConnect: false,

      syncFullHistory: false,

      generateHighQualityLinkPreview: false,

      connectTimeoutMs: 60000,

      defaultQueryTimeoutMs: 60000,

      keepAliveIntervalMs: 20000
    });

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", async update => {
      const {
        connection,
        lastDisconnect
      } = update;

      if (connection === "connecting") {
        console.log("Connecting to WhatsApp...");
      }

      if (connection === "open") {
        console.log("");
        console.log("========================================");
        console.log(" WhatsApp Connected Successfully");
        console.log(" Bot is now online.");
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
          `WhatsApp connection closed. Code: ${
            statusCode || "unknown"
          }`
        );

        if (
          statusCode === DisconnectReason.loggedOut
        ) {
          console.log("");
          console.log(
            "WhatsApp logged out."
          );
          console.log(
            "Delete the auth_info folder and pair again."
          );
          console.log("");
          return;
        }

        if (!stopping) {
          console.log(
            `Reconnecting in ${
              RETRY_DELAY / 1000
            } seconds...`
          );

          await sleep(RETRY_DELAY);

          if (!stopping) {
            starting = false;
            await startBot();
          }
        }
      }
    });

    /*
     * If the account is already linked,
     * do NOT generate a new pairing code.
     */
    if (state.creds.registered) {
      console.log("");
      console.log(
        "Existing WhatsApp session found."
      );
      console.log(
        "Waiting for WhatsApp connection..."
      );
      console.log("");

      starting = false;
      return;
    }

    /*
     * Wait a little before requesting
     * the pairing code.
     */
    await sleep(5000);

    if (stopping) return;

    let phoneNumber =
      cleanNumber(process.env.PHONE_NUMBER);

    if (!phoneNumber) {
      phoneNumber = await askPhoneNumber();
    }

    if (!phoneNumber) {
      console.log("");
      console.log(
        "ERROR: WhatsApp phone number is missing."
      );
      console.log(
        "Set PHONE_NUMBER in your .env file."
      );
      console.log("");

      starting = false;
      return;
    }

    if (phoneNumber.length < 8) {
      console.log("");
      console.log(
        "ERROR: Invalid WhatsApp phone number."
      );
      console.log("");

      starting = false;
      return;
    }

    console.log("");
    console.log(
      "Requesting WhatsApp pairing code..."
    );
    console.log("");

    try {
      const pairingCode =
        await socket.requestPairingCode(
          phoneNumber
        );

      console.log("");
      console.log("========================================");
      console.log("       WHATSAPP PAIRING CODE");
      console.log("");
      console.log(`             ${pairingCode}`);
      console.log("");
      console.log("========================================");
      console.log("");
      console.log(
        "Open WhatsApp on your phone:"
      );
      console.log(
        "Settings > Linked devices > Link a device"
      );
      console.log(
        "Then choose 'Link with phone number'"
      );
      console.log("");
      console.log(
        "Enter the code shown above."
      );
      console.log("");
      console.log(
        "The bot will WAIT until your phone is linked."
      );
      console.log(
        "Do not restart the server during pairing."
      );
      console.log("");

      await waitForRegistration(state);

    } catch (error) {
      console.log("");
      console.error(
        "Pairing code error:",
        error?.message || error
      );

      console.log("");
      console.log(
        `Retrying in ${
          RETRY_DELAY / 1000
        } seconds...`
      );

      await sleep(RETRY_DELAY);

      if (!stopping) {
        starting = false;
        await startBot();
      }

      return;
    }

  } catch (error) {
    console.log("");
    console.error(
      "Bot startup error:",
      error?.message || error
    );
    console.log("");

    if (!stopping) {
      await sleep(RETRY_DELAY);
      starting = false;
      await startBot();
    }

    return;
  }

  starting = false;
}

/*
 * Graceful shutdown
 */
process.on("SIGINT", () => {
  stopping = true;

  console.log("");
  console.log(
    "Stopping WhatsApp bot..."
  );

  process.exit(0);
});

process.on("SIGTERM", () => {
  stopping = true;

  console.log("");
  console.log(
    "Stopping WhatsApp bot..."
  );

  process.exit(0);
});

/*
 * Prevent unexpected crashes
 */
process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled promise rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Unexpected exception:",
      error
    );
  }
);

/*
 * Start
 */
console.log("");
console.log("========================================");
console.log("        PIYAS WHATSAPP BOT");
console.log("        Pairing Safe Version");
console.log("========================================");
console.log("");

startBot();