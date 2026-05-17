// ==UserScript==
// @name         ChatGPT Dictation Hotkey + Auto-Send
// @namespace    https://github.com/opendaniil
// @version      2.4.0
// @description  Alt+D starts/stops ChatGPT dictation and optionally auto-sends when the Send button becomes available.
// @icon         https://chatgpt.com/favicon.ico
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/opendaniil/browser-tweaks
// @supportURL   https://github.com/opendaniil/browser-tweaks/issues
// @downloadURL  https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-dictation-hotkey-autosend.user.js
// @updateURL    https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-dictation-hotkey-autosend.user.js
// ==/UserScript==

;(() => {
  const HOTKEY = {
    code: 'KeyD',
    altKey: true,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    ignoreRepeat: true,
  }

  const SELECTORS = {
    root: '#thread-bottom-container',
    dictation: `[aria-label="Start dictation"],[aria-label="Submit dictation"]`,
    sendReady: `#composer-submit-button[aria-label="Send prompt"]`,
  }

  const TIMING = {
    debounceMs: 120,
    timeoutMs: 15000,
  }

  const DictationState = {
    INACTIVE: 'Start dictation',
    ACTIVE: 'Submit dictation',
  }

  let observer = null
  let autosendArmed = false
  let debounceTimer = null
  let timeoutTimer = null

  window.addEventListener('keydown', handleHotkey, true)

  function isHotkey(event) {
    if (event.code !== HOTKEY.code) return false
    if (HOTKEY.ignoreRepeat && event.repeat) return false
    if (event.altKey !== HOTKEY.altKey) return false
    if (event.ctrlKey !== HOTKEY.ctrlKey) return false
    if (event.shiftKey !== HOTKEY.shiftKey) return false
    if (event.metaKey !== HOTKEY.metaKey) return false

    return true
  }

  function isDictationActive(button) {
    return button.getAttribute('aria-label') === DictationState.ACTIVE
  }

  function stopAutoSend() {
    autosendArmed = false

    observer?.disconnect()
    observer = null

    clearTimeout(debounceTimer)
    debounceTimer = null

    clearTimeout(timeoutTimer)
    timeoutTimer = null
  }

  function startAutoSend() {
    stopAutoSend()
    autosendArmed = true

    const root = document.querySelector(SELECTORS.root) || document.body

    observer = new MutationObserver(() => {
      if (!autosendArmed) return

      clearTimeout(debounceTimer)

      debounceTimer = setTimeout(() => {
        if (!autosendArmed) return

        const sendButton = document.querySelector(SELECTORS.sendReady)
        if (!sendButton) return

        stopAutoSend()
        sendButton.click()
      }, TIMING.debounceMs)
    })

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })

    timeoutTimer = setTimeout(stopAutoSend, TIMING.timeoutMs)
  }

  function handleHotkey(event) {
    if (!isHotkey(event)) return

    event.preventDefault()
    event.stopPropagation()

    const dictationButton = document.querySelector(SELECTORS.dictation)
    if (!dictationButton) return

    const wasActive = isDictationActive(dictationButton)

    dictationButton.click()

    if (!wasActive) {
      stopAutoSend()
      return
    }

    startAutoSend()
  }
})()
