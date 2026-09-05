const projects = [
	{ repo: 'docwriter-org/docwriter', label: 'DocWriter' },
	{ repo: 'docwriter-org/plain-writing-skill', label: 'Plain writing skill' }
];

async function fetchStars(repo: string): Promise<number | null> {
	try {
		const res = await fetch(`https://api.github.com/repos/${repo}`, {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'docwriter-landing' },
			signal: AbortSignal.timeout(5000)
		});
		if (!res.ok) return null;
		const body = await res.json();
		return Number.isInteger(body.stargazers_count) && body.stargazers_count >= 0
			? body.stargazers_count : null;
	} catch {
		return null;
	}
}

export const load = async () => ({
	projects: await Promise.all(projects.map(async (project) => ({
		...project, stars: await fetchStars(project.repo)
	})))
});
