const path = require('path');

function purgeProjectCache() {
    const root = path.resolve(__dirname, '../..');
    for (const key of Object.keys(require.cache)) {
        if (!key.startsWith(root)) continue;
        if (key.includes(`${path.sep}node_modules${path.sep}`)) continue;
        delete require.cache[key];
    }
}

module.exports = { purgeProjectCache };
