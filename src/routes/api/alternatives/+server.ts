import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '@anthropic-ai/claude-agent-sdk';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { atom, context, model } = await request.json();

		const prompt = `Given this atom, generate 4 alternatives that vary the subject — pick different nouns or noun phrases from within the claim that could serve as the subject instead.

Current atom:
- subject: "${atom.subject}"
- predicate: "${atom.predicate}"

For example, if the atom is "conversation | wrong paradigm for writing", alternatives might use subjects like "writing", "wrong paradigm", "the paradigm mismatch", "AI-assisted writing" — each reframing who/what the sentence is about, while keeping the core idea.

Surrounding context:
${context.map((a: { subject: string; predicate: string }) => `- ${a.subject} | ${a.predicate}`).join('\n')}

Return ONLY a JSON array of 4 alternatives, no commentary:
[
  { "subject": "...", "predicate": "..." },
  { "subject": "...", "predicate": "..." },
  { "subject": "...", "predicate": "..." },
  { "subject": "...", "predicate": "..." }
]

Each alternative keeps the same core idea but reframes it around a different noun as the subject. The predicate adjusts to make grammatical sense with the new subject.`;

		let resultText = '';
		for await (const message of query({
			prompt,
			options: {
				allowedTools: [],
				maxTurns: 1,
				...(model ? { model } : {})
			}
		})) {
			if ('result' in message && typeof message.result === 'string') {
				resultText = message.result;
			}
		}

		// Parse JSON from response
		const jsonMatch = resultText.match(/\[[\s\S]*\]/);
		if (jsonMatch) {
			return json(JSON.parse(jsonMatch[0]));
		}
		return json([]);
	} catch (error) {
		console.error('Alternatives error:', error);
		return json([], { status: 500 });
	}
};
