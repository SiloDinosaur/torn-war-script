// ==UserScript==
// @name         Torn War Targets
// @namespace    https://www.torn.com/factions.php
// @version      v1.0.0
// @description  Adds a box with possible targets to faction page
// @author       Maahly [3893095]
// @match        https://www.torn.com/factions.php?step=your*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.xmlHttpRequest
// @connect      api.torn.com
// @connect      ffscouter.com
// ==/UserScript==

// Feel free to modify these values
const MAX_FAIR_FIGHT = 3.5;
const LAST_N_MESSAGES_TO_CHECK_FOR_DIBS = 15;
const CALL_FULFILLMENT_TIMEOUT_MINUTES = 15;
const TARGET_REFRESH_INTERVAL_MS = 15000;
const MIN_CALL_FRAGMENT_LENGTH = 4;
const ENABLE_DEBUG_LOGS = false;

// /////////////////////////////
//
// DO NOT TOUCH BELOW THIS POINT
//
// /////////////////////////////

const FFSCOUTER_KEY_LENGTH = 16;
const FFSCOUTER_API_KEY_STORAGE_KEY = 'ffscouterApiKey';
const CONTENT_ELEMENT_ID = 'war-tagets-content';
const TARGET_STYLE_ID = 'war-targets-style';
const CALL_FULFILLMENT_TIMEOUT_MS = CALL_FULFILLMENT_TIMEOUT_MINUTES * 60 * 1000;
const LAST_UPDATED_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 10000;
const FACTION_CHAT_ID_PATTERN = /^faction-\d+$/;
const headerState = {
    lastUpdatedAt: null,
    lastUpdatedTimer: null,
    refreshTimer: null,
};
const targetState = {
    cards: new Map(),
    grid: null,
    message: null,
    calledFragments: new Set(),
    calledBy: new Map(),
    selfCalledFragments: new Set(),
    callEntries: [],
    parsedMessages: new Map(),
    lastKnownStates: new Map(),
    wrapper: null,
};
const chatState = {
    listObserver: null,
    listElement: null,
};
const statsCache = new Map();
const LOG_PREFIX = '[Torn War Targets]';
const logInfo = (...args) => console.log(LOG_PREFIX, ...args);
const logWarn = (...args) => console.warn(LOG_PREFIX, ...args);
const logError = (...args) => console.error(LOG_PREFIX, ...args);
const logDebug = (...args) => {
    if (!ENABLE_DEBUG_LOGS) {
        return;
    }
    console.debug(LOG_PREFIX, ...args);
};
const isFunction = (value) => typeof value === 'function';
const getModernGmApi = () => globalThis.GM ?? null;
const getTornPdaHttpGet = () =>
    globalThis.PDA_httpGet ?? globalThis.unsafeWindow?.PDA_httpGet ?? null;

const safeGetValue = (key, fallback = '') => {
    if (!isFunction(globalThis.GM_getValue)) {
        try {
            return globalThis.localStorage?.getItem(key) ?? fallback;
        } catch (error) {
            logWarn('Failed to read from localStorage.', { key, error });
            return fallback;
        }
    }

    try {
        return GM_getValue(key, fallback);
    } catch (error) {
        logWarn('GM_getValue failed.', { key, error });
        return fallback;
    }
};

const safeSetValue = (key, value) => {
    if (!isFunction(globalThis.GM_setValue)) {
        try {
            globalThis.localStorage?.setItem(key, value);
        } catch (error) {
            logWarn('Failed to write to localStorage.', { key, error });
        }
        return;
    }

    try {
        GM_setValue(key, value);
    } catch (error) {
        logWarn('GM_setValue failed.', { key, error });
    }
};

const getAvailabilityStatus = (member) => {
    if (!member) {
        return 'Offline';
    }

    return member?.last_update?.status ?? member?.last_action?.status ?? 'Offline';
};

const isFederalTarget = (target) => target?.status?.state === 'Federal';
const isTravelingTarget = (target) => target?.status?.state === 'Traveling';
const isAbroadTarget = (target) => target?.status?.state === 'Abroad';

