/**
 * Live Chat Stream - Captures the Antigravity chat via CDP
 * 
 * Based on Antigravity-Shit-Chat-master approach:
 * - Finds execution contexts in webviews
 * - Locates the #cascade element (chat container)
 * - Captures and streams HTML changes
 */

import WebSocket from 'ws';

const CDP_PORTS = [9222, 9000, 9001, 9002, 9003];

// State
let connection = null;
let onChatUpdate = null;
let pollInterval = null;
let lastHash = null;

/**
 * Simple hash function
 */
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash = hash & hash;
    }
    return hash.toString(36);
}

/**
 * Find CDP workbench targets
 */
async function findTargets() {
    const targets = [];

    for (const port of CDP_PORTS) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
                signal: AbortSignal.timeout(2000)
            });
            const list = await res.json();

            // Look for workbench pages
            const workbenches = list.filter(t =>
                t.url?.includes('workbench.html') ||
                t.title?.includes('Antigravity') ||
                t.type === 'page'
            );

            workbenches.forEach(t => targets.push({ ...t, port }));
        } catch (e) { /* port not available */ }
    }

    return targets;
}

/**
 * Connect to CDP and track execution contexts
 */
async function connectCDP(wsUrl) {
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });

    let idCounter = 1;
    const contexts = [];
    let cascadeContextId = null;

    // Call CDP method
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg) => {
            const data = JSON.parse(msg.toString());
            if (data.id === id) {
                ws.off('message', handler);
                if (data.error) reject(new Error(data.error.message));
                else resolve(data.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });

    // Track execution contexts
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
                if (idx !== -1) contexts.splice(idx, 1);
            }
        } catch (e) { }
    });

    // Enable runtime to receive context events
    await call('Runtime.enable', {});
    await new Promise(r => setTimeout(r, 500)); // Let contexts load

    return { ws, call, contexts, getCascadeContextId: () => cascadeContextId, setCascadeContextId: (id) => cascadeContextId = id };
}

/**
 * Find the context that contains #cascade (the chat element)
 */
async function findCascadeContext(cdp) {
    const SCRIPT = `(() => {
        const cascade = document.getElementById('cascade');
        if (!cascade) return { found: false };
        return { 
            found: true,
            hasContent: cascade.children.length > 0
        };
    })()`;

    // Try cached context first
    if (cdp.getCascadeContextId()) {
        try {
            const res = await cdp.call('Runtime.evaluate', {
                expression: SCRIPT,
                returnByValue: true,
                contextId: cdp.getCascadeContextId()
            });
            if (res.result?.value?.found) {
                return cdp.getCascadeContextId();
            }
        } catch (e) {
            cdp.setCascadeContextId(null);
        }
    }

    // Search all contexts
    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call('Runtime.evaluate', {
                expression: SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });
            if (result.result?.value?.found) {
                cdp.setCascadeContextId(ctx.id);
                return ctx.id;
            }
        } catch (e) { }
    }

    return null;
}

/**
 * Capture the chat HTML + CSS from #cascade
 * Returns raw HTML with CSS to preserve exact IDE styling
 */
