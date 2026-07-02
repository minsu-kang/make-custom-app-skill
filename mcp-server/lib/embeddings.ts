// Embeddings are requested directly against the OpenAI REST API using Node's
// built-in fetch (undici). The `openai` SDK bundles node-fetch@2, which throws
// intermittent `ERR_STREAM_PREMATURE_CLOSE` while decompressing gzip'd
// responses under Node 20+/24 — undici handles compressed responses reliably.

const MODEL = 'text-embedding-3-small';
const ENDPOINT = 'https://api.openai.com/v1/embeddings';

function getApiKey(): string {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
	return apiKey;
}

interface EmbeddingResponse {
	data: { embedding: number[] }[];
}

async function requestEmbeddings(input: string | string[]): Promise<number[][]> {
	const res = await fetch(ENDPOINT, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${getApiKey()}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ model: MODEL, input }),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`OpenAI embeddings request failed: ${res.status} ${res.statusText} ${detail}`.trim());
	}
	const json = (await res.json()) as EmbeddingResponse;
	return json.data.map((d) => d.embedding);
}

export async function embed(text: string): Promise<number[]> {
	const [embedding] = await requestEmbeddings(text);
	return embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
	if (texts.length === 0) return [];
	return requestEmbeddings(texts);
}
