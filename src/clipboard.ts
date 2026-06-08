/**
 * Copy text to the clipboard, returning whether it worked. Tries the synchronous `execCommand("copy")`
 * first because `navigator.clipboard` is unavailable on a Duet served over plain HTTP (a non-secure
 * context), then falls back to the async Clipboard API for secure contexts.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		const el = document.createElement("textarea");
		el.value = text;
		el.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
		document.body.appendChild(el);
		el.focus();
		el.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(el);
		if (ok) return true;
	} catch { /* fall through to the async clipboard API */ }
	try { if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; } } catch { /* ignore */ }
	return false;
}
