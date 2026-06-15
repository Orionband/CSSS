const { parseCiscoConfig } = require('../../src/worker/parser');

function mockDevice({ xmlRoot = {}, runningLines = [], startupLines = [] } = {}) {
    return {
        xmlRoot,
        running: parseCiscoConfig(runningLines),
        startup: parseCiscoConfig(startupLines),
    };
}

module.exports = { mockDevice };
