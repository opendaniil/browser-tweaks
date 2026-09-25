// ==UserScript==
// @name         ChatGPT Dictation Hotkey + Auto-Send
// @namespace    https://github.com/opendaniil
// @version      3.0.0
// @description  Alt+D starts/stops ChatGPT dictation and auto-sends when Send becomes available.
// @icon         https://chatgpt.com/favicon.ico
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-idle
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/opendaniil/browser-tweaks
// @supportURL   https://github.com/opendaniil/browser-tweaks/issues
// @downloadURL  https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-dictation-hotkey-autosend.user.js
// @updateURL    https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-dictation-hotkey-autosend.user.js
// ==/UserScript==

(() => {
    /**************************************************************************
     * Config
     **************************************************************************/

    const HOTKEY = {
        code: "KeyD",
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
        ignoreRepeat: true,
    };

    const SELECTORS = {
        composer: "[data-chatgpt-composer]",

        dictate:
            'button[aria-label="Dictate"]',

        stopDictation:
            'button[aria-label="Stop dictation"]',

        send:
            'button[type="submit"][aria-label="Send"]',
    };

    const TIMING = {
        debounceMs: 120,
        timeoutMs: 15000,
    };


    /**************************************************************************
     * State
     **************************************************************************/

    let observer = null;

    let autosendArmed = false;

    let debounceTimer = null;
    let timeoutTimer = null;


    /**************************************************************************
     * Hotkey
     **************************************************************************/

    window.addEventListener(
        "keydown",
        handleHotkey,
        true,
    );

    function isHotkey(event) {
        if (
            event.code !==
            HOTKEY.code
        ) {
            return false;
        }

        if (
            HOTKEY.ignoreRepeat &&
            event.repeat
        ) {
            return false;
        }

        if (
            event.altKey !==
            HOTKEY.altKey
        ) {
            return false;
        }

        if (
            event.ctrlKey !==
            HOTKEY.ctrlKey
        ) {
            return false;
        }

        if (
            event.shiftKey !==
            HOTKEY.shiftKey
        ) {
            return false;
        }

        if (
            event.metaKey !==
            HOTKEY.metaKey
        ) {
            return false;
        }

        return true;
    }


    /**************************************************************************
     * Composer
     **************************************************************************/

    function getVisibleButton(selector) {
        const buttons =
            document.querySelectorAll(
                selector,
            );

        for (
            const button of buttons
        ) {
            const rect =
                button.getBoundingClientRect();

            if (
                rect.width > 0 &&
                rect.height > 0
            ) {
                return button;
            }
        }

        return null;
    }

    function getDictationButton() {
        return (
            getVisibleButton(
                SELECTORS.stopDictation,
            ) ||
            getVisibleButton(
                SELECTORS.dictate,
            )
        );
    }

    function getComposerForButton(
        button,
    ) {
        return (
            button?.closest(
                SELECTORS.composer,
            ) ||
            document.body
        );
    }


    /**************************************************************************
     * Send
     **************************************************************************/

    function getSendButton(root) {
        const button =
            root.querySelector(
                SELECTORS.send,
            );

        if (
            !(
                button instanceof
                HTMLButtonElement
            )
        ) {
            return null;
        }

        return button;
    }

    function isSendReady(button) {
        return (
            button.isConnected &&
            !button.disabled &&
            button.getAttribute(
                "aria-disabled",
            ) !== "true"
        );
    }


    /**************************************************************************
     * Auto-send
     **************************************************************************/

    function stopAutoSend() {
        autosendArmed = false;

        observer?.disconnect();
        observer = null;

        clearTimeout(
            debounceTimer,
        );

        debounceTimer = null;

        clearTimeout(
            timeoutTimer,
        );

        timeoutTimer = null;
    }

    function tryAutoSend(root) {
        if (!autosendArmed) {
            return;
        }

        const sendButton =
            getSendButton(root);

        if (
            !sendButton ||
            !isSendReady(
                sendButton,
            )
        ) {
            return;
        }

        stopAutoSend();

        sendButton.click();
    }

    function scheduleAutoSendCheck(
        root,
    ) {
        if (!autosendArmed) {
            return;
        }

        clearTimeout(
            debounceTimer,
        );

        debounceTimer =
            setTimeout(
                () => {
                    tryAutoSend(root);
                },
                TIMING.debounceMs,
            );
    }

    function startAutoSend(root) {
        stopAutoSend();

        autosendArmed = true;

        observer =
            new MutationObserver(
                () => {
                    scheduleAutoSendCheck(
                        root,
                    );
                },
            );

        observer.observe(
            root,
            {
                childList: true,
                subtree: true,
                attributes: true,

                attributeFilter: [
                    "aria-label",
                    "aria-disabled",
                    "disabled",
                    "type",
                ],
            },
        );

        timeoutTimer =
            setTimeout(
                stopAutoSend,
                TIMING.timeoutMs,
            );

        /*
         * Send may already be ready by
         * the time the observer starts.
         */
        scheduleAutoSendCheck(
            root,
        );
    }


    /**************************************************************************
     * Dictation
     **************************************************************************/

    function handleHotkey(event) {
        if (!isHotkey(event)) {
            return;
        }

        const dictationButton =
            getDictationButton();

        if (!dictationButton) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const wasActive =
            dictationButton.matches(
                SELECTORS.stopDictation,
            );

        const composer =
            getComposerForButton(
                dictationButton,
            );

        dictationButton.click();

        /*
         * Dictate -> Stop dictation
         *
         * We just started recording.
         * Nothing should be sent yet.
         */
        if (!wasActive) {
            stopAutoSend();
            return;
        }

        /*
         * Stop dictation -> transcription.
         *
         * Wait until ChatGPT exposes an
         * enabled Send button and click it.
         */
        startAutoSend(
            composer,
        );
    }
})();