const ensureTargetStyles = () => {
    if (document.getElementById(TARGET_STYLE_ID)) {
        return;
    }

    const style = document.createElement('style');
    style.id = TARGET_STYLE_ID;
    style.textContent = `
        .war-targets-wrapper {
            display: flex;
            flex-direction: column;
            gap: 16px;
            padding: 12px;
            color: #f3f4f6;
            font-family: "Inter", "Segoe UI", sans-serif;
        }

        .war-targets-section-title {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.2em;
            color: #cbd5f5;
            margin-bottom: 6px;
        }

        .war-targets-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 8px;
        }

        .war-target-card {
            border-radius: 8px;
            border: 1px solid #1f2937;
            background: #111827;
            padding: 8px;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
            cursor: pointer;
            position: relative;
        }

        .war-target-card.state-okay {
            background: #064e3b;
            border-color: #047857;
        }

        .war-target-card.state-hospital {
            background: #7f1d1d;
            border-color: #dc2626;
        }

        .war-target-card.is-called {
            border-color: #fb7185;
            box-shadow: 0 0 0 1px rgba(190, 18, 60, 0.8),
                0 2px 6px rgba(190, 18, 60, 0.35);
        }

        .war-target-card.is-yours {
            border-color: #38bdf8;
            box-shadow: 0 0 0 1px rgba(14, 116, 144, 0.8),
                0 2px 6px rgba(14, 116, 144, 0.35);
        }

        .war-target-call-button {
            position: absolute;
            right: 6px;
            bottom: 6px;
            border: none;
            border-radius: 999px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.12em;
            background: rgba(15, 23, 42, 0.9);
            color: #e2e8f0;
            cursor: pointer;
        }

        .war-target-call-button:hover {
            background: rgba(30, 41, 59, 0.95);
        }

        .war-target-called-badge {
            position: absolute;
            top: 6px;
            right: 6px;
            padding: 2px 6px;
            border-radius: 999px;
            background: rgba(190, 18, 60, 0.9);
            color: #fff1f2;
            font-size: 9px;
            letter-spacing: 0.16em;
            text-transform: uppercase;
            display: none;
        }

        .war-target-called-badge.is-yours {
            background: rgba(14, 116, 144, 0.9);
            color: #ecfeff;
        }

        .war-target-name {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            font-size: 12px;
            margin-bottom: 6px;
            cursor: pointer;
        }

        .war-target-status-dot {
            width: 8px;
            height: 8px;
            border-radius: 999px;
        }

        .war-target-status-dot.online {
            background: #22c55e;
        }

        .war-target-status-dot.idle {
            background: #facc15;
        }

        .war-target-status-dot.offline {
            background: #9ca3af;
        }

        .war-target-meta {
            font-size: 11px;
            line-height: 1.4;
            color: #f9fafb;
            cursor: pointer;
        }

        .war-target-ff {
            color: #fde047;
            font-weight: 600;
        }

        .war-target-divider {
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            padding-top: 12px;
            margin-top: 12px;
        }

        .war-targets-header-content {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }

        .war-targets-last-updated {
            font-size: 11px;
            color: #cbd5f5;
            margin-left: 12px;
            padding-right: 6px;
            white-space: nowrap;
        }

        .war-targets-message {
            font-size: 12px;
            color: #e5e7eb;
        }

        .war-targets-api-key-form {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            margin-top: 8px;
        }

        .war-targets-api-key-input {
            min-width: 220px;
            width: min(320px, 100%);
            border: 1px solid #4b5563;
            border-radius: 6px;
            padding: 6px 8px;
            background: #0f172a;
            color: #f8fafc;
            font-size: 12px;
        }

        .war-targets-api-key-button {
            border: 1px solid #2563eb;
            border-radius: 6px;
            padding: 6px 10px;
            background: #1d4ed8;
            color: #eff6ff;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
        }

        .war-targets-api-key-button:hover {
            background: #1e40af;
        }
    `;

    document.head.appendChild(style);
};

const getHospitalLabel = (untilTimestamp) => {
    const untilSeconds = Number(untilTimestamp);
    if (!Number.isFinite(untilSeconds) || untilSeconds <= 0) {
        return { label: '', remainingSeconds: null };
    }

    const remainingSeconds = Math.max(0, Math.floor(untilSeconds - Date.now() / 1000));
    if (remainingSeconds === 0) {
        return { label: '', remainingSeconds };
    }

    if (remainingSeconds < 60) {
        return { label: `${remainingSeconds}s`, remainingSeconds };
    }

    const hours = Math.floor(remainingSeconds / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    const parts = [hours ? `${hours}h` : null, minutes ? `${minutes}m` : null]
        .filter(Boolean)
        .join('');

    return { label: parts, remainingSeconds };
};

const findFactionChatElement = (node) => {
    if (!(node instanceof Element)) {
        return null;
    }

    if (FACTION_CHAT_ID_PATTERN.test(node.id)) {
        return node;
    }

    const candidates = node.querySelectorAll('[id^="faction-"]');
    for (const candidate of candidates) {
        if (FACTION_CHAT_ID_PATTERN.test(candidate.id)) {
            return candidate;
        }
    }

    return null;
};

const getFactionChatList = () => {
    const factionChat = document.querySelector('[id^="faction-"]');
    return factionChat?.querySelector('[class^="scrollWrapper__"]') ?? null;
};

const getFactionChatTextarea = () => {
    const factionChat = document.querySelector('[id^="faction-"]');
    return factionChat?.querySelector('[class^="textarea__"]') ?? null;
};

const startsWithAnyFragment = (targetName, fragments) => {
    if (!targetName) {
        return false;
    }
    const lowerName = targetName.toLowerCase();
    for (const fragment of fragments) {
        if (lowerName.startsWith(fragment)) {
            return true;
        }
    }
    return false;
};

const dispatchEnterKey = (element) => {
    if (!element) {
        return;
    }
    const eventInit = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
    };
    element.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    element.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    element.dispatchEvent(new KeyboardEvent('keyup', eventInit));
};

const collectLastMessages = (listElement) => {
    if (!listElement) {
        logDebug('collectLastMessages skipped: missing chat list element.');
        return [];
    }

    const messageContainer = listElement.firstElementChild;
    if (!messageContainer) {
        logDebug('collectLastMessages skipped: message container is unavailable.');
        return [];
    }

    const messages = [...messageContainer.children]
        .slice(-LAST_N_MESSAGES_TO_CHECK_FOR_DIBS)
        .map((node) => node.innerText);
    logDebug('Collected recent faction chat messages.', {
        messageCount: messages.length,
        maxTrackedMessages: LAST_N_MESSAGES_TO_CHECK_FOR_DIBS,
    });
    return messages;
};

const observeChatList = (listElement) => {
    if (!listElement || chatState.listElement === listElement) {
        if (!listElement) {
            logDebug('observeChatList skipped: no list element available yet.');
        }
        return;
    }

    if (chatState.listObserver) {
        chatState.listObserver.disconnect();
    }

    chatState.listElement = listElement;
    chatState.listObserver = new MutationObserver((mutations) => {
        if (!mutations.some((mutation) => mutation.addedNodes.length > 0)) {
            return;
        }

        logDebug('Faction chat list mutation detected.', {
            mutationCount: mutations.length,
            listChildCount: listElement.childElementCount,
        });

        updateCalledTargets(collectLastMessages(listElement));
    });

    chatState.listObserver.observe(listElement, { childList: true, subtree: true });
    updateCalledTargets(collectLastMessages(listElement));
};

