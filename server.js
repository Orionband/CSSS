const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const zlib = require('zlib');
const twofish = require('twofish').twofish();
const fs = require('fs');
const toml = require('toml');
const xml2js = require('xml2js');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const crypto = require('crypto');

// ============================================================
//  WORKER THREAD (Decryption + Grading)
// ============================================================
if (!isMainThread) {
    (async () => {
        // --- HELPER: MATH ---
        const xor = (a, b) => {
            const len = a.length;
            const res = Buffer.allocUnsafe(len);
            for (let i = 0; i < len; i++) res[i] = a[i] ^ b[i];
            return res;
        };

        const cmac = (key, type, data) => {
            const tfKey = Array.from(key);
            const L = Buffer.from(twofish.encrypt(tfKey, Array.from(Buffer.alloc(16, 0))));
            
            const dbl = (v) => {
                let res = Buffer.allocUnsafe(16);
                let carry = 0;
                for (let i = 15; i >= 0; i--) {
                    let b = (v[i] << 1) | carry;
                    res[i] = b & 0xff;
                    carry = (v[i] >> 7) & 1;
                }
                if (v[0] >> 7) res[15] ^= 0x87;
                return res;
            };

            const K1 = dbl(L);
            const K2 = dbl(K1);
            const header = Buffer.alloc(16, 0);
            header[15] = type;
            const nBlocks = Math.ceil((16 + data.length) / 16);
            let state = Buffer.alloc(16, 0);

            for (let i = 0; i < nBlocks; i++) {
                let block;
                if (i === 0) block = header;
                else {
                    const start = (i - 1) * 16;
                    const end = start + 16;
                    block = (end > data.length) ? data.subarray(start) : data.subarray(start, end);
                }
                if (block.length === 16) {
                    if (i === nBlocks - 1) block = xor(block, K1);
                    state = Buffer.from(twofish.encrypt(tfKey, Array.from(xor(state, block))));
                } else {
                    const padded = Buffer.alloc(16, 0);
                    block.copy(padded);
                    padded[block.length] = 0x80;
                    state = Buffer.from(twofish.encrypt(tfKey, Array.from(xor(state, xor(padded, K2)))));
                }
            }
            return state;
        };

        function getXmlValue(rootObj, pathArray) {
            let current = rootObj;
            for (let key of pathArray) {
                if (current === undefined || current === null) return null;
                if (Array.isArray(current)) {
                    const isIndex = typeof key === 'number' || (typeof key === 'string' && /^\d+$/.test(key));
                    if (isIndex) {
                        current = current[parseInt(key)];
                    } else {
                        if (current.length === 1 && current[0] && current[0][key]) current = current[0][key];
                        else current = current[key]; 
                    }
                } else {
                    current = current[key];
                }
            }
            if (current && typeof current === 'object' && '_' in current) return current._;
            if (Array.isArray(current) && current.length === 1 && (typeof current[0] === 'string' || typeof current[0] === 'number')) return current[0];
            if (Array.isArray(current) && current.length === 1 && current[0] && current[0]._) return current[0]._;
            return current;
        }

        function parseCiscoConfig(lines) {
            if (!lines || lines.length === 0) return { global: [], blocks: {} };
            const config = { global: [], blocks: {} };
            let currentBlock = null;
            lines.forEach(rawLine => {
                const line = typeof rawLine === 'string' ? rawLine : rawLine._;
                if (!line) return;
                const trimmed = line.trim();
                if (trimmed === '!' || trimmed === '' || trimmed === 'end') return;
                if (line.startsWith(' ')) {
                    if (currentBlock) config.blocks[currentBlock].push(trimmed);
                } else {
                    currentBlock = trimmed;
                    if (!config.blocks[currentBlock]) config.blocks[currentBlock] = [];
                    config.global.push(trimmed);
                }
            });
            return config;
        }

        function evaluateCondition(device, condition) {
            if (!device) return false;

            if (condition.type === 'XmlMatch') {
                const actual = getXmlValue(device.xmlRoot, condition.path);
                return actual == condition.value; 
            }

            if (['ConfigMatch', 'ConfigContains', 'ConfigRegex'].includes(condition.type)) {
                const sourceCfg = condition.source === 'startup' ? device.startup : device.running;
                let targetLines = [];
                
                if (!condition.context || condition.context === 'global') {
                    targetLines = sourceCfg.global;
                } else {
                    const searchCtx = condition.context.toLowerCase().replace(/\s/g, '');
                    const blockKey = Object.keys(sourceCfg.blocks).find(k => k.toLowerCase().replace(/\s/g, '') === searchCtx);
                    if (blockKey) targetLines = sourceCfg.blocks[blockKey];
                }

                if (!targetLines) return false;

                if (condition.type === 'ConfigRegex') {
                    try {
                        const regex = new RegExp(condition.value);
                        return targetLines.some(l => regex.test(l));
                    } catch (e) { return false; }
                }

                if (condition.type === 'ConfigContains') {
                    return targetLines.some(l => l.includes(condition.value));
                }

                if (condition.type === 'ConfigMatch') {
                    if (condition.value.startsWith('^')) {
                        const regex = new RegExp(condition.value);
                        return targetLines.some(l => regex.test(l));
                    }
                    return targetLines.includes(condition.value);
                }
            }
            return false;
        }

        // --- MAIN PIPELINE ---
        try {
            const { fileData, configData } = workerData;
            const inputBuffer = Buffer.from(fileData);
            const totalBytes = inputBuffer.length;
            const safeTotal = totalBytes > 0 ? totalBytes : 1;
            
            const report = (stage, pct) => {
                const safePct = (typeof pct === 'number' && !isNaN(pct)) ? pct : 0;
                parentPort.postMessage({ type: 'progress', stage, percent: safePct });
            };

            let finalXML = "";
            
            if (inputBuffer.subarray(0, 5).toString() === "<?xml") {
                report("Reading XML", 50);
                finalXML = inputBuffer.toString();
            } else {
                const key = Buffer.alloc(16, 137);
                const iv = Buffer.alloc(16, 16);
                
                const s1 = Buffer.allocUnsafe(totalBytes);
                const updateInterval = Math.floor(safeTotal / 10);
                
                report("Deobfuscating", 0);
                for (let i = 0; i < totalBytes; i++) {
                    s1[i] = (inputBuffer[totalBytes - 1 - i] ^ ((totalBytes - (i * totalBytes)) | 0)) & 0xFF;
                    if (i % updateInterval === 0) report("Deobfuscating", (i / safeTotal) * 30);
                }

                report("Decrypting", 30);
                const tag = s1.subarray(totalBytes - 16);
                const ciphertext = s1.subarray(0, totalBytes - 16);
                
                const nTag = cmac(key, 0, iv);
                const hTag = cmac(key, 1, Buffer.alloc(0));
                const cTag = cmac(key, 2, ciphertext);
                if (!xor(xor(nTag, hTag), cTag).equals(tag)) throw new Error("File Integrity Failed");

                let decrypted = Buffer.allocUnsafe(ciphertext.length);
                let counter = Buffer.from(nTag);
                const cipherLen = ciphertext.length;
                
                for (let i = 0; i < cipherLen; i += 16) {
                    const k = Buffer.from(twofish.encrypt(Array.from(key), Array.from(counter)));
                    const lim = Math.min(16, cipherLen - i);
                    for (let j = 0; j < lim; j++) decrypted[i + j] = ciphertext[i + j] ^ k[j];
                    for (let j = 15; j >= 0; j--) { counter[j] = (counter[j] + 1) & 0xFF; if (counter[j] !== 0) break; }
                    if (i % 10000 === 0) report("Decrypting", 30 + (i / cipherLen) * 40);
                }

                report("Finalizing", 70);
                const s3 = Buffer.allocUnsafe(decrypted.length);
                const dLen = decrypted.length;
                for (let i = 0; i < dLen; i++) s3[i] = (decrypted[i] ^ (dLen - i)) & 0xFF;

                report("Decompressing", 80);
                try { finalXML = zlib.inflateSync(s3.subarray(4)).toString(); } 
                catch { finalXML = zlib.inflateRawSync(s3.subarray(4)).toString(); }
            }

            report("Grading...", 90);
            
            const conf = toml.parse(configData);
            const parser = new xml2js.Parser();
            const xmlObj = await parser.parseStringPromise(finalXML);
            
            const devMap = {};
            const devList = xmlObj?.PACKETTRACER5_ACTIVITY?.PACKETTRACER5?.[0]?.NETWORK?.[0]?.DEVICES?.[0]?.DEVICE || [];
            
            devList.forEach(d => {
                const nameObj = d.ENGINE[0].NAME[0];
                const name = nameObj._ || nameObj;
                devMap[name] = {
                    xmlRoot: d.ENGINE[0],
                    running: parseCiscoConfig(d.ENGINE?.[0]?.RUNNINGCONFIG?.[0]?.LINE || []),
                    startup: parseCiscoConfig(d.ENGINE?.[0]?.STARTUPCONFIG?.[0]?.LINE || [])
                };
            });

            let currentScore = 0;
            let maxScore = 0;
            // Store FULL results (Passed and Failed) for Server DB logs
            const serverResults = [];
            // Store FILTERED results for Client display (Security)
            const clientResults = [];

            conf.check.forEach(check => {
                const pts = parseInt(check.points);
                if (pts > 0) maxScore += pts;
                
                const device = devMap[check.device];
                let pass = false;

                if (device) {
                    const failCond = check.fail && check.fail.some(c => evaluateCondition(device, c));
                    if (!failCond) {
                        if (check.passoverride && check.passoverride.some(c => evaluateCondition(device, c))) {
                            pass = true;
                        } 
                        else if (check.pass && check.pass.length > 0) {
                            pass = check.pass.every(c => evaluateCondition(device, c));
                        }
                    }
                }

                if (pass) {
                    currentScore += pts;
                    clientResults.push({ message: check.message, points: pts });
                }

                // Log everything to database record
                serverResults.push({
                    message: check.message,
                    device: check.device,
                    possible: pts,
                    awarded: pass ? pts : 0,
                    passed: pass
                });
            });

            if (currentScore < 0) currentScore = 0;

            report("Complete", 100);

            const clientBreakdown = (conf.options && conf.options.show_check_messages) ? clientResults : [];

            parentPort.postMessage({
                type: 'result',
                xml: finalXML,
                grading: {
                    total: currentScore,
                    max: maxScore,
                    clientBreakdown: clientBreakdown,
                    serverBreakdown: serverResults,
                    options: conf.options || {}
                }
            });

        } catch (err) {
            parentPort.postMessage({ type: 'error', msg: err.message });
        }
    })();
}

