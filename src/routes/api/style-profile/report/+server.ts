import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readStyleReport } from '$lib/server/style-analysis/profile-store';
import { isMeasured } from '$lib/server/style-analysis/run-manager';

/**
 * The measurements behind the analysis, for the writer to inspect. Zero-valued
 * metrics are excluded for the same reason specialists never see them: a
 * feature that never fired is not a fact about how someone writes.
 */
export const GET: RequestHandler = async () => {
	const report = readStyleReport();
	if (!report) return json({ measurements: [] });
	return json({
		measurements: report.measurements.filter(isMeasured).map((measurement) => ({
			id: measurement.id,
			family: measurement.family,
			label: measurement.label,
			unit: measurement.unit,
			value: measurement.value,
			count: measurement.count,
			sourceCount: measurement.sourceCount
		}))
	});
};
