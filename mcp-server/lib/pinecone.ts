import { Pinecone, type Index, type RecordMetadata } from '@pinecone-database/pinecone';

let client: Pinecone | null = null;
let index: Index<RecordMetadata> | null = null;

export function getPineconeClient(): Pinecone {
	if (!client) {
		const apiKey = process.env.PINECONE_API_KEY;
		if (!apiKey) throw new Error('PINECONE_API_KEY is not set');
		client = new Pinecone({ apiKey });
	}
	return client;
}

export function getIndex(): Index<RecordMetadata> {
	if (!index) {
		const indexName = process.env.PINECONE_INDEX_NAME || 'make-app-contexts';
		index = getPineconeClient().index(indexName);
	}
	return index;
}

export function buildVectorId(slug: string, version: string, section: string): string {
	return `${slug}-v${version}#${section}`;
}

export interface ParsedVectorId {
	slug: string;
	version: string;
	section: string;
}

export function parseVectorId(id: string): ParsedVectorId | null {
	const match = id.match(/^(.+)-v(\d+)#(.+)$/);
	if (!match) return null;
	return { slug: match[1], version: match[2], section: match[3] };
}
