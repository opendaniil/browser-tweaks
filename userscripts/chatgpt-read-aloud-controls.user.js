// ==UserScript==
// @name         ChatGPT Read Aloud: Speed, Pause, Auto-Read
// @namespace    https://github.com/opendaniil
// @version      4.14
// @description  Adds compact controls for ChatGPT Read Aloud: realtime speed, play/pause, Space shortcut, and per-chat auto-read.
// @icon         https://chatgpt.com/favicon.ico
// @match        https://chatgpt.com/*
// @match        https://*.chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-start
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/opendaniil/browser-tweaks
// @supportURL   https://github.com/opendaniil/browser-tweaks/issues
// @downloadURL  https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-read-aloud-controls.user.js
// @updateURL    https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-read-aloud-controls.user.js
// ==/UserScript==

;(() => {
  /**************************************************************************
   * Config
   **************************************************************************/

  const MIN_SPEED = 0.5
  const MAX_SPEED = 4
  const SPEED_STEP = 0.25

  const SPEED_STORAGE_KEY = 'chatgptReadAloudComposerSpeedMvp'
  const AUTO_READ_STORAGE_PREFIX = 'chatgptReadAloudAutoRead:'

  const UI_ID = 'isolated-speed-ui'

  const WATCHDOG_INTERVAL_MS = 500
  const POLL_INTERVAL = 600
  const READ_DELAY = 1000
  const READ_ALOUD_EXPECTATION_MS = 10000

  /**************************************************************************
   * State
   **************************************************************************/

  let speed = 1
  let currentAudio = null
  let watchdogTimer = null
  let observer = null
  let autoReadObserver = null
  let routeObserver = null
  let ignoreRateChange = false
  let activeAudioSession = false
  let hasSeenPlayableAudio = false
  let isAudioLoading = false
  let keyboardShortcutsInstalled = false
  let readAloudClickListenerInstalled = false

  let loadingDotsTimer = null
  let loadingDotsCount = 1

  let isAutoReadEnabled = false
  let lastReadMsgId = null
  let waitTimer = null
  let lastUrl = location.href
  let readAloudExpectedUntil = 0

  let container = null
  let playerGroup = null
  let playPauseButton = null
  let speedDisplay = null
  let timeText = null
  let autoReadButton = null

  /**************************************************************************
   * Utils
   **************************************************************************/

  function log(...args) {
    console.debug('[ReadAloudControls]', ...args)
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  function roundTo(value, decimals = 2) {
    const p = 10 ** decimals
    return Math.round((value + Number.EPSILON) * p) / p
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return '--:--'
    }

    const total = Math.floor(seconds)
    const m = Math.floor(total / 60)
    const s = total % 60

    return `${m}:${String(s).padStart(2, '0')}`
  }

  function isVisible(el) {
    if (!el) return false

    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    )
  }

  function setVisibleKeepSpace(el, visible) {
    if (!el) return

    el.style.visibility = visible ? 'visible' : 'hidden'
    el.style.pointerEvents = visible ? 'auto' : 'none'
  }

  function startLoadingDots() {
    if (loadingDotsTimer) return

    loadingDotsTimer = window.setInterval(() => {
      loadingDotsCount = loadingDotsCount >= 3 ? 1 : loadingDotsCount + 1

      if (
        playPauseButton?.disabled &&
        /^[.]+$/.test(playPauseButton.textContent || '')
      ) {
        playPauseButton.textContent = '.'.repeat(loadingDotsCount)
      }
    }, 350)
  }

  function stopLoadingDots() {
    if (loadingDotsTimer) {
      clearInterval(loadingDotsTimer)
      loadingDotsTimer = null
    }

    loadingDotsCount = 1
  }

  function getChatStorageKey() {
    return `${AUTO_READ_STORAGE_PREFIX}${location.pathname || 'unknown'}`
  }

  function loadAutoReadState() {
    isAutoReadEnabled = localStorage.getItem(getChatStorageKey()) === 'true'
  }

  function saveAutoReadState() {
    localStorage.setItem(getChatStorageKey(), String(isAutoReadEnabled))
  }

  /**************************************************************************
   * Audio detection
   **************************************************************************/

  function isRealAudio(audio) {
    return audio instanceof HTMLAudioElement
  }

  function getAllAudioElements() {
    return Array.from(document.querySelectorAll('audio')).filter(isRealAudio)
  }

  function expectReadAloudAudio() {
    readAloudExpectedUntil = Date.now() + READ_ALOUD_EXPECTATION_MS
  }

  function isReadAloudAudioExpected() {
    return Date.now() <= readAloudExpectedUntil
  }

  function isAudioStillUsable(audio) {
    if (!isRealAudio(audio)) return false

    // Some streams may not have src/currentSrc, so do not check src.
    // DOM presence is enough for our current purpose.
    return document.contains(audio)
  }

  function getBestAudioCandidate() {
    if (!activeAudioSession) return null

    const audios = getAllAudioElements()

    if (currentAudio && audios.includes(currentAudio) && hasSeenPlayableAudio) {
      return currentAudio
    }

    const playing = audios.find((audio) => !audio.paused && !audio.ended)

    if (playing) {
      return playing
    }

    return null
  }

  function refreshCurrentAudioIfNeeded() {
    if (
      activeAudioSession &&
      currentAudio &&
      isAudioStillUsable(currentAudio) &&
      hasSeenPlayableAudio
    ) {
      return currentAudio
    }

    currentAudio = getBestAudioCandidate()
    return currentAudio
  }

  /**************************************************************************
   * Speed storage
   **************************************************************************/

  function loadSpeed() {
    const saved = Number(localStorage.getItem(SPEED_STORAGE_KEY))

    if (Number.isFinite(saved)) {
      speed = clamp(saved, MIN_SPEED, MAX_SPEED)
    } else {
      speed = 1
    }
  }

  function saveSpeed() {
    localStorage.setItem(SPEED_STORAGE_KEY, String(speed))
  }

  function updateDisplay() {
    if (speedDisplay) {
      speedDisplay.textContent = `${speed}x`
      speedDisplay.title =
        speed === 1 ? 'Speed is already 1x' : 'Reset speed to 1x'
    }
  }

  function setSpeed(nextSpeed) {
    speed = roundTo(clamp(nextSpeed, MIN_SPEED, MAX_SPEED))

    saveSpeed()
    updateDisplay()

    // Full scan only when the user actually changes speed.
    forceSpeedOnAllAudio()

    updateUI()
  }

  function changeSpeed(delta) {
    setSpeed(speed + delta)
  }

  /**************************************************************************
   * Force playbackRate
   **************************************************************************/

  function forceSpeed(audio) {
    if (!isRealAudio(audio)) return

    try {
      if (Math.abs(audio.playbackRate - speed) > 0.001) {
        ignoreRateChange = true
        audio.playbackRate = speed
      }

      audio.preservesPitch = true
      audio.mozPreservesPitch = true
      audio.webkitPreservesPitch = true
    } catch (error) {
      log('forceSpeed failed', error)
    }
  }

  function forceSpeedOnAllAudio() {
    const audios = getAllAudioElements()

    for (const audio of audios) {
      forceSpeed(audio)
    }

    const best = getBestAudioCandidate()

    if (best) {
      currentAudio = best
    }
  }

  function startWatchdog() {
    if (watchdogTimer) return

    watchdogTimer = window.setInterval(() => {
      const audio = refreshCurrentAudioIfNeeded()

      if (audio) {
        forceSpeed(audio)
      }

      updateUI()
    }, WATCHDOG_INTERVAL_MS)
  }

  /**************************************************************************
   * Native audio events
   **************************************************************************/

  document.addEventListener(
    'play',
    (event) => {
      if (!isRealAudio(event.target)) return
      if (!activeAudioSession && !isReadAloudAudioExpected()) return

      activeAudioSession = true
      hasSeenPlayableAudio = true
      isAudioLoading = true
      currentAudio = event.target
      readAloudExpectedUntil = 0

      // Full scan on play, because ChatGPT may create/swap audio elements here.
      forceSpeedOnAllAudio()
      forceSpeed(currentAudio)

      updateUI()

      log('audio play detected', currentAudio)
    },
    true,
  )

  document.addEventListener(
    'playing',
    (event) => {
      if (!isRealAudio(event.target)) return

      if (event.target === currentAudio) {
        isAudioLoading = false
        forceSpeed(currentAudio)
        updateUI()
      }
    },
    true,
  )

  document.addEventListener(
    'timeupdate',
    (event) => {
      if (!isRealAudio(event.target)) return

      if (event.target === currentAudio) {
        if (currentAudio.currentTime > 0) {
          isAudioLoading = false
        }

        forceSpeed(currentAudio)
        updateUI()
      }
    },
    true,
  )

  document.addEventListener(
    'waiting',
    (event) => {
      if (!isRealAudio(event.target)) return

      if (event.target === currentAudio && currentAudio.currentTime <= 0) {
        isAudioLoading = true
        updateUI()
      }
    },
    true,
  )

  document.addEventListener(
    'pause',
    (event) => {
      if (!isRealAudio(event.target)) return

      if (event.target === currentAudio) {
        updateUI()
      }
    },
    true,
  )

  document.addEventListener(
    'ended',
    (event) => {
      if (!isRealAudio(event.target)) return

      if (event.target === currentAudio) {
        activeAudioSession = false
        isAudioLoading = false
        hasSeenPlayableAudio = false
        currentAudio = null
        readAloudExpectedUntil = 0
        stopLoadingDots()
        updateUI()
      }
    },
    true,
  )

  document.addEventListener(
    'ratechange',
    (event) => {
      if (!isRealAudio(event.target)) return

      if (ignoreRateChange) {
        ignoreRateChange = false
        return
      }

      // Full scan on ratechange, because this is exactly when ChatGPT may be fighting us.
      forceSpeedOnAllAudio()
      forceSpeed(event.target)

      updateUI()
    },
    true,
  )

  /**************************************************************************
   * Play / pause
   **************************************************************************/

  function ensureCurrentAudio() {
    const audio = refreshCurrentAudioIfNeeded()

    if (audio) {
      currentAudio = audio
      return currentAudio
    }

    return null
  }

  function togglePlayPause() {
    const audio = ensureCurrentAudio()

    if (!audio) {
      updateUI()
      return
    }

    if (audio.ended) {
      updateUI()
      return
    }

    if (audio.paused) {
      isAudioLoading = audio.currentTime <= 0

      audio
        .play()
        .then(() => {
          forceSpeed(audio)
          updateUI()
        })
        .catch((error) => {
          log('play failed', error)
          updateUI()
        })
    } else {
      audio.pause()
      updateUI()
    }
  }

  /**************************************************************************
   * Keyboard shortcuts
   **************************************************************************/

  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false

    const tagName = target.tagName.toLowerCase()

    return (
      tagName === 'input' ||
      tagName === 'textarea' ||
      target.isContentEditable ||
      Boolean(target.closest("[contenteditable='true']")) ||
      Boolean(target.closest("[contenteditable='plaintext-only']"))
    )
  }

  function setupKeyboardShortcuts() {
    if (keyboardShortcutsInstalled) return

    keyboardShortcutsInstalled = true

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.code !== 'Space') return
        if (event.ctrlKey || event.altKey || event.metaKey) return
        if (isTypingTarget(event.target)) return

        const audio = refreshCurrentAudioIfNeeded()

        if (!audio || audio.ended) return

        event.preventDefault()
        event.stopPropagation()

        togglePlayPause()
      },
      true,
    )
  }

  /**************************************************************************
   * Auto Read Aloud
   **************************************************************************/

  const READ_SELECTORS = [
    '[data-testid="voice-play-turn-action-button"]',
    '[role="menuitem"][aria-label="Read aloud"]',
    '[role="menuitem"][aria-label="朗读"]',
    'button[aria-label="Read aloud"]',
    'button[aria-label="朗读"]',
  ]

  function getReadAloudControl(target) {
    if (!(target instanceof Element)) return null

    for (const selector of READ_SELECTORS) {
      const el = target.closest(selector)

      if (el && isVisible(el)) return el
    }

    return null
  }

  function setupReadAloudClickExpectation() {
    if (readAloudClickListenerInstalled) return

    readAloudClickListenerInstalled = true

    document.addEventListener(
      'click',
      (event) => {
        if (getReadAloudControl(event.target)) {
          expectReadAloudAudio()
        }
      },
      true,
    )
  }

  function simulateClick(el) {
    const rect = el.getBoundingClientRect()
    const cx = Math.round((rect.left + rect.right) / 2)
    const cy = Math.round((rect.top + rect.bottom) / 2)

    const shared = {
      bubbles: true,
      cancelable: true,
      clientX: cx,
      clientY: cy,
    }

    const pointer = {
      ...shared,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }

    const events = [
      [PointerEvent, { ...pointer, type: 'pointerover', pressure: 0 }],
      [
        PointerEvent,
        { ...pointer, type: 'pointerenter', pressure: 0, bubbles: false },
      ],
      [PointerEvent, { ...pointer, type: 'pointermove', pressure: 0 }],
      [
        PointerEvent,
        {
          ...pointer,
          type: 'pointerdown',
          pressure: 0.5,
          button: 0,
          buttons: 1,
        },
      ],
      [MouseEvent, { ...shared, type: 'mouseover' }],
      [MouseEvent, { ...shared, type: 'mouseenter', bubbles: false }],
      [MouseEvent, { ...shared, type: 'mousemove' }],
      [MouseEvent, { ...shared, type: 'mousedown', button: 0, buttons: 1 }],
      [PointerEvent, { ...pointer, type: 'pointerup', pressure: 0, button: 0 }],
      [MouseEvent, { ...shared, type: 'mouseup', button: 0 }],
      [MouseEvent, { ...shared, type: 'click', button: 0 }],
    ]

    for (const [EventClass, opts] of events) {
      const { type, ...rest } = opts
      el.dispatchEvent(new EventClass(type, rest))
    }
  }

  function dismissMenu() {
    const shared = {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    }

    document.body.dispatchEvent(
      new PointerEvent('pointerdown', {
        ...shared,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    )

    document.body.dispatchEvent(new MouseEvent('mousedown', shared))
    document.body.dispatchEvent(new MouseEvent('click', shared))
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  }

  function tryClickReadAloud() {
    for (const selector of READ_SELECTORS) {
      const el = document.querySelector(selector)

      if (el && isVisible(el)) {
        log('auto read click', selector)
        expectReadAloudAudio()
        el.click()
        return true
      }
    }

    return false
  }

  async function triggerReadAloud(msgEl) {
    if (!msgEl) return

    msgEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await sleep(500)

    if (tryClickReadAloud()) return

    const root =
      msgEl.closest('[data-testid^="conversation-turn"]') ||
      msgEl.closest('article') ||
      msgEl.parentElement

    const moreButton =
      root?.querySelector('button[aria-label="More actions"]') ||
      root?.querySelector('button[aria-label*="More" i]')

    if (!moreButton || !isVisible(moreButton)) {
      isAudioLoading = false
      updateUI()
      log('auto read: "More actions" button not found')
      return
    }

    simulateClick(moreButton)

    for (let i = 0; i < 5; i++) {
      await sleep(300)

      if (
        READ_SELECTORS.some((selector) =>
          isVisible(document.querySelector(selector)),
        )
      ) {
        break
      }
    }

    const clicked = tryClickReadAloud()

    await sleep(150)
    dismissMenu()

    if (!clicked) {
      isAudioLoading = false
      updateUI()
      log('auto read: "Read aloud" not found in menu')
    }
  }

  function isStreaming() {
    return Boolean(
      document.querySelector(
        '[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止生成"]',
      ),
    )
  }

  function getLastAssistantMsg() {
    const messages = document.querySelectorAll(
      '[data-message-author-role="assistant"]',
    )
    return messages.length ? messages[messages.length - 1] : null
  }

  function getMsgId(el) {
    return (
      el.getAttribute('data-message-id') || (el.innerText || '').slice(0, 80)
    )
  }

  function onNewMessage(msgEl) {
    if (!isAutoReadEnabled) return

    if (waitTimer) {
      clearTimeout(waitTimer)
      waitTimer = null
    }

    const poll = () => {
      if (!isAutoReadEnabled) return

      if (isStreaming()) {
        waitTimer = setTimeout(poll, POLL_INTERVAL)
        return
      }

      waitTimer = setTimeout(async () => {
        if (!isAutoReadEnabled) return

        const id = getMsgId(msgEl)

        if (id === lastReadMsgId) return

        lastReadMsgId = id

        await triggerReadAloud(msgEl)
      }, READ_DELAY)
    }

    poll()
  }

  function setupAutoReadObserver() {
    if (autoReadObserver || !document.body) return

    const lastMsg = getLastAssistantMsg()
    let lastMsgId = lastMsg ? getMsgId(lastMsg) : null

    autoReadObserver = new MutationObserver(() => {
      const currentMsg = getLastAssistantMsg()
      const currentMsgId = currentMsg ? getMsgId(currentMsg) : null

      if (currentMsg && currentMsgId !== lastMsgId) {
        lastMsgId = currentMsgId
        onNewMessage(currentMsg)
      } else if (!currentMsg) {
        lastMsgId = null
      }
    })

    autoReadObserver.observe(document.body, {
      childList: true,
      subtree: true,
    })
  }

  function setupRouteObserver() {
    if (routeObserver) return

    routeObserver = new MutationObserver(() => {
      if (location.href === lastUrl) return

      lastUrl = location.href
      lastReadMsgId = null
      activeAudioSession = false
      isAudioLoading = false
      hasSeenPlayableAudio = false
      currentAudio = null
      readAloudExpectedUntil = 0

      stopLoadingDots()

      loadAutoReadState()
      updateAutoReadButton()
      updateUI()
    })

    routeObserver.observe(document, {
      subtree: true,
      childList: true,
    })
  }

  function toggleAutoRead() {
    isAutoReadEnabled = !isAutoReadEnabled
    saveAutoReadState()
    updateAutoReadButton()

    if (isAutoReadEnabled) {
      const lastMsg = getLastAssistantMsg()

      if (lastMsg && !isStreaming()) {
        lastReadMsgId = getMsgId(lastMsg)
      }
    }
  }

  function updateAutoReadButton() {
    if (!autoReadButton) return

    autoReadButton.textContent = isAutoReadEnabled ? '🔊' : '🔇'
    autoReadButton.title = isAutoReadEnabled
      ? 'Auto Read is ON for this chat'
      : 'Auto Read is OFF for this chat'
    autoReadButton.style.opacity = isAutoReadEnabled ? '1' : '0.45'
  }

  /**************************************************************************
   * UI state
   **************************************************************************/

  function getPlayerState(audio) {
    if (!activeAudioSession || !audio || !hasSeenPlayableAudio) return 'idle'
    if (audio.ended) return 'ended'
    if (isAudioLoading) return 'loading'
    if (audio.paused) return 'paused'
    return 'playing'
  }

  function shouldShowPlayer(state) {
    return state === 'loading' || state === 'playing' || state === 'paused'
  }

  /**************************************************************************
   * UI
   **************************************************************************/

  function buildTimeText(audio) {
    if (!audio) return '--:-- / --:--'

    const current = formatTime(audio.currentTime)
    const duration = formatTime(audio.duration)

    return `${current} / ${duration}`
  }

  function updateUI() {
    if (!playerGroup || !playPauseButton || !timeText) return

    const audio = currentAudio
    const state = getPlayerState(audio)
    const visible = shouldShowPlayer(state)

    setVisibleKeepSpace(playerGroup, visible)

    if (!visible) {
      stopLoadingDots()

      playPauseButton.disabled = true
      playPauseButton.textContent = '▶'
      playPauseButton.title = 'No active Read Aloud audio'
      timeText.textContent = '--:-- / --:--'
      return
    }

    if (state === 'loading') {
      playPauseButton.disabled = true
      playPauseButton.textContent = '.'.repeat(loadingDotsCount)
      playPauseButton.title = 'Loading Read Aloud audio'
      timeText.textContent = buildTimeText(audio)
      startLoadingDots()
      return
    }

    stopLoadingDots()

    if (state === 'paused') {
      playPauseButton.disabled = false
      playPauseButton.textContent = '▶'
      playPauseButton.title = 'Play'
      timeText.textContent = buildTimeText(audio)
      return
    }

    if (state === 'playing') {
      playPauseButton.disabled = false
      playPauseButton.textContent = '⏸'
      playPauseButton.title = 'Pause'
      timeText.textContent = buildTimeText(audio)
      return
    }
  }

  function createUI() {
    if (document.getElementById(UI_ID)) return

    const threadBottom =
      document.querySelector('#thread-bottom') ||
      document.querySelector('#thread-bottom-container')

    if (!threadBottom) return

    container = document.createElement('div')
    container.id = UI_ID
    container.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 12px;
            margin-left: auto;
            margin-right: 12px;
            width: fit-content;
            min-width: 292px;
            max-width: 460px;
            font-size: 14px;
            align-self: flex-start;
        `

    playerGroup = document.createElement('div')
    playerGroup.style.cssText = `
            display: flex;
            align-items: center;
            gap: 7px;
            flex: 0 1 auto;
            min-width: 0;
            visibility: hidden;
            pointer-events: none;
        `

    playPauseButton = document.createElement('button')
    playPauseButton.type = 'button'
    playPauseButton.textContent = '▶'
    playPauseButton.disabled = true
    playPauseButton.title = 'No active Read Aloud audio'
    playPauseButton.style.height = '30px'
    playPauseButton.style.width = '40px'
    playPauseButton.onclick = togglePlayPause

    timeText = document.createElement('span')
    timeText.textContent = '--:-- / --:--'
    timeText.style.opacity = '0.75'
    timeText.style.whiteSpace = 'nowrap'
    timeText.style.width = '96px'
    timeText.style.textAlign = 'left'

    const minus = document.createElement('button')
    minus.type = 'button'
    minus.textContent = '-'
    minus.title = `Decrease speed by ${SPEED_STEP}x`
    minus.style.height = '30px'
    minus.style.width = '30px'

    speedDisplay = document.createElement('button')
    speedDisplay.type = 'button'
    speedDisplay.title = 'Reset speed to 1x'
    speedDisplay.style.height = '30px'
    speedDisplay.style.width = '60px'
    speedDisplay.style.textAlign = 'center'
    speedDisplay.style.cursor = 'pointer'
    speedDisplay.onclick = () => setSpeed(1)

    const plus = document.createElement('button')
    plus.type = 'button'
    plus.textContent = '+'
    plus.title = `Increase speed by ${SPEED_STEP}x`
    plus.style.height = '30px'
    plus.style.width = '30px'

    autoReadButton = document.createElement('button')
    autoReadButton.type = 'button'
    autoReadButton.style.height = '30px'
    autoReadButton.style.width = '38px'
    autoReadButton.style.textAlign = 'center'
    autoReadButton.style.flex = '0 0 auto'
    autoReadButton.onclick = toggleAutoRead

    minus.onclick = () => changeSpeed(-SPEED_STEP)
    plus.onclick = () => changeSpeed(SPEED_STEP)

    playerGroup.appendChild(playPauseButton)
    playerGroup.appendChild(timeText)
    playerGroup.appendChild(minus)
    playerGroup.appendChild(speedDisplay)
    playerGroup.appendChild(plus)

    container.appendChild(playerGroup)
    container.appendChild(autoReadButton)

    threadBottom.prepend(container)

    updateDisplay()
    updateAutoReadButton()
    updateUI()
  }

  /**************************************************************************
   * DOM
   **************************************************************************/

  function watchDOM() {
    if (observer || !document.body) return

    observer = new MutationObserver(() => {
      if (!document.getElementById(UI_ID)) {
        createUI()
        updateAutoReadButton()
      }
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    })
  }

  /**************************************************************************
   * Init
   **************************************************************************/

  function initDOM() {
    createUI()
    watchDOM()

    setupAutoReadObserver()
    setupRouteObserver()
    setupReadAloudClickExpectation()
    setupKeyboardShortcuts()

    startWatchdog()

    forceSpeedOnAllAudio()
    updateDisplay()
    updateAutoReadButton()
    updateUI()
  }

  function init() {
    loadSpeed()
    loadAutoReadState()

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initDOM, { once: true })
    } else {
      initDOM()
    }

    log('initialized')
  }

  init()
})()
