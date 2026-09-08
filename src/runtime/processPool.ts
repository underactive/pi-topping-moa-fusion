import { type ChildProcess } from "node:child_process";

/** Globally tracked spawned processes so /reload can kill them. */
export const trackedProcesses: Set<ChildProcess> = new Set();

/** Send SIGTERM, then force a still-live child down after the grace period. */
export function escalateKill(proc: ChildProcess, termTimeoutMs = 5000): void {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	try { proc.kill("SIGTERM"); } catch { return; }
	setTimeout(() => {
		if (proc.exitCode !== null || proc.signalCode !== null) return;
		try { proc.kill("SIGKILL"); } catch { /* ignore */ }
	}, termTimeoutMs).unref();
}

/** Kill every tracked process. Safe to call multiple times. */
export function cleanupTrackedProcesses(termTimeoutMs = 5000): void {
	// Snapshot targets before clearing so the delayed SIGKILL pass still
	// reaches the same processes that were just signalled.
	const processes = [...trackedProcesses];
	for (const proc of processes) {
		if (proc.exitCode !== null || proc.signalCode !== null) continue;
		try { proc.kill("SIGTERM"); } catch { /* ignore */ }
	}
	trackedProcesses.clear();

	// Give SIGTERM a moment, then SIGKILL any process that has not exited.
	setTimeout(() => {
		for (const proc of processes) {
			if (proc.exitCode !== null || proc.signalCode !== null) continue;
			try { proc.kill("SIGKILL"); } catch { /* ignore */ }
		}
	}, termTimeoutMs).unref();
}


export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
