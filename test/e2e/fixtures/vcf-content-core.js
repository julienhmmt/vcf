(function() {
	//#region src/content/detect.ts
	var SKIP_TYPES = /* @__PURE__ */ new Set([
		"hidden",
		"submit",
		"button",
		"checkbox",
		"radio",
		"file",
		"image",
		"reset"
	]);
	/**
	* All `<input type="password">` in `root`, including ones nested in
	* open shadow roots. `querySelectorAll` does not pierce shadow
	* boundaries, so each element with a `shadowRoot` is walked
	* separately; closed shadow roots are unreachable by design.
	*/
	function findPasswordInputs(root = document) {
		const found = [];
		const visit = (scope) => {
			for (const el of scope.querySelectorAll("*")) {
				if (el instanceof HTMLInputElement && el.type === "password") found.push(el);
				if (el.shadowRoot) visit(el.shadowRoot);
			}
		};
		visit(root);
		return found;
	}
	/**
	* Climbs from `el` looking for a `<form>` ancestor, bounded so a page
	* with no `<form>` at all (common on SPA login screens) doesn't walk
	* all the way to `<html>`. `parentElement` does not cross shadow
	* boundaries, so this naturally stops at the local shadow root too.
	*/
	function findScope(el, maxDepth = 6) {
		let node = el;
		for (let i = 0; i < maxDepth; i++) {
			if (node.tagName === "FORM") return node;
			const parent = node.parentElement;
			if (parent === null) break;
			node = parent;
		}
		return node;
	}
	function isPlausibleUsername(input) {
		if (SKIP_TYPES.has(input.type)) return false;
		if (input.type === "password") return false;
		const autocomplete = input.autocomplete.toLowerCase();
		return autocomplete !== "new-password" && autocomplete !== "current-password";
	}
	function precedes(a, b) {
		return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
	}
	/**
	* The field paired with `passwordEl` within `scope`. Prefers the
	* standard autofill hints (`autocomplete="username"` / `"email"`,
	* `type="email"`), then the nearest plausible text field immediately
	* before the password field, then the nearest one after (some forms
	* ask for the password first).
	*/
	function findUsernameField(passwordEl, scope) {
		const candidates = Array.from(scope.querySelectorAll("input")).filter(isPlausibleUsername);
		if (candidates.length === 0) return null;
		const byAutocomplete = candidates.find((el) => {
			const ac = el.autocomplete.toLowerCase();
			return ac === "username" || ac === "email";
		});
		if (byAutocomplete) return byAutocomplete;
		const byType = candidates.find((el) => el.type === "email");
		if (byType) return byType;
		const closestBefore = candidates.filter((el) => precedes(el, passwordEl)).at(-1);
		if (closestBefore) return closestBefore;
		return candidates[0] ?? null;
	}
	var OTP_NAME_PATTERN = /(?:^|[-_ ])(?:otp|totp|mfa|2fa)(?:[-_ ]|$)|one[-_ ]?time[-_ ]?code|verification[-_ ]?code/i;
	function looksLikeOtpField(input) {
		if (SKIP_TYPES.has(input.type) || input.type === "password") return false;
		const haystack = `${input.name} ${input.id} ${input.placeholder}`;
		if (!OTP_NAME_PATTERN.test(haystack)) return false;
		const maxLength = input.maxLength;
		return input.inputMode === "numeric" || /^[0-9]*$/.test(input.pattern) || maxLength > 0 && maxLength <= 10;
	}
	/**
	* A field for a one-time code. The standard autofill hint
	* (`autocomplete="one-time-code"`) is authoritative when present;
	* otherwise a conservative name/placeholder + numeric-shape heuristic
	* is used as a fallback, since most sites don't set the hint.
	*/
	function findOtpField(scope) {
		const inputs = Array.from(scope.querySelectorAll("input"));
		const byHint = inputs.find((el) => el.autocomplete.toLowerCase() === "one-time-code");
		if (byHint) return byHint;
		return inputs.find(looksLikeOtpField) ?? null;
	}
	/**
	* Every login form in `root`. A scope with more than one password
	* field (change-password, sign-up with confirmation, reset) is
	* skipped rather than guessed at — this only detects single-password
	* sign-in forms.
	*/
	function detectLoginForms(root = document) {
		const byScope = /* @__PURE__ */ new Map();
		for (const passwordEl of findPasswordInputs(root)) {
			const scope = findScope(passwordEl);
			const list = byScope.get(scope) ?? [];
			list.push(passwordEl);
			byScope.set(scope, list);
		}
		const forms = [];
		for (const [scope, passwords] of byScope) {
			if (passwords.length !== 1) continue;
			const passwordEl = passwords[0];
			if (passwordEl === void 0) continue;
			forms.push({
				root: scope,
				passwordEl,
				usernameEl: findUsernameField(passwordEl, scope),
				otpEl: findOtpField(scope)
			});
		}
		return forms;
	}
	//#endregion
	//#region src/content/inject.ts
	var NATIVE_VALUE_SETTER = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	function setNativeValue(el, value) {
		if (NATIVE_VALUE_SETTER) NATIVE_VALUE_SETTER.call(el, value);
		else el.value = value;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	}
	/**
	* Writes whichever values are present into the matching fields, then
	* lets `values` (and the values it came from, in the caller) go out
	* of scope — nothing here caches a secret for a second fill.
	*/
	function fillLoginForm(fields, values) {
		if (values.username !== null && fields.usernameEl !== null) setNativeValue(fields.usernameEl, values.username);
		if (values.password !== null) setNativeValue(fields.passwordEl, values.password);
		if (values.totp !== null && fields.otpEl !== null) setNativeValue(fields.otpEl, values.totp);
	}
	//#endregion
	//#region test/e2e/entry.ts
	window.VCF = {
		detectLoginForms,
		fillLoginForm
	};
	//#endregion
})();
