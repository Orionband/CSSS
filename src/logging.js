const crypto = require('crypto');

let pinoLogger = null;

function initLogger(options = {}) {
    try {
        const pino = require('pino');
        pinoLogger = pino({
            level: process.env.LOG_LEVEL || 'info',
            ...options,
        });
    } catch {
        pinoLogger = null;
    }
    return pinoLogger;
}

function getLogger() {
    if (!pinoLogger) initLogger();
    return pinoLogger;
}

function generateRequestId() {
    return crypto.randomBytes(8).toString('hex');
}

function requestIdMiddleware(req, res, next) {
    const incoming = req.headers['x-request-id'];
    req.requestId = (typeof incoming === 'string' && incoming.length <= 64) ? incoming : generateRequestId();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}

function logInfo(msg, fields = {}) {
    const logger = getLogger();
    if (logger) logger.info(fields, msg);
    else console.log(msg, Object.keys(fields).length ? fields : '');
}

function logError(msg, fields = {}) {
    const logger = getLogger();
    if (logger) logger.error(fields, msg);
    else console.error(msg, Object.keys(fields).length ? fields : '');
}

function logWarn(msg, fields = {}) {
    const logger = getLogger();
    if (logger) logger.warn(fields, msg);
    else console.warn(msg, Object.keys(fields).length ? fields : '');
}

module.exports = {
    initLogger,
    getLogger,
    generateRequestId,
    requestIdMiddleware,
    logInfo,
    logError,
    logWarn,
};
