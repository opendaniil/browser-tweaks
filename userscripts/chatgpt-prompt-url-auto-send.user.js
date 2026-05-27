// ==UserScript==
// @name         ChatGPT Prompt URL Auto-Send
// @version      1.1.4
// @description  Auto-clicks Send when ChatGPT URL has ?q= or ?prompt=.
// @icon         https://chatgpt.com/favicon.ico
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-start
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/opendaniil/browser-tweaks/blob/main/userscripts/README.md#chatgpt-prompt-url-auto-send
// @supportURL   https://github.com/opendaniil/browser-tweaks/issues
// @downloadURL  https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-prompt-url-auto-send.user.js
// @updateURL    https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-prompt-url-auto-send.user.js
// ==/UserScript==

(() => {
	const initialHref = location.href;
	const initialUrl = new URL(initialHref);

	const hasInitialPromptParam =
		initialUrl.searchParams.has("q") || initialUrl.searchParams.has("prompt");

	if (!hasInitialPromptParam) return;

	const SEND_READY_SELECTOR =
		'#composer-submit-button[aria-label="Send prompt"]';

	const CHECK_EVERY_MS = 250;
	const CLICK_DELAY_MS = 500;
	const VERIFY_DELAY_MS = 1000;
	const TIMEOUT_MS = 15000;

	let observer = null;
	let interval = null;
	let timeout = null;
	let clickDelayTimer = null;
	let verifyTimer = null;
	let done = false;
	let clicking = false;

	function currentUrlHasPromptParam() {
		const url = new URL(location.href);

		return url.searchParams.has("q") || url.searchParams.has("prompt");
	}

	function urlChangedAwayFromPrompt() {
		return location.href !== initialHref && !currentUrlHasPromptParam();
	}

	function cleanup() {
		if (done) return;
		done = true;

		observer?.disconnect();

		clearInterval(interval);
		clearTimeout(timeout);
		clearTimeout(clickDelayTimer);
		clearTimeout(verifyTimer);

		window.removeEventListener("popstate", onUrlMaybeChanged, true);
	}

	function onUrlMaybeChanged() {
		if (urlChangedAwayFromPrompt()) {
			cleanup();
		}
	}

	function patchHistoryMethod(name) {
		const original = history[name];

		history[name] = function (...args) {
			const result = original.apply(this, args);

			queueMicrotask(onUrlMaybeChanged);

			return result;
		};
	}

	patchHistoryMethod("pushState");
	patchHistoryMethod("replaceState");
	window.addEventListener("popstate", onUrlMaybeChanged, true);

	function tryClick() {
		if (done || clicking) return;

		if (urlChangedAwayFromPrompt()) {
			cleanup();
			return;
		}

		const button = document.querySelector(SEND_READY_SELECTOR);
		if (!button) return;

		clicking = true;

		clickDelayTimer = setTimeout(() => {
			if (done) return;

			if (urlChangedAwayFromPrompt()) {
				cleanup();
				return;
			}

			if (
				!button.isConnected ||
				button.disabled ||
				button.getAttribute("aria-disabled") === "true" ||
				button.getAttribute("aria-label") !== "Send prompt"
			) {
				clicking = false;
				return;
			}

			button.click();

			verifyTimer = setTimeout(() => {
				if (done) return;

				if (urlChangedAwayFromPrompt()) {
					cleanup();
					return;
				}

				const stillReady = document.querySelector(SEND_READY_SELECTOR);

				if (!stillReady) {
					cleanup();
					return;
				}

				clicking = false;
			}, VERIFY_DELAY_MS);
		}, CLICK_DELAY_MS);
	}

	function start() {
		observer = new MutationObserver(tryClick);

		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
		});

		interval = setInterval(tryClick, CHECK_EVERY_MS);
		timeout = setTimeout(cleanup, TIMEOUT_MS);

		tryClick();
	}

	if (document.body) {
		start();
	} else {
		const bodyWait = setInterval(() => {
			if (!document.body) return;

			clearInterval(bodyWait);
			start();
		}, 20);
	}
})();
