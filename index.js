import "dotenv/config";
import makeWASocket, {
  useMultiFileAuthState,
  Browsers
} from "@whiskeysockets/baileys";
import P from "pino";

const PHONE_NUMBER = (process.env.PHONE_NUMBER || "")
  .replace(/\D/g, "");

const AUTH_DIR = "./auth_info";

let pairingDone = false;

async function start() {
  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection }) => {

    if (connection === "connecting") {
      console.log("🔄 Connecting to WhatsApp...");

      if (
        PHONE_NUMBER &&
        !state.creds.registered &&
        !pairingDone
      ) {
        try {
          await new Promise(r => setTimeout(r, 5000));

          const code =
            await sock.requestPairingCode(
              PHONE_NUMBER
            );

          pairingDone = true;

          console.log("━━━━━━━━━━━━━━━━");
          console.log("🔐 PAIRING CODE:", code);
          console.log("━━━━━━━━━━━━━━━━");
          console.log("📱 WhatsApp → Linked Devices");
          console.log("→ Link with phone number");
          console.log("⏳ Waiting for connection...");
        } catch (e) {
          console.log(
            "❌ Pairing error:",
            e.message
          );
        }
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp Connected!");
      console.log("🤖 Bot is Online");
    }

    if (connection === "close") {
      console.log("❌ WebSocket Closed");
      console.log("🔄 Reconnecting...");

      setTimeout(start, 5000);
    }
  });
}

start();