// ============================================================
//  MAIN THREAD
// ============================================================
else {
    // --- DATABASE SETUP ---
    const db = new Database('grader.db');
    // Initialize Tables
    db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            password TEXT,
            unique_id TEXT UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            unique_id TEXT,
            score INTEGER,
            max_score INTEGER,
            details TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    `).run();

    // Helper: Generate Unique ID (XXXX-XXXX-XXXX)
    function generateUniqueId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 12; i++) {
            if (i > 0 && i % 4 === 0) result += '-';
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { maxHttpBufferSize: 1e8 });

    // --- CONFIG ---
    let configContent = "";
    let appConfig = { options: { max_submissions: 0, rate_limit_count: 0 } };
    
    function loadConfig() {
        try {
            configContent = fs.readFileSync('lab.conf', 'utf-8');
            appConfig = toml.parse(configContent);
            console.log("Configuration loaded.");
        } catch (e) {
            console.warn("WARNING: lab.conf not found. Grading will fail.");
        }
    }
    loadConfig();

    // --- MIDDLEWARE ---
    app.use(express.json());
    app.use(session({
        store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
        secret: 'packet-tracer-secure-secret-change-me',
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day
    }));

    // --- API ROUTES ---

    // Register
    app.post('/api/register', async (req, res) => {
        const { username, email, password } = req.body;
        if (!username || !email || !password) return res.status(400).json({ error: "All fields required" });

        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            const uid = generateUniqueId();
            
            const stmt = db.prepare('INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)');
            const info = stmt.run(username, email, hashedPassword, uid);
            
            req.session.userId = info.lastInsertRowid;
            req.session.uniqueId = uid;
            res.json({ success: true, unique_id: uid });
        } catch (err) {
            if (err.message.includes('UNIQUE')) return res.status(400).json({ error: "Username or Email already exists" });
            res.status(500).json({ error: "Database error" });
        }
    });

    // Login
    app.post('/api/login', async (req, res) => {
        const { username, password } = req.body;
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        req.session.userId = user.id;
        req.session.uniqueId = user.unique_id;
        res.json({ success: true, unique_id: user.unique_id });
    });

    // Logout
    app.post('/api/logout', (req, res) => {
        req.session.destroy();
        res.json({ success: true });
    });

    // Check Auth
    app.get('/api/me', (req, res) => {
        if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
        res.json({ 
            id: req.session.userId, 
            unique_id: req.session.uniqueId 
        });
    });
    // Get Submission History
    app.get('/api/history', (req, res) => {
        if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });

        try {
            const submissions = db.prepare(`
                SELECT id, score, max_score, timestamp, details 
                FROM submissions 
                WHERE user_id = ? 
                ORDER BY id DESC
            `).all(req.session.userId);

            // Filter details based on current config permissions
            // We only show what the user is ALLOWED to see
            const safeSubmissions = submissions.map(sub => {
                let details = [];
                try { details = JSON.parse(sub.details); } catch(e) {}

                // Security Filter: Re-apply the "Client View" logic
                const clientDetails = details.filter(item => {
                    // Only show items that Passed (or Penalties that were applied)
                    // If points > 0 (Earned) -> Show
                    // If points < 0 (Penalty) AND awarded < 0 (Applied) -> Show
                    // If points < 0 (Penalty) AND awarded == 0 (Avoided) -> Hide
                    
                    // In serverResults (stored in DB): 'awarded' tracks actual points given.
                    // 'possible' tracks the potential points.
                    
                    const isPenalty = item.possible < 0;
                    const pointsGot = item.awarded;

                    if (isPenalty) {
                        // Show if penalty was applied (negative points)
                        return pointsGot < 0;
                    } else {
                        // Show if points were earned (positive points)
                        return pointsGot > 0;
                    }
                }).map(item => ({
                    message: item.message,
                    points: item.awarded
                }));

                return {
                    id: sub.id,
                    score: sub.score,
                    max_score: sub.max_score,
                    timestamp: sub.timestamp,
                    // If config hides messages, send empty array
                    details: (appConfig.options.show_check_messages) ? clientDetails : []
                };
            });

            res.json({ success: true, history: safeSubmissions });
        } catch (err) {
            res.status(500).json({ error: "Database error" });
        }
    });
    // Static Files
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

    // --- SOCKET.IO (GRADING) ---
    io.on('connection', (socket) => {
        // Authenticate Socket using Session
        const sessionReq = socket.request;
        // NOTE: In production with specialized session stores, you might need parsing here.
        // For this simple stack, we rely on client-side state or basic sync. 
        // Ideally, we share the session store. Since socket.io doesn't auto-read express sessions without middleware:
        // We will do a simple "Auth Handshake" event for this standalone implementation.
        
        let socketUser = null;

        socket.on('authenticate', (uid) => {
            const user = db.prepare('SELECT * FROM users WHERE unique_id = ?').get(uid);
            if (user) {
                socketUser = user;
                socket.emit('auth_success', user.unique_id);
            } else {
                socket.emit('auth_fail');
            }
        });

        socket.on('upload_file', (fileData) => {
            if (!socketUser) return socket.emit('err', "Unauthorized: Please log in.");

            // --- RATE LIMITING & SUBMISSION LIMITS ---
            const opts = appConfig.options || {};
            const userId = socketUser.id;

            // 1. Max Submissions Check
            if (opts.max_submissions > 0) {
                const count = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ?').get(userId).c;
                if (count >= opts.max_submissions) {
                    return socket.emit('err', `Submission limit reached (${count}/${opts.max_submissions}).`);
                }
            }

            // 2. Time-based Rate Limiting (Submissions per Minute)
            if (opts.rate_limit_count > 0) {
                const windowSec = opts.rate_limit_window_seconds || 60;
                const recent = db.prepare(
                    `SELECT COUNT(*) as c FROM submissions 
                     WHERE user_id = ? AND timestamp > datetime('now', '-${windowSec} seconds')`
                ).get(userId).c;

                if (recent >= opts.rate_limit_count) {
                    return socket.emit('err', `Rate limit exceeded. Wait a moment.`);
                }
            }

            // --- START WORKER ---
            const worker = new Worker(__filename, { 
                workerData: { 
                    fileData, 
                    configData: configContent 
                } 
            });

            worker.on('message', (msg) => {
                if (msg.type === 'progress') {
                    socket.emit('progress', msg);
                } 
                else if (msg.type === 'result') {
                    const grading = msg.grading;
                    const timestamp = Date.now();
                    const capturesDir = path.join(__dirname, 'captures');

                    // --- SAVE TO DATABASE ---
                    db.prepare(`
                        INSERT INTO submissions (user_id, unique_id, score, max_score, details) 
                        VALUES (?, ?, ?, ?, ?)
                    `).run(
                        userId, 
                        socketUser.unique_id, 
                        grading.total, 
                        grading.max, 
                        JSON.stringify(grading.serverBreakdown) // Full details stored securely
                    );

                    // --- SAVE FILES ---
                    if (opts.retain_pka || opts.retain_xml) {
                        if (!fs.existsSync(capturesDir)) fs.mkdirSync(capturesDir);
                        
                        // Filename: [UID]_[TIMESTAMP].pka
                        const baseName = `${socketUser.unique_id}_${timestamp}`;

                        if (opts.retain_pka) {
                            fs.writeFileSync(path.join(capturesDir, `${baseName}.pka`), Buffer.from(fileData));
                        }
                        if (opts.retain_xml) {
                            fs.writeFileSync(path.join(capturesDir, `${baseName}.xml`), msg.xml);
                        }
                    }

                    delete msg.xml; // Don't send raw XML to client
                    // Remove server breakdown from client payload
                    delete grading.serverBreakdown;
                    
                    socket.emit('result', grading);
                    worker.terminate();
                } 
                else if (msg.type === 'error') {
                    socket.emit('err', msg.msg);
                    worker.terminate();
                }
            });

            worker.on('error', (err) => socket.emit('err', "System Error: " + err.message));
        });
    });

    const PORT = 3000;
    server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}