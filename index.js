const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient, ServerApiVersion } = require('mongodb');
const WebSocket = require('ws');
const qrcode = require('qrcode-terminal');
require('dotenv').config();

const mongoURI = "mongodb+srv://riteshfilmscreation:riteshfilmscreation@riteshfilmscreation.lspmkds.mongodb.net/?retryWrites=true&w=majority&appName=riteshfilmscreation";
// const mongoURI = process.env.MONGO_URI;
console.log("testing");
const mongoClient = new MongoClient(mongoURI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
let db;

const wwebClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
});

const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
let clients = new Set();
const activeCalls = new Map();

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (message) => handleWsMessage(ws, message));
    ws.on('close', () => {
        clients.delete(ws);
    });
});

function broadcast(event, data) {
    const message = JSON.stringify({ event, data });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

async function main() {
    await mongoClient.connect();
    console.log('Connected to MongoDB');
    db = mongoClient.db('whatsapp-api');

    wwebClient.on('qr', (qr) => {
        qrcode.generate(qr, { small: true });
        broadcast('qr', qr);
    });

    wwebClient.on('ready', async () => {
        console.log('Client is ready!');
        broadcast('ready', {
            info: wwebClient.info
        });
    });

    wwebClient.on('auth_failure', (msg) => {
        console.error('AUTHENTICATION FAILURE', msg);
        broadcast('auth_failure', msg);
    });

    wwebClient.on('disconnected', (reason) => {
        console.log('Client was logged out', reason);
        broadcast('disconnected', reason);
    });

    wwebClient.on('message', async (message) => {
        try {
            const chat = await message.getChat();
            const contact = await message.getContact();

            // Save/Update Chat
            const chatData = {
                id: chat.id._serialized,
                isGroup: chat.isGroup,
                isReadOnly: chat.isReadOnly,
                lastMessageId: chat.lastMessage?.id?._serialized,
                name: chat.name,
                timestamp: chat.timestamp,
            };
            await db.collection('chats').updateOne({ id: chat.id._serialized }, { $set: chatData }, { upsert: true });
            broadcast('chat_update', chatData);

            // Save/Update Contact
            const contactData = {
                id: contact.id._serialized,
                isBlocked: contact.isBlocked,
                isBusiness: contact.isBusiness,
                isEnterprise: contact.isEnterprise,
                isGroup: contact.isGroup,
                isMe: contact.isMe,
                isMyContact: contact.isMyContact,
                isUser: contact.isUser,
                isWAContact: contact.isWAContact,
                name: contact.name,
                number: contact.number,
                pushname: contact.pushname,
                shortName: contact.shortName
            };
            if(contact.isBusiness) {
                contactData.businessProfile = await contact.getBusinessProfile();
            }
            await db.collection('contacts').updateOne({ id: contact.id._serialized }, { $set: contactData }, { upsert: true });
            broadcast('contact_update', contactData);


            // Handle Status
            if (message.isStatus) {
                const statusUpdate = {
                    id: message.id._serialized,
                    body: message.body,
                    type: message.type,
                    timestamp: message.timestamp,
                    hasMedia: message.hasMedia
                };
                await db.collection('statuses').updateOne({
                    contactId: contact.id._serialized
                }, {
                    $push: { msgs: statusUpdate },
                    $set: {
                        timestamp: message.timestamp,
                        contactName: contact.name || contact.pushname,
                    },
                    $inc: { totalCount: 1 }
                }, { upsert: true });

                broadcast('new_status', { contactId: contact.id._serialized, update: statusUpdate });
            }

            // Save Message
            const messageData = {
                from: message.from,
                fromMe: message.fromMe,
                hasMedia: message.hasMedia,
                hasQuotedMsg: message.hasQuotedMsg,
                hasReaction: message.hasReaction,
                id: message.id._serialized,
                isStatus: message.isStatus,
                links: message.links,
                mentionedIds: message.mentionedIds,
                timestamp: message.timestamp,
                to: message.to,
                type: message.type,
                body: message.body,
            };

            await db.collection('messages').insertOne(messageData);
            broadcast('new_message', messageData);

        } catch (e) {
            console.error('Error processing message:', e);
        }
    });

    wwebClient.on('call', async (call) => {
        const callData = {
            canHandleLocally: call.canHandleLocally,
            from: call.from,
            fromMe: call.fromMe,
            id: call.id,
            isGroup: call.isGroup,
            isVideo: call.isVideo,
            participants: call.participants,
            timestamp: call.timestamp,
            webClientShouldHandle: call.webClientShouldHandle,
        };
        activeCalls.set(call.id, call); // Cache the call object to allow rejection
        setTimeout(() => activeCalls.delete(call.id), 60000); // Remove after 1 minute

        await db.collection('calls').insertOne(callData);
        broadcast('incoming_call', callData);
    });

    wwebClient.on('media_uploaded', (message) => {
        broadcast('media_uploaded', { messageId: message.id._serialized });
    });

    wwebClient.on('message_create', (message) => {
        if (message.fromMe) {
            broadcast('message_create', {
                id: message.id._serialized, from: message.from, to: message.to, body: message.body, type: message.type
            });
        }
    });

    wwebClient.on('message_edit', (message, newBody, oldBody) => {
        broadcast('message_edit', { messageId: message.id._serialized, newBody, oldBody });
    });

    wwebClient.on('message_reaction', async (reaction) => {
        broadcast('message_reaction', {
            reaction: reaction.reaction, msgId: reaction.msgId._serialized, senderId: reaction.senderId,
        });
    });

    await wwebClient.initialize();
}

async function handleWsMessage(ws, message) {
    try {
        const { event, data } = JSON.parse(message);
        let result, target;

        switch (event) {
            // --- Status ---
            case 'get_status_chat':
                target = await wwebClient.getMessageById(data.statusId);
                result = target ? await target.getChat() : null;
                break;
            case 'get_status_contact':
                target = await wwebClient.getMessageById(data.statusId);
                result = target ? await target.getContact() : null;
                break;
            case 'share_status_text':
                result = await wwebClient.setStatus(data.text);
                break;
            case 'share_status_image':
            case 'share_status_video':
            case 'share_status_audio':
                const media = await MessageMedia.fromUrl(data.url, { unsafeMime: true });
                result = await wwebClient.setStatus(data.caption || '', { media });
                break;

            // --- Business/Contact ---
            case 'block_contact':
                target = await wwebClient.getContactById(data.contactId);
                result = await target?.block();
                break;
            case 'unblock_contact':
                target = await wwebClient.getContactById(data.contactId);
                result = await target?.unblock();
                break;
            case 'get_about':
                target = await wwebClient.getContactById(data.contactId);
                result = await target?.getAbout();
                break;
            case 'get_contact_chat':
                target = await wwebClient.getContactById(data.contactId);
                result = await target?.getChat();
                break;
            case 'get_common_groups':
                target = await wwebClient.getContactById(data.contactId);
                result = await target?.getCommonGroups();
                break;
            case 'get_country_code':
                target = await wwebClient.getContactById(data.contactId);
                result = await target?.getCountryCode();
                break;
            case 'get_formatted_number':
                target = await wwebClient.getContactById(data.contactId);
                result = await target?.getFormattedNumber();
                break;
            case 'get_profile_pic_url':
                target = await wwebClient.getContactById(data.contactId);
                result = await target?.getProfilePicUrl();
                break;
                
            // --- Call ---
            case 'reject_call':
                target = activeCalls.get(data.callId);
                if (target) {
                    await target.reject();
                    activeCalls.delete(data.callId);
                    result = { success: true };
                } else {
                    throw new Error('Call not found or already ended.');
                }
                break;

            // --- Chat/PrivateChat ---
            case 'clear_messages':
                target = await wwebClient.getChatById(data.chatId);
                result = await target?.clearMessages();
                break;
            case 'clear_state':
                target = await wwebClient.getChatById(data.chatId);
                result = await target?.clearState();
                break;
            case 'delete_chat':
                target = await wwebClient.getChatById(data.chatId);
                result = await target?.delete();
                break;
            case 'get_chat_contact':
                target = await wwebClient.getChatById(data.chatId);
                result = await target?.getContact();
                break;
            case 'send_message':
                result = await wwebClient.sendMessage(data.chatId, data.message);
                break;
            case 'send_media_from_url':
                const mediaFromUrl = await MessageMedia.fromUrl(data.url, { unsafeMime: data.unsafeMime || false });
                result = await wwebClient.sendMessage(data.chatId, mediaFromUrl, { caption: data.caption });
                break;
            case 'send_state_typing':
                target = await wwebClient.getChatById(data.chatId);
                result = await target?.sendStateTyping();
                break;
            case 'sync_history':
                target = await wwebClient.getChatById(data.chatId);
                result = await target?.syncHistory();
                break;

            // --- Client ---
            case 'set_display_name':
                result = await wwebClient.setDisplayName(data.name);
                break;
            case 'set_profile_picture':
                const profilePicMedia = await MessageMedia.fromUrl(data.url);
                result = await wwebClient.setProfilePicture(profilePicMedia);
                break;
            case 'set_status': // client status/about
                result = await wwebClient.setStatus(data.status);
                break;

            // --- Message ---
            case 'delete_message':
                target = await wwebClient.getMessageById(data.messageId);
                result = await target?.delete(data.forEveryone || false);
                break;
            case 'download_media':
                target = await wwebClient.getMessageById(data.messageId);
                if (target?.hasMedia) {
                    result = await target.downloadMedia(); // returns MessageMedia object {mimetype, data, filename}
                } else {
                    throw new Error('Message has no media.');
                }
                break;
            case 'edit_message':
                target = await wwebClient.getMessageById(data.messageId);
                result = await target?.edit(data.newContent);
                break;
            case 'get_message_chat':
                target = await wwebClient.getMessageById(data.messageId);
                result = await target?.getChat();
                break;
            case 'get_message_info':
                target = await wwebClient.getMessageById(data.messageId);
                result = await target?.getInfo();
                break;
            case 'get_message_reactions':
                target = await wwebClient.getMessageById(data.messageId);
                result = await target?.getReactions();
                break;
            case 'react_to_message':
                target = await wwebClient.getMessageById(data.messageId);
                result = await target?.react(data.reaction);
                break;
            case 'reply_to_message':
                target = await wwebClient.getMessageById(data.messageId);
                result = await target?.reply(data.replyContent);
                break;

            default:
                throw new Error('Unknown event type');
        }

        ws.send(JSON.stringify({
            event: `${event}_success`,
            data: result ?? { success: true }
        }));

    } catch (error) {
        console.error(`Error handling event:`, error);
        ws.send(JSON.stringify({
            event: 'error',
            data: { message: error.message, stack: error.stack }
        }));
    }
}

main().catch(console.error);
