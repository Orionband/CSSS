const { getXmlValue } = require('./parser');

function evaluateCondition(device, condition) {
    if (!device) return false;

    // Detect Negation
    let type = condition.type;
    let isNegated = false;

    if (type.endsWith('Not')) {
        isNegated = true;
        type = type.slice(0, -3); // Remove "Not" suffix
    }

    let result = false;

    // --- XML CHECKS ---
    if (type === 'XmlMatch') {
        const actual = getXmlValue(device.xmlRoot, condition.path);
        // Loose equality
        result = (actual == condition.value);
    }
    else if (type === 'XmlRegex') {
        const actual = getXmlValue(device.xmlRoot, condition.path);
        if (actual !== undefined && actual !== null) {
            try {
                const re = new RegExp(condition.value);
                result = re.test(String(actual));
            } catch (e) { result = false; }
        }
    }

    // --- CONFIG CHECKS ---
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

        // If lines exist, check them
        if (targetLines) {
            if (type === 'ConfigRegex') {
                try {
                    const regex = new RegExp(condition.value);
                    result = targetLines.some(l => regex.test(l));
                } catch (e) { result = false; }
            }
            else if (type === 'ConfigMatch') {
                result = targetLines.includes(condition.value);
            }
        }
    }

    // Return result (inverted if Negated)
    return isNegated ? !result : result;
}

module.exports = { evaluateCondition };
