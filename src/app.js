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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.use(express.json());
app.use(session({
    store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
    secret: 'csss-secure-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Serve Static Files (CSS/JS) from root
app.use(express.static(path.join(__dirname, '../')));

app.use('/api', authRoutes);
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

    socket.on('upload_file', (fileData) => {
        if (!socketUser) return socket.emit('err', "Unauthorized");

        const opts = getConfig().options || {};
        const userId = socketUser.id;

        if (opts.max_submissions > 0) {
            const count = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ?').get(userId).c;
            if (count >= opts.max_submissions) return socket.emit('err', "Submission limit reached.");
        }

        if (opts.rate_limit_count > 0) {
            const win = opts.rate_limit_window_seconds || 60;
            const recent = db.prepare(`SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND timestamp > datetime('now', '-${win} seconds')`).get(userId).c;
            if (recent >= opts.rate_limit_count) return socket.emit('err', "Rate limit exceeded.");
        }

        const worker = new Worker(path.join(__dirname, 'worker/worker.js'), { 
            workerData: { fileData, configData: getRawConfig() } 
        });

        worker.on('message', (msg) => {
            if (msg.type === 'progress') socket.emit('progress', msg);
            else if (msg.type === 'result') {
                const { grading } = msg;
                const timestamp = Date.now();
                const capturesDir = path.join(__dirname, '../../captures');

                db.prepare('INSERT INTO submissions (user_id, unique_id, score, max_score, details) VALUES (?, ?, ?, ?, ?)')
                  .run(userId, socketUser.unique_id, grading.total, grading.max, JSON.stringify(grading.serverBreakdown));

                if (opts.retain_pka || opts.retain_xml) {
                    if (!fs.existsSync(capturesDir)) fs.mkdirSync(capturesDir);
                    const baseName = `${socketUser.unique_id}_${timestamp}`;
                    if (opts.retain_pka) fs.writeFileSync(path.join(capturesDir, `${baseName}.pka`), Buffer.from(fileData));
                    if (opts.retain_xml) fs.writeFileSync(path.join(capturesDir, `${baseName}.xml`), msg.xml);
                }

                delete msg.xml;
                delete grading.serverBreakdown;
                socket.emit('result', grading);
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
server.listen(PORT, () => console.log(`🚀 CSSS Server running on http://localhost:${PORT}`));
