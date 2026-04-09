const fs = require('fs');
const path = require('path');
const os = require('os');
const logFile = path.join(os.homedir(), 'error.log'); // Change log file location to user's home directory
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function logError(err, shouldExit = false) {
    const errorMessage = `[${new Date().toISOString()}] ${err.stack || err}\n`;
    logStream.write(errorMessage);
    console.error(errorMessage);
    if (shouldExit) {
        process.exit(1);
    }
}

process.on('uncaughtException', logError);
process.on('unhandledRejection', logError);

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = 3000;

// Increase the payload limit
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const isPkg = true; // typeof process.pkg !== 'undefined';

// Read chrome.exe path from MyWhatsappConsole.ini in the same directory as the executable
let chromiumPath;
let enableIncomingMessage = false; // Default: don't save incoming messages
let enableIncomingMessageMedia = false;
let enableAntiBan = false;

if (isPkg) {
    const iniPath = path.join(__dirname, 'MyWhatsappConsole.ini');
    console.log('Reading MyWhatsappConsole.ini from:', iniPath);

    try {
        const iniContent = fs.readFileSync(iniPath, 'utf-8').trim();
        // Parse the line starting with "ChromePath ="
        const match = iniContent.match(/^ChromePath\s*=\s*(.+)$/m);
        if (!match || !match[1]) {
            throw new Error('MyWhatsappConsole.ini does not contain a valid ChromePath.');
        }
        chromiumPath = match[1].trim();
        if (!chromiumPath) {
            throw new Error('ChromePath in MyWhatsappConsole.ini is empty.');
        }
        chromiumPath = path.join(__dirname, chromiumPath);

        // Parse IncomingMessage setting (case-insensitive, trims whitespace)
        const incomingMatch = iniContent.match(/^IncomingMessage\s*=\s*(.+)$/im);
        if (incomingMatch && incomingMatch[1].trim().toLowerCase() === 'true') {
            enableIncomingMessage = true;        
            console.log('Incoming Message Enabled');
        }
		
        // Parse IncomingMessageMedia setting (case-insensitive, trims whitespace)
        const incomingMediaMatch = iniContent.match(/^IncomingMessageMedia\s*=\s*(.+)$/im);
        if (incomingMediaMatch && incomingMediaMatch[1].trim().toLowerCase() === 'true') {
            enableIncomingMessageMedia = true;        
            console.log('Incoming Media Enabled');
        }

        // Parse AntiBan setting
        const antiBanMatch = iniContent.match(/^AntiBan\s*=\s*(.+)$/im);
        if (antiBanMatch && antiBanMatch[1].trim().toLowerCase() === 'true') {
            enableAntiBan = true;        
            console.log('AntiBan Mode Enabled (queue + typing + sendSeen)');
        }
    } catch (err) {
        logError(`Failed to read MyWhatsappConsole.ini: ${err.message}`);
    }
} else {
    chromiumPath = puppeteer.executablePath();
}

// write in the console the path of the chromium
console.log('Chromium path:', chromiumPath);

let client;
let isClientReady = false;
let clientReadyResolve = null;

function waitForClientReady() {
    if (isClientReady) return Promise.resolve();
    return new Promise(resolve => { clientReadyResolve = resolve; });
}

function setClientReady() {
    isClientReady = true;
    if (clientReadyResolve) {
        clientReadyResolve();
        clientReadyResolve = null;
    }
}

