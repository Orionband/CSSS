'use strict';

const fs = require('fs');

const SESSION_SECRET_FILE = '/run/secrets/session_secret';
const DISCORD_SECRET_FILE = '/run/secrets/discord_client_secret';

function readSecretFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8').replace(/[\r\n]+$/, '');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

/**
 * Apply Docker Compose secret files to env. Fails closed when secrets are mounted
 * but the same keys are also set via .env / env_file (prevents silent override).
 */
function applyDockerSecrets(env = process.env, options = {}) {
    const sessionFile = options.sessionSecretFile ?? SESSION_SECRET_FILE;
    const discordFile = options.discordSecretFile ?? DISCORD_SECRET_FILE;
    const patches = {};
    const errors = [];

    const sessionFromFile = readSecretFile(sessionFile);
    if (sessionFromFile !== null) {
        if (env.SESSION_SECRET) {
            errors.push(
                'SESSION_SECRET is set in the environment but Docker secrets/session_secret is mounted. Remove SESSION_SECRET from .env.'
            );
        } else if (sessionFromFile.length < 32) {
            errors.push('secrets/session_secret must be at least 32 characters.');
        } else {
            patches.SESSION_SECRET = sessionFromFile;
        }
    }

    const discordFromFile = readSecretFile(discordFile);
    if (discordFromFile !== null) {
        if (env.DISCORD_CLIENT_SECRET) {
            errors.push(
                'DISCORD_CLIENT_SECRET is set in the environment but Docker secrets/discord_client_secret is mounted. Remove DISCORD_CLIENT_SECRET from .env.'
            );
        } else {
            patches.DISCORD_CLIENT_SECRET = discordFromFile;
        }
    }

    return { patches, errors };
}

module.exports = {
    applyDockerSecrets,
    readSecretFile,
    SESSION_SECRET_FILE,
    DISCORD_SECRET_FILE,
};
