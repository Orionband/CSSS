const DEFAULT_MAX_ELEMENTS = 250000;
const DEFAULT_MAX_DEPTH = 48;
const DEFAULT_MAX_PARSED_NODES = 500000;

/**
 * Lightweight pre-parse scan: count elements and nesting without building a DOM.
 */
function validateXmlParseBudget(xml, opts = {}) {
    const maxElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS;
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const len = xml.length;
    let depth = 0;
    let elements = 0;

    for (let i = 0; i < len; i++) {
        if (xml.charCodeAt(i) !== 60) continue;

        const c1 = xml.charCodeAt(i + 1);
        if (c1 === 33) {
            if (xml.startsWith('!--', i + 2)) {
                const end = xml.indexOf('-->', i + 5);
                i = end === -1 ? len - 1 : end + 2;
                continue;
            }
            const gt = xml.indexOf('>', i + 2);
            i = gt === -1 ? len - 1 : gt;
            continue;
        }
        if (c1 === 63) {
            const end = xml.indexOf('?>', i + 2);
            i = end === -1 ? len - 1 : end + 1;
            continue;
        }
        if (c1 === 47) {
            depth--;
            if (depth < 0) throw new Error('Invalid XML structure.');
            const gt = xml.indexOf('>', i + 2);
            i = gt === -1 ? len - 1 : gt;
            continue;
        }

        const gt = xml.indexOf('>', i + 1);
        if (gt === -1) throw new Error('Invalid XML structure.');

        elements++;
        if (elements > maxElements) {
            throw new Error('XML exceeds element limit.');
        }

        const tagSlice = xml.slice(i, gt + 1);
        const selfClosing = /\/\s*>$/.test(tagSlice);
        if (!selfClosing) {
            depth++;
            if (depth > maxDepth) {
                throw new Error('XML exceeds nesting depth.');
            }
        }
        i = gt;
    }
}

function walkParsedXmlBudget(node, budget) {
    if (budget.remaining <= 0) {
        throw new Error('XML exceeds parse size limit.');
    }
    budget.remaining--;

    if (node === null || node === undefined) return;
    if (typeof node !== 'object') return;

    if (Array.isArray(node)) {
        for (const item of node) walkParsedXmlBudget(item, budget);
        return;
    }

    for (const key of Object.keys(node)) {
        walkParsedXmlBudget(node[key], budget);
    }
}

function assertParsedXmlWithinBudget(root, maxNodes = DEFAULT_MAX_PARSED_NODES) {
    walkParsedXmlBudget(root, { remaining: maxNodes });
}

module.exports = {
    validateXmlParseBudget,
    assertParsedXmlWithinBudget,
    DEFAULT_MAX_ELEMENTS,
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_PARSED_NODES,
};
