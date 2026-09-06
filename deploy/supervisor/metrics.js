/** Counters and a Prometheus text rendering of them plus live gauges. */
export function createMetrics() {
	const counters = { spawns: 0, spawn_failures: 0, reaps: 0, oom_kills: 0, proxy_errors: 0, auth_denied: 0 };
	let readyCount = 0;
	let readySumMs = 0;
	let readyLastMs = 0;
	return {
		inc(name, by = 1) {
			counters[name] = (counters[name] ?? 0) + by;
		},
		observeReady(ms) {
			readyCount += 1;
			readySumMs += ms;
			readyLastMs = ms;
		},
		snapshot() {
			return { ...counters, ready_count: readyCount, ready_sum_ms: readySumMs, ready_last_ms: readyLastMs };
		},
		render(gauges = {}) {
			const lines = [];
			for (const [k, v] of Object.entries(counters)) {
				lines.push(`# TYPE docwriter_supervisor_${k}_total counter`, `docwriter_supervisor_${k}_total ${v}`);
			}
			lines.push('# TYPE docwriter_supervisor_ready_seconds summary');
			lines.push(`docwriter_supervisor_ready_seconds_sum ${(readySumMs / 1000).toFixed(3)}`);
			lines.push(`docwriter_supervisor_ready_seconds_count ${readyCount}`);
			lines.push(`docwriter_supervisor_ready_last_seconds ${(readyLastMs / 1000).toFixed(3)}`);
			for (const [k, v] of Object.entries(gauges)) {
				lines.push(`# TYPE docwriter_supervisor_${k} gauge`, `docwriter_supervisor_${k} ${v}`);
			}
			return lines.join('\n') + '\n';
		}
	};
}
