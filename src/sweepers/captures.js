const fs = require('fs');
const path = require('path');

function startCapturesSweeper(capturesDir, intervalMs = 24 * 60 * 60 * 1000) {
    const handle = setInterval(() => {
        if (fs.existsSync(capturesDir)) {
            const now = Date.now();
            fs.readdir(capturesDir, (err, files) => {
                if (err) return;
                files.forEach((file) => {
                    const filePath = path.join(capturesDir, file);
                    fs.stat(filePath, (statErr, stats) => {
                        if (statErr) return;
                        if (now - stats.mtimeMs > 30 * 24 * 60 * 60 * 1000) fs.unlink(filePath, () => {});
                    });
                });
            });
        }
    }, intervalMs);

    if (typeof handle.unref === 'function') handle.unref();
    return handle;
}

module.exports = { startCapturesSweeper };