async function captureChat(cdp, contextId) {
    const SCRIPT = `(() => {
        const cascade = document.getElementById('cascade');
        if (!cascade) return { error: 'cascade not found' };
        
        // --- PREPARE CLONE ---
        
        // Handle Terminal Canvas elements (xterm.js uses WebGL which can't be captured easily)
        // xterm.js has an accessibility layer that contains the actual text
        const terminalContainers = cascade.querySelectorAll('.xterm, [class*="terminal"], [class*="Terminal"]');
        const terminalTexts = [];
        
        terminalContainers.forEach((container, i) => {
            try {
                let text = '';
                
                // Priority 1: Look for xterm accessibility layer (has actual text)
                const accessibilityLayer = container.querySelector('.xterm-accessibility, [class*="accessibility"]');
                if (accessibilityLayer) {
                    const rows = accessibilityLayer.querySelectorAll('[role="listitem"], div');
                    const lines = [];
                    rows.forEach(row => {
                        const rowText = row.textContent;
                        if (rowText && rowText.trim() && !rowText.includes('{') && !rowText.includes(':')) {
                            lines.push(rowText);
                        }
                    });
                    text = lines.join('\\n');
                }
                
                // Priority 2: Look for xterm-rows (visible text layer)
                if (!text.trim()) {
                    const rowsLayer = container.querySelector('.xterm-rows');
                    if (rowsLayer) {
                        const rows = rowsLayer.querySelectorAll('div > span');
                        const lines = [];
                        rows.forEach(row => {
                            const rowText = row.textContent;
                            // Filter out CSS-like content
                            if (rowText && rowText.trim() && 
                                !rowText.includes('{') && 
                                !rowText.includes('background:') &&
                                !rowText.includes('.xterm')) {
                                lines.push(rowText);
                            }
                        });
                        text = lines.join('\\n');
                    }
                }
                
                // Priority 3: Look for pre/code elements (non-xterm terminals)
                if (!text.trim()) {
                    const preCode = container.querySelector('pre, code');
                    if (preCode) {
                        text = preCode.textContent || '';
                        // Filter out CSS content
                        if (text.includes('.xterm') || text.includes('background:')) {
                            text = '';
                        }
                    }
                }
                
                if (text.trim()) {
                    terminalTexts.push({
                        index: i,
                        text: text.trim(),
                        container: container
                    });
                }
            } catch(e) {}
        });
        
        // Clone the cascade
        const clone = cascade.cloneNode(true);
        
        // Replace terminal canvases with styled pre elements containing the text
        const clonedTerminals = clone.querySelectorAll('.xterm, [class*="terminal"], [class*="Terminal"]');
        terminalTexts.forEach(item => {
            if (clonedTerminals[item.index]) {
                const terminal = clonedTerminals[item.index];
                
                // Create a styled pre element with the terminal text
                const pre = document.createElement('pre');
                pre.textContent = item.text;
                pre.style.cssText = \`
                    background: #1e1e1e;
                    color: #d4d4d4;
                    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                    font-size: 13px;
                    line-height: 1.4;
                    padding: 12px;
                    margin: 0;
                    overflow-x: auto;
                    white-space: pre-wrap;
                    word-break: break-all;
                    border-radius: 6px;
                \`;
                
                // Replace the canvas-based terminal with our text version
                const canvases = terminal.querySelectorAll('canvas');
                if (canvases.length > 0) {
                    // Replace the first canvas's parent or the canvas itself
                    canvases[0].parentNode.replaceChild(pre, canvases[0]);
                    // Remove other canvases (xterm has multiple layers)
                    for (let i = 1; i < canvases.length; i++) {
                        canvases[i].remove();
                    }
                }
            }
        });
        
        // Also handle any remaining canvases (charts, etc.) with the old method
        const remainingCanvases = cascade.querySelectorAll('canvas');
        const canvasReplacements = [];
        remainingCanvases.forEach((canvas, i) => {
            // Skip if already handled by terminal extraction
            if (canvas.closest('.xterm, [class*="terminal"], [class*="Terminal"]')) return;
            
            try {
                if (canvas.width > 0 && canvas.height > 0) {
                    const dataUrl = canvas.toDataURL();
                    if (dataUrl && dataUrl.length > 100) {
                        canvasReplacements.push({ index: i, dataUrl });
                    }
                }
            } catch(e) {}
        });
        
        // Apply non-terminal canvas replacements
        const clonedCanvases = clone.querySelectorAll('canvas');
        canvasReplacements.forEach(item => {
            if (clonedCanvases[item.index]) {
                const img = document.createElement('img');
                img.src = item.dataUrl;
                img.style.display = 'block';
                clonedCanvases[item.index].parentNode.replaceChild(img, clonedCanvases[item.index]);
            }
        });

        // --- MINIMAL CLEANUP ---
        
        // Find the contenteditable input and remove its parent container
        const contentEditable = clone.querySelector('[contenteditable="true"]');
        if (contentEditable) {
            // Walk up to find a reasonable container (the input bar wrapper)
            let container = contentEditable.parentElement;
            // Go up a few levels to get the whole input area
            for (let i = 0; i < 5 && container && container !== clone; i++) {
                if (container.querySelector('[contenteditable]') && 
                    (container.className.includes('input') || 
                     container.className.includes('Input') ||
                     container.className.includes('Composer') ||
                     container.style.position === 'sticky')) {
                    container.remove();
                    break;
                }
                container = container.parentElement;
            }
            // If we didn't find a good container, just remove the contenteditable itself
            if (clone.querySelector('[contenteditable="true"]')) {
                clone.querySelector('[contenteditable="true"]').remove();
            }
        }
        
        // Remove textarea/input elements
        clone.querySelectorAll('textarea, input').forEach(el => el.remove());
        
        // --- SAFE FOOTER REMOVAL (structural/position-based only, won't affect messages) ---
        
        // Remove feedback buttons (exact text only, these are never in messages)
        clone.querySelectorAll('button').forEach(btn => {
            const text = btn.textContent.trim();
            if (text === 'Good' || text === 'Bad' || 
                text === 'Accept all' || text === 'Reject all' ||
                text === 'Review Changes') {
                btn.remove();
            }
        });
        
        // Remove by attributes (structural - these can't be in chat messages)
        clone.querySelectorAll('[placeholder]').forEach(el => el.remove());
        clone.querySelectorAll('[data-placeholder]').forEach(el => el.remove());
        clone.querySelectorAll('[contenteditable]').forEach(el => {
            // Remove the contenteditable and walk up to find its container
            let container = el;
            for (let i = 0; i < 5 && container.parentElement && container.parentElement !== clone; i++) {
                container = container.parentElement;
            }
            container.remove();
        });
        
        // Remove by class patterns (structural)
        clone.querySelectorAll('[class*="Composer"], [class*="composer"]').forEach(el => el.remove());
        clone.querySelectorAll('[class*="InputBar"], [class*="inputBar"], [class*="input-bar"]').forEach(el => el.remove());
        clone.querySelectorAll('[class*="ChatInput"], [class*="chatInput"], [class*="chat-input"]').forEach(el => el.remove());
        
        // Remove position:sticky elements (the footer is sticky at bottom)
        clone.querySelectorAll('*').forEach(el => {
            const style = el.getAttribute('style') || '';
            if (style.includes('position: sticky') || style.includes('position:sticky')) {
                el.remove();
            }
        });
        
        // Remove the last child if it looks like an input container (has no actual message content)
        // This catches the footer bar by structure, not by text
        const lastChild = clone.lastElementChild;
        if (lastChild) {
            const hasMessageContent = lastChild.querySelector('[class*="message"], [class*="Message"], [data-message]');
            const hasInputElements = lastChild.querySelector('[contenteditable], [placeholder], button, select');
            if (!hasMessageContent && hasInputElements) {
                lastChild.remove();
            }
        }

        // --- CAPTURE CSS ---

        let css = '';
        for (const sheet of document.styleSheets) {
            try { 
                for (const rule of sheet.cssRules) {
                    let text = rule.cssText;
                    text = text.replace(/(^|[\\s,}])body(?=[\\s,{])/gi, '$1#cascade-container');
                    text = text.replace(/(^|[\\s,}])html(?=[\\s,{])/gi, '$1#cascade-container');
                    css += text + '\\n'; 
                }
            } catch (e) { }
        }
        
        const computed = window.getComputedStyle(document.body);
        let variables = ':root {';
        for (let i = 0; i < computed.length; i++) {
            const prop = computed[i];
            if (prop.startsWith('--')) {
                variables += \`\${prop}: \${computed.getPropertyValue(prop)};\`;
            }
        }
        variables += '}';
        
        return {
            html: clone.outerHTML,
            css: variables + css,
            bodyBg: computed.backgroundColor,
            bodyColor: computed.color
        };
    })()`;

    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });

        if (result.result?.value && !result.result.value.error) {
            return result.result.value;
        }
    } catch (e) { }

    return null;
}