function createClient() {
    isClientReady = false;
    clientReadyResolve = null;
    if (client) {
        try { client.destroy(); } catch (e) {}
        client = null;
    }

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: chromiumPath,
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--start-minimized'
            ]
        }
    });

    client.on('qr', async () => {
        console.log('QR code received, scan it with WhatsApp.');
    });

    client.on('authenticated', () => {
        isAuthenticated = true;
        console.log('Client authenticated.');
    });

    client.on('auth_failure', msg => {
        console.error('Authentication failure:', msg);
    });

    client.on('disconnected', reason => {
        console.error('WhatsApp client disconnected:', reason);
        isClientReady = false;
        setTimeout(() => {
            console.log('Restarting WhatsApp client...');
            createClient();
        }, 3000);
    });

    client.initialize();

    // Listen for Puppeteer browser disconnect and minimize if not authenticated
    client.once('ready', async () => {
        setClientReady();
        console.log('Client ready — coda messaggi attiva.');
        try {
            const browser = client.pupBrowser;            
            if (browser) {
                const pages = await browser.pages();
                if (pages[0]) {
                    const session = await pages[0].target().createCDPSession();
                    await session.send('Browser.setWindowBounds', {
                        windowId: (await session.send('Browser.getWindowForTarget')).windowId,
                        bounds: { windowState: 'minimized' }
                    });
                }
            }    

//// --- INIZIO WORKAROUND PER ISSUE #3834 (No LID for user) ---
//            await client.pupPage.evaluate(() => {
//                if (window.WWebJS && window.WWebJS.injectToFunction) {
//                    try {
//                        window.WWebJS.injectToFunction(
//                            { module: 'WAWebLid1X1MigrationGating', function: 'Lid1X1MigrationUtils.isLidMigrated' },
//                            () => false
//                        );
//                        window.WWebJS.injectToFunction(
//                            { module: 'WAWebLid1X1MigrationGating', function: 'shouldHaveAccountLid' },
//                            () => false
//                        );
//                        console.log('Workaround "No LID for user" applicato con successo nella pagina web.');
//                    } catch (e) {
//                        console.warn('Errore nell\'applicazione del workaround LID:', e);
//                    }
//                }
//            });            
            if (browser) {
                browser.once('disconnected', () => {
                    console.error('Chromium browser disconnected. Restarting WhatsApp client...');
                    setTimeout(() => {
                        createClient();
                    }, 3000);
                });
            }
        } catch (e) {
            console.error('Error setting up browser disconnect handler:', e);
        }
    });
}

// Start the client for the first time
createClient();

// Funzione aggressiva per forzare il caching del LID
async function resolveAndCacheContact(waClient, chatId) {
    try {
        // Se sembra un LID mascherato da @c.us (più di 15 cifre)
        const digits = chatId.replace('@c.us', '').replace('@lid', '');
        if (digits.length > 15) {
            const lidId = digits + '@lid';
            console.log(`⚠️ Numero sospetto, trattato come LID: ${lidId}`);
            try {
                const lidAndPhone = await waClient.getContactLidAndPhone(lidId);
                if (lidAndPhone?.[0]?.pn) {
                    console.log(`LID risolto → ${lidAndPhone[0].pn}`);
                    // Ora invia usando il LID, non il numero
                    return lidAndPhone[0].lid; // WhatsApp vuole il @lid per inviare
                }
            } catch (e) {
                console.warn(`⚠️ getContactLidAndPhone fallito per ${lidId}:`, e.message);
            }
        }

        // Caso normale
        const numberId = await waClient.getNumberId(chatId);
        if (!numberId) {
            console.error(`Il numero ${chatId} non è registrato su WhatsApp.`);
            return chatId;
        }

        const serialized = numberId._serialized;
        await waClient.getContactById(serialized);

        try {
            await waClient.getContactLidAndPhone(serialized);
        } catch (e) {
            console.warn(`⚠️ getContactLidAndPhone fallito per ${serialized}:`, e.message);
        }

        return serialized;
    } catch (err) {
        console.warn(`⚠️ Errore nel pre-fetch del contatto per ${chatId}:`, err.message);
        return chatId;
    }
}

// ============================================================
// MESSAGE QUEUE SYSTEM - Anti-ban: delay + typing + sendSeen
// ============================================================
const messageQueue = [];
let isProcessingQueue = false;

function randomDelay(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function simulateTyping(chatId, durationMs) {
    try {
        // sendSeen — segna i messaggi come letti
        try {
            await client.sendSeen(chatId);
        } catch (e) {
            console.warn('⚠️ sendSeen fallito:', e.message);
        }

        // Ottieni la chat per sendStateTyping
        let chat;
        try {
            chat = await client.getChatById(chatId);
        } catch (e) {
            console.warn('⚠️ getChatById fallito:', e.message);
            // fallback: aspetta senza typing
            await sleep(durationMs);
            return;
        }
        if (!chat) {
            await sleep(durationMs);
            return;
        }

        // Simula typing a intervalli durante il delay
        const typingInterval = 4000;
        const startTime = Date.now();

        while (Date.now() - startTime < durationMs) {
            try {
                await chat.sendStateTyping();
            } catch (e) {
                console.warn('⚠️ sendStateTyping fallito:', e.message);
            }
            const remaining = durationMs - (Date.now() - startTime);
            if (remaining <= 0) break;
            await sleep(Math.min(typingInterval, remaining));
        }

        try {
            await chat.clearState();
        } catch (e) {
            console.warn('⚠️ clearState fallito:', e.message);
        }
    } catch (err) {
        console.warn('⚠️ Errore simulazione typing:', err.message);
    }
}

function enqueueMessage(job) {
    messageQueue.push(job);
    console.log(`📨 Messaggio accodato per ${job.chatId} (coda: ${messageQueue.length})`);
    processQueue();
}

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        // Attendi che il client sia pronto
        if (!isClientReady) {
            console.log('⏸️ Client non pronto, attendo ready...');
            await waitForClientReady();
            console.log('▶️ Client pronto, riprendo...');
        }

        const job = messageQueue.shift();

        try {
            // Risolvi il contatto una volta
            let resolvedChatId;
            try {
                resolvedChatId = await resolveAndCacheContact(client, job.chatId);
            } catch (e) {
                console.warn('⚠️ Resolve contatto fallito, uso ID originale:', e.message);
                resolvedChatId = job.chatId;
            }

            // Delay casuale 20-40 secondi
            const delayMs = randomDelay(20000, 40000);
            console.log(`⏳ Delay ${(delayMs / 1000).toFixed(1)}s per ${resolvedChatId}...`);

            // Simula typing durante il delay
            await simulateTyping(resolvedChatId, delayMs);

            // Invia il messaggio passando l'ID risolto
            await job.sendFn(resolvedChatId);
            console.log(`✅ Messaggio inviato a ${resolvedChatId}`);
        } catch (error) {
            console.error(`❌ Errore invio a ${job.chatId}:`, error.message || error);
            logError(error);
        }
    }

    isProcessingQueue = false;
}

