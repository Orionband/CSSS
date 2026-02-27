const dotenv = require('dotenv');
dotenv.config(); 

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const db = require('./database');
const { getConfig, getRawConfig } = require('./config');
const authRoutes = require('./routes/auth');
const quizRoutes = require('./routes/quiz');

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);

// Dynamically determine global max socket size from all labs
const cfgInitial = getConfig();
let globalMaxUploadMB = 75; // Baseline fallback
(cfgInitial.labs || []).forEach(l => {
    if (l.max_upload_mb && l.max_upload_mb > globalMaxUploadMB) {
        globalMaxUploadMB = l.max_upload_mb;
    }
});

const io = new Server(server, { maxHttpBufferSize: globalMaxUploadMB * 1024 * 1024 }); 

app.use(express.json());

const sessionMiddleware = session({
    store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
    secret: process.env.SESSION_SECRET, 
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,  
        secure: "auto",
        sameSite: 'lax',        
        maxAge: 24 * 60 * 60 * 1000
    }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', authRoutes);
app.use('/api/quiz', quizRoutes);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));

global.submissionLocks = new Set();
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS) || 4;
let activeWorkers = 0;
const workerQueue = [];

function processWorkerQueue() {
    if (workerQueue.length === 0 || activeWorkers >= MAX_WORKERS) return;
    activeWorkers++;
    
    const task = workerQueue.shift();
    const { socket, workerData, lockKey, socketUser, targetLab } = task;

    const worker = new Worker(path.join(__dirname, 'worker/worker.js'), { workerData });

    worker.on('message', (msg) => {
        if (msg.type === 'progress') socket.emit('progress', msg);
        else if (msg.type === 'result') {
            const { grading } = msg;
            const timestamp = Date.now();
            const capturesDir = path.join(__dirname, '../captures');

            db.prepare('INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, details, type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
			.run(socketUser.id, socketUser.unique_id, targetLab.id, grading.total, grading.max, JSON.stringify(grading.serverBreakdown), 'lab', 'completed');

            // Save files based on new global Environment Variables
            if (process.env.RETAIN_PKA === 'true' || process.env.RETAIN_XML === 'true') {
                if (!fs.existsSync(capturesDir)) fs.mkdirSync(capturesDir, { recursive: true });
                const safeTitle = targetLab.title.replace(/[^a-z0-9]/gi, '_');
                const baseName = `${safeTitle}_${socketUser.unique_id}_${timestamp}`;
                if (process.env.RETAIN_PKA === 'true') fs.writeFileSync(path.join(capturesDir, `${baseName}.pka`), Buffer.from(workerData.fileData));
                if (process.env.RETAIN_XML === 'true') fs.writeFileSync(path.join(capturesDir, `${baseName}.xml`), msg.xml);
            }

            const payload = { 
                total: grading.total, max: grading.max, clientBreakdown: grading.clientBreakdown, show_score: grading.show_score
            };

            if (!grading.show_score) { delete payload.total; delete payload.max; }

            socket.emit('result', payload);
            global.submissionLocks.delete(lockKey); 
            worker.terminate();
            activeWorkers--;
            processWorkerQueue();
        } else if (msg.type === 'error') {
            socket.emit('err', msg.msg);
            global.submissionLocks.delete(lockKey); 
            worker.terminate();
            activeWorkers--;
            processWorkerQueue();
        }
    });
    
    worker.on('error', (e) => {
        socket.emit('err', "Worker Error: " + e.message);
        global.submissionLocks.delete(lockKey); 
        worker.terminate();
        activeWorkers--;
        processWorkerQueue();
    });
}

io.on('connection', (socket) => {
    let socketUser = null;

    socket.on('authenticate', () => {
        const session = socket.request.session;
        if (session && session.userId && session.uniqueId) {
            const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId);
            if (user) {
                socketUser = user;
                socket.emit('auth_success', user.unique_id);
                return;
            }
        }
        socket.emit('auth_fail');
    });

    socket.on('upload_file', (packet) => {
        if (!socketUser) return socket.emit('err', "Unauthorized");
        
        const fileData = packet.fileData || packet;
        const cfg = getConfig();
        const labs = cfg.labs || [];
        const labId = packet.labId || (labs.length > 0 ? labs[0].id : null);
        const userId = socketUser.id;

        if (!labId) return socket.emit('err', "No configuration loaded.");

        const targetLab = labs.find(l => l.id === labId);
        if (!targetLab) return socket.emit('err', "Invalid Lab ID");

        // 1. Per-Lab Max Upload Size Enforcement
        const labMaxMb = targetLab.max_upload_mb || 75;
        if (Buffer.byteLength(fileData) > labMaxMb * 1024 * 1024) {
            return socket.emit('err', `File exceeds the maximum allowed size of ${labMaxMb}MB for this lab.`);
        }

        const lockKey = `lab_${userId}_${labId}`;
        if (global.submissionLocks.has(lockKey)) {
            return socket.emit('err', "A submission is currently processing. Please wait.");
        }
        global.submissionLocks.add(lockKey);

        try {
            // 2. Per-Lab Max Submissions Enforcement
            const maxSubs = targetLab.max_submissions || 0;
            if (maxSubs > 0) {
                const count = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?').get(userId, labId).c;
                if (count >= maxSubs) {
                    global.submissionLocks.delete(lockKey);
                    return socket.emit('err', "Submission limit reached.");
                }
            }

            // 3. Per-Lab Rate Limiting Enforcement
            const rateLimitCount = targetLab.rate_limit_count || 0;
            if (rateLimitCount > 0) {
                const win = targetLab.rate_limit_window_seconds || 60;
                // Check recent submissions ONLY for this specific lab, not across the whole platform
                const recent = db.prepare("SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ? AND timestamp > datetime('now', '-' || ? || ' seconds')").get(userId, labId, win).c;
                if (recent >= rateLimitCount) {
                    global.submissionLocks.delete(lockKey);
                    return socket.emit('err', "Rate limit exceeded. Please wait before submitting this lab again.");
                }
            }

            // 4. Per-Lab Max XML Output limit (pass to worker)
            const maxXmlMb = targetLab.max_xml_output_mb || (labMaxMb * 15);

            workerQueue.push({ 
                socket, 
                workerData: { fileData, configData: getRawConfig(), labId, maxXmlMb }, 
                lockKey, socketUser, targetLab 
            });
            processWorkerQueue();

        } catch (err) {
            global.submissionLocks.delete(lockKey);
            socket.emit('err', "Internal Server Error");
        }
    });
});

setInterval(() => {
    const capturesDir = path.join(__dirname, '../captures');
    if (fs.existsSync(capturesDir)) {
        const now = Date.now();
        fs.readdir(capturesDir, (err, files) => {
            if (err) return;
            files.forEach(file => {
                const filePath = path.join(capturesDir, file);
                fs.stat(filePath, (err, stats) => {
                    if (err) return;
                    if (now - stats.mtimeMs > 30 * 24 * 60 * 60 * 1000) fs.unlink(filePath, () => {});
                });
            });
        });
    }
}, 24 * 60 * 60 * 1000);

const PORT = 3000;
server.listen(PORT, () => console.log(`CSSS Server running on http://localhost:${PORT}`));