/**
 * Start streaming chat updates
 */
export async function startChatStream(updateCallback, pollMs = 2000) {
    onChatUpdate = updateCallback;

    // Find and connect to target
    const targets = await findTargets();
    if (targets.length === 0) {
        return { success: false, error: 'No CDP targets found' };
    }

    // Try each target until we find one with #cascade
    for (const target of targets) {
        try {
            console.log(`🔍 Checking ${target.title}`);
            const cdp = await connectCDP(target.webSocketDebuggerUrl);
            const contextId = await findCascadeContext(cdp);

            if (contextId) {
                console.log(`✅ Found cascade in context ${contextId}`);
                connection = cdp;

                // Start polling
                const poll = async () => {
                    if (!connection) return;

                    const contextId = await findCascadeContext(connection);
                    if (!contextId) return;

                    const chat = await captureChat(connection, contextId);
                    if (chat && chat.html) {
                        const hash = hashString(chat.html);
                        if (hash !== lastHash) {
                            lastHash = hash;
                            if (onChatUpdate) {
                                onChatUpdate(chat);
                            }
                        }
                    }
                };

                // Initial capture
                await poll();

                // Start polling interval
                pollInterval = setInterval(poll, pollMs);

                return { success: true, target: target.title };
            } else {
                cdp.ws.close();
            }
        } catch (e) {
            console.error(`Failed: ${e.message}`);
        }
    }

    return { success: false, error: 'No cascade element found in any target' };
}

/**
 * Stop streaming
 */
export function stopChatStream() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    if (connection) {
        connection.ws.close();
        connection = null;
    }
    lastHash = null;
    onChatUpdate = null;
}

/**
 * Get current chat snapshot
 */
export async function getChatSnapshot() {
    if (!connection) {
        // Try to get a one-shot snapshot
        const targets = await findTargets();
        for (const target of targets) {
            try {
                const cdp = await connectCDP(target.webSocketDebuggerUrl);
                const contextId = await findCascadeContext(cdp);
                if (contextId) {
                    const chat = await captureChat(cdp, contextId);
                    cdp.ws.close();
                    return chat;
                }
                cdp.ws.close();
            } catch (e) { }
        }
        return null;
    }

    const contextId = await findCascadeContext(connection);
    if (!contextId) return null;
    return await captureChat(connection, contextId);
}

/**
 * Check if stream is active
 */
export function isStreaming() {
    return connection !== null && pollInterval !== null;
}