const observeChatRoot = (chatRoot) => {
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (findFactionChatElement(node)) {
                    logInfo('Faction chat opened.');
                    const listElement = getFactionChatList();
                    observeChatList(listElement);
                    return;
                }
            }
        }
    });

    observer.observe(chatRoot, { childList: true, subtree: true });
    observeChatList(getFactionChatList());
};

const startChatRootObserver = () => {
    const chatRoot = document.getElementById('chatRoot');
    if (!chatRoot) {
        logWarn('Chat root not found yet.');
        return false;
    }

    observeChatRoot(chatRoot);
    return true;
};

const waitForChatRoot = () => {
    if (startChatRootObserver()) {
        return;
    }

    const bodyObserver = new MutationObserver(() => {
        if (startChatRootObserver()) {
            bodyObserver.disconnect();
        }
    });

    if (!document.body) {
        logError('document.body is unavailable; cannot observe chat root.');
        return;
    }

    bodyObserver.observe(document.body, { childList: true, subtree: true });
};

const getHospitalRemainingSeconds = (untilTimestamp) => {
    const untilSeconds = Number(untilTimestamp);
    if (!Number.isFinite(untilSeconds) || untilSeconds <= 0) {
        return null;
    }
    const remaining = Math.floor(untilSeconds - Date.now() / 1000);
    return Math.max(0, remaining);
};

const isCallEligible = (target) => {
    if (target?.status?.state !== 'Hospital') {
        return true;
    }
    const remainingSeconds = getHospitalRemainingSeconds(target?.status?.until);
    if (remainingSeconds == null) {
        return true;
    }
    return remainingSeconds <= 20 * 60;
};

const getEffectiveState = (target) => {
    const rawState = target?.status?.state ?? 'Unknown';
    if (rawState !== 'Hospital') {
        return rawState;
    }
    const remaining = getHospitalRemainingSeconds(target?.status?.until);
    return remaining === 0 ? 'Okay' : rawState;
};

const getEffectiveDescription = (target, effectiveState) => {
    if (effectiveState === 'Okay' && target?.status?.state === 'Hospital') {
        return '';
    }
    return target?.status?.description ?? '';
};

const formatCallMessage = (target) => {
    const targetName = target?.name ?? '';
    if (!targetName) {
        return '';
    }
    const effectiveState = getEffectiveState(target);
    if (effectiveState !== 'Hospital') {
        return targetName;
    }
    const remainingSeconds = getHospitalRemainingSeconds(target?.status?.until);
    if (remainingSeconds == null || remainingSeconds <= 0) {
        return targetName;
    }
    const minutesRemaining = Math.max(1, Math.ceil(remainingSeconds / 60));
    return `${targetName} in ${minutesRemaining}`;
};

const getStatusLabel = ({ state, description, hospitalLabel }) => {
    if (state === 'Hospital' && hospitalLabel) {
        const isAbroadHospital = /In\s+a\s+.+\s+hospital/i.test(description);
        return `${isAbroadHospital ? 'Hosp' : 'Hospital'} ${hospitalLabel}`;
    }

    if (state === 'Abroad' && description.startsWith('In ')) {
        return description.replace('In ', 'In ');
    }

    if (state === 'Traveling' && description.startsWith('Traveling')) {
        return description;
    }

    return state;
};

const updateTargetCard = (target, cardData) => {
    if (!cardData?.card) {
        return;
    }

    cardData.targetData = target;
    const effectiveState = getEffectiveState(target);
    const effectiveDescription = getEffectiveDescription(target, effectiveState);
    const { label: hospitalLabel } = getHospitalLabel(target?.status?.until);
    const stateClass = (effectiveState ?? 'unknown').toLowerCase();
    cardData.card.className = `war-target-card state-${stateClass}`;
    const targetId = String(target?.id ?? '');
    const targetName = target?.name ?? '';
    handleTargetStateTransition(targetId, targetName, effectiveState);
    applyCalledState(cardData, targetName);
    cardData.card.dataset.targetId = targetId;

    const availability = (target?.availability_status ?? 'Offline').toLowerCase();
    cardData.statusDot.className = `war-target-status-dot ${availability}`;
    cardData.statusDot.title = availability;

    cardData.name.textContent = target?.name ?? 'Unknown';
    cardData.statusLine.textContent = getStatusLabel({
        state: effectiveState,
        description: effectiveDescription,
        hospitalLabel,
    });
    cardData.bsLine.textContent = `BS: ${target?.bs_estimate_human ?? 'Unknown'}`;
    cardData.ffLine.className = 'war-target-ff';
    cardData.ffLine.textContent = `FF: ${target?.fair_fight ?? 'N/A'}`;
    updateCalledBadge(cardData, targetName);
    updateCallButtonVisibility(cardData, targetName);
};

