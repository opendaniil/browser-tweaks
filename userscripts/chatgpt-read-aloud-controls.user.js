// ==UserScript==
// @name         ChatGPT Read Aloud: Speed, Pause, Auto-Read
// @version      4.17.0
// @description  Adds compact controls for ChatGPT Read Aloud: realtime speed, play/pause, Space shortcut, and per-chat auto-read.
// @icon         https://chatgpt.com/favicon.ico
// @match        https://chatgpt.com/*
// @match        https://*.chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/opendaniil/browser-tweaks/blob/main/userscripts/README.md#chatgpt-read-aloud-speed-pause-auto-read
// @supportURL   https://github.com/opendaniil/browser-tweaks/issues
// @downloadURL  https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-read-aloud-controls.user.js
// @updateURL    https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-read-aloud-controls.user.js
// ==/UserScript==

(() => {
	/**************************************************************************
	 * Config
	 **************************************************************************/

	const MIN_SPEED = 0.5;
	const MAX_SPEED = 4;
	const SPEED_STEP = 0.25;

	const SPEED_STORAGE_KEY = "chatgptReadAloudComposerSpeedMvp";
	const AUTO_READ_STORAGE_PREFIX = "chatgptReadAloudAutoRead:";
	const DEFAULT_VOLUME_BOOST = 4;
	const MIN_VOLUME_BOOST = 1;
	const MAX_VOLUME_BOOST = 24;
	const VOLUME_BOOST_STORAGE_KEY = "volumeBoost";

	const UI_ID = "isolated-speed-ui";

	const POLL_INTERVAL = 600;
	const READ_ALOUD_EXPECTATION_MS = 10000;
	const PROVISIONAL_AUDIO_TIMEOUT_MS = 3000;

	/**************************************************************************
	 * State
	 **************************************************************************/

	let speed = 1;
	let volumeBoost = DEFAULT_VOLUME_BOOST;
	let currentAudio = null;
	let hasSeenPlayableAudio = false;
	let isAudioLoading = false;
	const directlyObservedAudioElements = new WeakSet();
	let provisionalAudioTimer = null;
	let volumeBoostContext = null;
	const boostedAudioElements = new WeakMap();


	let isAutoReadEnabled = false;
	let lastReadMsgId = null;
	let waitTimer = null;
	let lastUrl = location.href;
	let readAloudExpectedUntil = 0;

	let container = null;
	let playerGroup = null;
	let playPauseButton = null;
	let speedDisplay = null;
	let voiceBars = null;
	let autoReadButton = null;

	/**************************************************************************
	 * Utils
	 **************************************************************************/

	function log(...args) {
		console.debug("[ReadAloudControls]", ...args);
	}

	function clamp(value, min, max) {
		return Math.max(min, Math.min(max, value));
	}

	function roundTo(value, decimals = 2) {
		const p = 10 ** decimals;
		return Math.round((value + Number.EPSILON) * p) / p;
	}

	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function isVisible(el) {
		if (!el) return false;

		const rect = el.getBoundingClientRect();
		const style = getComputedStyle(el);

		return (
			rect.width > 0 &&
			rect.height > 0 &&
			style.visibility !== "hidden" &&
			style.display !== "none"
		);
	}

	function setVisibleKeepSpace(el, visible) {
		if (!el) return;

		el.style.visibility = visible ? "visible" : "hidden";
		el.style.pointerEvents = visible ? "auto" : "none";
	}


	function getChatStorageKey() {
		return `${AUTO_READ_STORAGE_PREFIX}${location.pathname || "unknown"}`;
	}

	function loadAutoReadState() {
		isAutoReadEnabled = localStorage.getItem(getChatStorageKey()) === "true";
	}

	function saveAutoReadState() {
		localStorage.setItem(getChatStorageKey(), String(isAutoReadEnabled));
	}

	/**************************************************************************
	 * Audio detection
	 **************************************************************************/

	function isRealAudio(audio) {
		return audio instanceof HTMLAudioElement;
	}


	function expectReadAloudAudio() {
		readAloudExpectedUntil = Date.now() + READ_ALOUD_EXPECTATION_MS;
	}

	function isReadAloudAudioExpected() {
		return Date.now() <= readAloudExpectedUntil;
	}


	function clearProvisionalAudioTimer() {
		if (!provisionalAudioTimer) return;

		clearTimeout(provisionalAudioTimer);
		provisionalAudioTimer = null;
	}

	function clearAudioSession() {

		isAudioLoading = false;
		hasSeenPlayableAudio = false;
		currentAudio = null;
		readAloudExpectedUntil = 0;
		clearProvisionalAudioTimer();
	}

	function startProvisionalAudioTimer(audio) {
		clearProvisionalAudioTimer();

		provisionalAudioTimer = window.setTimeout(() => {
			provisionalAudioTimer = null;

			if (currentAudio !== audio || hasSeenPlayableAudio) return;

			clearAudioSession();
			updateUI();
		}, PROVISIONAL_AUDIO_TIMEOUT_MS);
	}

	function confirmAudioSession(audio) {
		if (!isRealAudio(audio)) return;


		currentAudio = audio;
		hasSeenPlayableAudio = true;
		isAudioLoading = false;
		readAloudExpectedUntil = 0;
		clearProvisionalAudioTimer();
		forceSpeed(currentAudio);

	}




	function shouldCaptureAudio(audio) {
		if (!isRealAudio(audio)) return false;

		return (
			isReadAloudAudioExpected() ||
			currentAudio === audio
		);
	}


	function observeAudioDirectly(audio) {
		if (
			!isRealAudio(audio) ||
			directlyObservedAudioElements.has(audio)
		) {
			return;
		}

		directlyObservedAudioElements.add(audio);

		audio.addEventListener(
			"playing",
			() => handleAudioPlaying(audio),
			true,
		);
		audio.addEventListener(
			"timeupdate",
			() => handleAudioTimeUpdate(audio),
			true,
		);
		audio.addEventListener(
			"waiting",
			() => handleAudioWaiting(audio),
			true,
		);
		audio.addEventListener("pause", () => handleAudioPause(audio), true);
		audio.addEventListener("ended", () => handleAudioEnded(audio), true);
		audio.addEventListener(
			"ratechange",
			() => handleAudioRateChange(audio),
			true,
		);
	}

	function installAudioPlayHook() {

		const mediaPrototype = window.HTMLMediaElement?.prototype;
		const originalPlay = mediaPrototype?.play;
		const descriptor = mediaPrototype
			? Object.getOwnPropertyDescriptor(mediaPrototype, "play")
			: null;

		if (
			!mediaPrototype ||
			typeof originalPlay !== "function" ||
			!descriptor ||
			!descriptor.writable
		) {
			log("audio play hook unavailable");
			return;
		}

		const wrappedPlay = function (...args) {
			try {
				if (isRealAudio(this) && shouldCaptureAudio(this)) {
					const wasConfirmed =
						currentAudio === this && hasSeenPlayableAudio;
					currentAudio = this;
					hasSeenPlayableAudio = wasConfirmed;
					isAudioLoading = wasConfirmed
						? this.currentTime <= 0
						: true;
					observeAudioDirectly(this);
					if (wasConfirmed) {
						clearProvisionalAudioTimer();
					} else {
						startProvisionalAudioTimer(this);
					}
					forceSpeed(this);
					updateUI();
					log("audio play detected", currentAudio);
				}
			} catch (error) {
				log("audio play observation failed", error);
			}

			return Reflect.apply(originalPlay, this, args);
		};

		try {
			Object.defineProperty(mediaPrototype, "play", {
				...descriptor,
				value: wrappedPlay,
			});
		} catch (error) {
			log("audio play hook installation failed", error);
		}
	}

	/**************************************************************************
	 * Speed storage
	 **************************************************************************/

	function loadSpeed() {
		const saved = Number(localStorage.getItem(SPEED_STORAGE_KEY));

		if (Number.isFinite(saved)) {
			speed = clamp(saved, MIN_SPEED, MAX_SPEED);
		} else {
			speed = 1;
		}
	}

	function saveSpeed() {
		localStorage.setItem(SPEED_STORAGE_KEY, String(speed));
	}

	function loadVolumeBoost() {
		const saved = Number(
			GM_getValue(VOLUME_BOOST_STORAGE_KEY, DEFAULT_VOLUME_BOOST),
		);

		volumeBoost = Number.isFinite(saved)
			? clamp(saved, MIN_VOLUME_BOOST, MAX_VOLUME_BOOST)
			: DEFAULT_VOLUME_BOOST;
	}

	function saveVolumeBoost() {
		GM_setValue(VOLUME_BOOST_STORAGE_KEY, volumeBoost);
	}

	function setVolumeBoost(nextBoost) {
		if (typeof nextBoost === "string" && nextBoost.trim() === "") return;

		const next = Number(nextBoost);

		if (!Number.isFinite(next)) return;

		volumeBoost = roundTo(clamp(next, MIN_VOLUME_BOOST, MAX_VOLUME_BOOST));
		saveVolumeBoost();
	}

	function setupMenuCommands() {
		GM_registerMenuCommand(`Set volume boost: ${volumeBoost}x`, () => {
			const input = prompt(
				`Set volume boost (${MIN_VOLUME_BOOST}-${MAX_VOLUME_BOOST})`,
				String(volumeBoost),
			);

			if (input === null) return;

			setVolumeBoost(Number(input));
		});
	}

	function updateDisplay() {
		if (speedDisplay) {
			speedDisplay.textContent = `${speed}x`;
			speedDisplay.title =
				speed === 1 ? "Speed is already 1x" : "Reset speed to 1x";
		}
	}

	function setSpeed(nextSpeed) {
		speed = roundTo(clamp(nextSpeed, MIN_SPEED, MAX_SPEED));

		saveSpeed();
		updateDisplay();

		forceSpeed(currentAudio);

		updateUI();
	}

	function changeSpeed(delta) {
		setSpeed(speed + delta);
	}

	/**************************************************************************
	 * Force playbackRate
	 **************************************************************************/

	function forceVolumeBoost(audio) {
		const existing = boostedAudioElements.get(audio);

		if (existing) {
			if (existing.gain.gain.value !== volumeBoost) {
				existing.gain.gain.value = volumeBoost;
			}

			if (existing.context.state === "suspended") {
				existing.context.resume().catch((error) => {
					log("volume boost resume failed", error);
				});
			}

			return;
		}

		const AudioContextConstructor =
			window.AudioContext || window.webkitAudioContext;

		if (!AudioContextConstructor) return;

		try {
			if (!volumeBoostContext || volumeBoostContext.state === "closed") {
				volumeBoostContext = new AudioContextConstructor();
			}

			const source = volumeBoostContext.createMediaElementSource(audio);
			const gain = volumeBoostContext.createGain();

			gain.gain.value = volumeBoost;
			source.connect(gain);
			gain.connect(volumeBoostContext.destination);
			boostedAudioElements.set(audio, {
				context: volumeBoostContext,
				source,
				gain,
			});

			if (volumeBoostContext.state === "suspended") {
				volumeBoostContext.resume().catch((error) => {
					log("volume boost resume failed", error);
				});
			}
		} catch (error) {
			log("forceVolumeBoost failed", error);
		}
	}

	function forceSpeed(audio) {
		if (!isRealAudio(audio)) return;

		try {
			if (Math.abs(audio.playbackRate - speed) > 0.001) {
				audio.playbackRate = speed;
			}

			if (audio.volume !== 1) {
				audio.volume = 1;
			}

			forceVolumeBoost(audio);

			audio.preservesPitch = true;
			audio.mozPreservesPitch = true;
			audio.webkitPreservesPitch = true;
		} catch (error) {
			log("forceSpeed failed", error);
		}
	}



	function handleAudioPlaying(audio) {
		if (audio !== currentAudio) return;

		confirmAudioSession(audio);
		updateUI();
	}

	function handleAudioTimeUpdate(audio) {
		if (audio !== currentAudio) return;

		if (audio.currentTime > 0) {

			confirmAudioSession(audio);
		}

		forceSpeed(audio);
		updateUI();
	}

	function handleAudioWaiting(audio) {
		if (audio === currentAudio && audio.currentTime <= 0) {
			isAudioLoading = true;
			updateUI();
		}
	}

	function handleAudioPause(audio) {
		if (audio !== currentAudio) return;

		updateUI();
	}

	function handleAudioEnded(audio) {
		if (audio !== currentAudio) return;

		clearAudioSession();
		updateUI();
	}

	function handleAudioRateChange(audio) {
		if (!currentAudio && !isReadAloudAudioExpected()) {
			return;
		}


		forceSpeed(audio);

		updateUI();
	}


	/**************************************************************************
	 * Play / pause
	 **************************************************************************/


	function togglePlayPause() {
		const audio = currentAudio;

		if (!audio) {
			updateUI();
			return;
		}

		if (audio.ended) {
			updateUI();
			return;
		}

		if (audio.paused) {
			isAudioLoading = audio.currentTime <= 0;

			audio
				.play()
				.then(() => {
					forceSpeed(audio);
					updateUI();
				})
				.catch((error) => {
					log("play failed", error);
					updateUI();
				});
		} else {
			audio.pause();
			updateUI();
		}
	}

	/**************************************************************************
	 * Keyboard shortcuts
	 **************************************************************************/

	function isTypingTarget(target) {
		if (!(target instanceof Element)) return false;

		const tagName = target.tagName.toLowerCase();

		return (
			tagName === "input" ||
			tagName === "textarea" ||
			target.isContentEditable ||
			Boolean(target.closest("[contenteditable='true']")) ||
			Boolean(target.closest("[contenteditable='plaintext-only']"))
		);
	}

	function setupKeyboardShortcuts() {


		document.addEventListener(
			"keydown",
			(event) => {
				if (event.code !== "Space") return;
				if (event.ctrlKey || event.altKey || event.metaKey) return;
				if (isTypingTarget(event.target)) return;

				const audio = currentAudio;

				if (!audio || audio.ended) return;

				event.preventDefault();
				event.stopPropagation();

				togglePlayPause();
			},
			true,
		);
	}

	/**************************************************************************
	 * Auto Read Aloud
	 **************************************************************************/

	const READ_SELECTOR =
		'[role="menuitem"][data-testid="voice-play-turn-action-button"]';
	const MORE_ACTIONS_SELECTOR = 'button[aria-label="More actions"]';

	function getReadAloudControl(target) {
		if (!(target instanceof Element)) return null;

		const el = target.closest(READ_SELECTOR);
		return el && isVisible(el) ? el : null;
	}

	function setupReadAloudClickExpectation() {


		document.addEventListener(
			"click",
			(event) => {
				if (getReadAloudControl(event.target)) {
					expectReadAloudAudio();
				}
			},
			true,
		);
	}

	async function triggerReadAloud(msgEl) {
		if (!msgEl) return;

		const root = msgEl.closest('[data-testid^="conversation-turn"]');
		const moreButton = root?.querySelector(MORE_ACTIONS_SELECTOR);

		if (!moreButton || !isVisible(moreButton)) {
			isAudioLoading = false;
			updateUI();
			log('auto read: "More actions" button not found');
			return;
		}

		const rect = moreButton.getBoundingClientRect();
		moreButton.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				cancelable: true,
				clientX: Math.round((rect.left + rect.right) / 2),
				clientY: Math.round((rect.top + rect.bottom) / 2),
				pointerId: 1,
				pointerType: "mouse",
				isPrimary: true,
				button: 0,
				buttons: 1,
				pressure: 0.5,
			}),
		);

		for (let i = 0; i < 5; i++) {
			await sleep(300);

			const readAloud = document.querySelector(READ_SELECTOR);
			if (readAloud && isVisible(readAloud)) {
				expectReadAloudAudio();
				readAloud.click();
				return;
			}
		}

		isAudioLoading = false;
		updateUI();
		log('auto read: "Read aloud" menu item not found');
	}

	function isStreaming() {
		return Boolean(document.querySelector('[data-testid="stop-button"]'));
	}

	function getLastAssistantMsg() {
		const messages = document.querySelectorAll(
			'[data-message-author-role="assistant"]',
		);
		return messages.length ? messages[messages.length - 1] : null;
	}

	function getMsgId(el) {
		return el.getAttribute("data-message-id");
	}

	function onNewMessage(msgEl) {
		if (!isAutoReadEnabled) return;

		if (waitTimer) {
			clearTimeout(waitTimer);
			waitTimer = null;
		}

		const poll = () => {
			if (!isAutoReadEnabled) return;

			if (isStreaming()) {
				waitTimer = setTimeout(poll, POLL_INTERVAL);
				return;
			}

			waitTimer = null;
			const id = getMsgId(msgEl);

			if (id === lastReadMsgId) return;

			lastReadMsgId = id;
			triggerReadAloud(msgEl);
		};

		poll();
	}

	function setupAutoReadObserver() {
		if (!document.body) return;

		const lastMsg = getLastAssistantMsg();
		let lastMsgId = lastMsg ? getMsgId(lastMsg) : null;

		const autoReadObserver = new MutationObserver(() => {
			const currentMsg = getLastAssistantMsg();
			const currentMsgId = currentMsg ? getMsgId(currentMsg) : null;

			if (currentMsg && currentMsgId !== lastMsgId) {
				lastMsgId = currentMsgId;
				onNewMessage(currentMsg);
			} else if (!currentMsg) {
				lastMsgId = null;
			}
		});

		autoReadObserver.observe(document.body, {
			childList: true,
			subtree: true,
		});
	}

	function setupRouteObserver() {

		const routeObserver = new MutationObserver(() => {
			if (location.href === lastUrl) return;

			lastUrl = location.href;
			if (waitTimer) {
				clearTimeout(waitTimer);
				waitTimer = null;
			}
			lastReadMsgId = null;
			clearAudioSession();

			loadAutoReadState();
			updateAutoReadButton();
			updateUI();
		});

		routeObserver.observe(document, {
			subtree: true,
			childList: true,
		});
	}

	function toggleAutoRead() {
		isAutoReadEnabled = !isAutoReadEnabled;
		saveAutoReadState();
		updateAutoReadButton();

		if (isAutoReadEnabled) {
			const lastMsg = getLastAssistantMsg();

			if (lastMsg && !isStreaming()) {
				lastReadMsgId = getMsgId(lastMsg);
			}
		}
	}

	function updateAutoReadButton() {
		if (!autoReadButton) return;

		autoReadButton.textContent = isAutoReadEnabled ? "🔊" : "🔇";
		autoReadButton.title = isAutoReadEnabled
			? "Auto Read is ON for this chat"
			: "Auto Read is OFF for this chat";
		autoReadButton.style.opacity = isAutoReadEnabled ? "1" : "0.45";
	}

	/**************************************************************************
	 * UI state
	 **************************************************************************/

	function getPlayerState(audio) {
		if (!audio || audio.ended) return "idle";
		if (isAudioLoading) return "loading";
		if (audio.paused) return "paused";
		return "playing";
	}


	/**************************************************************************
	 * UI
	 **************************************************************************/

	function ensureVoiceBarsStyle() {
		if (document.getElementById("read-aloud-voice-bars-style")) return;

		const style = document.createElement("style");
		style.id = "read-aloud-voice-bars-style";
		style.textContent = `
		#isolated-speed-ui .read-aloud-voice-bars {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 3px;
			width: 42px;
			height: 30px;
			opacity: 0.75;
		}

		#isolated-speed-ui .read-aloud-voice-bar {
			width: 3px;
			height: 8px;
			border-radius: 999px;
			background: currentColor;
			transform-origin: center;
			animation: readAloudVoiceBars 0.8s ease-in-out infinite;
			animation-play-state: paused;
		}

		#isolated-speed-ui .read-aloud-voice-bar:nth-child(1) {
			animation-delay: -0.45s;
		}

		#isolated-speed-ui .read-aloud-voice-bar:nth-child(2) {
			animation-delay: -0.3s;
		}

		#isolated-speed-ui .read-aloud-voice-bar:nth-child(3) {
			animation-delay: -0.15s;
		}

		#isolated-speed-ui .read-aloud-voice-bar:nth-child(4) {
			animation-delay: 0s;
		}

		#isolated-speed-ui .read-aloud-voice-bar:nth-child(5) {
			animation-delay: -0.25s;
		}

		#isolated-speed-ui .read-aloud-voice-bars.is-playing .read-aloud-voice-bar {
			animation-play-state: running;
		}

		#isolated-speed-ui .read-aloud-voice-bars.is-muted {
			opacity: 0.35;
		}

		@keyframes readAloudVoiceBars {
			0%, 100% {
				transform: scaleY(0.55);
			}
			50% {
				transform: scaleY(1.8);
			}
		}
	`;

		document.head.appendChild(style);
	}

	function updateVoiceBarsState(state) {
		if (!voiceBars) return;

		voiceBars.classList.toggle("is-playing", state === "playing");
		voiceBars.classList.toggle("is-muted", state !== "playing");
	}

	function updateUI() {
		if (!playerGroup || !playPauseButton || !voiceBars) return;

		const audio = currentAudio;
		const state = getPlayerState(audio);
		const visible = state !== "idle";

		updateVoiceBarsState(state);
		setVisibleKeepSpace(playerGroup, visible);

		if (!visible) {

			playPauseButton.disabled = true;
			playPauseButton.textContent = "▶";
			playPauseButton.title = "No active Read Aloud audio";
			return;
		}

		if (state === "loading") {
			playPauseButton.disabled = true;
			playPauseButton.textContent = "...";
			playPauseButton.title = "Loading Read Aloud audio";
			return;
		}


		if (state === "paused") {
			playPauseButton.disabled = false;
			playPauseButton.textContent = "▶";
			playPauseButton.title = "Play";
			return;
		}

		if (state === "playing") {
			playPauseButton.disabled = false;
			playPauseButton.textContent = "⏸";
			playPauseButton.title = "Pause";
			return;
		}
	}

	function createUI() {
		if (document.getElementById(UI_ID)) return;

		ensureVoiceBarsStyle();

		const threadBottom =
			document.querySelector("#thread-bottom") ||
			document.querySelector("#thread-bottom-container");

		if (!threadBottom) return;

		container = document.createElement("div");
		container.id = UI_ID;
		container.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 12px;
            margin-left: auto;
            margin-right: 12px;
            width: fit-content;
            min-width: 190px;
            max-width: 460px;
            font-size: 14px;
            align-self: flex-start;
            position: relative;
            z-index: 100;
            pointer-events: auto;
        `;

		playerGroup = document.createElement("div");
		playerGroup.style.cssText = `
            display: flex;
            align-items: center;
            gap: 7px;
            flex: 0 1 auto;
            min-width: 0;
            visibility: hidden;
            pointer-events: none;
        `;

		playPauseButton = document.createElement("button");
		playPauseButton.type = "button";
		playPauseButton.textContent = "▶";
		playPauseButton.disabled = true;
		playPauseButton.title = "No active Read Aloud audio";
		playPauseButton.style.height = "30px";
		playPauseButton.style.width = "40px";
		playPauseButton.onclick = togglePlayPause;

		voiceBars = document.createElement("div");
		voiceBars.className = "read-aloud-voice-bars is-muted";
		voiceBars.title = "Read Aloud activity";

		for (let i = 0; i < 5; i++) {
			const bar = document.createElement("span");
			bar.className = "read-aloud-voice-bar";
			voiceBars.appendChild(bar);
		}

		const minus = document.createElement("button");
		minus.type = "button";
		minus.textContent = "-";
		minus.title = `Decrease speed by ${SPEED_STEP}x`;
		minus.style.height = "30px";
		minus.style.width = "30px";

		speedDisplay = document.createElement("button");
		speedDisplay.type = "button";
		speedDisplay.title = "Reset speed to 1x";
		speedDisplay.style.height = "30px";
		speedDisplay.style.width = "60px";
		speedDisplay.style.textAlign = "center";
		speedDisplay.style.cursor = "pointer";
		speedDisplay.onclick = () => setSpeed(1);

		const plus = document.createElement("button");
		plus.type = "button";
		plus.textContent = "+";
		plus.title = `Increase speed by ${SPEED_STEP}x`;
		plus.style.height = "30px";
		plus.style.width = "30px";

		autoReadButton = document.createElement("button");
		autoReadButton.type = "button";
		autoReadButton.style.height = "30px";
		autoReadButton.style.width = "38px";
		autoReadButton.style.textAlign = "center";
		autoReadButton.style.flex = "0 0 auto";
		autoReadButton.onclick = toggleAutoRead;

		minus.onclick = () => changeSpeed(-SPEED_STEP);
		plus.onclick = () => changeSpeed(SPEED_STEP);

		playerGroup.appendChild(playPauseButton);
		playerGroup.appendChild(voiceBars);
		playerGroup.appendChild(minus);
		playerGroup.appendChild(speedDisplay);
		playerGroup.appendChild(plus);

		container.appendChild(playerGroup);
		container.appendChild(autoReadButton);

		threadBottom.prepend(container);

		updateDisplay();
		updateAutoReadButton();
		updateUI();
	}
	/**************************************************************************
	 * DOM
	 **************************************************************************/

	function watchDOM() {
		if (!document.body) return;

		const observer = new MutationObserver(() => {
			if (!document.getElementById(UI_ID)) {
				createUI();
			}
		});

		observer.observe(document.body, {
			childList: true,
			subtree: true,
		});
	}


	/**************************************************************************
	 * Init
	 **************************************************************************/

	function initDOM() {
		createUI();
		watchDOM();

		setupAutoReadObserver();
		setupRouteObserver();
		setupReadAloudClickExpectation();
		setupKeyboardShortcuts();


		updateDisplay();
		updateAutoReadButton();
		updateUI();
	}

	function init() {
		installAudioPlayHook();
		loadSpeed();
		loadVolumeBoost();
		loadAutoReadState();

		if (typeof GM_registerMenuCommand === "function") {
			setupMenuCommands();
		}

		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", initDOM, { once: true });
		} else {
			initDOM();
		}

		log("initialized");
	}

	init();
})();
