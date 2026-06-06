const zlib = require('zlib');
const fs = require('fs');
const crypto = require('crypto');
const { xor, cmac, decryptCTRWithFinalXor, PKT_N_TAG, PKT_H_TAG } = require('./crypto');
const { parseCiscoConfig } = require('./parser');
const { evaluateCondition } = require('./grading');
const { parseXmlForGrading } = require('./xmlLimits');
const { ensureArray } = require('../limits');

function stripDoctypeCompletely(xml) {
    if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
        throw new Error("Invalid XML: DOCTYPE and ENTITY declarations are strictly forbidden.");
    }
    return xml;
}

function sanitizeErrorMessage(rawMessage) {
    if (!rawMessage) return "An unknown error occurred during grading.";

    const msg = rawMessage.toLowerCase();

    if (msg.includes('file integrity failed')) return "File integrity check failed. The file may be corrupted.";
    if (msg.includes('element limit') || msg.includes('attribute limit') || msg.includes('nesting depth') || msg.includes('invalid xml structure')) {
        return "The file exceeds size or complexity limits.";
    }
    if (msg.includes('decompression failed') || msg.includes('too large')) return "File decompression failed or exceeds size limits.";
    if (msg.includes('lab configuration not found')) return "Lab configuration not found for the selected lab.";
    if (msg.includes('unexpected end')) return "The uploaded file appears to be incomplete or corrupted.";
    if (msg.includes('invalid xml') || msg.includes('not well-formed') || msg.includes('xml')) return "The file contains invalid or malformed data.";
    if (msg.includes('toml') || msg.includes('parse')) return "Server configuration error. Contact your instructor.";

    return "An error occurred while processing your submission.";
}

function collectRequiredDeviceNames(checks) {
    const names = new Set();
    for (const check of ensureArray(checks)) {
        if (check.device) names.add(check.device);
    }
    return names;
}

function getDeviceName(d) {
    const nameObj = d.ENGINE[0].NAME[0];
    return String(nameObj._ || nameObj).trim();
}

function buildDeviceMap(devList, requiredDevices) {
    const devMap = Object.create(null);
    const filterByChecks = requiredDevices.size > 0;

    devList.forEach((d) => {
        const name = getDeviceName(d);
        if (filterByChecks && !requiredDevices.has(name)) return;

        devMap[name] = {
            xmlRoot: d.ENGINE[0],
            running: parseCiscoConfig(d.ENGINE?.[0]?.RUNNINGCONFIG?.[0]?.LINE || []),
            startup: parseCiscoConfig(d.ENGINE?.[0]?.STARTUPCONFIG?.[0]?.LINE || []),
        };
    });

    return devMap;
}

function loadInputBuffer(job) {
    if (job.fileBuffer) {
        return Buffer.isBuffer(job.fileBuffer) ? job.fileBuffer : Buffer.from(job.fileBuffer);
    }
    if (job.tempFilePath) {
        return fs.readFileSync(job.tempFilePath);
    }
    throw new Error("No submission data provided.");
}

/**
 * @param {object} job - labConfig, maxXmlMb, retainXml, fileBuffer or tempFilePath
 * @param {(msg: object) => void} emit
 */