const renderTargetCard = (target) => {
    const card = document.createElement('div');
    const cardData = {
        card,
        name: document.createElement('span'),
        statusDot: document.createElement('span'),
        statusLine: document.createElement('div'),
        bsLine: document.createElement('div'),
        ffLine: document.createElement('div'),
        calledBadge: document.createElement('div'),
        callButton: document.createElement('button'),
    };
    updateTargetCard(target, cardData);

    const targetId = target?.id;
    if (targetId) {
        card.addEventListener('click', () => {
            window.open(
                `https://www.torn.com/profiles.php?XID=${encodeURIComponent(targetId)}`,
                '_blank',
                'noopener'
            );
        });
    }

    const nameRow = document.createElement('div');
    nameRow.className = 'war-target-name';

    nameRow.appendChild(cardData.statusDot);
    nameRow.appendChild(cardData.name);

    const meta = document.createElement('div');
    meta.className = 'war-target-meta';

    meta.appendChild(cardData.statusLine);
    meta.appendChild(cardData.bsLine);
    meta.appendChild(cardData.ffLine);

    cardData.calledBadge.className = 'war-target-called-badge';
    cardData.callButton.className = 'war-target-call-button';
    cardData.callButton.type = 'button';
    cardData.callButton.textContent = 'Call';
    cardData.callButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const textarea = getFactionChatTextarea();
        if (!textarea) {
            logWarn('Cannot send call message: faction chat textarea not found.', {
                targetName: cardData?.targetData?.name,
            });
            window.alert('Open the faction chat first.');
            return;
        }
        const message = formatCallMessage(cardData?.targetData);
        if (!message) {
            logWarn('Cannot send call message: empty message after formatting.', {
                target: cardData?.targetData,
            });
            return;
        }
        textarea.value = message;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        setTimeout(() => {
            dispatchEnterKey(textarea);
        }, 0);
    });
    card.appendChild(cardData.calledBadge);
    card.appendChild(cardData.callButton);
    card.appendChild(nameRow);
    card.appendChild(meta);

    return cardData;
};

const isTargetCalled = (targetName) => {
    return startsWithAnyFragment(targetName, targetState.calledFragments);
};

const getTargetCaller = (targetName) => {
    if (!targetName) {
        return null;
    }
    const lowerName = targetName.toLowerCase();
    for (const fragment of targetState.calledFragments) {
        if (lowerName.startsWith(fragment)) {
            return targetState.calledBy.get(fragment) ?? null;
        }
    }
    return null;
};

const isTargetCalledBySelf = (targetName) => {
    return startsWithAnyFragment(targetName, targetState.selfCalledFragments);
};

const formatCallerLabel = (name) => {
    if (!name) {
        return 'Called';
    }
    const trimmed = name.trim();
    if (trimmed.length <= 10) {
        return trimmed;
    }
    return `${trimmed.slice(0, 10)}…`;
};

const applyCalledState = (cardData, targetName) => {
    if (!cardData?.card) {
        return;
    }
    if (!isCallEligible(cardData?.targetData)) {
        cardData.card.classList.remove('is-yours');
        cardData.card.classList.remove('is-called');
        return;
    }
    const calledBySelf = isTargetCalledBySelf(targetName);
    if (calledBySelf) {
        cardData.card.classList.add('is-yours');
    } else {
        cardData.card.classList.remove('is-yours');
    }
    if (!calledBySelf && isTargetCalled(targetName)) {
        cardData.card.classList.add('is-called');
    } else {
        cardData.card.classList.remove('is-called');
    }
};

const updateCalledBadge = (cardData, targetName) => {
    if (!cardData?.calledBadge) {
        return;
    }
    if (!isCallEligible(cardData?.targetData)) {
        cardData.calledBadge.textContent = 'Called';
        cardData.calledBadge.classList.remove('is-yours');
        cardData.calledBadge.style.display = 'none';
        return;
    }
    if (isTargetCalledBySelf(targetName)) {
        cardData.calledBadge.textContent = 'Yours';
        cardData.calledBadge.classList.add('is-yours');
        cardData.calledBadge.style.display = 'inline-flex';
        return;
    }
    if (isTargetCalled(targetName)) {
        cardData.calledBadge.textContent = formatCallerLabel(
            getTargetCaller(targetName)
        );
        cardData.calledBadge.classList.remove('is-yours');
        cardData.calledBadge.style.display = 'inline-flex';
        return;
    }
    cardData.calledBadge.textContent = 'Called';
    cardData.calledBadge.classList.remove('is-yours');
    cardData.calledBadge.style.display = 'none';
};

const updateCallButtonVisibility = (cardData, targetName) => {
    if (!cardData?.callButton) {
        return;
    }
    const shouldShow =
        !isTargetCalled(targetName) && !isTargetCalledBySelf(targetName);
    cardData.callButton.style.display = shouldShow ? 'inline-flex' : 'none';
};

const handleTargetStateTransition = (targetId, targetName, effectiveState) => {
    if (!targetId) {
        logDebug('handleTargetStateTransition skipped: target id missing.', {
            targetName,
            effectiveState,
        });
        return;
    }
    const previousState = targetState.lastKnownStates.get(targetId);
    targetState.lastKnownStates.set(targetId, effectiveState);
    if (previousState !== effectiveState) {
        logDebug('Target state transition tracked.', {
            targetId,
            targetName,
            previousState,
            effectiveState,
        });
    }
    if (previousState === 'Okay' && effectiveState === 'Hospital') {
        if (removeCallsForTargetName(targetName)) {
            logDebug('Removed call entries due to Okay -> Hospital transition.', {
                targetId,
                targetName,
            });
            rebuildCalledState();
            refreshCallStyles();
        }
    }
};

const normalizeMessageKey = (message) => (message ?? '').trim().toLowerCase();

const parseChatMessageParts = (message) => {
    const text = (message ?? '').replace(/\r/g, '').trim();
    if (!text) {
        logDebug('Skipping chat parse: message text is empty after trim.');
        return null;
    }

    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) {
        logDebug('Skipping chat parse: no non-empty lines remained.', {
            originalLength: text.length,
        });
        return null;
    }

    const callerMatch = lines[0].match(/^([^:]+):$/);
    if (callerMatch && lines.length >= 2) {
        logDebug('Parsed chat message with explicit caller prefix.', {
            callerName: callerMatch[1].trim(),
            messagePart: lines[1],
            lineCount: lines.length,
        });
        return {
            callerName: callerMatch[1].trim(),
            messagePart: lines[1],
            isSelf: false,
        };
    }

    logDebug('Parsed chat message as self/unprefixed call candidate.', {
        messagePart: lines[0],
        lineCount: lines.length,
    });
    return {
        callerName: '',
        messagePart: lines[0],
        isSelf: true,
    };
};

