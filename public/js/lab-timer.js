import { state } from './state.js';

export function freezeLabTimer() {
    if (state.labTimerInterval) {
        clearInterval(state.labTimerInterval);
        state.labTimerInterval = null;
    }
    state.labTimerFrozen = true;
}
