const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const mongoose = require("mongoose");
const WebSocket = require("ws");

// MongoDB Connection
const mongoURI =process.env.mongoURI;
mongoose
  .connect(mongoURI)
  .then(() => console.log("MongoDB connected successfully!"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Define a simple message schema for MongoDB
const MessageSchema = new mongoose.Schema({
  from: String,
  to: String,
  body: String,
  type: String,
  timestamp: { type: Date, default: Date.now },
  mediaName: String,
  mediaData: String,
  mediaSize: String,
  mediaMimeType: String,
});
const Message = mongoose.model("Message", MessageSchema);

// Create a WebSocket server
const wss = new WebSocket.Server({ port: 8080 });
wss.on("listening", () =>
  console.log("WebSocket server listening on port 8080")
);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "MyData" }), // Local storage for session
  puppeteer: {
    product: "chrome",
    executablePath:
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--headless"],
  },
});

// Broadcast messages to all connected WebSocket clients
const broadcast = (data) => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  });
};

// Client ready event
client.once("ready", () => {
  console.log("Client is ready!");
  broadcast({ type: "status", message: "Client is ready!" });
});

// QR code received event
client.on("qr", (qr) => {
  console.log("QR RECEIVED", qr);
  qrcode.generate(qr, { small: true });
  broadcast({ type: "qr", qrCode: qr }); // Send QR to WebSocket clients
});

// Client authenticated event
client.on("authenticated", () => console.log("Client is authenticated!"));
// Authentication failure event
client.on("auth_failure", (msg) =>
  console.error("Authentication failed!", msg)
);

// Disconnected event
client.on("disconnected", (reason) => {
  console.log("Client was disconnected:", reason);
  broadcast({ type: "status", message: `Client disconnected: ${reason}` });
});

// Incoming message handler
client.on("message", async (message) => {
  console.log("Message received:", message.body);
  broadcast({
    type: "message",
    message: { from: message.from, body: message.body, id: message.id.id },
  }); // Send to WS clients
  try {
    // Save message to MongoDB
    const media = await message.downloadMedia();
    const newMessage = new Message({
      from: message.from,
      to: message.to,
      body: message.body,
      type: message.type,
      mediaName: message.hasMedia ? media.filename : null,
      mediaData: message.hasMedia ? media.data : null,
      mediaSize: message.hasMedia ? media.filesize : null,
      mediaMimeType: message.hasMedia ? media.mimetype : null,
    });
    await newMessage.save();
    console.log("Message saved to MongoDB!");
  } catch (err) {
    console.error("Error saving message to MongoDB:", err);
  }
});

// Incoming message create handler (includes sent messages)
client.on("message_create", async (message) => {
  if (message.fromMe) {
    console.log("Message sent:", message.body);
    broadcast({
      type: "sent_message",
      message: { to: message.to, body: message.body, id: message.id.id },
    });
  }

  // Handle media messages (images, videos, documents, audio)
  if (message.hasMedia) {
    const media = await message.downloadMedia();
    console.log("Media message received:", media.mimetype);
    broadcast({
      type: "media_message",
      message: {
        from: message.from,
        mimetype: media.mimetype,
        data: media.data,
      },
    });
    try {
      // Update the saved message with media info if it exists
      await Message.findOneAndUpdate(
        { "id.id": message.id.id },
        {
          mediaUrl: "Data embedded in message object",
          mediaMimeType: media.mimetype,
        }
      );
    } catch (err) {
      console.error("Error updating message with media info in MongoDB:", err);
    }
  }
});

// Message reaction handler
client.on("message_reaction", (reaction) => {
  console.log(
    `Reaction "${reaction.reaction}" on message ${reaction.msgId.id} by ${reaction.senderId}`
  );
  broadcast({
    type: "message_reaction",
    reaction: {
      messageId: reaction.msgId.id,
      reaction: reaction.reaction,
      senderId: reaction.senderId,
    },
  });
});

