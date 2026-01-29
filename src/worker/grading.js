const { getXmlValue } = require('./parser');

function evaluateCondition(device, condition) {
    if (!device) return false;

    // --- XML CHECKS ---
    // 1. XmlMatch: Strict Equality (Good for specific models, bools)
    if (condition.type === 'XmlMatch') {
        const actual = getXmlValue(device.xmlRoot, condition.path);
        return actual == condition.value;
    }

    // 2. XmlRegex: Pattern Match (Good for Serial Nums, Mac Addr, Version strings)
    if (condition.type === 'XmlRegex') {
        const actual = getXmlValue(device.xmlRoot, condition.path);
        if (actual === undefined || actual === null) return false;
        try {
            const re = new RegExp(condition.value);
            return re.test(String(actual));
        } catch (e) { return false; }
    }

    // --- CONFIG CHECKS ---
    if (['ConfigMatch', 'ConfigRegex'].includes(condition.type)) {
        const sourceCfg = condition.source === 'startup' ? device.startup : device.running;
        let targetLines = [];
        
        // Context Switching
        if (!condition.context || condition.context === 'global') {
            targetLines = sourceCfg.global;
        } else {
            const searchCtx = condition.context.toLowerCase().replace(/\s/g, '');
            const blockKey = Object.keys(sourceCfg.blocks).find(k => k.toLowerCase().replace(/\s/g, '') === searchCtx);
            if (blockKey) targetLines = sourceCfg.blocks[blockKey];
        }

        if (!targetLines) return false;

        // 3. ConfigRegex: Pattern Match (Good for dynamic IPs, Encrypted Passwords)
        if (condition.type === 'ConfigRegex') {
            try {
                const regex = new RegExp(condition.value);
                return targetLines.some(l => regex.test(l));
            } catch (e) { return false; }
        }

        // 4. ConfigMatch: Strict String Match (Good for specific commands)
        if (condition.type === 'ConfigMatch') {
            return targetLines.includes(condition.value);
        }
    }
    return false;
}

module.exports = { evaluateCondition };
