import OpenAI from 'openai';

let client: OpenAI | null = null;

function getClient(): OpenAI {
	if (!client) {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
		client = new OpenAI({ apiKey });
	}
	return client;
}

const MODEL = 'text-embedding-3-small';

export async function embed(text: string): Promise<number[]> {
	const res = await getClient().embeddings.create({
		model: MODEL,
		input: text,
	});
	return res.data[0].embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
	if (texts.length === 0) return [];
	const res = await getClient().embeddings.create({
		model: MODEL,
		input: texts,
	});
	return res.data.map((d) => d.embedding);
}
