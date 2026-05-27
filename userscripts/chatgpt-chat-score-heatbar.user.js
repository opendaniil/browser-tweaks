// ==UserScript==
// @name         ChatGPT Chat Score Heatbar
// @version      1.2.2
// @description  Adds a growing heatbar to ChatGPT chat links based on the local activity score.
// @icon         https://chatgpt.com/favicon.ico
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-idle
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/opendaniil/browser-tweaks/blob/main/userscripts/README.md#chatgpt-chat-score-heatbar
// @supportURL   https://github.com/opendaniil/browser-tweaks/issues
// @downloadURL  https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-chat-score-heatbar.user.js
// @updateURL    https://raw.githubusercontent.com/opendaniil/browser-tweaks/main/userscripts/chatgpt-chat-score-heatbar.user.js
// ==/UserScript==

(() => {
	const METRICS_KEY = "chatgpt-chat-score-heatbar-metrics";
	const DEBUG_SCORE = false;

	const OPEN_COOLDOWN_MS = 30 * 60 * 1000;
	const ACTIVE_MS_PER_SCORE = 3 * 60 * 1000;
	const MAX_ACTIVE_GAP_MS = 90 * 1000;

	const MAX_SCORE_FOR_FULL_BAR = 40;

	const MIN_BAR_WIDTH = 2;
	const MAX_BAR_WIDTH = 5;

	const SCORE_WEIGHTS = {
		open: 1,
	};

	const CHAT_LINK_SELECTOR = 'a[href*="/c/"]';
	const SIDEBAR_CHAT_LINK_SELECTOR = 'a[data-sidebar-item="true"][href*="/c/"]';

	let currentChatKey = null;
	let paintQueued = false;
	let pageObserver = null;
	let lastActivityAt = 0;
	let lastActivityChatKey = null;

	function logScore(...args) {
		if (!DEBUG_SCORE) return;

		console.debug("[cgpt-score]", ...args);
	}

	// Lifecycle / main flow
	function init() {
		injectStyles();
		cleanupLegacyBars();

		hookNavigation();

		recordOpen();
		setupActivityTracking();

		observePage();
		queuePaint();
	}

	function hookNavigation() {
		const originalPushState = history.pushState;
		const originalReplaceState = history.replaceState;

		history.pushState = function (...args) {
			const result = originalPushState.apply(this, args);
			window.dispatchEvent(new Event("cgpt-locationchange"));
			return result;
		};

		history.replaceState = function (...args) {
			const result = originalReplaceState.apply(this, args);
			window.dispatchEvent(new Event("cgpt-locationchange"));
			return result;
		};

		window.addEventListener("popstate", () => {
			window.dispatchEvent(new Event("cgpt-locationchange"));
		});

		window.addEventListener("cgpt-locationchange", () => {
			recordOpen();
			queuePaint();
		});
	}

	function queuePaint() {
		if (paintQueued) return;

		paintQueued = true;

		requestAnimationFrame(() => {
			paintQueued = false;
			applyHeatbars();
		});
	}

	function observePage() {
		if (pageObserver) return;

		pageObserver = new MutationObserver(queuePaint);

		pageObserver.observe(document.body, {
			childList: true,
			subtree: true,
		});

		queuePaint();
	}

	// Navigation / open tracking
	function recordOpen() {
		const chatKey = getChatKeyFromPath();
		if (!chatKey) return;

		if (chatKey === currentChatKey) return;

		currentChatKey = chatKey;
		lastActivityChatKey = chatKey;
		lastActivityAt = 0;

		const allMetrics = getAllMetrics();
		const metrics = getMetricsForChat(allMetrics, chatKey);
		const t = now();

		if (metrics.lastOpenAt && t - metrics.lastOpenAt < OPEN_COOLDOWN_MS) {
			return;
		}

		incrementOpen(allMetrics, metrics, chatKey);
	}

	function incrementOpen(allMetrics, metrics, chatKey) {
		const t = now();

		metrics.opens += SCORE_WEIGHTS.open;
		metrics.lastOpenAt = t;
		metrics.updatedAt = t;
		refreshMetricsScore(metrics);

		saveAllMetrics(allMetrics);
		queuePaint();

		logScore({
			chatKey,
			reason: "open",
			score: metrics.score,
			opens: metrics.opens,
			activeMs: metrics.activeMs || 0,
		});
	}

	// Activity time tracking
	function setupActivityTracking() {
		["keydown", "pointerdown", "scroll", "wheel", "touchstart"].forEach(
			(eventName) => {
				window.addEventListener(eventName, markActivity, {
					passive: true,
					capture: true,
				});
			},
		);

		document.addEventListener("selectionchange", markActivity);
		window.addEventListener("focus", markActivity);
	}

	function markActivity() {
		const chatKey = getChatKeyFromPath();
		if (!chatKey) return;

		const t = now();
		const isVisible = document.visibilityState === "visible";
		const hasFocus = document.hasFocus();
		const sameChat = lastActivityChatKey === chatKey;

		if (!sameChat || !isVisible || !hasFocus) {
			lastActivityChatKey = chatKey;
			lastActivityAt = t;
			return;
		}

		const gap = lastActivityAt ? t - lastActivityAt : 0;
		lastActivityChatKey = chatKey;
		lastActivityAt = t;

		if (gap <= 0 || gap > MAX_ACTIVE_GAP_MS) return;

		addActiveGap(chatKey, gap, t);
	}

	function addActiveGap(chatKey, gap, t) {
		const allMetrics = getAllMetrics();
		const metrics = getMetricsForChat(allMetrics, chatKey);

		metrics.activeMs = (metrics.activeMs || 0) + gap;
		metrics.lastActivityAt = t;
		metrics.updatedAt = t;
		refreshMetricsScore(metrics);

		saveAllMetrics(allMetrics);
		queuePaint();

		logScore({
			chatKey,
			reason: "active",
			gap,
			score: metrics.score,
			opens: metrics.opens,
			activeMs: metrics.activeMs || 0,
		});
	}

	// Heatbar rendering
	function injectStyles() {
		if (document.querySelector("#cgpt-heatbar-style")) return;

		const style = document.createElement("style");
		style.id = "cgpt-heatbar-style";
		style.textContent = `
      .cgpt-heatbar-target {
        position: relative !important;
      }

      .cgpt-heatbar-target::before {
        content: "";
        position: absolute;
        width: var(--cgpt-heatbar-width, 0px);
        opacity: var(--cgpt-heatbar-opacity, 0);
        background: var(--cgpt-heatbar-color, hsl(120 90% 55% / 0.85));
        border-radius: 999px;
        pointer-events: none;
        z-index: 5;
        transition:
          width 160ms ease,
          opacity 160ms ease,
          top 160ms ease,
          bottom 160ms ease;
      }

      .cgpt-heatbar-sidebar::before {
        left: 4px;
        top: 22%;
        bottom: 22%;
      }

      .cgpt-heatbar-sidebar:hover::before {
        top: 16%;
        bottom: 16%;
      }

      .cgpt-heatbar-page {
        padding-left: 16px !important;
      }

      .cgpt-heatbar-page::before {
        left: 0;
        top: 12px;
        bottom: 12px;
      }

      .cgpt-heatbar-page:hover::before {
        top: 8px;
        bottom: 8px;
      }
    `;

		document.head.appendChild(style);
	}

	function cleanupLegacyBars() {
		// biome-ignore lint/suspicious/useIterableCallbackReturn: Remove older heatbar markers before re-applying current classes.
		document.querySelectorAll(".cgpt-heatbar").forEach((el) => el.remove());
	}

	function applyHeatbars() {
		cleanupLegacyBars();

		const allMetrics = getAllMetrics();

		document.querySelectorAll(CHAT_LINK_SELECTOR).forEach((link) => {
			if (!isRealChatLink(link)) return;

			const chatKey = getChatKeyFromHref(link.getAttribute("href"));
			if (!chatKey) return;

			const metrics = allMetrics[chatKey] || createEmptyMetrics();
			const score = computeScore(metrics);

			link.classList.remove("cgpt-heatbar-sidebar", "cgpt-heatbar-page");
			link.classList.add("cgpt-heatbar-target");

			if (isSidebarChatLink(link)) {
				link.classList.add("cgpt-heatbar-sidebar");
			} else {
				link.classList.add("cgpt-heatbar-page");
			}

			if (!score) {
				link.style.setProperty("--cgpt-heatbar-width", "0px");
				link.style.setProperty("--cgpt-heatbar-opacity", "0");
				link.style.setProperty("--cgpt-heatbar-color", "transparent");
				link.removeAttribute("title");
				return;
			}

			const t = getHeatValue(score);
			const width = getWidthForHeat(t);

			link.style.setProperty("--cgpt-heatbar-width", `${width}px`);
			link.style.setProperty("--cgpt-heatbar-opacity", String(0.3 + t * 0.7));
			link.style.setProperty("--cgpt-heatbar-color", getColorForHeat(t));

			link.title = makeTooltip(metrics);
		});
	}

	function getHeatValue(score) {
		if (!score) return 0;

		return Math.min(Math.log1p(score) / Math.log1p(MAX_SCORE_FOR_FULL_BAR), 1);
	}

	function getWidthForHeat(t) {
		return MIN_BAR_WIDTH + Math.round(t * (MAX_BAR_WIDTH - MIN_BAR_WIDTH));
	}

	function getColorForHeat(t) {
		const hue = Math.round(120 * (1 - t));
		return `hsl(${hue} 90% 55% / 0.85)`;
	}

	function makeTooltip(metrics) {
		const score = computeScore(metrics);

		return [
			`Score: ${score}`,
			`Opens: ${metrics.opens || 0}`,
			`Active: ${formatMinutes(metrics.activeMs || 0)}`,
		].join(" · ");
	}

	// Metrics persistence / migration
	function readJson(key) {
		try {
			return JSON.parse(localStorage.getItem(key) || "{}");
		} catch {
			return {};
		}
	}

	function writeJson(key, value) {
		localStorage.setItem(key, JSON.stringify(value));
	}

	function createEmptyMetrics() {
		return {
			score: 0,
			opens: 0,
			activeMs: 0,
			lastOpenAt: 0,
			lastActivityAt: 0,
			lastActivityChatKey: "",
			updatedAt: 0,
		};
	}

	function getAllMetrics() {
		return readJson(METRICS_KEY);
	}

	function saveAllMetrics(metrics) {
		writeJson(METRICS_KEY, metrics);
	}

	function getMetricsForChat(metrics, chatKey) {
		if (!metrics[chatKey]) {
			metrics[chatKey] = createEmptyMetrics();
		}

		return metrics[chatKey];
	}

	function computeScore(metrics) {
		return (
			(metrics.opens || 0) +
			Math.floor((metrics.activeMs || 0) / ACTIVE_MS_PER_SCORE)
		);
	}

	function refreshMetricsScore(metrics) {
		metrics.score = computeScore(metrics);
		return metrics.score;
	}

	// URL / DOM helpers
	function now() {
		return Date.now();
	}

	function normalizeChatPath(pathname = location.pathname) {
		const match = pathname.match(/\/c\/[^/?#]+/);
		return match?.[0] ?? null;
	}

	function getChatKeyFromPath(pathname = location.pathname) {
		return normalizeChatPath(pathname);
	}

	function getChatKeyFromHref(href) {
		if (!href) return null;

		try {
			const url = new URL(href, location.origin);
			return normalizeChatPath(url.pathname);
		} catch {
			return normalizeChatPath(href);
		}
	}

	function formatMinutes(ms) {
		if (!ms) return "0m";

		return `${Math.round(ms / 60000)}m`;
	}

	function isRealChatLink(link) {
		if (!(link instanceof HTMLAnchorElement)) return false;

		const chatKey = getChatKeyFromHref(link.getAttribute("href"));
		if (!chatKey) return false;

		if (!link.textContent.trim() && !link.querySelector("svg,img"))
			return false;

		return true;
	}

	function isSidebarChatLink(link) {
		return link.matches(SIDEBAR_CHAT_LINK_SELECTOR);
	}

	init();
})();
