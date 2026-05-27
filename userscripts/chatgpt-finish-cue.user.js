// ==UserScript==
// @name         ChatGPT Finish Cue
// @version      1.4.0
// @description  Plays a short sound and/or flashes the page when ChatGPT finishes responding.
// @icon         https://chatgpt.com/favicon.ico
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/opendaniil/browser-tweaks/blob/main/userscripts/README.md#chatgpt-finish-cue
// @supportURL   https://github.com/opendaniil/browser-tweaks/issues
// @downloadURL  https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-finish-cue.user.js
// @updateURL    https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-finish-cue.user.js
// ==/UserScript==

(() => {
	const SELECTORS = {
		stop: [
			'[data-testid="stop-button"]',
			'button[aria-label*="Stop"]',
			'button[aria-label*="停止生成"]',
			'button[aria-label*="Остановить"]',
		].join(","),
	};

	const TIMING = {
		debounceMs: 180,
		minStreamingMs: 800,
		routeGraceMs: 700,
	};

	const FLASH = {
		durationMs: 220,
		defaultBrightness: 1.08,
	};

	const SOUND = {
		defaultVolume: 4,
	};

	let wasStreaming = false;
	let streamingStartedAt = 0;
	let lastUrl = location.href;
	let lastRouteChangeAt = 0;
	let debounceTimer = null;

	function getNumber(key, defaultValue) {
		const value = Number(GM_getValue(key, defaultValue));
		return Number.isFinite(value) ? value : defaultValue;
	}

	function getBrightness() {
		return Math.min(
			3,
			Math.max(0, getNumber("brightness", FLASH.defaultBrightness)),
		);
	}

	function getVolume() {
		return Math.min(10, Math.max(0, getNumber("volume", SOUND.defaultVolume)));
	}

	function setBrightness() {
		const current = getBrightness();
		const input = prompt(
			"Flash brightness: 0–3. Use 0 to disable flash.",
			String(current),
		);

		if (input === null) return;

		const value = Number(input);

		if (!Number.isFinite(value) || value < 0 || value > 3) {
			alert("Use a number from 0 to 3");
			return;
		}

		GM_setValue("brightness", value);
	}

	function setVolume() {
		const current = getVolume();
		const input = prompt(
			"Sound volume: 0–10. Use 0 to disable sound.",
			String(current),
		);

		if (input === null) return;

		const value = Number(input);

		if (!Number.isFinite(value) || value < 0 || value > 10) {
			alert("Use a number from 0 to 10");
			return;
		}

		GM_setValue("volume", value);
	}

	GM_registerMenuCommand("Set flash brightness", setBrightness);
	GM_registerMenuCommand("Set sound volume", setVolume);

	function isStreaming() {
		return Boolean(document.querySelector(SELECTORS.stop));
	}

	function flashDone() {
		const brightness = getBrightness();
		if (brightness <= 0) return;

		document.documentElement.animate(
			[
				{ filter: "brightness(1)" },
				{ filter: `brightness(${brightness})` },
				{ filter: "brightness(1)" },
			],
			{
				duration: FLASH.durationMs,
				easing: "ease-out",
			},
		);
	}

	function playDoneSound() {
		const volume = getVolume();
		if (volume <= 0) return;

		const AudioContext = window.AudioContext || window.webkitAudioContext;
		if (!AudioContext) return;

		const ctx = new AudioContext();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();

		osc.type = "triangle";
		osc.frequency.value = 420;

		const normalizedVolume = volume / 10;

		gain.gain.setValueAtTime(0.001, ctx.currentTime);
		gain.gain.exponentialRampToValueAtTime(
			0.18 * normalizedVolume,
			ctx.currentTime + 0.005,
		);
		gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

		osc.connect(gain);
		gain.connect(ctx.destination);

		osc.start();
		osc.stop(ctx.currentTime + 0.09);

		setTimeout(() => {
			ctx.close().catch(() => {});
		}, 150);
	}

	function signalDone() {
		flashDone();
		playDoneSound();
	}

	function resetStreamingState() {
		wasStreaming = false;
		streamingStartedAt = 0;
	}

	function checkRouteChange() {
		if (location.href === lastUrl) return false;

		lastUrl = location.href;
		lastRouteChangeAt = Date.now();
		resetStreamingState();

		return true;
	}

	function checkState() {
		if (checkRouteChange()) return;

		const currentlyStreaming = isStreaming();

		if (currentlyStreaming && !wasStreaming) {
			streamingStartedAt = Date.now();
		}

		if (wasStreaming && !currentlyStreaming) {
			const streamedForMs = Date.now() - streamingStartedAt;
			const routeQuietForMs = Date.now() - lastRouteChangeAt;

			if (
				streamedForMs >= TIMING.minStreamingMs &&
				routeQuietForMs >= TIMING.routeGraceMs
			) {
				signalDone();
			}
		}

		wasStreaming = currentlyStreaming;
	}

	const observer = new MutationObserver(() => {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(checkState, TIMING.debounceMs);
	});

	function init() {
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
		});

		checkState();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init, { once: true });
	} else {
		init();
	}
})();
