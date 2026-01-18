/**
 * Quota Service - Fetches model quota data from Antigravity
 * 
 * Finds the Antigravity language server process, extracts port and CSRF token
 * from command line, then calls GetUserStatus API to get quota data.
 */

import https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// API endpoint 
const GET_USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

// Thresholds for status colors
const THRESHOLDS = {
    WARNING: 30,
    CRITICAL: 10
};

// Cache
let cachedQuota = null;
let lastFetch = 0;
const CACHE_TTL = 15000; // 15 seconds

let cachedConnection = null;
let lastConnectionCheck = 0;
const CONNECTION_CACHE_TTL = 60000; // 1 minute

/**
 * Scan running processes to find Antigravity language server
 * and extract port + CSRF token from command line
 */
async function findLanguageServer() {
    // Check cache
    if (cachedConnection && Date.now() - lastConnectionCheck < CONNECTION_CACHE_TTL) {
        return cachedConnection;
    }

    try {
        // PowerShell command to find language_server process with csrf_token
        const command = `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'csrf_token' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json"`;

        const { stdout } = await execAsync(command, { timeout: 15000, maxBuffer: 1024 * 1024 });

        if (!stdout || stdout.trim().length === 0) {
            console.log('[QuotaService] No language_server process found');
            return null;
        }

        // Parse JSON output
        let processes;
        try {
            const trimmed = stdout.trim();
            const jsonStart = trimmed.indexOf('[') >= 0 ? trimmed.indexOf('[') : trimmed.indexOf('{');
            const jsonStr = trimmed.substring(jsonStart);
            processes = JSON.parse(jsonStr);
            if (!Array.isArray(processes)) {
                processes = [processes];
            }
        } catch (e) {
            console.log('[QuotaService] Failed to parse process list:', e.message);
            return null;
        }

        // Find Antigravity process (has --app_data_dir antigravity)
        for (const proc of processes) {
            const cmdLine = proc.CommandLine || '';

            // Check if this is the Antigravity language server
            if (!cmdLine.includes('--extension_server_port') || !cmdLine.includes('--csrf_token')) {
                continue;
            }
            if (!/--app_data_dir\s+antigravity\b/i.test(cmdLine)) {
                continue;
            }

            // Extract CSRF token
            const tokenMatch = cmdLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
            if (!tokenMatch) {
                continue;
            }

            const token = tokenMatch[1];
            const pid = proc.ProcessId;

            // Find listening ports for this process
            const ports = await getProcessListeningPorts(pid);
            console.log(`[QuotaService] Found process ${pid} with ${ports.length} listening ports: ${ports.join(', ')}`);

            // Test each port to find the API port
            for (const port of ports) {
                const works = await testApiPort(port, token);
                if (works) {
                    const connection = { port, token, pid };
                    cachedConnection = connection;
                    lastConnectionCheck = Date.now();
                    console.log(`[QuotaService] Found working API on port ${port}`);
                    return connection;
                }
            }
        }

        console.log('[QuotaService] No valid Antigravity process found');
        return null;

    } catch (e) {
        console.error('[QuotaService] Error scanning processes:', e.message);
        return null;
    }
}

/**
 * Get listening ports for a process
 */
async function getProcessListeningPorts(pid) {
    try {
        const command = `powershell -NoProfile -NonInteractive -Command "$ports = Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort; if ($ports) { $ports | Sort-Object -Unique }"`;
        const { stdout } = await execAsync(command, { timeout: 5000 });

        const ports = [];
        const matches = stdout.match(/\b\d{1,5}\b/g) || [];
        for (const m of matches) {
            const p = parseInt(m, 10);
            if (p > 0 && p <= 65535) {
                ports.push(p);
            }
        }
        return ports.sort((a, b) => b - a); // Try higher ports first (more likely to be API)
    } catch (e) {
        console.log('[QuotaService] Failed to get listening ports:', e.message);
        return [];
    }
}

/**
 * Test if a port responds to the API
 */
async function testApiPort(port, token) {
    return new Promise((resolve) => {
        const data = JSON.stringify({ metadata: { ideName: 'antigravity' } });

        const options = {
            hostname: '127.0.0.1',
            port,
            path: GET_USER_STATUS_PATH,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': token
            },
            rejectUnauthorized: false,
            timeout: 3000
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                // Accept any successful response or valid JSON error
                resolve(res.statusCode === 200 || body.includes('"user_status"'));
            });
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });

        req.write(data);
        req.end();
    });
}

/**
 * Make API request to the language server
 */
