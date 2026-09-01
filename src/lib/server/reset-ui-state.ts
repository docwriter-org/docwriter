/**
 * Reset pending reviews and/or comment threads across workspace tabs.
 *
 * Uses the live Hocuspocus document when the WS server is up so connected
 * browsers receive the same Yjs update. Falls back to a throwaway replay
 * via `withLiveDoc` (startup / `--reset-ui` before any client connects).
 */
import * as Y from 'yjs';
import { applyUiReset, type UiResetOptions, type UiResetResult } from '$lib/shared/reset-ui-state';
import { isBinaryOrPreviewPath } from '$lib/shared/file-kinds';
import { listPersistedTabIds } from './ydoc-persistence';
import { getTabsState } from './runtime-state';
import { withLiveDoc } from './ws-server';

export interface TabUiResetResult extends UiResetResult {
	tabId: string;
	yjsUpdate: string | null;
}

export interface WorkspaceUiResetResult {
	tabs: TabUiResetResult[];
	reviewsCleared: number;
	commentsCleared: number;
}

export async function resetTabUiState(
	tabId: string,
	options: UiResetOptions = {}
): Promise<TabUiResetResult> {
	return withLiveDoc(tabId, (ydoc) => {
		const before = Y.encodeStateVector(ydoc);
		const cleared = applyUiReset(ydoc, options);
		if (cleared.reviewsCleared === 0 && cleared.commentsCleared === 0) {
			return { tabId, yjsUpdate: null, ...cleared };
		}
		const yjsUpdate = Buffer.from(Y.encodeStateAsUpdate(ydoc, before)).toString('base64');
		return { tabId, yjsUpdate, ...cleared };
	});
}

export async function resetWorkspaceUiState(
	options: UiResetOptions & { tabId?: string } = {}
): Promise<WorkspaceUiResetResult> {
	const tabIds = options.tabId
		? [options.tabId]
		: [...new Set([...listPersistedTabIds(), ...getTabsState().order])]
				.filter((id) => !isBinaryOrPreviewPath(id))
				.sort();
	const tabs: TabUiResetResult[] = [];
	let reviewsCleared = 0;
	let commentsCleared = 0;
	for (const tabId of tabIds) {
		if (isBinaryOrPreviewPath(tabId)) continue;
		const result = await resetTabUiState(tabId, options);
		tabs.push(result);
		reviewsCleared += result.reviewsCleared;
		commentsCleared += result.commentsCleared;
	}
	return { tabs, reviewsCleared, commentsCleared };
}