async function runGrade(job, emit) {
    const { labConfig, maxXmlMb, retainXml } = job;
    if (!labConfig) throw new Error("Lab configuration not found.");

    const inputBuffer = loadInputBuffer(job);
    const totalBytes = inputBuffer.length;
    const safeTotal = totalBytes > 0 ? totalBytes : 1;

    const report = (stage, pct) => {
        const safePct = (typeof pct === 'number' && !isNaN(pct)) ? pct : 0;
        emit({ type: 'progress', stage, percent: safePct });
    };

    let finalXML = "";
    const limitMb = maxXmlMb || 20;
    const MAX_XML_OUTPUT = 1024 * 1024 * limitMb;

    const notifyFileVerified = () => emit({ type: 'file_verified' });

    if (inputBuffer.subarray(0, 5).toString() === "<?xml") {
        throw new Error("File Integrity Failed");
    }

    {
        const key = Buffer.alloc(16, 137);

        const s1 = Buffer.allocUnsafe(totalBytes);
        const progressStride = Math.max(100000, Math.floor(safeTotal / 10));

        report("Deobfuscating", 0);
        for (let i = 0; i < totalBytes; i++) {
            s1[i] = (inputBuffer[totalBytes - 1 - i] ^ ((totalBytes - (i * totalBytes)) | 0)) & 0xFF;
            if (i > 0 && i % progressStride === 0) {
                report("Deobfuscating", (i / safeTotal) * 30);
            }
        }

        report("Decrypting", 30);
        const tag = s1.subarray(totalBytes - 16);
        const ciphertext = s1.subarray(0, totalBytes - 16);

        const cTag = cmac(key, 2, ciphertext);
        const computedTag = xor(xor(PKT_N_TAG, PKT_H_TAG), cTag);
        if (computedTag.length !== tag.length || !crypto.timingSafeEqual(computedTag, tag)) {
            throw new Error("File Integrity Failed");
        }
        report("Decrypting", 45);
        const payload = Buffer.allocUnsafe(ciphertext.length);
        decryptCTRWithFinalXor(key, PKT_N_TAG, ciphertext, payload, true);

        report("Decompressing", 65);

        const zlibOptions = { maxOutputLength: MAX_XML_OUTPUT };

        try {
            finalXML = zlib.inflateSync(payload.subarray(4), zlibOptions).toString();
        } catch (e) {
            try {
                finalXML = zlib.inflateRawSync(payload.subarray(4), zlibOptions).toString();
            } catch (zlibErr) {
                throw new Error("Decompression failed or file too large.");
            }
        }
        notifyFileVerified();
    }

    report("Grading...", 70);

    finalXML = stripDoctypeCompletely(finalXML);
    finalXML = finalXML.replace(/<\?(?!xml\s)[^?]*\?>/gi, "");

    const xmlObj = await parseXmlForGrading(finalXML);

    const checks = ensureArray(labConfig.checks);
    const requiredDevices = collectRequiredDeviceNames(checks);

    let ptBlocks = [];
    if (xmlObj && xmlObj.PACKETTRACER5_ACTIVITY && xmlObj.PACKETTRACER5_ACTIVITY.PACKETTRACER5) {
        ptBlocks = xmlObj.PACKETTRACER5_ACTIVITY.PACKETTRACER5;
    } else if (xmlObj && xmlObj.PACKETTRACER5) {
        ptBlocks = Array.isArray(xmlObj.PACKETTRACER5) ? xmlObj.PACKETTRACER5 : [xmlObj.PACKETTRACER5];
    }

    const devList = ptBlocks.length > 0 ? (ptBlocks[0]?.NETWORK?.[0]?.DEVICES?.[0]?.DEVICE || []) : [];
    const devMap = buildDeviceMap(devList, requiredDevices);

    let currentScore = 0;
    let maxScore = 0;
    const serverResults = [];
    const clientResults = [];

    const showMsgs = (labConfig.show_check_messages !== false);
    const showMissed = (labConfig.show_missed_points === true);

    checks.forEach((check) => {
        const pts = parseInt(check.points);
        if (Number.isNaN(pts)) {
            console.warn(`[Worker] Skipping check with invalid points: ${check.message}`);
            return;
        }
        if (pts > 0) maxScore += pts;

        const device = devMap[check.device];
        let pass = false;

        let checkContext = 'global';
        const passArr = ensureArray(check.pass);
        const passOverrideArr = ensureArray(check.passoverride);
        const failArr = ensureArray(check.fail);
        if (passArr.length > 0) {
            checkContext = passArr[0].context || (passArr[0].type.startsWith('Xml') ? 'hardware' : 'global');
        } else if (passOverrideArr.length > 0) {
            checkContext = passOverrideArr[0].context || 'global';
        }

        if (device) {
            const failCond = failArr.some((c) => evaluateCondition(device, c));
            if (!failCond) {
                if (passOverrideArr.some((c) => evaluateCondition(device, c))) {
                    pass = true;
                } else if (passArr.length > 0) {
                    pass = passArr.every((c) => evaluateCondition(device, c));
                }
            }
        }

        if (pass) {
            currentScore += pts;
            if (showMsgs) {
                clientResults.push({ message: check.message, points: pts, passed: true, device: check.device, context: checkContext });
            }
        } else if (showMsgs && showMissed) {
            clientResults.push({ message: check.message, points: 0, passed: false, device: check.device, context: checkContext });
        }

        serverResults.push({
            message: check.message,
            device: check.device,
            context: checkContext,
            possible: pts,
            awarded: pass ? pts : 0,
            passed: pass,
        });
    });

    if (currentScore < 0) currentScore = 0;
    report("Complete", 100);

    const showScore = (labConfig.show_score !== false);

    const result = {
        type: 'result',
        grading: {
            total: currentScore,
            max: maxScore,
            clientBreakdown: showMsgs ? clientResults : null,
            serverBreakdown: serverResults,
            show_score: showScore,
        },
    };

    if (retainXml) {
        result.xml = finalXML;
    }

    return result;
}

module.exports = { runGrade, sanitizeErrorMessage };