const extractCallEntry = (message) => {
    if (!message) {
        logDebug('Skipping call extraction: message is empty.');
        return null;
    }

    const messageParts = parseChatMessageParts(message);
    if (!messageParts) {
        logDebug('Skipping call extraction: message parts parsing failed.', {
            rawMessage: message,
        });
        return null;
    }

    const { callerName, messagePart, isSelf } = messageParts;
    const match = messagePart.match(/^([a-z0-9]+)(?:\s+in\s+\d+)?(?:[.!?,])?$/i);
    if (!match) {
        logDebug('Skipping call extraction: message part did not match fragment pattern.', {
            callerName,
            messagePart,
            isSelf,
        });
        return null;
    }
    const fragment = match[1].toLowerCase();
    if (fragment.length < MIN_CALL_FRAGMENT_LENGTH) {
        logDebug('Skipping call extraction: fragment too short.', {
            fragment,
            fragmentLength: fragment.length,
            minLength: MIN_CALL_FRAGMENT_LENGTH,
        });
        return null;
    }
    const entry = {
        fragment,
        callerName,
        isSelf,
        messageKey: normalizeMessageKey(`${callerName}|${messagePart}`),
    };
    logDebug('Extracted valid call entry from chat message.', entry);
    return entry;
};

const rebuildCalledState = () => {
    const fragments = new Set();
    const calledBy = new Map();
    const selfFragments = new Set();
    targetState.callEntries.forEach((entry) => {
        if (entry.isSelf) {
            selfFragments.add(entry.fragment);
            return;
        }
        fragments.add(entry.fragment);
        if (entry.callerName) {
            calledBy.set(entry.fragment, entry.callerName);
        }
    });
    targetState.calledFragments = fragments;
    targetState.calledBy = calledBy;
    targetState.selfCalledFragments = selfFragments;
    logDebug('Rebuilt called-state indexes.', {
        calledFragments: [...fragments],
        selfCalledFragments: [...selfFragments],
        calledBy: [...calledBy.entries()],
    });
};

const refreshCallStyles = () => {
    targetState.cards.forEach((cardData) => {
        const targetName = cardData?.name?.textContent ?? '';
        applyCalledState(cardData, targetName);
        updateCalledBadge(cardData, targetName);
        updateCallButtonVisibility(cardData, targetName);
    });
};

const pruneParsedMessages = (now) => {
    const originalSize = targetState.parsedMessages.size;
    targetState.parsedMessages.forEach((parsedAt, key) => {
        if (now - parsedAt > CALL_FULFILLMENT_TIMEOUT_MS) {
            targetState.parsedMessages.delete(key);
        }
    });
    while (targetState.parsedMessages.size > LAST_N_MESSAGES_TO_CHECK_FOR_DIBS) {
        const oldestKey = targetState.parsedMessages.keys().next().value;
        targetState.parsedMessages.delete(oldestKey);
    }
    if (targetState.parsedMessages.size !== originalSize) {
        logDebug('Pruned parsed message cache.', {
            before: originalSize,
            after: targetState.parsedMessages.size,
            timeoutMs: CALL_FULFILLMENT_TIMEOUT_MS,
            maxTrackedMessages: LAST_N_MESSAGES_TO_CHECK_FOR_DIBS,
        });
    }
};

const pruneCallEntries = (now) => {
    const originalCount = targetState.callEntries.length;
    targetState.callEntries = targetState.callEntries.filter(
        (entry) => now - entry.parsedAt <= CALL_FULFILLMENT_TIMEOUT_MS
    );
    if (targetState.callEntries.length > LAST_N_MESSAGES_TO_CHECK_FOR_DIBS) {
        targetState.callEntries.sort((a, b) => a.parsedAt - b.parsedAt);
        targetState.callEntries.splice(
            0,
            targetState.callEntries.length - LAST_N_MESSAGES_TO_CHECK_FOR_DIBS
        );
    }
    if (targetState.callEntries.length !== originalCount) {
        logDebug('Pruned call fulfillment entries.', {
            before: originalCount,
            after: targetState.callEntries.length,
            timeoutMs: CALL_FULFILLMENT_TIMEOUT_MS,
            maxTrackedMessages: LAST_N_MESSAGES_TO_CHECK_FOR_DIBS,
        });
    }
};

const removeCallsForTargetName = (targetName) => {
    if (!targetName) {
        logDebug('removeCallsForTargetName skipped: missing target name.');
        return false;
    }
    const lowerName = targetName.toLowerCase();
    const originalLength = targetState.callEntries.length;
    targetState.callEntries = targetState.callEntries.filter(
        (entry) => !lowerName.startsWith(entry.fragment)
    );
    const removed = targetState.callEntries.length !== originalLength;
    if (removed) {
        logDebug('Removed call entries for target fulfillment target.', {
            targetName,
            removedCount: originalLength - targetState.callEntries.length,
        });
    }
    return removed;
};

