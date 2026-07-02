'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { applyDockerSecrets, readSecretFile } = require('../../docker/secretEnv');

describe('docker secretEnv', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csss-secret-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads SESSION_SECRET from a mounted secret file', () => {
        const sessionFile = path.join(tmpDir, 'session_secret');
        fs.writeFileSync(sessionFile, `${'a'.repeat(32)}\n`);

        const { patches, errors } = applyDockerSecrets({}, { sessionSecretFile: sessionFile });
        assert.equal(errors.length, 0);
        assert.equal(patches.SESSION_SECRET, 'a'.repeat(32));
    });

    it('rejects SESSION_SECRET in env when a secret file is mounted', () => {
        const sessionFile = path.join(tmpDir, 'session_secret');
        fs.writeFileSync(sessionFile, `${'b'.repeat(32)}`);

        const { errors } = applyDockerSecrets(
            { SESSION_SECRET: 'from-dotenv-should-not-be-here-xxxxxxxx' },
            { sessionSecretFile: sessionFile }
        );
        assert.equal(errors.length, 1);
        assert.match(errors[0], /Remove SESSION_SECRET from \.env/);
    });

    it('rejects secret files shorter than 32 characters', () => {
        const sessionFile = path.join(tmpDir, 'session_secret');
        fs.writeFileSync(sessionFile, 'short');

        const { errors } = applyDockerSecrets({}, { sessionSecretFile: sessionFile });
        assert.equal(errors.length, 1);
        assert.match(errors[0], /at least 32 characters/);
    });

    it('loads DISCORD_CLIENT_SECRET when file is mounted and env is clear', () => {
        const discordFile = path.join(tmpDir, 'discord_client_secret');
        fs.writeFileSync(discordFile, 'discord-secret-value');

        const { patches, errors } = applyDockerSecrets({}, { discordSecretFile: discordFile });
        assert.equal(errors.length, 0);
        assert.equal(patches.DISCORD_CLIENT_SECRET, 'discord-secret-value');
    });

    it('rejects DISCORD_CLIENT_SECRET in env when secret file is mounted', () => {
        const discordFile = path.join(tmpDir, 'discord_client_secret');
        fs.writeFileSync(discordFile, 'from-file');

        const { errors } = applyDockerSecrets(
            { DISCORD_CLIENT_SECRET: 'from-env' },
            { discordSecretFile: discordFile }
        );
        assert.equal(errors.length, 1);
        assert.match(errors[0], /Remove DISCORD_CLIENT_SECRET from \.env/);
    });

    it('readSecretFile strips trailing newlines', () => {
        const filePath = path.join(tmpDir, 'secret');
        fs.writeFileSync(filePath, 'value-with-newline\n\r\n');

        assert.equal(readSecretFile(filePath), 'value-with-newline');
    });

    it('readSecretFile returns null for missing files', () => {
        assert.equal(readSecretFile(path.join(tmpDir, 'missing')), null);
    });

    it('readSecretFile returns null when the file disappears before read', () => {
        const filePath = path.join(tmpDir, 'vanishing');
        fs.writeFileSync(filePath, 'x');
        const originalReadFileSync = fs.readFileSync;
        fs.readFileSync = (p, ...args) => {
            if (p === filePath) {
                fs.rmSync(filePath, { force: true });
            }
            return originalReadFileSync(p, ...args);
        };
        try {
            assert.equal(readSecretFile(filePath), null);
        } finally {
            fs.readFileSync = originalReadFileSync;
        }
    });
});
