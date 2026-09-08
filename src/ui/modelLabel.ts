import { truncateToWidth, visibleWidth, type SelectListLayoutOptions } from "@earendil-works/pi-tui";

/**
 * Truncates a slash-namespaced model ref (`provider/accounts/.../model-name`)
 * so the parts that matter to identify the model survive first. Priority:
 * the model name (last segment) is mandatory, then the first segment (the
 * namespace root), then the segment right before the model name, then
 * whatever else still fits. Skipped runs collapse to a single ellipsis.
 */
export function smartTruncateModelLabel(text: string, maxWidth: number): string {
	const ELLIPSIS = "…";
	const ANSI_RE = /\x1b\[[0-9;]*m/g;
	if (visibleWidth(text) <= maxWidth) return text;
	const segments = text.split("/");
	const n = segments.length;
	if (n === 1) return truncateToWidth(text, maxWidth, ELLIPSIS).replace(ANSI_RE, "");

	const lastIndex = n - 1;
	const kept = new Set<number>([lastIndex]);
	const priority: number[] = [];
	priority.push(0);
	if (n - 2 > 0) priority.push(n - 2);
	for (let i = 1; i <= n - 3; i++) priority.push(i);

	const render = () => {
		const parts: string[] = [];
		let i = 0;
		while (i < n) {
			if (kept.has(i)) {
				parts.push(segments[i]!);
				i++;
			} else {
				while (i < n && !kept.has(i)) i++;
				parts.push(ELLIPSIS);
			}
		}
		return parts.join("/");
	};

	let current = render();
	if (visibleWidth(current) > maxWidth) {
		const skeleton = `${ELLIPSIS}/`;
		const budget = Math.max(0, maxWidth - visibleWidth(skeleton));
		return (skeleton + truncateToWidth(segments[lastIndex]!, budget, ELLIPSIS)).replace(ANSI_RE, "");
	}

	for (const index of priority) {
		kept.add(index);
		const candidate = render();
		if (visibleWidth(candidate) > maxWidth) {
			kept.delete(index);
			continue;
		}
		current = candidate;
	}
	return current;
}

export const MODEL_LIST_LAYOUT: SelectListLayoutOptions = {
	truncatePrimary: ({ text, maxWidth }) => smartTruncateModelLabel(text, maxWidth),
};
