const dotenv = require('dotenv');
dotenv.config();

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    console.error('FATAL: SESSION_SECRET is missing or too short (minimum 32 characters). Refusing to start.');
    console.error('Run `node quickstart.js` to generate a .env file with a secure SESSION_SECRET.');
    process.exit(1);
}

const { initLogger } = require('./logging');
initLogger();

const { createApp } = require('./server/createApp');

const runtime = createApp();
let stopping = false;

async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}, shutting down...`);
    try {
        await runtime.stop();
    } catch (e) {
        console.error('Shutdown error:', e.message);
    }
    process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

runtime.start().catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
});

module.exports = runtime;