// Route to send text messages
app.post('/send-text-message', async (req, res) => {
    const { from, body } = req.body;
    if (!from || !body) return res.status(400).send('Invalid request');

    if (enableAntiBan) {
        enqueueMessage({
            chatId: from,
            sendFn: async (resolvedId) => {
                await client.sendMessage(resolvedId, body);
            }
        });
        res.status(200).send('Message queued');
    } else {
        try {
            const validFrom = await resolveAndCacheContact(client, from);
            await client.sendMessage(validFrom, body);
            res.status(200).send('Message event triggered');
        } catch (error) {
            logError(error);
            res.status(500).send('Error sending text message');
        }
    }
});

// Route to send media messages
app.post('/send-media-message', async (req, res) => {
    const { from, data, filename, filesize, mimetype } = req.body;
    if (!from || !data || !mimetype) return res.status(400).send('Invalid request');

    if (enableAntiBan) {
        enqueueMessage({
            chatId: from,
            sendFn: async (resolvedId) => {
                const media = new MessageMedia(mimetype, data, filename, filesize);
                await client.sendMessage(resolvedId, media);
            }
        });
        res.status(200).send('Media message queued');
    } else {
        try {
            const validFrom = await resolveAndCacheContact(client, from);
            const media = new MessageMedia(mimetype, data, filename, filesize);
            await client.sendMessage(validFrom, media);
            res.status(200).send('Media message sent');
        } catch (error) {
            logError(error);
            res.status(500).send('Error sending media message');
        }
    }
});

// Route to send text, media, or both
app.post('/send-message', async (req, res) => {
    const { from, text, data, filename, filesize, mimetype } = req.body;
    if (!from) return res.status(400).send('Invalid request: "from" is required');
    if (!text && !(data && mimetype)) return res.status(400).send('Invalid request: "text" or "data" and "mimetype" are required');

    if (enableAntiBan) {
        enqueueMessage({
            chatId: from,
            sendFn: async (resolvedId) => {
                if (text && data && mimetype) {
                    const media = new MessageMedia(mimetype, data, filename, filesize);
                    await client.sendMessage(resolvedId, text);
                    await sleep(randomDelay(1500, 3000));
                    await client.sendMessage(resolvedId, media);
                } else if (text) {
                    await client.sendMessage(resolvedId, text);
                } else {
                    const media = new MessageMedia(mimetype, data, filename, filesize);
                    await client.sendMessage(resolvedId, media);
                }
            }
        });
        res.status(200).send('Message queued');
    } else {
        try {
            const validFrom = await resolveAndCacheContact(client, from);
            if (text && data && mimetype) {
                const media = new MessageMedia(mimetype, data, filename, filesize);
                await client.sendMessage(validFrom, text);
                await client.sendMessage(validFrom, media);
            } else if (text) {
                await client.sendMessage(validFrom, text);
            } else {
                const media = new MessageMedia(mimetype, data, filename, filesize);
                await client.sendMessage(validFrom, media);
            }
            res.status(200).send('Message sent');
        } catch (error) {
            logError(error);
            res.status(500).send('Error sending message');
        }
    }
});

// Route per verificare lo stato della coda
app.get('/queue-status', (req, res) => {
    res.json({
        queueLength: messageQueue.length,
        isProcessing: isProcessingQueue
    });
});

