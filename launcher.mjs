#!/usr/bin/env node
/**
 * Antigravity Mobile Launcher
 * 
 * One-click script that:
 * 1. Starts the HTTP telemetry server
 * 2. Finds Antigravity installation (Windows/Mac/Linux)
 * 3. Launches Antigravity with CDP enabled (--remote-debugging-port=9222)
 * 
 * Usage: node launcher.mjs
 */

import { spawn, exec, fork } from 'child_process';
import { existsSync } from 'fs';
import { platform, homedir, networkInterfaces } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP_PORT = 9222;
const HTTP_PORT = 3001;

// ============================================================================
// Antigravity Installation Paths by Platform
// ============================================================================
const ANTIGRAVITY_PATHS = {
    win32: [
        join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'),
        join(process.env.LOCALAPPDATA || '', 'Antigravity', 'Antigravity.exe'),
        join(process.env.PROGRAMFILES || '', 'Antigravity', 'Antigravity.exe'),
        join(process.env['PROGRAMFILES(X86)'] || '', 'Antigravity', 'Antigravity.exe'),
        join(homedir(), 'AppData', 'Local', 'Programs', 'Antigravity', 'Antigravity.exe'),
        join(homedir(), 'AppData', 'Local', 'Antigravity', 'Antigravity.exe'),
    ],
    darwin: [
        '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
        join(homedir(), 'Applications', 'Antigravity.app', 'Contents', 'MacOS', 'Antigravity'),
    ],
    linux: [
        '/usr/bin/antigravity',
        '/usr/local/bin/antigravity',
        '/opt/Antigravity/antigravity',
        join(homedir(), '.local', 'bin', 'antigravity'),
    ]
};

// ============================================================================
// Helper Functions
// ============================================================================
function log(emoji, message) {
    console.log(`${emoji}  ${message}`);
}

function logSection(title) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ${title}`);
    console.log(`${'─'.repeat(50)}`);
}

async function findAntigravityPath() {
    const os = platform();
    const paths = ANTIGRAVITY_PATHS[os] || [];

    for (const p of paths) {
        if (p && existsSync(p)) return p;
    }

    // Try system commands
    if (os === 'win32') {
        return await findViaCommand(`where Antigravity.exe`);
    } else {
        return await findViaCommand(`which antigravity`);
    }
}

async function findViaCommand(cmd) {
    return new Promise((resolve) => {
        exec(cmd, (err, stdout) => {
            const path = stdout?.split('\n')[0]?.trim();
            resolve(path && existsSync(path) ? path : null);
        });
    });
}

async function isPortInUse(port) {
    return new Promise((resolve) => {
        const cmd = platform() === 'win32'
            ? `netstat -ano | findstr :${port} | findstr LISTENING`
            : `lsof -i :${port}`;

        exec(cmd, (err, stdout) => {
            resolve(stdout && stdout.trim().length > 0);
        });
    });
}

function getLocalIPs() {
    const ips = [];
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                ips.push(net.address);
            }
        }
    }
    return ips;
}

async function waitForServer(port, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const res = await fetch(`http://localhost:${port}/api/status`);
            if (res.ok) return true;
        } catch { }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

async function waitForCDP(port, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const res = await fetch(`http://localhost:${port}/json/version`);
            if (res.ok) return true;
        } catch { }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

