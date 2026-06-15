import { state } from './state.js';

function clearLabTimerInterval() {
    if (state.labTimerInterval) {
        clearInterval(state.labTimerInterval);
        state.labTimerInterval = null;
    }
}

function labTimerTick() {
    if (state.labTimerFrozen) return;

    const timerDiv = document.getElementById('lab-timer');
    if (!timerDiv || state.labTimerEndTime == null) return;

    const remaining = Math.max(0, Math.floor((state.labTimerEndTime - Date.now()) / 1000));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    timerDiv.innerText = `${m}:${s < 10 ? '0' : ''}${s}`;
    state.labWarnOnTick?.(remaining);

    if (remaining <= 0) {
        clearLabTimerInterval();
        timerDiv.innerText = "TIME'S UP";
        timerDiv.style.color = '#f44747';
        state.labTimerExpired = true;
        state.labTimerOnExpire?.();
    }
}

export function startLabTimer(timeRemainingSeconds, onExpire) {
    clearLabTimerInterval();
    state.labTimerFrozen = false;
    state.labTimerFrozenAt = null;
    state.labTimerExpired = false;
    state.labTimerOnExpire = onExpire ?? null;

    const timerDiv = document.getElementById('lab-timer');
    if (timeRemainingSeconds === null || timeRemainingSeconds === undefined) {
        state.labTimerEndTime = null;
        if (timerDiv) timerDiv.innerText = '';
        return;
    }

    state.labTimerEndTime = Date.now() + (timeRemainingSeconds * 1000);
    labTimerTick();
    state.labTimerInterval = setInterval(labTimerTick, 1000);
}

export function freezeLabTimer() {
    if (state.labTimerFrozen || state.labTimerEndTime == null) return;
    state.labTimerFrozenAt = Date.now();
    clearLabTimerInterval();
    state.labTimerFrozen = true;
}

export function unfreezeLabTimer() {
    if (!state.labTimerFrozen) return;
    if (state.labTimerFrozenAt != null && state.labTimerEndTime != null) {
        state.labTimerEndTime += Date.now() - state.labTimerFrozenAt;
    }
    state.labTimerFrozen = false;
    state.labTimerFrozenAt = null;
    if (state.labTimerEndTime == null) return;

    labTimerTick();
    state.labTimerInterval = setInterval(labTimerTick, 1000);
}
