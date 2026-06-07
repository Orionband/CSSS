const FINISH_SRC = '/sound/finish.wav';
const WARN_SRC = '/sound/warn.wav';
const GAIN_SRC = '/sound/gain.wav';

function playSound(src) {
    try {
        new Audio(src).play().catch(() => {});
    } catch {
        /* autoplay or missing file */
    }
}

function sendNotification(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
        new Notification(title, { body });
    } catch {
        /* unsupported or blocked */
    }
}

/** Request permission; call from a user gesture (e.g. start lab/quiz). */
export async function ensureNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
        return (await Notification.requestPermission()) === 'granted';
    } catch {
        return false;
    }
}

export function playFinishSound({ title = 'Complete', body = 'Your work has been submitted.' } = {}) {
    playSound(FINISH_SRC);
    sendNotification(title, body);
}

export function playGainSound({ title = 'Gained points', body = 'Your score increased.' } = {}) {
    playSound(GAIN_SRC);
    sendNotification(title, body);
}

function formatRemaining(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function warnMessageForThreshold(thresholdSeconds, totalLimitSeconds) {
    if (thresholdSeconds === 60) return '1 minute remaining on your lab session.';
    if (thresholdSeconds === 300) return '5 minutes remaining on your lab session.';
    if (totalLimitSeconds > 30 * 60 && thresholdSeconds === Math.floor(totalLimitSeconds * 0.25)) {
        return '25% of lab time remaining (75% elapsed).';
    }
    return `${formatRemaining(thresholdSeconds)} remaining on your lab session.`;
}

export function playWarnSound(thresholdSeconds, totalLimitSeconds) {
    playSound(WARN_SRC);
    sendNotification('Lab time warning', warnMessageForThreshold(thresholdSeconds, totalLimitSeconds));
}

/** Lab countdown warnings; each threshold fires once when remaining seconds crosses at or below it. */
export function createLabWarnScheduler(totalLimitSeconds) {
    if (!Number.isFinite(totalLimitSeconds) || totalLimitSeconds <= 0) {
        return () => {};
    }

    const thresholds = new Set([300, 60]);
    if (totalLimitSeconds > 30 * 60) {
        thresholds.add(Math.floor(totalLimitSeconds * 0.25));
    }

    const fired = new Set();

    return (remainingSeconds) => {
        for (const threshold of thresholds) {
            if (remainingSeconds <= threshold && !fired.has(threshold)) {
                fired.add(threshold);
                playWarnSound(threshold, totalLimitSeconds);
            }
        }
    };
}
