const fs = require('fs');
const WebSocket = require('ws');
const pako = require('pako');
const readline = require('readline');

// Mock browser globals required by hslib.js
global.window = global;
global.WebSocket = WebSocket;
global.pako = pako;
global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
global.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
global.document = {
    getElementsByTagName: () => [{ appendChild: () => {} }],
    createElement: () => ({})
};

// Disable internal logs of hslib to prevent polluting stdout
global.HSD_Flag = false;
global.HSID_Flag = false;

// Load the library
const candidatePaths = [
    './hslib.js',
    '../kotak-api-docs/Websocket/hslib.js',
    '../../kotak-api-docs/Websocket/hslib.js',
    '../Websocket/hslib.js',
];
let hslibCode = null;
for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
        hslibCode = fs.readFileSync(p, 'utf8');
        break;
    }
}
if (!hslibCode) {
    throw new Error('hslib.js not found in candidate paths: ' + candidatePaths.join(', '));
}
eval(hslibCode);

let wsClient = null;
let heartbeatInterval = null;
let watchdogInterval = null;
let lastMessageTime = Date.now();

// Queue for subscribe messages that arrive before wsClient.onopen fires.
// Drained immediately once the connection is established.
let wsOpen = false;
let pendingSubscriptions = [];

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
        const msg = JSON.parse(line);
        handleMessage(msg);
    } catch (e) {
        console.error("Failed to parse JSON line:", e.message);
    }
});

function handleMessage(msg) {
    if (msg.action === 'connect') {
        // Reset state for this new connection
        wsOpen = false;
        pendingSubscriptions = [];
        lastMessageTime = Date.now();

        const url = "wss://mlhsm.kotaksecurities.com";
        wsClient = new HSWebSocket(url);
        
        wsClient.onopen = function () {
            wsOpen = true;
            lastMessageTime = Date.now();

            // Send connection request
            let jObj = {
                "Authorization": msg.auth,
                "Sid": msg.sid,
                "type": "cn"
            };
            wsClient.send(JSON.stringify(jObj));
            
            // Start heartbeat
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
                wsClient.send(JSON.stringify({ type: "ti", scrips: "" }));
            }, 30000);

            // Start watchdog (if no message received for 30 seconds during active connection, restart)
            if (watchdogInterval) clearInterval(watchdogInterval);
            watchdogInterval = setInterval(() => {
                if (wsOpen && Date.now() - lastMessageTime > 30000) {
                    console.error("Watchdog timeout: No data received from Kotak WebSocket for 30s. Exiting bridge to force restart...");
                    console.log(JSON.stringify({ event: "error", message: "Watchdog timeout: no data for 30s" }));
                    process.exit(1);
                }
            }, 5000);

            // Initially subscribe if scrips are provided
            if (msg.scrips) {
                sendSubscriptions(msg.scrips, wsClient, msg.type);
            }

            // Drain any subscribe messages that arrived before open
            if (pendingSubscriptions.length > 0) {
                console.error(`Draining ${pendingSubscriptions.length} queued subscription(s)`);
                for (const pending of pendingSubscriptions) {
                    sendSubscriptions(pending.scrips, wsClient, pending.type);
                }
                pendingSubscriptions = [];
            }
        };

        wsClient.onclose = function (event) {
            wsOpen = false;
            pendingSubscriptions = [];
            console.log(JSON.stringify({ event: "closed", code: event ? event.code : null, reason: event ? event.reason : null }));
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            if (watchdogInterval) clearInterval(watchdogInterval);
            process.exit(1);
        };

        wsClient.onerror = function (err) {
            wsOpen = false;
            pendingSubscriptions = [];
            console.log(JSON.stringify({ event: "error", message: err ? (err.message || err.toString()) : "unknown error" }));
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            if (watchdogInterval) clearInterval(watchdogInterval);
            process.exit(1);
        };

        wsClient.onmessage = function (data) {
            lastMessageTime = Date.now();
            let parsed;
            if (typeof data === 'string') {
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    parsed = data;
                }
            } else {
                parsed = data;
            }

            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    normalizeTick(item);
                }
            } else if (parsed && typeof parsed === 'object') {
                normalizeTick(parsed);
            }

            console.log(JSON.stringify({ event: "data", data: parsed }));
        };
    } else if (msg.action === 'subscribe') {
        if (wsClient) {
            if (wsOpen) {
                try {
                    sendSubscriptions(msg.scrips, wsClient, msg.type);
                } catch (e) {
                    console.log(JSON.stringify({ event: "error", message: `subscribe failed: ${e.message}` }));
                }
            } else {
                // Connection not open yet — queue for drain in onopen
                pendingSubscriptions.push({ scrips: msg.scrips, type: msg.type });
            }
        }
    } else if (msg.action === 'close') {
        if (wsClient) {
            wsClient.close();
        }
        process.exit(0);
    }
}

function isIndexScrip(scrip) {
    const parts = String(scrip).trim().split('|');
    const tokenOrName = parts.length > 1 ? parts[1].trim() : parts[0].trim();
    return !/^\d+$/.test(tokenOrName);
}

function sendSubscriptions(scripsStr, ws, explicitType) {
    if (!scripsStr || !ws) return;
    const scrips = String(scripsStr).split(/[,&]/).map(s => s.trim()).filter(Boolean);
    if (scrips.length === 0) return;

    if (explicitType) {
        const formatted = scrips.join('&');
        ws.send(JSON.stringify({ type: explicitType, scrips: formatted, channelnum: 1 }));
        return;
    }

    const indexScrips = [];
    const marketScrips = [];

    for (const s of scrips) {
        if (isIndexScrip(s)) {
            indexScrips.push(s);
        } else {
            marketScrips.push(s);
        }
    }

    if (marketScrips.length > 0) {
        const subObj = {
            "type": "mws",
            "scrips": marketScrips.join('&'),
            "channelnum": 1
        };
        try {
            ws.send(JSON.stringify(subObj));
        } catch (e) {
            console.error(`Failed to send mws subscription: ${e.message}`);
        }
    }

    if (indexScrips.length > 0) {
        const subObj = {
            "type": "ifs",
            "scrips": indexScrips.join('&'),
            "channelnum": 1
        };
        try {
            ws.send(JSON.stringify(subObj));
        } catch (e) {
            console.error(`Failed to send ifs subscription: ${e.message}`);
        }
    }
}

function normalizeTick(item) {
    if (!item || typeof item !== 'object') return;
    if (item.iv !== undefined && item.ltp === undefined) {
        item.ltp = item.iv;
    }
    if (item.ic !== undefined && item.c === undefined) {
        item.c = item.ic;
    }
    if (item.openingPrice !== undefined && item.op === undefined) {
        item.op = item.openingPrice;
    }
    if (item.highPrice !== undefined && item.h === undefined) {
        item.h = item.highPrice;
    }
    if (item.lowPrice !== undefined && item.lo === undefined) {
        item.lo = item.lowPrice;
    }
    if ((!item.tk || !item.e) && item.name) {
        const parts = item.name.split('|');
        if (parts.length >= 3) {
            if (!item.e) item.e = parts[1];
            if (!item.tk) item.tk = parts.slice(2).join('|');
        } else if (parts.length === 2) {
            if (!item.e) item.e = parts[0];
            if (!item.tk) item.tk = parts[1];
        }
    }
}
