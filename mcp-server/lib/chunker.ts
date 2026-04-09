import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

const CONTEXTS_DIR = path.join(os.homedir(), '.cursor', 'make-app-contexts');

export interface MarkdownSection {
	section: string;
	content: string;
}

export interface AppChunk {
	id: string;
	text: string;
	metadata: {
		slug: string;
		version: string;
		section: string;
		source: string;
		ticket_key?: string;
		ticket_type?: string;
	};
}

interface ModuleEntry {
	name: string;
	label?: string;
	typeId: number;
}

interface NamedEntry {
	name: string;
	label?: string;
}

interface AppMetadata {
	slug: string;
	version: string;
	label?: string;
	description?: string;
	origin?: string;
	modules?: ModuleEntry[];
	rpcs?: NamedEntry[];
	webhooks?: NamedEntry[];
	connections?: NamedEntry[];
	functions?: Array<NamedEntry | string>;
}

/**
 * Split a markdown string into sections by ## headings.
 */
export function splitMarkdownSections(markdown: string): MarkdownSection[] {
	const lines = markdown.split(/\r?\n/);
	const sections: MarkdownSection[] = [];
	let currentSection: string | null = null;
	let currentLines: string[] = [];

	for (const line of lines) {
		const headingMatch = line.match(/^## (.+)$/);
		if (headingMatch) {
			if (currentSection) {
				sections.push({
					section: normalizeSection(currentSection),
					content: currentLines.join('\n').trim(),
				});
			}
			currentSection = headingMatch[1];
			currentLines = [line];
		} else {
			currentLines.push(line);
		}
	}

	if (currentSection && currentLines.length > 0) {
		sections.push({
			section: normalizeSection(currentSection),
			content: currentLines.join('\n').trim(),
		});
	}

	return sections;
}

function normalizeSection(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/\s+/g, '-');
}

/**
 * Summarize metadata.json into a searchable text string.
 */
export function summarizeMetadata(metadata: AppMetadata): string {
	const parts: string[] = [];
	parts.push(`App: ${metadata.label || metadata.slug} (${metadata.slug} v${metadata.version})`);
	if (metadata.description) parts.push(`Description: ${metadata.description}`);
	if (metadata.origin) parts.push(`Origin: ${metadata.origin}`);

	if (metadata.modules?.length) {
		const typeMap: Record<number, string> = {
			1: 'Trigger',
			4: 'Action',
			5: 'Search',
			9: 'Instant Trigger',
			10: 'Responder',
			11: 'Universal',
		};
		const grouped: Record<string, string[]> = {};
		for (const m of metadata.modules) {
			const type = typeMap[m.typeId] || `Type ${m.typeId}`;
			if (!grouped[type]) grouped[type] = [];
			grouped[type].push(m.label || m.name);
		}
		const summary = Object.entries(grouped)
			.map(([type, names]) => `${type} (${names.length}): ${names.join(', ')}`)
			.join('; ');
		parts.push(`Modules: ${summary}`);
	}

	if (metadata.rpcs?.length) {
		parts.push(`RPCs: ${metadata.rpcs.map((r) => r.label || r.name).join(', ')}`);
	}
	if (metadata.webhooks?.length) {
		parts.push(`Webhooks: ${metadata.webhooks.map((w) => w.label || w.name).join(', ')}`);
	}
	if (metadata.connections?.length) {
		parts.push(`Connections: ${metadata.connections.map((c) => c.label || c.name).join(', ')}`);
	}
	if (metadata.functions?.length) {
		parts.push(`Custom Functions: ${metadata.functions.map((f) => (typeof f === 'string' ? f : f.name)).join(', ')}`);
	}

	return parts.join('\n');
}

interface WorkHistoryRow {
	date: string;
	task: string;
	details: string;
}

function parseWorkHistoryRows(text: string): WorkHistoryRow[] {
	const rows: WorkHistoryRow[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
		if (!match) continue;
		const [, date, task, details] = match;
		if (date === 'Date' || date.startsWith('-')) continue;
		rows.push({ date: date.trim(), task: task.trim(), details: details.trim() });
	}
	return rows;
}

/**
 * Merge two Work History markdown sections. Existing rows are preserved;
 * rows with the same Date+Task key are replaced by the newer (incoming) version.
 */
export function mergeWorkHistory(existingText: string, newText: string): string {
	const existingRows = parseWorkHistoryRows(existingText);
	const newRows = parseWorkHistoryRows(newText);

	if (existingRows.length === 0) return newText;
	if (newRows.length === 0) return existingText;

	const merged = new Map<string, WorkHistoryRow>();
	for (const row of existingRows) {
		merged.set(`${row.date}::${row.task}`, row);
	}
	for (const row of newRows) {
		merged.set(`${row.date}::${row.task}`, row);
	}

	const lines = [
		'## Work History',
		'',
		'| Date | Task | Details |',
		'|---|---|---|',
	];
	for (const row of merged.values()) {
		lines.push(`| ${row.date} | ${row.task} | ${row.details} |`);
	}
	return lines.join('\n');
}

/**
 * Read and chunk all data for an app into vectors.
 */
export async function chunkApp(slug: string, version: string): Promise<AppChunk[]> {
	const chunks: AppChunk[] = [];
	const appKey = `${slug}-v${version}`;

	const mdPath = path.join(CONTEXTS_DIR, `${appKey}.md`);
	if (existsSync(mdPath)) {
		const md = await readFile(mdPath, 'utf-8');
		const sections = splitMarkdownSections(md);
		for (const { section, content } of sections) {
			if (!content) continue;
			chunks.push({
				id: `${appKey}#${section}`,
				text: content,
				metadata: { slug, version: String(version), section, source: 'summary' },
			});
		}
	}

	const metaPath = path.join(CONTEXTS_DIR, appKey, 'metadata.json');
	if (existsSync(metaPath)) {
		const raw = await readFile(metaPath, 'utf-8');
		const metadata: AppMetadata = JSON.parse(raw);
		const text = summarizeMetadata(metadata);
		chunks.push({
			id: `${appKey}#metadata`,
			text,
			metadata: { slug, version: String(version), section: 'metadata', source: 'metadata' },
		});
	}

	return chunks;
}
