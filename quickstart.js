const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise(resolve => readline.question(query, resolve));
const askBool = async (query) => {
    let ans = await question(`${query} (y/n) [n]: `);
    return ans.trim().toLowerCase() === 'y' ? 'true' : 'false';
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
    const allowRegistration = await askBool('Allow new user registrations?');

    const replaceOrAdd = (key, value) => {
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
            envContent += `\n${key}=${value}\n`;
        }
    };

    replaceOrAdd('SESSION_SECRET', secret);
    replaceOrAdd('NODE_ENV', 'production');
    replaceOrAdd('APP_TITLE', appTitle.trim() || 'CSSS ENGINE');
    replaceOrAdd('RETAIN_PKA', retainPka);
    replaceOrAdd('RETAIN_XML', retainXml);
    replaceOrAdd('SHOW_LEADERBOARD', showLeaderboard);
    replaceOrAdd('SHOW_HISTORY', showHistory);
    replaceOrAdd('ALLOW_REGISTRATION', allowRegistration);
    replaceOrAdd('BIND_HOST', '127.0.0.1');
    replaceOrAdd('DEFAULT_MAX_UPLOAD_MB', '50');

    envContent = envContent.replace(/^MAX_UPLOAD_MB=.*\n?/gm, '');
    envContent = envContent.replace(/^MAX_XML_OUTPUT_MB=.*\n?/gm, '');

    envContent = envContent.replace(/\n\n+/g, '\n').trim() + '\n';
    fs.writeFileSync(envFile, envContent, 'utf-8');

    console.log('\n--- Configuration Saved to .env ---\n');

    // ADMIN ACCOUNT CREATION
    const createAdmin = await askBool('Would you like to create an Admin account now?');
    if (createAdmin === 'true') {
        const db = require('./src/database.js'); // Initializes DB and runs migrations

        const adminUser = await question('Admin Username: ');
        const adminEmail = await question('Admin Email [admin@localhost]: ');
        let adminPass = '';
        while(adminPass.length < 8) {
            adminPass = await question('Admin Password (min 8 chars): ');
        }

        try {
            const hash = bcrypt.hashSync(adminPass, 10);
            const uid = crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
            
            const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUser);
            if (existing) {
                db.prepare('UPDATE users SET password = ?, email = ?, is_admin = 1 WHERE id = ?').run(hash, adminEmail || 'admin@localhost', existing.id);
                console.log(`\nSUCCESS: Existing user '${adminUser}' was updated and promoted to Admin.`);
            } else {
                db.prepare('INSERT INTO users (username, email, password, unique_id, is_admin) VALUES (?, ?, ?, ?, 1)')
                  .run(adminUser, adminEmail || 'admin@localhost', hash, uid);
                console.log(`\nSUCCESS: Admin user '${adminUser}' created successfully.`);
            }
        } catch (e) {
            console.error("\nERROR creating admin:", e.message);
        }
    }

    console.log('\nSetup Complete! Run `npm start` to boot the server.\n');
    readline.close();
    process.exit(0);
})();