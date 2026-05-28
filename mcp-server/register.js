#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

const SERVER_NAME = 'make-app-context';
const MCP_CONFIG_PATH = path.join(os.homedir(), '.cursor', 'mcp.json');
const ENV_PATH = path.join(import.meta.dirname, '.env');
const DIST_ENTRY = path.join(import.meta.dirname, 'dist', 'index.js');

function parseEnvFile(filePath) {
	const content = readFileSync(filePath, 'utf-8');
	const env = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIdx = trimmed.indexOf('=');
		if (eqIdx === -1) continue;
		env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
	}
	return env;
}

if (!existsSync(ENV_PATH)) {
	console.error(`❌ .env file not found: ${ENV_PATH}`);
	console.error('   Copy .env.example to .env and fill in your API keys first.');
	process.exit(1);
}

if (!existsSync(DIST_ENTRY)) {
	console.error(`❌ dist/index.js not found. Run "npm run build" first.`);
	process.exit(1);
}

const env = parseEnvFile(ENV_PATH);
const requiredKeys = ['PINECONE_API_KEY', 'OPENAI_API_KEY', 'PINECONE_INDEX_NAME'];
const missing = requiredKeys.filter((k) => !env[k]);
if (missing.length > 0) {
	console.error(`❌ Missing env vars in .env: ${missing.join(', ')}`);
	process.exit(1);
}

let mcpConfig = { mcpServers: {} };
if (existsSync(MCP_CONFIG_PATH)) {
	mcpConfig = JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf-8'));
	if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
}

const alreadyExists = !!mcpConfig.mcpServers[SERVER_NAME];

// Use absolute node path so Cursor (launched from macOS GUI without shell PATH)
// can spawn the server. Literal 'node' fails with `spawn node ENOENT`.
const NODE_BIN = process.execPath;

mcpConfig.mcpServers[SERVER_NAME] = {
	command: NODE_BIN,
	args: [DIST_ENTRY],
	env: {
		PINECONE_API_KEY: env.PINECONE_API_KEY,
		OPENAI_API_KEY: env.OPENAI_API_KEY,
		PINECONE_INDEX_NAME: env.PINECONE_INDEX_NAME,
	},
};

writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig, null, 2) + '\n');

if (alreadyExists) {
	console.log(`✅ Updated "${SERVER_NAME}" in ${MCP_CONFIG_PATH}`);
} else {
	console.log(`✅ Registered "${SERVER_NAME}" in ${MCP_CONFIG_PATH}`);
}
console.log(`   Command: ${NODE_BIN} ${DIST_ENTRY}`);
console.log(`   Env vars: ${requiredKeys.join(', ')}`);
console.log('');
console.log('👉 Restart Cursor to activate the MCP server.');
