let socketInstance = null;

export function getSocket() {
    if (!socketInstance) {
        if (typeof io === 'undefined') {
            throw new Error('Socket.IO client is not loaded on this page.');
        }
        socketInstance = io({ autoConnect: false });
    }
    return socketInstance;
}

export const state = {
    get socket() {
        return getSocket();
    },
    currentUser: null,
    availableChallenges: [],
    currentChallengeId: null,
    currentChallengeType: null,
    quizTimerInterval: null,
    labTimerInterval: null,
    labTimerFrozen: false,
    quizMetadataCache: null,
    csrfToken: null,
    tabSwitchNonce: 0,
    appOptions: {},
    currentPage: 'challenges',
    challengeTab: 'labs',
};
