const { getXmlValue } = require('./parser');
function evaluateCondition(device, condition) {
    if (!device) return false;
    if (condition.type === 'XmlMatch') {
        const actual = getXmlValue(device.xmlRoot, condition.path);
        return actual == condition.value;
    }
    if (['ConfigMatch', 'ConfigContains', 'ConfigRegex'].includes(condition.type)) {
        const sourceCfg = condition.source === 'startup' ? device.startup : device.running;
        let targetLines = [];
        if (!condition.context || condition.context === 'global') targetLines = sourceCfg.global;
        else {
            const searchCtx = condition.context.toLowerCase().replace(/\s/g, '');
            const blockKey = Object.keys(sourceCfg.blocks).find(k => k.toLowerCase().replace(/\s/g, '') === searchCtx);
            if (blockKey) targetLines = sourceCfg.blocks[blockKey];
        }
        if (!targetLines) return false;
        if (condition.type === 'ConfigRegex') {
            try {
                const regex = new RegExp(condition.value);
                return targetLines.some(l => regex.test(l));
            } catch (e) { return false; }
        }
        if (condition.type === 'ConfigContains') {
            return targetLines.some(l => l.includes(condition.value));
        }
        if (condition.type === 'ConfigMatch') {
            if (condition.value.startsWith('^')) {
                const regex = new RegExp(condition.value);
                return targetLines.some(l => regex.test(l));
            }
            return targetLines.includes(condition.value);
        }
    }
    return false;
}
module.exports = { evaluateCondition };
