const PLAIN_WRITING_SKILL_REPO = 'docwriter-org/plain-writing-skill';

async function fetchPlainWritingStars(): Promise<number | null> {
	try {
		const res = await fetch(`https://api.github.com/repos/${PLAIN_WRITING_SKILL_REPO}`, {
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': 'docwriter-landing'
			}
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { stargazers_count?: number };
		return typeof body.stargazers_count === 'number' ? body.stargazers_count : null;
	} catch {
		return null;
	}
}

export const load = async () => {
	const plainWritingStars = await fetchPlainWritingStars();
	return { plainWritingStars };
};
