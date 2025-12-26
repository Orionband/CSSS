function getXmlValue(rootObj, pathArray) {
    let current = rootObj;
    for (let key of pathArray) {
        if (current === undefined || current === null) return null;
        if (Array.isArray(current)) {
            const isIndex = typeof key === 'number' || (typeof key === 'string' && /^\d+$/.test(key));
            if (isIndex) current = current[parseInt(key)];
            else {
                if (current.length === 1 && current[0] && current[0][key]) current = current[0][key];
                else current = current[key]; 
            }
        } else {
            current = current[key];
        }
    }
    if (current && typeof current === 'object' && '_' in current) return current._;
    if (Array.isArray(current) && current.length === 1 && (typeof current[0] === 'string' || typeof current[0] === 'number')) return current[0];
    if (Array.isArray(current) && current.length === 1 && current[0] && current[0]._) return current[0]._;
    return current;
}
function parseCiscoConfig(lines) {
    if (!lines || lines.length === 0) return { global: [], blocks: {} };
    const config = { global: [], blocks: {} };
    let currentBlock = null;
    lines.forEach(rawLine => {
        const line = typeof rawLine === 'string' ? rawLine : rawLine._;
        if (!line) return;
        const trimmed = line.trim();
        if (trimmed === '!' || trimmed === '' || trimmed === 'end') return;
        if (line.startsWith(' ')) {
            if (currentBlock) config.blocks[currentBlock].push(trimmed);
        } else {
            currentBlock = trimmed;
            if (!config.blocks[currentBlock]) config.blocks[currentBlock] = [];
            config.global.push(trimmed);
        }
    });
    return config;
}
module.exports = { getXmlValue, parseCiscoConfig };
