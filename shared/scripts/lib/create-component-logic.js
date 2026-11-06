/**
 * create-component-logic.js: the decisions and texts behind create-component.js (the entry script in the folder above).
 *
 * Role: pure functions and constants only. No network, no file access, no process.exit, no console. The entry script
 * prints these lines and does all the I/O. A new rule goes here with a unit test in lib/__tests__/create-component-logic.test.js.
 */

const INIT_MODES = ['example', 'blank'];

const INIT_MODE_USAGE = "initMode: example (copies the endpoint scaffold of Make's model app; the default in employee mode), blank (an empty endpoint; the default in public mode)";

const ENDPOINT_REFUSAL_LINE = '  SDK Endpoints are a closed beta. If Make refused this call, the account has no access to them: tell the user, and use an RPC or a module instead.';

const USAGE_LINES = [
	'Usage: node create-component.js <app-slug> <app-version> <type> [args...]',
	'',
	'Types:',
	'  module <name> <label> <type_id> [connection] [description]',
	'    type_id: 1=trigger, 4=action, 9=search, 10=instant_trigger, 11=responder, 12=universal',
	'',
	'  rpc <name> <label> [connection]',
	'',
	'  function <name>',
	'',
	'  connection <label> <auth-type>',
	'    auth-type: tokenAuth, oAuth, basic, digest, apiCert, apiKey, ...',
	'',
	'  webhook <label> <webhook-type> [connection]',
	'    webhook-type: web, web-shared',
	'',
	'  endpoint <name> <label> [connection] [description] [initMode]',
	`    ${INIT_MODE_USAGE}`,
	'',
	'Examples:',
	'  node create-component.js monday 2 module aggregateTableV2 "Aggregate Table (beta)" 4 monday',
	'  node create-component.js monday 2 rpc RpcAggregateColumns "Aggregate columns" monday',
	'  node create-component.js monday 2 function buildAggregateSelect',
	'  node create-component.js monday 2 connection "Monday v3" oAuth',
	'  node create-component.js monday 2 webhook "Monday Events" web monday',
	'  node create-component.js google-docs 1 endpoint listFiles "List Files" google-docs',
];

/** The two lines printed when an endpoint is called without a name or a label. */
function endpointUsageLines() {
	return ['Usage: create-component.js <slug> <version> endpoint <name> <label> [connection] [description] [initMode]', `  ${INIT_MODE_USAGE}`];
}

/** The `endpointInitMode` to send: a given value wins, public mode defaults to `blank`, null leaves the field out. */
function endpointInitMode({ mode, initMode }) {
	if (initMode) return initMode;
	return mode === 'public' ? 'blank' : null;
}

/** Lines that follow `Creation failed` and its message line. */
function creationFailedLines({ mode, type }) {
	return mode === 'public' && type === 'endpoint' ? [ENDPOINT_REFUSAL_LINE] : [];
}

module.exports = { INIT_MODES, INIT_MODE_USAGE, ENDPOINT_REFUSAL_LINE, USAGE_LINES, endpointUsageLines, endpointInitMode, creationFailedLines };