client.on('message', async msg => {
    if (!enableIncomingMessage) return;

    if (msg.type !== 'chat') return;

    if (!enableIncomingMessageMedia && msg.hasMedia) return;

    try {
        if (msg.from === 'status@broadcast') return;

        const isGroupMsg = msg.from.endsWith('@g.us');

        // 🔑 Risoluzione reale del numero (chat private + gruppi + LID)
        const resolvedFrom = await resolvePhoneFromMessage(msg, client);

        const messageData = {
            from: resolvedFrom,          // 👈 QUI numero reale
            to: msg.to,
            body: msg.body,
            type: msg.type,
            timestamp: msg.timestamp,
            id: msg.id ? msg.id._serialized : undefined,
            isGroupMsg,
            //author: msg.author,          // opzionale
            deviceType: msg.deviceType,
            hasMedia: msg.hasMedia || false,
            mediaFile: null
        };

        // Create a unique filename using timestamp and message id
        const now = new Date();
        const timestamp = now.toISOString().replace(/[-:.TZ]/g, '');
        const uniqueId = msg.id ? msg.id.id : Math.floor(Math.random() * 1000000);

        // Save media if present (audio, video, image, document, etc.)
        if (enableIncomingMessageMedia && msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media) {
                // Determine extension from mimetype
                let ext = '';
                if (media.mimetype) {
                    const match = media.mimetype.match(/\/([a-z0-9]+)/i);
                    ext = match ? '.' + match[1] : '';
                    if (media.mimetype === 'image/jpeg') {
                        ext = '.jpg';
                    }
                }
                // Fallback for known types
                if (!ext && msg.type === 'audio') ext = '.ogg';
                if (!ext && msg.type === 'video') ext = '.mp4';
                if (!ext && msg.type === 'image') ext = '.png';

                const mediaFilename = `media_${timestamp}_${uniqueId}${ext}`;
                const buffer = Buffer.from(media.data, 'base64');
                fs.writeFileSync(mediaFilename, buffer);
                messageData.mediaFile = mediaFilename;
            }
        }

        // Save message metadata as JSON
        const jsonFilename = `incoming_${timestamp}_${uniqueId}.json`;
        fs.writeFileSync(jsonFilename, JSON.stringify(messageData, null, 2), 'utf-8');
        console.log(`Message saved: ${jsonFilename}`);
    } catch (err) {
        console.log('Error processing incoming message:');
        logError(err);
    }
});


async function resolvePhoneFromMessage(msg, client) {
    try {
        // Caso gruppo → usa author
        if (msg.from.endsWith('@g.us') && msg.author) {
            const contact = await client.getContactById(msg.author);
            if (contact?.number) {
                return contact.number + '@c.us';
            }
        }

        // Caso LID (esplicito nel from o nascosto nell'id messaggio)
        const isLidFrom = msg.from.endsWith('@lid');
        const isLidInId = msg.id?._serialized?.includes('@lid');

        if (isLidFrom || isLidInId) {
            // Determina quale LID usare
            let lidId = isLidFrom ? msg.from : null;
            if (!lidId && isLidInId) {
                const lidMatch = msg.id._serialized.match(/_([\d]+@lid)_/);
                if (lidMatch) lidId = lidMatch[1];
            }

            if (lidId) {
                try {
                    const lidAndPhone = await client.getContactLidAndPhone(lidId);
                    if (lidAndPhone?.[0]?.pn) {
                        return lidAndPhone[0].pn; // già in formato 393457673422@c.us
                    }
                } catch (e) {
                    console.warn(`⚠️ getContactLidAndPhone fallito per ${lidId}:`, e.message);
                }
            }
        }

        // Caso normale
        return msg.from;
    } catch (err) {
        console.warn('⚠️ Unable to resolve phone from LID:', err.message);
        return msg.from;
    }
}


// Start the server and handle port in use error
const server = app.listen(port, () => {
    console.log(`MyWhatsApp is running on port ${port}!`);
});

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Exiting process.`);
        process.exit(1);
    } else {
        console.error(`Server error: ${error.message}`);
    }
});

// Cleanup function to close the server and browser
const cleanup = async () => {
    console.log('Cleaning up...');
    if (server) {
        server.close(() => {
            console.log('Server closed.');
        });
    }
    if (client && client.pupBrowser) {
        await client.pupBrowser.close();
        console.log('Browser closed.');
    }
    logStream.close();
    process.exit(0);
};

// Handle termination signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGHUP', cleanup);
process.on('exit', cleanup);