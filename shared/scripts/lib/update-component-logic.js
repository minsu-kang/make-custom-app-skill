/**
 * update-component-logic.js: the decisions and texts behind update-component.js (the entry script in the folder above).
 *
 * Role: pure functions and constants only. No network, no file access, no process.exit, no console. The entry script
 * prints these lines and does all the I/O. A new rule goes here with a unit test in lib/__tests__/update-component-logic.test.js.
 */

const ALLOWED_FIELDS = {
	module: ['label', 'description', 'connection', 'altConnection', 'webhook', 'typeId', 'crud', 'public', 'deprecated'],
	rpc: ['label', 'connection', 'altConnection'],
	connection: ['label'],
	webhook: ['label', 'connection', 'altConnection'],
	endpoint: ['label', 'description', 'public', 'deprecated', 'archived'],
};

/** What an employee may set on a module: the field list before a module could be deprecated here. */
const EMPLOYEE_MODULE_FIELDS = ALLOWED_FIELDS.module.filter((f) => f !== 'deprecated');

const MODULE_PUBLIC_NOTE = '  (This changes only whether the module is visible in the scenario editor. It does not publish the app.)';

const USAGE_LINES = [
	'Usage: node update-component.js <app-slug> <app-version> <type> <name> <key=value> [key=value...]',
	'',
	'Updates component metadata (NOT file contents — use update-app.js for that).',
	'',
	'Types and supported fields:',
	'  module     label, description, connection, altConnection, webhook, typeId, crud, public, deprecated (public mode only)',
	'  rpc        label, connection, altConnection',
	'  connection label',
	'  webhook    label, connection, altConnection',
	'  endpoint   label, description, public, deprecated, archived (context, annotations → update-app.js)',
	'  function   (not supported)',
	'',
	'Examples:',
	'  node update-component.js monday 2 module aggregateTableV2 label="Aggregate Table"',
	'  node update-component.js monday 2 module newModule public=true     # show the module in the scenario editor',
	'  node update-component.js monday 2 module oldModule public=false    # hide the module',
	'  node update-component.js monday 2 rpc RpcBoards label="List Boards" connection=monday',
	'  node update-component.js monday 2 connection monday label="Monday v2 Updated"',
	'  node update-component.js google-docs 1 endpoint getDocument label="Get a Document" public=true',
	'  node update-component.js google-docs 1 endpoint oldEndpoint deprecated=true',
];

/** The refusal lines for a module `deprecated` field in employee mode (an employee may not set it), or null. */
function employeeFieldError({ mode, type, body }) {
	if (mode !== 'employee' || type !== 'module' || !('deprecated' in body)) return null;
	return ['ERROR: Invalid field(s) for module: deprecated', `  Allowed fields: ${EMPLOYEE_MODULE_FIELDS.join(', ')}`];
}

function action(title, path, note = null, verb = title) {
	return { title, verb, path, note };
}

function publicAction(mode, type, on) {
	const path = on ? 'public' : 'private';
	if (mode !== 'public') return action(on ? 'Publish' : 'Unpublish', path);
	if (type === 'module') return action(on ? 'Show module (public)' : 'Hide module (private)', path, MODULE_PUBLIC_NOTE, on ? 'Show module' : 'Hide module');
	return action(on ? 'Set endpoint public' : 'Set endpoint private', path);
}

function deprecateAction(type, on) {
	const verb = (on ? 'Deprecate' : 'Undeprecate') + (type === 'module' ? ' module' : '');
	return action(verb, on ? 'deprecate' : 'undeprecate');
}

/**
 * The flag fields of a body that use their own POST route instead of a PATCH field, in the order public, deprecated,
 * archived. `title` is the first line of an action, `verb` names it in the result lines, `note` is an extra line or null.
 * `rest` is the body without those fields.
 */
function flagActions({ mode, type, body }) {
	const rest = { ...body };
	const actions = [];
	if ('public' in rest && (type === 'module' || type === 'endpoint')) {
		actions.push(publicAction(mode, type, rest.public));
		delete rest.public;
	}
	if ('deprecated' in rest && (type === 'endpoint' || (type === 'module' && mode === 'public'))) {
		actions.push(deprecateAction(type, rest.deprecated));
		delete rest.deprecated;
	}
	if ('archived' in rest && type === 'endpoint') {
		actions.push(action(rest.archived ? 'Archive' : 'Unarchive', rest.archived ? 'archive' : 'unarchive'));
		delete rest.archived;
	}
	return { actions, rest };
}

module.exports = { ALLOWED_FIELDS, EMPLOYEE_MODULE_FIELDS, MODULE_PUBLIC_NOTE, USAGE_LINES, employeeFieldError, flagActions };