// ============================================================================
// Main Launch Sequence
// ============================================================================
async function main() {
    console.log(`
╔════════════════════════════════════════════════════════╗
║          ⚡ Antigravity Mobile Launcher                ║
╠════════════════════════════════════════════════════════╣
║  One-click setup for mobile streaming + CDP control    ║
╚════════════════════════════════════════════════════════╝
    `);

    const os = platform();
    log('💻', `Platform: ${os}`);

    // ========================================================================
    // Step 1: Start HTTP Server
    // ========================================================================
    logSection('🌐 Starting HTTP Server');

    const httpServerPath = join(__dirname, 'http-server.mjs');

    if (!existsSync(httpServerPath)) {
        log('❌', `HTTP server not found at: ${httpServerPath}`);
        process.exit(1);
    }

    if (await isPortInUse(HTTP_PORT)) {
        log('✅', `HTTP server already running on port ${HTTP_PORT}`);
    } else {
        log('🚀', 'Starting HTTP server...');

        // Use fork for better subprocess handling
        const httpServer = spawn('node', [httpServerPath], {
            cwd: __dirname,
            stdio: 'ignore',
            detached: true,
            windowsHide: true
        });
        httpServer.unref();

        // Wait for server to be ready
        const serverReady = await waitForServer(HTTP_PORT, 8000);
        if (serverReady) {
            log('✅', `HTTP server started on port ${HTTP_PORT}`);
        } else {
            log('⚠️', 'HTTP server may still be starting...');
        }
    }

    // ========================================================================
    // Step 2: Find Antigravity
    // ========================================================================
    logSection('🔍 Finding Antigravity');

    const antigravityPath = await findAntigravityPath();

    if (!antigravityPath) {
        log('❌', 'Could not find Antigravity installation!');
        console.log('\nPlease install Antigravity or specify path:');
        console.log('  ANTIGRAVITY_PATH=/path/to/antigravity node launcher.mjs\n');
        process.exit(1);
    }

    log('✅', `Found: ${antigravityPath}`);

    // ========================================================================
    // Step 3: Check if Antigravity already running with CDP
    // ========================================================================
    logSection('🔌 Checking CDP');

    const cdpAlreadyRunning = await waitForCDP(CDP_PORT, 2000);

    if (cdpAlreadyRunning) {
        log('✅', `CDP already active on port ${CDP_PORT}`);
    } else {
        // ========================================================================
        // Step 4: Launch Antigravity with CDP
        // ========================================================================
        logSection('🚀 Launching Antigravity');

        log('📝', `Starting with --remote-debugging-port=${CDP_PORT}`);

        const antigravity = spawn(antigravityPath, [`--remote-debugging-port=${CDP_PORT}`], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false
        });
        antigravity.unref();

        // Wait for CDP to be ready
        log('⏳', 'Waiting for Antigravity to start...');
        const cdpReady = await waitForCDP(CDP_PORT, 15000);

        if (cdpReady) {
            log('✅', 'CDP is now active!');
        } else {
            log('⚠️', 'CDP not responding - Antigravity may need more time');
        }
    }

    // ========================================================================
    // Step 5: Final Status
    // ========================================================================
    logSection('✨ Status Check');

    // Check CDP
    try {
        const res = await fetch(`http://localhost:${CDP_PORT}/json/version`);
        const data = await res.json();
        log('✅', `CDP: ${data.Browser || 'Active'}`);
    } catch {
        log('❌', 'CDP: Not responding');
    }

    // Check HTTP
    try {
        const res = await fetch(`http://localhost:${HTTP_PORT}/api/status`);
        if (res.ok) log('✅', `HTTP Server: Running`);
        else throw new Error();
    } catch {
        log('❌', 'HTTP Server: Not responding');
    }

    // ========================================================================
    // Done!
    // ========================================================================
    const ips = getLocalIPs();
    const mainIP = ips.find(ip => ip.startsWith('192.168.')) || ips[0] || 'YOUR_IP';

    console.log(`
╔════════════════════════════════════════════════════════╗
║                   🎉 READY TO GO!                      ║
╠════════════════════════════════════════════════════════╣
║                                                        ║
║  📱 Mobile Dashboard:                                  ║
║     http://${mainIP}:${HTTP_PORT}                            ║
║                                                        ║
║  🖥️  Local Access:                                     ║
║     http://localhost:${HTTP_PORT}                             ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
    `);

    if (ips.length > 1) {
        log('🌐', 'All available IPs:');
        ips.forEach(ip => console.log(`     http://${ip}:${HTTP_PORT}`));
    }

    console.log('\n✅ You can close this window - servers will keep running.\n');
}

// ============================================================================
// CLI
// ============================================================================
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Antigravity Mobile Launcher

Usage: node launcher.mjs [options]

Options:
  --help, -h    Show this help

Environment Variables:
  ANTIGRAVITY_PATH   Custom path to Antigravity executable
    `);
    process.exit(0);
}

// Custom path from env
if (process.env.ANTIGRAVITY_PATH) {
    const customPath = process.env.ANTIGRAVITY_PATH;
    if (existsSync(customPath)) {
        ANTIGRAVITY_PATHS[platform()] = [customPath];
    }
}

// Run!
main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
