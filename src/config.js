const fs = require('fs');
const toml = require('toml');
const path = require('path');

let config = { options: {}, labs: [] };
let rawConfig = "";

function reloadConfig() {
    try {
        const configPath = path.resolve(__dirname, '../lab.conf');
        if (!fs.existsSync(configPath)) {
            throw new Error(`File not found at: ${configPath}`);
        }
        rawConfig = fs.readFileSync(configPath, 'utf-8');
        if (rawConfig.charCodeAt(0) === 0xFEFF) { rawConfig = rawConfig.slice(1); }
        config = toml.parse(rawConfig);
        console.log("CSSS Config loaded.");
    } catch (e) {
        console.warn("WARNING: lab.conf error.");
        console.error(`   Details: ${e.message}`);
    }
}
reloadConfig();

module.exports = { getConfig: () => config, getRawConfig: () => rawConfig };
