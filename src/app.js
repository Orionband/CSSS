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
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50 * 1024 * 1024 }); //using 50 because of the module 1-13 size... how did you even get it that high...

const dotenv = require('dotenv');
dotenv.config();

app.use(express.json());

app.use(session({
    store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
    secret: process.env.SESSION_SECRET, // read secret from .env
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,  
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',        
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(express.static(path.join(__dirname, '../public')));

app.use('/api', authRoutes);
app.use('/api/quiz', quizRoutes);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));

io.on('connection', (socket) => {
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

    socket.on('upload_file', (packet) => {
        if (!socketUser) return socket.emit('err', "Unauthorized");
        
        const fileData = packet.fileData || packet;
        const cfg = getConfig();
        const labs = cfg.labs || [];
        const labId = packet.labId || (labs.length > 0 ? labs[0].id : null);
        const opts = cfg.options || {};
        const userId = socketUser.id;

        if (!labId) return socket.emit('err', "No configuration loaded.");

        const targetLab = labs.find(l => l.id === labId);
        if (!targetLab) return socket.emit('err', "Invalid Lab ID");

        if (opts.max_submissions > 0) {
            const count = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?').get(userId, labId).c;
            if (count >= opts.max_submissions) return socket.emit('err', "Submission limit reached.");
        }
        if (opts.rate_limit_count > 0) {
            const win = opts.rate_limit_window_seconds || 60;
            const recent = db.prepare("SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND timestamp > datetime('now', '-' || ? || ' seconds')").get(userId, win).c;
            if (recent >= opts.rate_limit_count) return socket.emit('err', "Rate limit exceeded.");
        }

        const worker = new Worker(path.join(__dirname, 'worker/worker.js'), { 
            workerData: { fileData, configData: getRawConfig(), labId: labId } 
        });

        worker.on('message', (msg) => {
            if (msg.type === 'progress') socket.emit('progress', msg);
            else if (msg.type === 'result') {
                const { grading } = msg;
                const timestamp = Date.now();
                const capturesDir = path.join(__dirname, '../captures');

                db.prepare('INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, details, type) VALUES (?, ?, ?, ?, ?, ?, ?)')
                  .run(userId, socketUser.unique_id, labId, grading.total, grading.max, JSON.stringify(grading.serverBreakdown), 'lab');

                if (opts.retain_pka || opts.retain_xml) {
                    if (!fs.existsSync(capturesDir)) fs.mkdirSync(capturesDir, { recursive: true });
                    const safeTitle = targetLab.title.replace(/[^a-z0-9]/gi, '_');
                    const baseName = `${safeTitle}_${socketUser.unique_id}_${timestamp}`;
                    if (opts.retain_pka) fs.writeFileSync(path.join(capturesDir, `${baseName}.pka`), Buffer.from(fileData));
                    if (opts.retain_xml) fs.writeFileSync(path.join(capturesDir, `${baseName}.xml`), msg.xml);
                }

                // --- SECURITY SANITIZATION ---
                const payload = { 
                    total: grading.total,
                    max: grading.max,
                    clientBreakdown: grading.clientBreakdown,
                    show_score: grading.show_score
                };

                // If score is hidden, scrub it from the packet entirely
                if (!grading.show_score) {
                    delete payload.total;
                    delete payload.max;
                }

                socket.emit('result', payload);
                worker.terminate();
            } else if (msg.type === 'error') {
                socket.emit('err', msg.msg);
                worker.terminate();
            }
        });
        
        worker.on('error', (e) => socket.emit('err', "Worker Error: " + e.message));
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`CSSS Server running on http://localhost:${PORT}`));
