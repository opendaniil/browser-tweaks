// ==UserScript==
// @name         Zen Browser: Compact Mode Shortcut Priority
// @namespace    https://github.com/opendaniil
// @version      1.0.0
// @description  Prevents websites from handling Cmd+S / Ctrl+S so Zen Browser can use it for Toggle Compact Mode.
// @icon         https://zen-browser.app/favicon.ico
// @match        *://*/*
// @grant        none
// @run-at       document-start
// @allFrames    true
// @license      MIT
// @homepageURL  https://github.com/opendaniil/browser-tweaks
// @supportURL   https://github.com/opendaniil/browser-tweaks/issues
// @downloadURL  https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/zen-browser-compact-mode-shortcut-priority.user.js
// @updateURL    https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/zen-browser-compact-mode-shortcut-priority.user.js
// ==/UserScript==

;(() => {
  const KEY_CODE = 'KeyS'

  function isCompactModeShortcut(event) {
    const isSaveKey =
      event.code === KEY_CODE || event.key?.toLowerCase() === 's'

    const usesPrimaryModifier = event.metaKey || event.ctrlKey
    const hasExtraModifiers = event.altKey || event.shiftKey

    return isSaveKey && usesPrimaryModifier && !hasExtraModifiers
  }

  window.addEventListener(
    'keydown',
    function preserveBrowserCompactModeShortcut(event) {
      if (!isCompactModeShortcut(event)) {
        return
      }

      // Do not call preventDefault().
      // We only stop website handlers so the browser can still handle Cmd+S / Ctrl+S.
      event.stopImmediatePropagation()
      event.stopPropagation()

      console.debug('[userscript] Preserved browser compact mode shortcut')
    },
    true,
  )
})()