const updateCalledTargets = (messages) => {
    const now = Date.now();
    logDebug('Starting called-target update cycle.', {
        incomingMessageCount: (messages ?? []).length,
        existingCallEntries: targetState.callEntries.length,
        parsedMessageCacheSize: targetState.parsedMessages.size,
    });
    (messages ?? []).forEach((message) => {
        const entry = extractCallEntry(message);
        if (!entry) {
            return;
        }
        if (targetState.parsedMessages.has(entry.messageKey)) {
            logDebug('Skipping duplicate call entry based on message key.', {
                messageKey: entry.messageKey,
                fragment: entry.fragment,
            });
            return;
        }
        targetState.parsedMessages.set(entry.messageKey, now);
        const hadExistingFragment = targetState.callEntries.some(
            (existing) => existing.fragment === entry.fragment
        );
        targetState.callEntries = targetState.callEntries.filter(
            (existing) => existing.fragment !== entry.fragment
        );
        targetState.callEntries.push({ ...entry, parsedAt: now });
        logDebug('Registered/updated call fulfillment entry.', {
            fragment: entry.fragment,
            callerName: entry.callerName,
            isSelf: entry.isSelf,
            replacedExistingFragment: hadExistingFragment,
        });
    });

    pruneParsedMessages(now);
    pruneCallEntries(now);
    rebuildCalledState();
    refreshCallStyles();
    logDebug('Completed called-target update cycle.', {
        totalCallEntries: targetState.callEntries.length,
        calledFragmentsCount: targetState.calledFragments.size,
        selfCalledFragmentsCount: targetState.selfCalledFragments.size,
    });
};

const ensureTargetLayout = () => {
    const content = document.getElementById(CONTENT_ELEMENT_ID);
    if (!content) {
        return null;
    }

    ensureTargetStyles();

    if (!targetState.wrapper) {
        content.textContent = '';
        targetState.wrapper = document.createElement('div');
        targetState.wrapper.className = 'war-targets-wrapper';

        targetState.message = document.createElement('div');
        targetState.message.className = 'war-targets-message';

        targetState.grid = document.createElement('div');
        targetState.grid.className = 'war-targets-grid';

        targetState.wrapper.appendChild(targetState.message);
        targetState.wrapper.appendChild(targetState.grid);
        content.appendChild(targetState.wrapper);
    }

    return targetState.wrapper;
};

const renderTargetGrid = (targets) => {
    if (!ensureTargetLayout()) {
        logWarn('Target layout is unavailable; cannot render target grid.');
        return;
    }

    const visibleTargets = targets.filter(
        (target) =>
            Number.isFinite(target?.fair_fight) && target.fair_fight <= MAX_FAIR_FIGHT
    );
    const sortedTargets = visibleTargets
        .map((target, index) => ({ target, index }))
        .sort((first, second) => {
            const firstState = getEffectiveState(first.target);
            const secondState = getEffectiveState(second.target);
            const firstGroup =
                firstState === 'Okay' ? 0 : firstState === 'Hospital' ? 1 : 2;
            const secondGroup =
                secondState === 'Okay' ? 0 : secondState === 'Hospital' ? 1 : 2;

            if (firstGroup !== secondGroup) {
                return firstGroup - secondGroup;
            }

            if (firstGroup === 0) {
                const firstFf = Number(first.target?.fair_fight);
                const secondFf = Number(second.target?.fair_fight);
                const firstValue = Number.isFinite(firstFf)
                    ? firstFf
                    : Number.NEGATIVE_INFINITY;
                const secondValue = Number.isFinite(secondFf)
                    ? secondFf
                    : Number.NEGATIVE_INFINITY;
                if (firstValue !== secondValue) {
                    return secondValue - firstValue;
                }
            }

            if (firstGroup === 1) {
                const firstSeconds = getHospitalRemainingSeconds(
                    first.target?.status?.until
                );
                const secondSeconds = getHospitalRemainingSeconds(
                    second.target?.status?.until
                );
                const firstValue =
                    firstSeconds == null ? Number.POSITIVE_INFINITY : firstSeconds;
                const secondValue =
                    secondSeconds == null ? Number.POSITIVE_INFINITY : secondSeconds;
                if (firstValue !== secondValue) {
                    return firstValue - secondValue;
                }
            }

            return first.index - second.index;
        })
        .map(({ target }) => target);

    if (visibleTargets.length === 0) {
        targetState.message.textContent = 'No targets found.';
        targetState.message.style.display = 'block';
        targetState.grid.style.display = 'none';
        return;
    }

    targetState.message.textContent = '';
    targetState.message.style.display = 'none';
    targetState.grid.style.display = 'grid';

    const seenIds = new Set();
    sortedTargets.forEach((target) => {
        const targetId = target?.id ?? '';
        if (!targetId) {
            logWarn('Skipping target without id.', { target });
            return;
        }
        seenIds.add(String(targetId));
        let cardData = targetState.cards.get(String(targetId));
        if (!cardData) {
            cardData = renderTargetCard(target);
            targetState.cards.set(String(targetId), cardData);
        } else {
            updateTargetCard(target, cardData);
        }

        // Keep DOM order aligned with sorted target order on every refresh.
        targetState.grid.appendChild(cardData.card);
    });

    targetState.cards.forEach((cardData, id) => {
        if (!seenIds.has(id)) {
            cardData.card.remove();
            targetState.cards.delete(id);
        }
    });
};

const setContentMessage = (message) => {
    if (!ensureTargetLayout()) {
        logWarn('Target layout is unavailable; cannot set content message.', {
            message,
        });
        return;
    }
    targetState.message.textContent = message;
    targetState.message.style.display = 'block';
    targetState.grid.style.display = 'none';
};

const getStoredApiKey = () => {
    const storedKey = safeGetValue(FFSCOUTER_API_KEY_STORAGE_KEY, '');
    if (typeof storedKey === 'string') {
        return storedKey.trim();
    }

    return '';
};

const setStoredApiKey = (key) => {
    safeSetValue(FFSCOUTER_API_KEY_STORAGE_KEY, key);
};

const getInitialApiKey = () => {
    const storedKey = getStoredApiKey();
    if (storedKey) {
        return storedKey;
    }

    return '';
};

