/** Trigger a browser download of `content` as a file named `filename`. */
export function downloadBlob(filename: string, content: BlobPart, mimeType = "application/octet-stream"): void {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download a value as pretty-printed JSON. Pass `replacer` to e.g. serialise Maps. */
export function downloadJson(filename: string, value: unknown, replacer?: (key: string, value: unknown) => unknown): void {
	downloadBlob(filename, JSON.stringify(value, replacer, 2), "application/json");
}
