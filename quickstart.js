const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/** Best-effort .env permissions (Unix chmod; Windows icacls). Never throws. */
function restrictEnvFilePermissions(envPath) {
    try {
        if (process.platform === 'win32') {
            const r1 = spawnSync('icacls', [envPath, '/inheritance:r'], { windowsHide: true, stdio: 'ignore' });
            if (r1.error || r1.status !== 0) {
                throw new Error('Failed to remove inheritance on .env file (icacls error).');
            }
            const user = process.env.USERNAME;
            if (user) {
                const r2 = spawnSync('icacls', [envPath, '/grant:r', `${user}:(R,W)`], { windowsHide: true, stdio: 'ignore' });
                if (r2.error || r2.status !== 0) {
                    throw new Error('Failed to set .env file permissions (icacls error).');
                }
            }
        } else {
            fs.chmodSync(envPath, 0o600);
        }
    } catch (e) {
        console.warn('Warning: Could not restrict .env file permissions:', e.message);
    }
}
const bcrypt = require('bcryptjs');
const { sanitizeUsername, sanitizeEmail } = require('./src/sanitizeUserFields');
const { validatePasswordPolicy } = require('./src/passwordPolicy');
const { parseDiscordOAuthUrl } = require('./src/discordOAuth');
const { logAccountCreated, logPasswordChanged, logAdminChange, logOwnerGranted } = require('./src/auditLog');

const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise(resolve => readline.question(query, resolve));
const askBool = async (query, defaultYes = false) => {
    const hint = defaultYes ? 'y' : 'n';
    let ans = await question(`${query} (y/n) [${hint}]: `);
    const trimmed = ans.trim().toLowerCase();
    if (trimmed === '') return defaultYes ? 'true' : 'false';
    return trimmed === 'y' ? 'true' : 'false';
};

const askProxyType = async () => {
    console.log('\nWhich proxy setup matches your deployment?');
    console.log('  1) Reverse proxy — terminates TLS or routes on this machine / localhost');
    console.log('     Examples: nginx, Apache, Caddy, ngrok');
    console.log('     → TRUST_PROXY=loopback');
    console.log('  2) Cloud platform — provider edge or load balancer in front of the app');
    console.log('     Examples: Koyeb, Railway, Render, Fly.io');
    console.log('     → TRUST_PROXY=1\n');
    while (true) {
        const ans = (await question('Choose 1 or 2 [1]: ')).trim();
        if (ans === '' || ans === '1') return 'reverse';
        if (ans === '2') return 'cloud';
        console.log('Please enter 1 or 2.');
    }
};