// WebSocket server connection handling
wss.on("connection", (ws) => {
  console.log("Client connected to WebSocket");
  ws.on("message", async (message) => {
    const data = JSON.parse(message);
    switch (data.type) {
      case "sendMessage":
        if (data.to && data.body) {
          try {
            const chat = await client.getChatById(data.to);
            if (chat) await chat.sendMessage(data.body);
            console.log(`Message sent to ${data.to}: ${data.body}`);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "success",
                originalType: data.type,
              })
            );
          } catch (error) {
            console.error("Error sending message:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "sendMedia":
        if (data.to && data.base64Data && data.mimetype) {
          try {
            const media = new MessageMedia(
              data.mimetype,
              data.base64Data,
              data.filename
            );
            await client.sendMessage(data.to, media, { caption: data.caption });
            console.log(`Media sent to ${data.to}: ${data.filename}`);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "success",
                originalType: data.type,
              })
            );
          } catch (error) {
            console.error("Error sending media:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "sendContactCard":
        if (data.to && data.contactId) {
          try {
            const contact = await client.getContactById(data.contactId);
            await client.sendMessage(data.to, contact);
            console.log(
              `Contact card sent to ${data.to} for ${data.contactId}`
            );
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "success",
                originalType: data.type,
              })
            );
          } catch (error) {
            console.error("Error sending contact card:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "replyMessage":
        if (data.targetMessageId && data.body) {
          try {
            const message = await client.getMessageById(data.targetMessageId);
            if (message) await message.reply(data.body);
            console.log(
              `Replied to message ${data.targetMessageId} with: ${data.body}`
            );
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "success",
                originalType: data.type,
              })
            );
          } catch (error) {
            console.error("Error replying to message:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "muteChat":
        if (data.chatId) {
          try {
            const chat = await client.getChatById(data.chatId);
            if (chat) await chat.mute();
            console.log(`Chat ${data.chatId} muted.`);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "success",
                originalType: data.type,
              })
            );
          } catch (error) {
            console.error("Error muting chat:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "unmuteChat":
        if (data.chatId) {
          try {
            const chat = await client.getChatById(data.chatId);
            if (chat) await chat.unmute();
            console.log(`Chat ${data.chatId} unmuted.`);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "success",
                originalType: data.type,
              })
            );
          } catch (error) {
            console.error("Error unmuting chat:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "blockContact":
        if (data.contactId) {
          try {
            const contact = await client.getContactById(data.contactId);
            if (contact) await contact.block();
            console.log(`Contact ${data.contactId} blocked.`);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "success",
                originalType: data.type,
              })
            );
          } catch (error) {
            console.error("Error blocking contact:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "unblockContact":
        if (data.contactId) {
          try {
            const contact = await client.getContactById(data.contactId);
            if (contact) await contact.unblock();
            console.log(`Contact ${data.contactId} unblocked.`);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "success",
                originalType: data.type,
              })
            );
          } catch (error) {
            console.error("Error unblocking contact:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "getContactInfo":
        if (data.contactId) {
          try {
            const contact = await client.getContactById(data.contactId);
            console.log("Contact Info:", contact);
            ws.send(
              JSON.stringify({
                type: "contactInfo",
                contact: contact.serialize(),
              })
            );
          } catch (error) {
            console.error("Error getting contact info:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "getProfilePicture":
        if (data.contactId) {
          try {
            const ppUrl = await client.getProfilePicUrl(data.contactId);
            console.log(`Profile picture URL for ${data.contactId}: ${ppUrl}`);
            ws.send(
              JSON.stringify({
                type: "profilePicture",
                contactId: data.contactId,
                url: ppUrl,
              })
            );
          } catch (error) {
            console.error("Error getting profile picture:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "getChatStatus":
        if (data.chatId) {
          try {
            const chat = await client.getChatById(data.chatId);
            const statuses = await chat.getMessages({
              limit: 5,
              fromMe: false,
              type: "status",
            }); // Example for getting last 5 statuses
            console.log(`Statuses for chat ${data.chatId}:`, statuses);
            ws.send(
              JSON.stringify({
                type: "chatStatuses",
                chatId: data.chatId,
                statuses: statuses,
              })
            );
          } catch (error) {
            console.error("Error getting chat statuses:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "sendStatus":
        if (data.body) {
          try {
            await client.sendStatus(data.body);
            console.log("Status shared:", data.body);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "success",
                originalType: data.type,
              })
            );
          } catch (error) {
            console.error("Error sharing status:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      case "sendReaction":
        if (data.messageId && data.reaction) {
          try {
            const message = await client.getMessageById(data.messageId);
            if (message) await message.react(data.reaction);
            console.log(
              `Reacted to message ${data.messageId} with ${data.reaction}`
            );
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "success",
                originalType: data.type,
              })
            );
          } catch (error) {
            console.error("Error sending reaction:", error);
            ws.send(
              JSON.stringify({
                type: "ack",
                status: "error",
                originalType: data.type,
                error: error.message,
              })
            );
          }
        }
        break;
      // Note: WhatsApp-Web.js currently does not directly support making or receiving calls
      // The client.on('call') event is for incoming calls, not initiating outgoing calls programmatically.
      case "makeCall":
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "error",
            originalType: data.type,
            error:
              "Making calls is not directly supported by whatsapp-web.js API.",
          })
        );
        break;
      default:
        console.warn("Unknown WebSocket message type:", data.type);
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "error",
            originalType: data.type,
            error: "Unknown command",
          })
        );
    }
  });
  ws.on("close", () => console.log("Client disconnected from WebSocket"));
  ws.on("error", (error) => console.error("WebSocket error:", error));
});

// Incoming call event
client.on("call", async (call) => {
  console.log("Call received:", call);
  broadcast({ type: "incoming_call", call: call });
  // You can automatically reject calls if desired
  // await call.reject();
});

// Start your client
client.initialize();
