import { Pinecone, type Index, type RecordMetadata } from '@pinecone-database/pinecone';
import { getPineconeApiKey, getPineconeIndexName } from './config.js';

let client: Pinecone | null = null;
let index: Index<RecordMetadata> | null = null;

export function getPineconeClient(): Pinecone {
	if (!client) {
		client = new Pinecone({ apiKey: getPineconeApiKey() });
	}
	return client;
}

export function getIndex(): Index<RecordMetadata> {
	if (!index) {
		index = getPineconeClient().index(getPineconeIndexName());
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
