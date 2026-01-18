#!/usr/bin/env node
/**
 * Antigravity Mobile Bridge - HTTP Server
 * 
 * Features:
 * - CDP screenshot streaming (zero-token capture)
 * - CDP command injection (control agent from mobile)
 * - WebSocket real-time updates
 * - Live chat view replication
 * 
 * Usage: node http-server.mjs
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import * as CDP from './cdp-client.mjs';
import * as ChatStream from './chat-stream.mjs';
import * as QuotaService from './quota-service.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Configuration
// ============================================================================
const HTTP_PORT = 3001;
const DATA_DIR = join(__dirname, 'data');
const MESSAGES_FILE = join(DATA_DIR, 'messages.json');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
}

// ============================================================================
// Storage
// ============================================================================
let messages = [];
let inbox = [];

function loadMessages() {
    try {
        if (existsSync(MESSAGES_FILE)) {
            messages = JSON.parse(readFileSync(MESSAGES_FILE, 'utf-8'));
        }
    } catch (e) {
        messages = [];
    }
}

function saveMessages() {
    try {
        if (messages.length > 500) messages = messages.slice(-500);
        writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
    } catch (e) { }
}

loadMessages();

// ============================================================================
// WebSocket Clients
// ============================================================================
const clients = new Set();

function broadcast(event, data) {
    const message = JSON.stringify({ event, data, ts: new Date().toISOString() });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ============================================================================
// HTTP Server
// ============================================================================
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ============================================================================
// CDP Endpoints - Screenshot & Command Injection
// ============================================================================

// Check CDP status
app.get('/api/cdp/status', async (req, res) => {
    try {
        const status = await CDP.isAvailable();
        res.json(status);
    } catch (e) {
        res.json({ available: false, error: e.message });
    }
});

// Get available CDP targets
app.get('/api/cdp/targets', async (req, res) => {
    try {
        const targets = await CDP.getTargets();
        res.json({ targets });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Capture screenshot
app.get('/api/cdp/screenshot', async (req, res) => {
    try {
        const format = req.query.format || 'png';
        const quality = parseInt(req.query.quality) || 80;

        const base64 = await CDP.captureScreenshot({ format, quality });

        // Return as image
        if (req.query.raw === 'true') {
            const buffer = Buffer.from(base64, 'base64');
            res.set('Content-Type', `image/${format}`);
            res.set('Cache-Control', 'no-cache');
            res.send(buffer);
        } else {
            res.json({
                success: true,
                format,
                data: base64,
                dataUrl: `data:image/${format};base64,${base64}`
            });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Screenshot as raw image (for <img> src)
app.get('/api/cdp/screen.png', async (req, res) => {
    try {
        const base64 = await CDP.captureScreenshot({ format: 'png', quality: 90 });
        const buffer = Buffer.from(base64, 'base64');
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(buffer);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Inject command (type text)
app.post('/api/cdp/inject', async (req, res) => {
    try {
        const { text, submit } = req.body;
        if (!text) return res.status(400).json({ error: 'Text required' });

        let result;
        if (submit) {
            result = await CDP.injectAndSubmit(text);
        } else {
            result = await CDP.injectCommand(text);
        }

        // Log to messages
        messages.push({
            type: 'mobile_command',
            content: text,
            timestamp: new Date().toISOString()
        });
        saveMessages();
        broadcast('mobile_command', { text, submitted: !!submit });

        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Focus input area
app.post('/api/cdp/focus', async (req, res) => {
    try {
        const result = await CDP.focusInput();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get live chat messages from IDE
app.get('/api/cdp/chat', async (req, res) => {
    try {
        const result = await CDP.getChatMessages();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message, messages: [] });
    }
});

// Get agent panel content
app.get('/api/cdp/panel', async (req, res) => {
    try {
        const result = await CDP.getAgentPanelContent();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get conversation text from the IDE panel
app.get('/api/cdp/conversation', async (req, res) => {
    try {
        const result = await CDP.getConversationText();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// Live Chat Stream (captures #cascade element from webview)
// ============================================================================

// Get live chat snapshot
app.get('/api/chat/snapshot', async (req, res) => {
    try {
        const snapshot = await ChatStream.getChatSnapshot();
        if (snapshot) {
            res.json(snapshot);
        } else {
            res.status(503).json({ error: 'No chat found', messages: [] });
        }
    } catch (e) {
        res.status(500).json({ error: e.message, messages: [] });
    }
});

// Start chat stream
app.post('/api/chat/start', async (req, res) => {
    try {
        const result = await ChatStream.startChatStream((chat) => {
            // Broadcast chat updates to WebSocket clients
            broadcast('chat_update', {
                messageCount: chat.messageCount,
                messages: chat.messages,
                timestamp: new Date().toISOString()
            });
        }, 2000);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Stop chat stream
app.post('/api/chat/stop', (req, res) => {
    ChatStream.stopChatStream();
    res.json({ success: true });
});

// Check stream status
app.get('/api/chat/status', (req, res) => {
    res.json({ streaming: ChatStream.isStreaming() });
});

// ============================================================================
// Quota Endpoints - Model quota data from Antigravity
// ============================================================================

// Get model quota data
app.get('/api/quota', async (req, res) => {
    try {
        const quota = await QuotaService.getQuota();
        res.json(quota);
    } catch (e) {
        res.status(500).json({ available: false, error: e.message, models: [] });
    }
});

// Check quota service availability
app.get('/api/quota/status', async (req, res) => {
    try {
        const status = await QuotaService.isAvailable();
        res.json(status);
    } catch (e) {
        res.json({ available: false, error: e.message });
    }
});

// ============================================================================
// Message Endpoints
// ============================================================================

// Broadcast a message
app.post('/api/broadcast', (req, res) => {
    const { type, content, context_summary, timestamp } = req.body;

    const msg = {
        type: type || 'agent',
        content: content || '',
        context_summary,
        timestamp: timestamp || new Date().toISOString()
    };

    messages.push(msg);
    saveMessages();
    broadcast('message', msg);

    console.log(`📡 [${type}] ${content.substring(0, 60)}...`);

    res.json({ success: true, clients: clients.size });
});

// Get messages (called by mobile UI)
app.get('/api/messages', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json({ messages: messages.slice(-limit), count: messages.length });
});

// Add message to inbox (called by mobile UI)
app.post('/api/inbox', (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    inbox.push({
        content: message,
        from: 'mobile',
        timestamp: new Date().toISOString()
    });

    broadcast('inbox_updated', { count: inbox.length });
    console.log(`📥 [INBOX] ${message.substring(0, 50)}...`);

    res.json({ success: true, inbox_count: inbox.length });
});

// Read inbox
app.get('/api/inbox/read', (req, res) => {
    const result = { messages: [...inbox], count: inbox.length };
    inbox = []; // Clear after reading
    res.json(result);
});

// Clear all messages
app.post('/api/messages/clear', (req, res) => {
    messages = [];
    saveMessages();
    broadcast('messages_cleared', {});
    res.json({ success: true });
});

// Status
app.get('/api/status', async (req, res) => {
    let cdpStatus = { available: false };
    try {
        cdpStatus = await CDP.isAvailable();
    } catch (e) { }

    res.json({
        ok: true,
        clients: clients.size,
        inbox_count: inbox.length,
        message_count: messages.length,
        cdp: cdpStatus
    });
});

// ============================================================================
// WebSocket
// ============================================================================
wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`🔌 Client connected. Total: ${clients.size}`);

    // Send history
    ws.send(JSON.stringify({
        event: 'history',
        data: { messages: messages.slice(-50) },
        ts: new Date().toISOString()
    }));

    // Handle messages from mobile
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.action === 'inject') {
                // CDP command injection
                const result = await CDP.injectAndSubmit(msg.text);
                ws.send(JSON.stringify({ event: 'inject_result', data: result }));
            } else if (msg.action === 'screenshot') {
                // Request screenshot
                const base64 = await CDP.captureScreenshot();
                ws.send(JSON.stringify({ event: 'screenshot', data: { image: base64 } }));
            }
        } catch (e) {
            ws.send(JSON.stringify({ event: 'error', data: { message: e.message } }));
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`🔌 Client disconnected. Total: ${clients.size}`);
    });
});

// ============================================================================
// Start
// ============================================================================
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════════════════════╗
║       📱 Antigravity Mobile Bridge                     ║
╠════════════════════════════════════════════════════════╣
║  Mobile UI:    http://localhost:${HTTP_PORT}                   ║
║  Screenshot:   http://localhost:${HTTP_PORT}/api/cdp/screen.png║
║  API Status:   http://localhost:${HTTP_PORT}/api/status        ║
╚════════════════════════════════════════════════════════╝
  `);
});