const renderApiKeyMessage = (message, initialValue = '') => {
    if (!ensureTargetLayout()) {
        return;
    }

    targetState.message.textContent = '';

    const textElement = document.createElement('div');
    textElement.textContent = message;

    const form = document.createElement('div');
    form.className = 'war-targets-api-key-form';

    const keyInput = document.createElement('input');
    keyInput.className = 'war-targets-api-key-input';
    keyInput.type = 'text';
    keyInput.maxLength = FFSCOUTER_KEY_LENGTH;
    keyInput.placeholder = 'Enter your FFScouter API key';
    keyInput.value = initialValue;

    const saveButton = document.createElement('button');
    saveButton.className = 'war-targets-api-key-button';
    saveButton.type = 'button';
    saveButton.textContent = 'Save';

    const submitApiKey = () => {
        const key = keyInput.value.trim();
        setStoredApiKey(key);
        verifyApiKey(key);
    };

    saveButton.addEventListener('click', submitApiKey);
    keyInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submitApiKey();
        }
    });

    form.appendChild(keyInput);
    form.appendChild(saveButton);
    targetState.message.appendChild(textElement);
    targetState.message.appendChild(form);

    targetState.message.style.display = 'block';
    targetState.grid.style.display = 'none';
};

const requestJson = (url) => {
    const requestFn = isFunction(globalThis.GM_xmlhttpRequest)
        ? globalThis.GM_xmlhttpRequest
        : isFunction(getModernGmApi()?.xmlHttpRequest)
          ? getModernGmApi().xmlHttpRequest
          : null;

    if (requestFn) {
        return new Promise((resolve, reject) => {
            requestFn({
                method: 'GET',
                url,
                timeout: REQUEST_TIMEOUT_MS,
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        logError('HTTP request failed.', {
                            url,
                            status: response.status,
                            responseText: response.responseText,
                        });
                        reject(new Error(`Request failed with status ${response.status}`));
                        return;
                    }

                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (error) {
                        logError('Failed to parse JSON response.', {
                            url,
                            responseText: response.responseText,
                            error,
                        });
                        reject(error);
                    }
                },
                onerror: (error) => {
                    logError('Network request failed.', { url, error });
                    reject(new Error('Network request failed.'));
                },
                ontimeout: () => {
                    logError('Network request timed out.', { url, timeoutMs: REQUEST_TIMEOUT_MS });
                    reject(new Error('Request timed out.'));
                },
            });
        });
    }

    const tornPdaHttpGet = getTornPdaHttpGet();
    if (isFunction(tornPdaHttpGet)) {
        return Promise.resolve(tornPdaHttpGet(url))
            .then((response) => {
                const text = typeof response === 'string' ? response : response?.responseText;
                if (!text) {
                    logError('TornPDA request returned an empty response.', { url, response });
                    throw new Error('TornPDA request returned an empty response.');
                }
                return JSON.parse(text);
            })
            .catch((error) => {
                logError('TornPDA request failed.', { url, error });
                throw error;
            });
    }

    return fetch(url, { method: 'GET' })
        .then((response) => {
            if (!response.ok) {
                logError('Fetch request failed.', { url, status: response.status });
                throw new Error(`Request failed with status ${response.status}`);
            }
            return response.json();
        })
        .catch((error) => {
            logError('Fetch request failed unexpectedly.', { url, error });
            throw error;
        });
};

const fetchFactionInfo = async (key) => {
    const data = await requestJson(
        `https://api.torn.com/v2/faction?key=${encodeURIComponent(key)}`
    );
    const id = data?.basic?.id;
    const name = data?.basic?.name;

    if (!id || !name) {
        logError('Faction info response is missing required fields.', { data });
        throw new Error('Unable to read faction information.');
    }

    return { id: String(id), name };
};

const fetchEnemyFaction = async (key, currentFactionId) => {
    if (!currentFactionId) {
        logError('Missing current faction id while fetching enemy faction.');
        throw new Error('Missing faction id.');
    }

    const data = await requestJson(
        `https://api.torn.com/v2/faction/rankedwars?key=${encodeURIComponent(
            key
        )}&limit=1`
    );
    const rankedWars = Array.isArray(data?.rankedwars)
        ? data.rankedwars
        : Array.isArray(data)
          ? data
          : [];
    const activeWar = rankedWars?.[0] ?? null;
    const factions = activeWar?.factions ?? [];
    const enemyFaction = factions.find(
        (faction) => String(faction?.id) !== String(currentFactionId)
    );

    if (!enemyFaction?.id) {
        logError('Unable to resolve enemy faction from ranked wars response.', {
            currentFactionId,
            rankedWars,
            activeWar,
        });
        throw new Error('Unable to resolve enemy faction.');
    }

    return { id: String(enemyFaction.id), name: enemyFaction?.name ?? '' };
};

const fetchEnemyTargets = async (key, enemyId, { useScouter = true } = {}) => {
    if (!enemyId) {
        logWarn('Enemy faction id missing; skipping target fetch.');
        return [];
    }

    const membersData = await requestJson(
        `https://api.torn.com/v2/faction/${encodeURIComponent(
            enemyId
        )}/members?key=${encodeURIComponent(key)}`
    );
    const rawMembers = Array.isArray(membersData?.members)
        ? membersData.members
        : Object.values(membersData?.members ?? {});
    const memberIds = rawMembers
        .map((member) => member?.id)
        .filter((id) => Boolean(id));

    if (memberIds.length === 0) {
        logWarn('No enemy members found.', { enemyId });
        return [];
    }

    if (useScouter && memberIds.length > 0 && statsCache.size === 0) {
        const statsData = await requestJson(
            `https://ffscouter.com/api/v1/get-stats?key=${encodeURIComponent(
                key
            )}&targets=${memberIds.join(',')}`
        );
        (Array.isArray(statsData) ? statsData : []).forEach((stat) => {
            if (stat?.player_id) {
                statsCache.set(stat.player_id, stat);
            }
        });
        if (statsCache.size === 0) {
            logWarn('FFScouter returned no stats for requested member ids.', {
                enemyId,
                memberCount: memberIds.length,
            });
        }
    }

    return rawMembers
        .map((member) => {
            const stats = statsCache.get(member?.id);
            if (!stats || stats.fair_fight == null) {
                return null;
            }

            return {
                ...member,
                availability_status: getAvailabilityStatus(member),
                fair_fight: stats.fair_fight,
                bs_estimate_human: stats.bs_estimate_human,
            };
        })
        .filter(
            (member) =>
                Boolean(member) &&
                !isFederalTarget(member) &&
                !isTravelingTarget(member) &&
                !isAbroadTarget(member)
        );
};

