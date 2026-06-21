const { getXmlValue } = require('./parser');
const CryptMD5 = require('cryptmd5');
const crypto = require('crypto');
const RE2 = require('re2');

function safeRegex(pattern, flags) {
  return new RE2(pattern, flags);
}

function verifyType5(password, storedHash) {
    if (typeof storedHash !== 'string' || !storedHash.startsWith('$1$')) {
        return false;
    }

    const parts = storedHash.split('$');
    if (parts.length < 4 || !parts[2] || !parts[3]) {
        return false;
    }

    const salt = parts[2].substring(0, 8);
    try {
        const computed = CryptMD5.cryptMD5(password, salt);
        
        const a = Buffer.from(computed);
        const b = Buffer.from(storedHash);
        
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch (e) {
        return false;
    }
}

function evaluateCondition(device, condition) {
    if (!device) return false;

    let type = condition.type;
    if (typeof type !== 'string' || type.length === 0) return false;
    let isNegated = false;

    if (type.endsWith('Not')) {
        isNegated = true;
        type = type.slice(0, -3);
    }

    let result = false;

    if (type === 'XmlMatch') {
        const actual = getXmlValue(device.xmlRoot, condition.path);
        
        if (actual !== undefined && actual !== null) {
            result = String(actual).trim() === String(condition.value).trim();
        }
    }
    else if (type === 'XmlRegex') {
        const actual = getXmlValue(device.xmlRoot, condition.path);
        if (actual !== undefined && actual !== null) {
            try {
                const re = safeRegex(condition.value);
                result = re.test(String(actual));
            } catch (e) { result = false; }
        }
    }

    else if (['ConfigMatch', 'ConfigRegex'].includes(type)) {
        const sourceCfg = condition.source === 'startup' ? device.startup : device.running;
        let targetLines = [];
        
        if (!condition.context || condition.context === 'global') {
            targetLines = sourceCfg.global;
        } else {
            const searchCtx = condition.context.toLowerCase().replace(/\s/g, '');
            const blockKey = Object.keys(sourceCfg.blocks).find(k => k.toLowerCase().replace(/\s/g, '') === searchCtx);
            if (blockKey) targetLines = sourceCfg.blocks[blockKey];
        }

        if (targetLines) {
            if (type === 'ConfigRegex') {
                try {
                    const regex = safeRegex(condition.value);
                    result = targetLines.some(l => regex.test(l));
                } catch (e) { result = false; }
            }
            else if (type === 'ConfigMatch') {
                result = targetLines.includes(condition.value);
            }
        }
    }

    else if (type === 'Type5Match') {
        const sourceCfg = condition.source === 'startup' ? device.startup : device.running;
        let targetLines = sourceCfg.global || [];
        let hashToVerify = null;

        if (condition.mode === 'device') {
            const regex = /^enable\s+secret\s+5\s+(\$1\$.+)$/i;
            for (const line of targetLines) {
                const match = line.match(regex);
                if (match) {
                    hashToVerify = match[1];
                    break;
                }
            }
        } else if (condition.mode === 'user') {
            const escapedUser = (condition.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = safeRegex(`^username\\s+${escapedUser}\\s+(?:\\S+\\s+)*secret\\s+5\\s+(\\$1\\$.+)$`, 'i');
            for (const line of targetLines) {
                const match = line.match(regex);
                if (match) {
                    hashToVerify = match[1];
                    break;
                }
            }
        }

        if (hashToVerify) {
            result = verifyType5(condition.password || '', hashToVerify);
        } else {
            result = false;
        }
    }

    return isNegated ? !result : result;
}

module.exports = { evaluateCondition };
