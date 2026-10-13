/**
 * SDK Endpoint `annotations` — MCP-style behavior hints on the endpoint entity.
 * Allowed keys and boolean values mirror the manifest schema (`additionalProperties: false`).
 */
const ANNOTATION_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint', 'arbitraryCallHint'];

/** Parse and validate the text of an annotations file. Throws an Error with a readable message. */
function parseAnnotations(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch (err) {
		throw new Error(`annotations file is not valid JSON: ${err.message}`);
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('annotations must be a JSON object, e.g. { "readOnlyHint": true }');
	}
	for (const [key, v] of Object.entries(value)) {
		if (!ANNOTATION_KEYS.includes(key)) {
			throw new Error(`unknown annotation "${key}". Allowed: ${ANNOTATION_KEYS.join(', ')}`);
		}
		if (typeof v !== 'boolean') {
			throw new Error(`annotation "${key}" must be true or false`);
		}
	}
	return value;
}

module.exports = { ANNOTATION_KEYS, parseAnnotations };
