const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const u = require('../update-component-logic');

describe('flagActions', () => {
	it('row 20: a module public flag in public mode shows or hides the module, with the note', () => {
		assert.deepEqual(u.flagActions({ mode: 'public', type: 'module', body: { public: true, label: 'x' } }), {
			actions: [{ title: 'Show module (public)', verb: 'Show module', path: 'public', note: u.MODULE_PUBLIC_NOTE }],
			rest: { label: 'x' },
		});
		assert.deepEqual(u.flagActions({ mode: 'public', type: 'module', body: { public: false } }).actions, [{ title: 'Hide module (private)', verb: 'Hide module', path: 'private', note: u.MODULE_PUBLIC_NOTE }]);
	});

	it('row 20: the module note is the row 20 line', () => {
		assert.equal(u.MODULE_PUBLIC_NOTE, '  (This changes only whether the module is visible in the scenario editor. It does not publish the app.)');
	});

	it('row 20: an endpoint public flag in public mode', () => {
		assert.deepEqual(u.flagActions({ mode: 'public', type: 'endpoint', body: { public: true } }).actions, [{ title: 'Set endpoint public', verb: 'Set endpoint public', path: 'public', note: null }]);
		assert.deepEqual(u.flagActions({ mode: 'public', type: 'endpoint', body: { public: false } }).actions, [{ title: 'Set endpoint private', verb: 'Set endpoint private', path: 'private', note: null }]);
	});

	it('employee mode keeps Publish and Unpublish', () => {
		assert.deepEqual(u.flagActions({ mode: 'employee', type: 'module', body: { public: true } }).actions, [{ title: 'Publish', verb: 'Publish', path: 'public', note: null }]);
		assert.deepEqual(u.flagActions({ mode: 'employee', type: 'module', body: { public: false } }).actions, [{ title: 'Unpublish', verb: 'Unpublish', path: 'private', note: null }]);
		assert.deepEqual(u.flagActions({ mode: 'employee', type: 'endpoint', body: { public: false } }).actions, [{ title: 'Unpublish', verb: 'Unpublish', path: 'private', note: null }]);
	});

	it('3.8: module deprecation in public mode, endpoint deprecation and archive in both modes', () => {
		assert.deepEqual(u.flagActions({ mode: 'public', type: 'module', body: { deprecated: true } }).actions, [{ title: 'Deprecate module', verb: 'Deprecate module', path: 'deprecate', note: null }]);
		assert.deepEqual(u.flagActions({ mode: 'public', type: 'module', body: { deprecated: false } }).actions, [{ title: 'Undeprecate module', verb: 'Undeprecate module', path: 'undeprecate', note: null }]);
		assert.deepEqual(u.flagActions({ mode: 'employee', type: 'endpoint', body: { deprecated: true, archived: false } }).actions.map((a) => a.verb), ['Deprecate', 'Unarchive']);
		assert.deepEqual(u.flagActions({ mode: 'public', type: 'endpoint', body: { deprecated: false, archived: true } }).actions.map((a) => a.path), ['undeprecate', 'archive']);
		assert.deepEqual(u.flagActions({ mode: 'employee', type: 'module', body: { deprecated: true } }), { actions: [], rest: { deprecated: true } });
	});

	it('the actions come in the order public, deprecated, archived, and the rest keeps the other fields', () => {
		const r = u.flagActions({ mode: 'public', type: 'endpoint', body: { archived: true, label: 'L', deprecated: true, public: true } });
		assert.deepEqual(r.actions.map((a) => a.path), ['public', 'deprecate', 'archive']);
		assert.deepEqual(r.rest, { label: 'L' });
	});

	it('a flag the type does not take stays in the rest', () => {
		assert.deepEqual(u.flagActions({ mode: 'public', type: 'rpc', body: { public: true } }), { actions: [], rest: { public: true } });
		assert.deepEqual(u.flagActions({ mode: 'public', type: 'module', body: { archived: true } }), { actions: [], rest: { archived: true } });
	});

	it('does not change the body it was given', () => {
		const body = { public: true, label: 'x' };
		u.flagActions({ mode: 'public', type: 'module', body });
		assert.deepEqual(body, { public: true, label: 'x' });
	});
});

describe('employeeFieldError', () => {
	it('refuses a module deprecated field in employee mode with today\'s lines (spec 3.8)', () => {
		assert.deepEqual(u.employeeFieldError({ mode: 'employee', type: 'module', body: { deprecated: true } }), ['ERROR: Invalid field(s) for module: deprecated', '  Allowed fields: label, description, connection, altConnection, webhook, typeId, crud, public']);
		assert.equal(u.employeeFieldError({ mode: 'public', type: 'module', body: { deprecated: true } }), null);
		assert.equal(u.employeeFieldError({ mode: 'employee', type: 'endpoint', body: { deprecated: true } }), null);
		assert.equal(u.employeeFieldError({ mode: 'employee', type: 'module', body: { label: 'x' } }), null);
	});
});

describe('allowed fields', () => {
	it('a module takes deprecated, the employee list leaves it out, the other types are unchanged', () => {
		assert.deepEqual(u.ALLOWED_FIELDS.module, ['label', 'description', 'connection', 'altConnection', 'webhook', 'typeId', 'crud', 'public', 'deprecated']);
		assert.deepEqual(u.EMPLOYEE_MODULE_FIELDS, ['label', 'description', 'connection', 'altConnection', 'webhook', 'typeId', 'crud', 'public']);
		assert.deepEqual(u.ALLOWED_FIELDS.rpc, ['label', 'connection', 'altConnection']);
		assert.deepEqual(u.ALLOWED_FIELDS.connection, ['label']);
		assert.deepEqual(u.ALLOWED_FIELDS.webhook, ['label', 'connection', 'altConnection']);
		assert.deepEqual(u.ALLOWED_FIELDS.endpoint, ['label', 'description', 'public', 'deprecated', 'archived']);
	});
});

describe('usage', () => {
	it('row 20: the usage comments of the two module examples, and the module deprecated field', () => {
		assert.ok(u.USAGE_LINES.includes('  node update-component.js monday 2 module newModule public=true     # show the module in the scenario editor'));
		assert.ok(u.USAGE_LINES.includes('  node update-component.js monday 2 module oldModule public=false    # hide the module'));
		assert.ok(u.USAGE_LINES.includes('  module     label, description, connection, altConnection, webhook, typeId, crud, public, deprecated (public mode only)'));
	});

	it('the rest of the usage is today\'s', () => {
		assert.equal(u.USAGE_LINES[0], 'Usage: node update-component.js <app-slug> <app-version> <type> <name> <key=value> [key=value...]');
		assert.ok(u.USAGE_LINES.includes('  endpoint   label, description, public, deprecated, archived (context, annotations → update-app.js)'));
		assert.equal(u.USAGE_LINES[u.USAGE_LINES.length - 1], '  node update-component.js google-docs 1 endpoint oldEndpoint deprecated=true');
	});
});
