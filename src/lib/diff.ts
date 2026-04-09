export type DiffPart = { text: string; type: 'same' | 'added' | 'removed' };

// Simple word-level diff using longest common subsequence
export function wordDiff(oldText: string, newText: string): DiffPart[] {
	const oldWords = oldText.split(/(\s+)/); // preserve whitespace
	const newWords = newText.split(/(\s+)/);

	// LCS table
	const m = oldWords.length;
	const n = newWords.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (oldWords[i - 1] === newWords[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	// Backtrack to build diff
	const parts: DiffPart[] = [];
	let i = m,
		j = n;

	const stack: DiffPart[] = [];
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
			stack.push({ text: oldWords[i - 1], type: 'same' });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			stack.push({ text: newWords[j - 1], type: 'added' });
			j--;
		} else {
			stack.push({ text: oldWords[i - 1], type: 'removed' });
			i--;
		}
	}

	stack.reverse();

	// Merge adjacent same-type parts
	for (const part of stack) {
		if (parts.length > 0 && parts[parts.length - 1].type === part.type) {
			parts[parts.length - 1].text += part.text;
		} else {
			parts.push({ ...part });
		}
	}

	return parts;
}