(async () => {
    const envFile = path.join(__dirname, '.env');
    const secret = crypto.randomBytes(64).toString('hex');

    let envContent = '';
    if (fs.existsSync(envFile)) {
        envContent = fs.readFileSync(envFile, 'utf-8');
    }

    console.log("======================================");
    console.log("       CSSS Configuration Setup       ");
    console.log("======================================\n");

    const appTitle = await question('Application title (shown on login and dashboard) [CSSS ENGINE]: ');
    const retainPka = await askBool('Retain student .pka files on the server?');
    const retainXml = await askBool('Retain decompressed .xml grading files on the server?');
    const showLeaderboard = await askBool('Enable global leaderboard?');
    const showHistory = await askBool('Enable History tab for students?');
    const enableDiscordAuth = await askBool('Enable Discord authentication?');
    const allowRegistration = enableDiscordAuth === 'true'
        ? 'false'
        : await askBool('Allow new user registrations?');
    const behindProxy = await askBool('Will CSSS run behind a proxy (not direct public access)?');

    const replaceOrAdd = (key, value) => {
        const regex = new RegExp(`^${key}=.*`, 'm');
        const line = `${key}=${value}`;
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, () => line);
        } else {
            envContent += `\n${line}\n`;
        }
    };

    const removeEnvKey = (key) => {
        envContent = envContent.replace(new RegExp(`^${key}=.*\n?`, 'gm'), '');
    };

    let discordSetup = null;
    if (enableDiscordAuth === 'true') {
        console.log('\n--- Discord OAuth setup ---');
        console.log('1. Open https://discord.com/developers/applications and select your app.');
        console.log('2. OAuth2 → URL Generator: enable the identify scope.');
        console.log('3. Add this redirect URI (required):');
        console.log('   https://<your-host>/api/auth/discord/callback');
        console.log('   (localhost example: http://localhost:10000/api/auth/discord/callback)');
        console.log('4. Copy the generated OAuth URL and paste it below.\n');

        while (!discordSetup) {
            const oauthUrl = await question('Paste the generated Discord OAuth URL: ');
            try {
                discordSetup = parseDiscordOAuthUrl(oauthUrl);
            } catch (e) {
                console.log(`Invalid OAuth URL: ${e.message}`);
            }
        }

        let clientSecret = '';
        while (!clientSecret.trim()) {
            clientSecret = await question('Discord client secret (DISCORD_CLIENT_SECRET): ');
            if (!clientSecret.trim()) {
                console.log('Client secret is required when Discord auth is enabled.');
            }
        }
        discordSetup.clientSecret = clientSecret.trim();
    }

    replaceOrAdd('SESSION_SECRET', secret);
    replaceOrAdd('NODE_ENV', 'production');
    replaceOrAdd('APP_TITLE', appTitle.trim() || 'CSSS ENGINE');
    replaceOrAdd('RETAIN_PKA', retainPka);
    replaceOrAdd('RETAIN_XML', retainXml);
    replaceOrAdd('SHOW_LEADERBOARD', showLeaderboard);
    replaceOrAdd('SHOW_HISTORY', showHistory);
    replaceOrAdd('ALLOW_REGISTRATION', allowRegistration);
    replaceOrAdd('DEFAULT_MAX_UPLOAD_MB', '50');

    if (enableDiscordAuth === 'true' && discordSetup) {
        replaceOrAdd('DISCORD_AUTH_ENABLED', 'true');
        replaceOrAdd('DISCORD_CLIENT_ID', discordSetup.clientId);
        replaceOrAdd('DISCORD_CLIENT_SECRET', discordSetup.clientSecret);
        replaceOrAdd('DISCORD_REDIRECT_URI', discordSetup.redirectUri);
        replaceOrAdd('DISCORD_OAUTH_SCOPE', discordSetup.scope);
    } else {
        replaceOrAdd('DISCORD_AUTH_ENABLED', 'false');
        removeEnvKey('DISCORD_CLIENT_ID');
        removeEnvKey('DISCORD_CLIENT_SECRET');
        removeEnvKey('DISCORD_REDIRECT_URI');
        removeEnvKey('DISCORD_OAUTH_SCOPE');
    }

    let trustProxyValue = null;
    if (behindProxy === 'true') {
        const proxyType = await askProxyType();
        trustProxyValue = proxyType === 'cloud' ? '1' : 'loopback';
        replaceOrAdd('TRUST_PROXY', trustProxyValue);
    } else {
        envContent = envContent.replace(/^TRUST_PROXY=.*\n?/gm, '');
    }

    envContent = envContent.replace(/^MAX_UPLOAD_MB=.*\n?/gm, '');
    envContent = envContent.replace(/^MAX_XML_OUTPUT_MB=.*\n?/gm, '');

    envContent = envContent.replace(/\n\n+/g, '\n').trim() + '\n';
    fs.writeFileSync(envFile, envContent, 'utf-8');
    restrictEnvFilePermissions(envFile);

    console.log('\n--- Configuration Saved to .env ---');
    if (enableDiscordAuth === 'true' && discordSetup) {
        console.log('DISCORD_AUTH_ENABLED=true');
        console.log(`DISCORD_REDIRECT_URI=${discordSetup.redirectUri}`);
        console.log('Password login and registration are disabled; students sign in with Discord.');
        console.log('(Client ID and secret saved; not shown here.)');
    } else {
        console.log('DISCORD_AUTH_ENABLED=false');
    }
    if (behindProxy === 'true') {
        console.log(`TRUST_PROXY=${trustProxyValue}`);
    } else {
        console.log('TRUST_PROXY: unset (direct access — no proxy)');
    }
    console.log('');

    const createOwner = enableDiscordAuth !== 'true' && await askBool('Would you like to create an Owner account now?');
    if (enableDiscordAuth === 'true') {
        console.log('\nOwner setup: sign in with Discord after starting the server, then use `node tool.js`');
        console.log('to grant owner/admin to your account.');
    }
    if (createOwner === 'true') {
        const db = require('./src/database.js');

        const adminUser = sanitizeUsername(await question('Owner Username: '));
        const adminEmailRaw = await question('Owner Email [admin@localhost]: ');
        const adminEmail = adminEmailRaw.trim() === ''
            ? 'admin@localhost'
            : sanitizeEmail(adminEmailRaw);
        if (!adminUser) {
            console.error('\nERROR: Invalid owner username (ASCII letters, numbers, . _ - only).');
            readline.close();
            process.exit(1);
        }
        if (!adminEmail) {
            console.error('\nERROR: Invalid owner email address.');
            readline.close();
            process.exit(1);
        }
        let adminPass = '';
        let passPolicy;
        do {
            adminPass = await question('Owner Password (min 8 chars, 1 uppercase, 1 number, 1 symbol): ');
            passPolicy = validatePasswordPolicy(adminPass);
            if (!passPolicy.ok) {
                console.log('Password policy violation: ' + passPolicy.error);
            }
        } while (!passPolicy.ok);

        try {
            const hash = bcrypt.hashSync(adminPass, 10);
            const uid = crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
            
            const existing = db.prepare('SELECT id, is_admin, is_owner FROM users WHERE username = ?').get(adminUser);
            if (existing) {
                db.prepare('UPDATE users SET password = ?, email = ?, is_admin = 1, is_owner = 1 WHERE id = ?').run(hash, adminEmail || 'admin@localhost', existing.id);
                logPasswordChanged({
                    actorUserId: null,
                    targetUserId: existing.id,
                    targetUsername: adminUser,
                    source: 'quickstart',
                });
                if (!existing.is_owner) {
                    logOwnerGranted({
                        actorUserId: null,
                        targetUserId: existing.id,
                        username: adminUser,
                        source: 'quickstart',
                    });
                }
                if (!existing.is_admin) {
                    logAdminChange({
                        granted: true,
                        actorUserId: null,
                        targetUserId: existing.id,
                        username: adminUser,
                        source: 'quickstart',
                    });
                }
                console.log(`\nSUCCESS: Existing user '${adminUser}' was updated and promoted to Owner.`);
                console.log('This account has full admin access and can create other admin accounts.');
            } else {
                const info = db.prepare('INSERT INTO users (username, email, password, unique_id, is_admin, is_owner) VALUES (?, ?, ?, ?, 1, 1)')
                  .run(adminUser, adminEmail || 'admin@localhost', hash, uid);
                logAccountCreated({
                    actorUserId: null,
                    targetUserId: info.lastInsertRowid,
                    username: adminUser,
                    isAdmin: true,
                    isOwner: true,
                    source: 'quickstart',
                });
                console.log(`\nSUCCESS: Owner user '${adminUser}' created successfully.`);
                console.log('This account has full admin access and can create other admin accounts.');
            }
        } catch (e) {
            console.error("\nERROR creating owner:", e.message);
        }
    }

    console.log('\nSetup Complete! Run `npm start` to boot the server.\n');
    readline.close();
    process.exit(0);
})();