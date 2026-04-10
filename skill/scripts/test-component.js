#!/usr/bin/env node
/**
 * Make Custom App Component Integration Test Runner
 *
 * Wrapper that delegates to the make-apps-mockup framework for running
 * module, RPC, connection, and webhook integration tests.
 *
 * Usage:
 *   node test-component.js <app-slug> <app-version> <component-type> [component-name ...] [--format=console|json] [--debug]
 *
 * Examples:
 *   node test-component.js monday 2 module                          # test all modules
 *   node test-component.js monday 2 module CreateItemV2             # test one module
 *   node test-component.js monday 2 rpc idFinderItem getBoards      # test multiple RPCs
 *   node test-component.js monday 2 module CreateItemV2 --format=json  # JSON output for AI agents
 *   node test-component.js monday 2 module --debug                  # show HTTP request details
 *
 * Component types: module, rpc, connection, webhook
 *
 * Requires:
 *   - make-apps-mockup repo path configured in SKILL.md (make-apps-mockup-path: /path/to/repo)
 *   - MAKE_API_KEY environment variable set
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_MD_PATH = path.join(os.homedir(), '.cursor/skills/make-custom-app/SKILL.md');

function getMockupPath() {
	if (!fs.existsSync(SKILL_MD_PATH)) return null;
	const content = fs.readFileSync(SKILL_MD_PATH, 'utf-8');
	const lines = content.trim().split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = lines[i].match(/^make-apps-mockup-path:\s*(.+)$/);
		if (match) return match[1].trim();
	}
	return null;
}

const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const positional = args.filter(a => !a.startsWith('--'));

const [slug, version, componentType, ...componentNames] = positional;

if (!slug || !version || !componentType) {
	console.log('Usage: node test-component.js <app-slug> <app-version> <component-type> [component-name ...] [options]');
	console.log('');
	console.log('Component types: module, rpc, connection, webhook');
	console.log('');
	console.log('Options:');
	console.log('  --format=console|json   Output format (default: console)');
	console.log('  --debug                 Show HTTP request/response details');
	console.log('');
	console.log('Examples:');
	console.log('  node test-component.js monday 2 module                          # all modules');
	console.log('  node test-component.js monday 2 module CreateItemV2             # one module');
	console.log('  node test-component.js monday 2 rpc idFinderItem getBoards      # multiple RPCs');
	console.log('  node test-component.js monday 2 module --format=json            # JSON output');
	process.exit(1);
}

const validTypes = ['module', 'rpc', 'connection', 'webhook'];
if (!validTypes.includes(componentType)) {
	console.error(`Invalid component type: "${componentType}". Must be one of: ${validTypes.join(', ')}`);
	process.exit(1);
}

const mockupPath = getMockupPath();

if (!mockupPath || !fs.existsSync(mockupPath)) {
	console.error('make-apps-mockup path not configured or not found.');
	console.error('');
	console.error('Please configure it in SKILL.md by adding this line at the end:');
	console.error('  make-apps-mockup-path: /path/to/make-apps-mockup');
	console.error('');
	console.error('Or clone the repo first:');
	console.error('  git clone <make-apps-mockup-repo> /path/to/make-apps-mockup');
	process.exit(1);
}

// Ensure mockup repo is on master and up-to-date
try {
	execSync('git checkout master --quiet && git pull origin master --quiet', {
		cwd: mockupPath,
		stdio: 'pipe',
		timeout: 15000,
	});
} catch (e) {
	const msg = (e.stderr || e.stdout || '').toString().trim();
	if (msg) console.error(`Warning: mockup repo sync failed — ${msg}`);
}

const envFile = path.join(mockupPath, '.env');
if (!process.env.MAKE_API_KEY && fs.existsSync(envFile)) {
	const envContent = fs.readFileSync(envFile, 'utf-8');
	for (const line of envContent.split('\n')) {
		const match = line.match(/^([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
		if (match) process.env[match[1]] = match[2];
	}
}

if (!process.env.MAKE_API_KEY) {
	console.error('MAKE_API_KEY not found. Set it in:');
	console.error(`  - ${envFile}`);
	console.error('  - or export MAKE_API_KEY=your-api-key');
	process.exit(1);
}

const formatFlag = flags.find(f => f.startsWith('--format='));
const format = formatFlag ? formatFlag.split('=')[1] : 'console';
const debug = flags.includes('--debug');

const cmdParts = [
	'NODE_OPTIONS="--no-node-snapshot"',
	'npx ts-node main.ts run',
	slug,
	version,
	componentType,
];

if (componentNames.length > 0) {
	cmdParts.push(`"${componentNames.join(' ')}"`);
}

if (format !== 'console') {
	cmdParts.push(`--format=${format}`);
}

if (debug) {
	cmdParts.push('--debug');
}

const cmd = cmdParts.join(' ');

try {
	const output = execSync(cmd, {
		cwd: mockupPath,
		stdio: 'pipe',
		input: componentNames.length === 0 ? '\n' : undefined,
		env: { ...process.env },
		maxBuffer: 50 * 1024 * 1024,
	});

	const stdout = output.toString();
	const lines = stdout.split('\n').filter(l => !l.includes('npm warn'));
	console.log(lines.join('\n'));
	process.exit(0);
} catch (e) {
	if (e.stdout) {
		const stdout = e.stdout.toString();
		const lines = stdout.split('\n').filter(l => !l.includes('npm warn'));
		console.log(lines.join('\n'));
	}
	if (e.stderr) {
		const stderr = e.stderr.toString();
		const errLines = stderr.split('\n').filter(l => !l.includes('npm warn'));
		if (errLines.some(l => l.trim())) {
			console.error(errLines.join('\n'));
		}
	}
	process.exit(e.status || 1);
}
