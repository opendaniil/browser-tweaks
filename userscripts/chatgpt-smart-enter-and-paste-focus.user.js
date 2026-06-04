// ==UserScript==
// @name         PREVIEW ChatGPT Smart Enter and Paste Focus
// @namespace    local
// @version      1.3
// @description  Focuses the ChatGPT prompt on paste outside editable fields and sends with Enter when the composer is ready.
// @icon         https://chatgpt.com/favicon.ico
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-start
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/opendaniil/browser-tweaks/blob/main/userscripts/README.md#chatgpt-smart-enter-and-paste-focus
// @supportURL   https://github.com/opendaniil/browser-tweaks/issues
// @downloadURL  https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-smart-enter-and-paste-focus.user.js
// @updateURL    https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-smart-enter-and-paste-focus.user.js
// ==/UserScript==

(() => {
	let promptInput = null;
	let sendButton = null;

	function getPromptInput() {
		if (!promptInput || !document.contains(promptInput)) {
			promptInput = document.querySelector("#prompt-textarea");
		}

		return promptInput;
	}

	function getSendButton() {
		if (!sendButton || !document.contains(sendButton)) {
			sendButton = document.querySelector("#composer-submit-button");
		}

		return sendButton;
	}

	function isInsideEditableElement(element) {
		if (!element) return false;

		return Boolean(
			element.closest(
				'input, textarea, select, [contenteditable="true"], [role="textbox"]',
			),
		);
	}

	function isPromptFocused() {
		const input = getPromptInput();
		if (!input) return false;

		const active = document.activeElement;
		if (!active) return false;

		return active === input || input.contains(active);
	}

	function isVisible(element) {
		if (!element) return false;

		return Boolean(
			element.offsetWidth ||
				element.offsetHeight ||
				element.getClientRects().length,
		);
	}

	function canSend() {
		const button = getSendButton();

		if (!button) return false;
		if (!document.contains(button)) return false;
		if (!isVisible(button)) return false;
		if (button.disabled) return false;
		if (button.getAttribute("aria-disabled") === "true") return false;

		return true;
	}

	function sendPrompt() {
		const button = getSendButton();

		if (!canSend()) return false;

		button.click();
		return true;
	}

	document.addEventListener(
		"paste",
		(event) => {
			const input = getPromptInput();
			if (!input) return;

			if (isInsideEditableElement(event.target)) {
				return;
			}

			input.focus();
		},
		true,
	);

	document.addEventListener(
		"keydown",
		(event) => {
			if (event.key !== "Enter") return;
			if (event.repeat) return;

			if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
				return;
			}

			const input = getPromptInput();
			if (!input) return;

			const focused = isPromptFocused();

			if (!focused && isInsideEditableElement(event.target)) {
				return;
			}

			if (!focused && canSend()) {
				event.preventDefault();
				event.stopPropagation();

				sendPrompt();
			}
		},
		true,
	);
})();