const loadTargets = async (key, options = {}) => {
    const { showLoading = true, ...requestOptions } = options;
    if (showLoading) {
        setContentMessage('Loading targets...');
    }
    const factionInfo = await fetchFactionInfo(key);
    const enemyInfo = await fetchEnemyFaction(key, factionInfo?.id);
    const targets = await fetchEnemyTargets(key, enemyInfo?.id, requestOptions);
    headerState.lastUpdatedAt = Date.now();
    renderTargetGrid(targets);
};

const updateLastUpdatedText = () => {
    const header = document.getElementById('war-targets-header');
    const lastUpdated = header?.querySelector('.war-targets-last-updated');
    if (!lastUpdated) {
        return;
    }

    if (!headerState.lastUpdatedAt) {
        lastUpdated.textContent = 'Last updated: --';
        return;
    }

    const seconds = Math.max(
        0,
        Math.floor((Date.now() - headerState.lastUpdatedAt) / 1000)
    );
    lastUpdated.textContent = `Last updated: ${seconds} seconds ago`;
};

const startLastUpdatedTimer = () => {
    if (headerState.lastUpdatedTimer) {
        clearInterval(headerState.lastUpdatedTimer);
    }
    headerState.lastUpdatedTimer = setInterval(
        updateLastUpdatedText,
        LAST_UPDATED_INTERVAL_MS
    );
    updateLastUpdatedText();
};

const startAutoRefresh = (key) => {
    if (headerState.refreshTimer) {
        clearInterval(headerState.refreshTimer);
    }

    headerState.refreshTimer = setInterval(() => {
        loadTargets(key, { useScouter: false, showLoading: false }).catch((error) => {
            logError('Auto-refresh failed.', { error });
            setContentMessage('Unable to refresh targets.');
        });
    }, TARGET_REFRESH_INTERVAL_MS);
};

const verifyApiKey = (key) => {
    if (!key || key.length !== FFSCOUTER_KEY_LENGTH) {
        renderApiKeyMessage(
            'Invalid API key! Please use the same you use for FFScouter.',
            key
        );
        return;
    }

    setContentMessage('Validating API key...');

    requestJson(
        `https://ffscouter.com/api/v1/check-key?key=${encodeURIComponent(key)}`
    )
        .then((data) => {
            if (!data?.is_registered) {
                throw new Error('Invalid API key.');
            }
            setStoredApiKey(key);
            return loadTargets(key).then(() => {
                startAutoRefresh(key);
                startLastUpdatedTimer();
            });
        })
        .catch((error) => {
            logError('API key validation failed.', { key, error });
            renderApiKeyMessage(
                'Unable to validate API key. Please confirm your key and try again.',
                key
            );
        });
};

const getTargetContainer = () => {
    const factionMain = document.getElementById('faction-main');
    if (!factionMain) {
        logWarn('Faction main container not found yet.');
    }
    return factionMain?.children?.[0]?.children?.[0]?.children?.[0] ?? null;
};

function renderNewElements() {
    const targetDiv = getTargetContainer();
    if (!targetDiv) {
        logWarn('Target container not available; delaying initialization.');
        return false;
    }

    if (document.getElementById('war-targets-header')) {
        return true;
    }

    // Add new divs
    // Header
    const headerDiv = document.createElement('div');
    const headerContent = document.createElement('div');
    headerContent.className = 'war-targets-header-content';

    const headerTitle = document.createElement('span');
    headerTitle.textContent = `My Targets | Max FF: ${MAX_FAIR_FIGHT}`;

    const lastUpdated = document.createElement('span');
    lastUpdated.className = 'war-targets-last-updated';
    lastUpdated.textContent = 'Last updated: --';

    headerContent.appendChild(headerTitle);
    headerContent.appendChild(lastUpdated);
    headerDiv.appendChild(headerContent);
    headerDiv.className = 'title-black title-toggle m-top10 tablet active top-round';
    headerDiv.id = 'war-targets-header';
    const fifthChild = targetDiv.children[4];
    targetDiv.insertBefore(headerDiv, fifthChild);
    // Content
    const contentDiv = document.createElement('div');
    contentDiv.textContent = 'Checking API key...';
    contentDiv.className = 'cont-gray10 cont-toggle bottom-round editor-content announcement unreset scrollbar-bright';
    contentDiv.id = 'war-tagets-content';
    const sixthChild = targetDiv.children[5];
    targetDiv.insertBefore(contentDiv, sixthChild);

    return true;
}

(async function() {
    'use strict';

    waitForChatRoot();

    const initialize = () => {
        if (!renderNewElements()) {
            logWarn('Render preconditions not met; retrying initialization in 500ms.');
            setTimeout(initialize, 500);
            return;
        }
        verifyApiKey(getInitialApiKey());
    };

    setTimeout(initialize, 1000);
})();
