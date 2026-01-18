/**
 * CDP Client - Chrome DevTools Protocol interface for Antigravity
 * 
 * Provides:
 * - Screenshot capture (zero-token screen streaming)
 * - Command injection (type into agent input)
 * - Page inspection
 */

const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}`;

/**
 * Get list of available CDP targets (pages/tabs)
 */
export async function getTargets() {
    const response = await fetch(`${CDP_URL}/json/list`);
    return response.json();
}

/**
 * Get CDP version info
 */
export async function getVersion() {
    const response = await fetch(`${CDP_URL}/json/version`);
    return response.json();
}

/**
 * Find the main Antigravity editor page
 */
export async function findEditorTarget() {
    const targets = await getTargets();

    // Look for the main editor window (not launchpad, not devtools)
    const editor = targets.find(t =>
        t.type === 'page' &&
        t.title.includes('Antigravity') &&
        !t.title.includes('Launchpad') &&
        !t.url.includes('devtools')
    );

    return editor || targets.find(t => t.type === 'page');
}

/**
 * Connect to a CDP target via WebSocket
 */
export async function connectToTarget(target) {
    const wsUrl = target.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('No WebSocket URL for target');

    return new Promise((resolve, reject) => {
        // Dynamic import for WebSocket (works in Node)
        import('ws').then(({ default: WebSocket }) => {
            const ws = new WebSocket(wsUrl);
            let messageId = 1;
            const pending = new Map();

            ws.on('open', () => {
                const client = {
                    send: (method, params = {}) => {
                        return new Promise((res, rej) => {
                            const id = messageId++;
                            pending.set(id, { resolve: res, reject: rej });
                            ws.send(JSON.stringify({ id, method, params }));
                        });
                    },
                    close: () => ws.close(),
                    ws
                };
                resolve(client);
            });

            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id && pending.has(msg.id)) {
                    const { resolve, reject } = pending.get(msg.id);
                    pending.delete(msg.id);
                    if (msg.error) reject(new Error(msg.error.message));
                    else resolve(msg.result);
                }
            });

            ws.on('error', reject);
        }).catch(reject);
    });
}

/**
 * Capture screenshot of the current page
 * Returns base64-encoded PNG
 */
export async function captureScreenshot(options = {}) {
    const target = await findEditorTarget();
    if (!target) throw new Error('No editor target found');

    const client = await connectToTarget(target);

    try {
        const result = await client.send('Page.captureScreenshot', {
            format: options.format || 'png',
            quality: options.quality || 80,
            captureBeyondViewport: false
        });

        return result.data; // base64 string
    } finally {
        client.close();
    }
}

/**
 * Get page dimensions
 */
export async function getPageMetrics() {
    const target = await findEditorTarget();
    if (!target) throw new Error('No editor target found');

    const client = await connectToTarget(target);

    try {
        const metrics = await client.send('Page.getLayoutMetrics');
        return metrics;
    } finally {
        client.close();
    }
}

/**
 * Inject text into the agent input field
 */
export async function injectCommand(text) {
    const target = await findEditorTarget();
    if (!target) throw new Error('No editor target found');

    const client = await connectToTarget(target);

    try {
        // First, try to find and focus the input field
        await client.send('Runtime.evaluate', {
            expression: `
                (function() {
                    // Look for common input selectors in VS Code-like editors
                    const selectors = [
                        'textarea.inputarea',
                        'textarea[aria-label*="input"]',
                        'div[contenteditable="true"]',
                        '.monaco-inputbox textarea',
                        'textarea'
                    ];
                    
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el) {
                            el.focus();
                            return { found: true, selector: sel };
                        }
                    }
                    
                    // If no textarea, try to click the input area
                    const inputArea = document.querySelector('.input-area, .chat-input, [class*="input"]');
                    if (inputArea) {
                        inputArea.click();
                        return { found: true, clicked: true };
                    }
                    
                    return { found: false };
                })()
            `,
            returnByValue: true
        });

        // Small delay for focus
        await new Promise(r => setTimeout(r, 100));

        // Type each character
        for (const char of text) {
            await client.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                text: char,
                key: char,
                code: `Key${char.toUpperCase()}`
            });
            await client.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: char,
                code: `Key${char.toUpperCase()}`
            });
        }

        return { success: true, injected: text };
    } finally {
        client.close();
    }
}

/**
 * Inject text and press Enter to submit
 */
export async function injectAndSubmit(text) {
    const target = await findEditorTarget();
    if (!target) throw new Error('No editor target found');

    const client = await connectToTarget(target);

    try {
        // Use insertText for bulk text (more reliable)
        await client.send('Input.insertText', { text });

        // Small delay
        await new Promise(r => setTimeout(r, 50));

        // Press Enter
        await client.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13
        });
        await client.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13
        });

        return { success: true, submitted: text };
    } finally {
        client.close();
    }
}

/**
 * Focus the input area (click to activate)
 */
export async function focusInput() {
    const target = await findEditorTarget();
    if (!target) throw new Error('No editor target found');

    const client = await connectToTarget(target);

    try {
        const result = await client.send('Runtime.evaluate', {
            expression: `
                (function() {
                    // Try multiple strategies to focus input
                    
                    // Strategy 1: Find textarea
                    const textarea = document.querySelector('textarea');
                    if (textarea) {
                        textarea.focus();
                        textarea.click();
                        return { method: 'textarea', success: true };
                    }
                    
                    // Strategy 2: Find contenteditable
                    const editable = document.querySelector('[contenteditable="true"]');
                    if (editable) {
                        editable.focus();
                        editable.click();
                        return { method: 'contenteditable', success: true };
                    }
                    
                    // Strategy 3: Simulate keyboard shortcut Ctrl+L or similar
                    document.body.dispatchEvent(new KeyboardEvent('keydown', {
                        key: 'l',
                        code: 'KeyL',
                        ctrlKey: true,
                        bubbles: true
                    }));
                    
                    return { method: 'keyboard_shortcut', success: true };
                })()
            `,
            returnByValue: true
        });

        return result.result?.value || { success: false };
    } finally {
        client.close();
    }
}

/**
 * Check if CDP is available
 */
export async function isAvailable() {
    try {
        const version = await getVersion();
        return { available: true, browser: version.Browser };
    } catch (e) {
        return { available: false, error: e.message };
    }
}

/**
 * Scrape chat messages from the Antigravity UI
 * Returns array of { role: 'user'|'agent', content: string, timestamp: string }
 */
export async function getChatMessages() {
    const target = await findEditorTarget();
    if (!target) throw new Error('No editor target found');

    const client = await connectToTarget(target);

    try {
        const result = await client.send('Runtime.evaluate', {
            expression: `
                (function() {
                    const messages = [];
                    
                    // Blacklist patterns - things to ignore
                    const blacklist = [
                        /^(gemini|claude|gpt|model|opus|sonnet|flash)/i,
                        /^(pro|low|high|medium|thinking)/i,
                        /^(submit|cancel|dismiss|retry)/i,
                        /^(planning|execution|verification)/i,
                        /^(agent|assistant|user)$/i,
                        /^\\d+:\\d+/,  // timestamps like 3:35 AM
                        /terminated due to error/i,
                        /troubleshooting guide/i,
                        /can plan before executing/i,
                        /deep research.*complex tasks/i,
                        /conversation mode/i,
                        /fast agent/i,
                        /\\(thinking\\)/i,
                        /ask anything/i,
                        /add context/i,
                        /workflows/i,
                        /mentions/i
                    ];
                    
                    function isBlacklisted(text) {
                        const trimmed = text.trim();
                        if (trimmed.length < 20) return true; // Too short
                        if (trimmed.split(' ').length < 4) return true; // Not enough words
                        
                        for (const pattern of blacklist) {
                            if (pattern.test(trimmed)) return true;
                        }
                        return false;
                    }
                    
                    // Look specifically for conversation content
                    // Target the main chat/agent panel area
                    const conversationSelectors = [
                        // Specific conversation containers
                        '.conversation-content',
                        '.agent-response',
                        '.assistant-message',
                        '.user-query',
                        // Monaco editor markers
                        '[data-mode-id] .view-lines',
                        // Fallback - look in right panel
                        '.auxiliary-bar .content',
                        '.panel-content'
                    ];
                    
                    // Try to find conversation elements
                    for (const sel of conversationSelectors) {
                        const els = document.querySelectorAll(sel);
                        for (const el of els) {
                            const text = el.innerText?.trim();
                            if (text && !isBlacklisted(text) && text.length > 30 && text.length < 5000) {
                                // Check if it looks like a conversation message
                                const hasProperSentences = /[.!?]/.test(text);
                                const wordCount = text.split(/\\s+/).length;
                                
                                if (hasProperSentences && wordCount > 5) {
                                    const classStr = (el.className || '').toLowerCase();
                                    let role = 'agent';
                                    if (classStr.includes('user') || classStr.includes('human')) {
                                        role = 'user';
                                    }
                                    
                                    messages.push({
                                        role,
                                        content: text.substring(0, 1500),
                                        timestamp: new Date().toISOString()
                                    });
                                }
                            }
                        }
                        if (messages.length > 0) break;
                    }
                    
                    return { 
                        messages: messages.slice(-20), 
                        count: messages.length,
                        note: 'Use MCP broadcast_interaction for reliable chat streaming'
                    };
                })()
            `,
            returnByValue: true
        });

        return result.result?.value || { messages: [], count: 0 };
    } finally {
        client.close();
    }
}

/**
 * Get the current agent panel/chat content as text
 */
export async function getAgentPanelContent() {
    const target = await findEditorTarget();
    if (!target) throw new Error('No editor target found');

    const client = await connectToTarget(target);

    try {
        const result = await client.send('Runtime.evaluate', {
            expression: `
                (function() {
                    // Look for the agent panel or chat view
                    const panelSelectors = [
                        '.agent-panel',
                        '.chat-panel', 
                        '[class*="agent"]',
                        '[class*="chat-view"]',
                        '.panel.right',
                        '.sidebar-right',
                        '.auxiliary-bar'
                    ];
                    
                    for (const sel of panelSelectors) {
                        const panel = document.querySelector(sel);
                        if (panel) {
                            return {
                                found: true,
                                selector: sel,
                                content: panel.innerText?.substring(0, 5000) || '',
                                html: panel.innerHTML?.substring(0, 10000) || ''
                            };
                        }
                    }
                    
                    // Fallback: get all visible text
                    return {
                        found: false,
                        content: document.body.innerText?.substring(0, 5000) || ''
                    };
                })()
            `,
            returnByValue: true
        });

        return result.result?.value || { found: false, content: '' };
    } finally {
        client.close();
    }
}

/**
 * Get all visible conversation text from the right-side panel/chat area
 * This looks for the actual rendered conversation content
 */
export async function getConversationText() {
    const target = await findEditorTarget();
    if (!target) throw new Error('No editor target found');

    const client = await connectToTarget(target);

    try {
        const result = await client.send('Runtime.evaluate', {
            expression: `
                (function() {
                    // Get text from the right side of the window (where chat typically is)
                    const rightPanel = document.querySelector('.split-view-container .split-view-view:last-child') 
                        || document.querySelector('.editor-group-container + *')
                        || document.querySelector('.auxiliary-bar-content')
                        || document.querySelector('[id*="workbench.panel"]');
                    
                    if (rightPanel) {
                        const text = rightPanel.innerText || '';
                        // Split into potential messages based on patterns
                        const lines = text.split('\\n').filter(l => l.trim().length > 20);
                        
                        return {
                            found: true,
                            rawText: text.substring(0, 8000),
                            lines: lines.slice(0, 50)
                        };
                    }
                    
                    // Try to get any visible markdown/rendered content
                    const markdownContainers = document.querySelectorAll('.rendered-markdown, .markdown-body, [class*="markdown"]');
                    if (markdownContainers.length > 0) {
                        const texts = Array.from(markdownContainers).map(el => el.innerText).filter(t => t.length > 30);
                        return {
                            found: true,
                            source: 'markdown',
                            lines: texts.slice(0, 20)
                        };
                    }
                    
                    return { found: false };
                })()
            `,
            returnByValue: true
        });

        return result.result?.value || { found: false };
    } finally {
        client.close();
    }
}
