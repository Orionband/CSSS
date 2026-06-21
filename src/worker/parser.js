function getXmlValue(rootObj, pathArray) {

    let current = rootObj;

    for (let i = 0; i < pathArray.length; i++) {

        let key = pathArray[i];

        if (current === undefined || current === null) return null;



        if (Array.isArray(current)) {

            const isIndex = typeof key === 'number' || (typeof key === 'string' && /^\d+$/.test(key));

            if (isIndex) {

                current = current[parseInt(key)];

            } else {

                if (current.length === 1 && current[0] && typeof current[0] === 'object' && current[0][key] !== undefined) {

                    current = current[0][key];

                } else {

                    current = current[key];

                }

            }

        } else if (typeof current === 'object') {

            current = current[key];

        } else {

            return null;

        }

    }



    return unwrapValue(current);

}



/**

 * Unwrap xml2js value representations:

 * - { _: "text", $: { attr: "val" } } => "text"

 * - ["single"] => "single"

 * - [{ _: "text" }] => "text"

 * - primitive => primitive

 */

function unwrapValue(val) {

    if (val === undefined || val === null) return val;



    if (Array.isArray(val)) {

        if (val.length === 1) {

            return unwrapValue(val[0]);

        }

        return val;

    }



    if (typeof val === 'object' && '_' in val) {

        return val._;

    }



    return val;

}



function configLineText(rawLine) {

    if (rawLine == null) return null;

    if (typeof rawLine === 'string') return rawLine;

    if (typeof rawLine === 'object' && '_' in rawLine) {

        const inner = rawLine._;

        if (inner == null) return null;

        return typeof inner === 'string' ? inner : String(inner);

    }

    if (typeof rawLine === 'number' || typeof rawLine === 'boolean') return String(rawLine);

    return null;

}



function parseCiscoConfig(lines) {

    if (!lines || lines.length === 0) return { global: [], blocks: Object.create(null) };

    const config = { global: [], blocks: Object.create(null) };

    let currentBlock = null;

    lines.forEach(rawLine => {

        const line = configLineText(rawLine);

        if (line == null || line === '') return;

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

