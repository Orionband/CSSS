// quickstart.js 
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envFile = path.join(__dirname, '.env');
const secret = crypto.randomBytes(64).toString('hex');

let envContent = '';
if (fs.existsSync(envFile)) {
    envContent = fs.readFileSync(envFile, 'utf-8');
}

// Replace or add SESSION_SECRET
if (/^SESSION_SECRET=.*/m.test(envContent)) {
    envContent = envContent.replace(/^SESSION_SECRET=.*/m, `SESSION_SECRET=${secret}`);
} else {
    envContent += `\nSESSION_SECRET=${secret}\n`;
}

// Replace or add NODE_ENV
if (/^NODE_ENV=.*/m.test(envContent)) {
    envContent = envContent.replace(/^NODE_ENV=.*/m, `NODE_ENV=production`);
} else {
    envContent += `NODE_ENV=production\n`;
}

fs.writeFileSync(envFile, envContent, 'utf-8');

console.log('SESSION_SECRET generated and saved to .env'); 
console.log('NODE_ENV set to production'); 
console.log('Secret:', secret);
