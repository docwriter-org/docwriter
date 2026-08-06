import { expect, test } from '@playwright/test';

test('reference status opens the large author style review workflow', async ({ page }) => {
	await page.route('**/api/style-profile', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				status: 'empty',
				referenceCount: 0,
				activeCount: 0,
				unresolvedCount: 0,
				stale: false,
				profile: null
			})
		});
	});
	await page.route('**/api/references', async (route) => {
		if (route.request().method() === 'GET') {
			await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ references: [] }) });
			return;
		}
		await route.continue();
	});
	await page.goto('/');
	const referencesButton = page.locator('button[title="Manage writing references and the learned author style"]');
	await expect(referencesButton).toContainText('References not provided', { timeout: 45_000 });
	await referencesButton.click();
	const dialog = page.getByRole('dialog', { name: 'Writing references' });
	await expect(dialog).toBeVisible();
	const dialogBox = await dialog.boundingBox();
	expect(dialogBox).not.toBeNull();
	expect(dialogBox!.width).toBeGreaterThan(1200);
	expect(dialogBox!.height).toBeGreaterThan(680);
	await expect(page.getByRole('button', { name: 'Sources' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Analyze', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Active skill' })).toBeVisible();
	await page.getByRole('button', { name: 'Analyze', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Measure first, then interpret' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Pick your poison' })).toBeVisible();
	await expect(page.getByText('No analysis has run yet')).toBeVisible();
});

test('analysis is rendered as a clear activity list beside close calls', async ({ page }) => {
	const completedSpecialist = (id: 'organization' | 'language' | 'discourse' | 'synthesis') => ({
		id,
		status: 'completed',
		families: [],
		startedAt: 1,
		completedAt: 2
	});
	await page.route('**/api/style-profile', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				status: 'needs-calibration',
				referenceCount: 1,
				activeCount: 0,
				unresolvedCount: 1,
				stale: false,
				profile: {
					schemaVersion: 1,
					analyzerVersion: 'test',
					status: 'needs-calibration',
					createdAt: 1,
					updatedAt: 2,
					sourceSnapshotHash: 'source-hash',
					propositions: [{
						id: 'punctuation-colon',
						family: 'punctuation',
						type: 'clause-boundary',
						statement: 'Use colons to introduce concise explanations.',
						instruction: 'Use a colon when the next clause directly explains the first.',
						scope: ['sentence'],
						metricIds: ['punctuation.colon.rate'],
						evidenceIds: ['span-1'],
						counterevidenceIds: [],
						interpretationConfidence: 0.7,
						evidenceConfidence: 0.72,
						confidence: 0.71,
						actionability: 0.9,
						role: 'descriptive',
						status: 'pending',
						createdAt: 1,
						updatedAt: 2
					}],
					calibrations: [{
						id: 'trial-1',
						propositionId: 'punctuation-colon',
						status: 'generated',
						candidateA: 'The result is clear: the shorter opening works better.',
						candidateB: 'The result is clear. The shorter opening works better.'
					}],
					lastRun: {
						id: 'run-1',
						status: 'completed',
						provider: 'test',
						phase: 'completed',
						progress: 100,
						startedAt: 1,
						updatedAt: 2,
						completedAt: 2,
						specialists: [
							completedSpecialist('organization'),
							{ ...completedSpecialist('language'), status: 'error', error: 'RAW PROVIDER STACK TRACE' },
							completedSpecialist('discourse'),
							completedSpecialist('synthesis')
						]
					}
				}
			})
		});
	});
	await page.route('**/api/references', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ references: [{ id: 'source-1', label: 'Sample', type: 'stored-sample', target: 'sample.txt', role: 'authored', materializationStatus: 'ready' }] })
		});
	});

	await page.goto('/');
	await page.getByRole('button', { name: 'Calibrate references' }).click();
	await page.getByRole('button', { name: 'Analyze', exact: true }).click();
	const activityList = page.getByRole('list', { name: 'Analysis progress' });
	await expect(activityList.getByRole('listitem')).toHaveCount(7);
	await expect(activityList.getByText('Organization specialist')).toBeVisible();
	await expect(activityList.getByText('Language specialist')).toBeVisible();
	await expect(activityList.getByText('Needs attention')).toBeVisible();
	await expect(page.getByText('RAW PROVIDER STACK TRACE')).toHaveCount(0);
	await expect(page.getByRole('button', { name: /The result is clear: the shorter opening/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /The result is clear\. The shorter opening/ })).toBeVisible();
});