function apiRequest(port, token, path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);

        const options = {
            hostname: '127.0.0.1',
            port,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': token
            },
            rejectUnauthorized: false,
            timeout: 10000
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${responseData.substring(0, 200)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(responseData));
                } catch (e) {
                    reject(new Error(`Failed to parse response: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });

        req.write(data);
        req.end();
    });
}

/**
 * Determine status based on remaining percentage
 */
function getStatus(remainingPercent) {
    if (remainingPercent <= 0) return 'exhausted';
    if (remainingPercent <= THRESHOLDS.CRITICAL) return 'danger';
    if (remainingPercent <= THRESHOLDS.WARNING) return 'warning';
    return 'healthy';
}

/**
 * Calculate remaining time string from reset timestamp
 */
function formatResetTime(resetAtMs) {
    if (!resetAtMs) return null;

    const now = Date.now();
    const resetAt = typeof resetAtMs === 'string' ? parseInt(resetAtMs) : resetAtMs;
    const diffMs = resetAt - now;

    if (diffMs <= 0) return 'Now';

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

/**
 * Model name mapping
 */
const MODEL_NAMES = {
    'MODEL_PLACEHOLDER_M12': 'Claude Opus 4.5',
    'MODEL_CLAUDE_4_5_SONNET': 'Claude Sonnet 4.5',
    'MODEL_CLAUDE_4_5_SONNET_THINKING': 'Claude Sonnet 4.5 Thinking',
    'MODEL_PLACEHOLDER_M18': 'Gemini 3 Flash',
    'MODEL_PLACEHOLDER_M7': 'Gemini 3 Pro High',
    'MODEL_PLACEHOLDER_M8': 'Gemini 3 Pro Low',
    'MODEL_PLACEHOLDER_M9': 'Gemini 3 Pro Image',
    'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 'GPT-OSS 120B'
};

function getDisplayName(modelId) {
    return MODEL_NAMES[modelId] || modelId?.replace('MODEL_', '').replace(/_/g, ' ') || 'Unknown';
}

/**
 * Parse the API response to extract model quota
 */
function parseQuotaResponse(response) {
    const models = [];

    // The quota data is in userStatus.cascadeModelConfigData.clientModelConfigs
    const clientConfigs = response?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];

    for (const config of clientConfigs) {
        const quotaInfo = config.quotaInfo || {};
        // remainingFraction is 0-1, convert to percentage
        const remainingFraction = quotaInfo.remainingFraction ?? 1;
        const remainingPercent = Math.round(remainingFraction * 100);

        // Get model identifier
        const modelId = config.modelOrAlias?.model || config.modelOrAlias || 'unknown';
        const label = config.label || getDisplayName(modelId);

        // Parse reset time
        const resetAt = quotaInfo.resetAt ? new Date(quotaInfo.resetAt).getTime() : null;

        models.push({
            id: modelId,
            name: label,
            remaining: remainingPercent, // Display as percentage
            limit: 100,
            remainingPercent,
            resetAt,
            resetIn: formatResetTime(resetAt),
            status: getStatus(remainingPercent)
        });
    }

    return models;
}

/**
 * Fetch quota data from Antigravity
 */
export async function getQuota() {
    // Check cache
    if (cachedQuota && Date.now() - lastFetch < CACHE_TTL) {
        return cachedQuota;
    }

    try {
        const connection = await findLanguageServer();

        if (!connection) {
            return {
                available: false,
                error: 'Antigravity language server not found. Make sure Antigravity is running.',
                models: []
            };
        }

        const response = await apiRequest(
            connection.port,
            connection.token,
            GET_USER_STATUS_PATH,
            {
                metadata: {
                    ideName: 'antigravity',
                    extensionName: 'antigravity',
                    locale: 'en'
                }
            }
        );

        console.log('[QuotaService] API Response received');
        console.log('[QuotaService] Response keys:', Object.keys(response));
        console.log('[QuotaService] Response structure:', JSON.stringify(response, null, 2).substring(0, 500));

        const models = parseQuotaResponse(response);

        const result = {
            available: true,
            models,
            fetchedAt: new Date().toISOString()
        };

        cachedQuota = result;
        lastFetch = Date.now();

        return result;

    } catch (e) {
        console.error('[QuotaService] Error:', e.message);
        return {
            available: false,
            error: e.message,
            models: []
        };
    }
}

/**
 * Clear the cache
 */
export function clearCache() {
    cachedQuota = null;
    lastFetch = 0;
    cachedConnection = null;
    lastConnectionCheck = 0;
}

/**
 * Check if the service can connect
 */
export async function isAvailable() {
    const connection = await findLanguageServer();
    return {
        available: !!connection,
        port: connection?.port,
        pid: connection?.pid
    };
}
