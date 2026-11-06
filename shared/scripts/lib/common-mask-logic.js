/**
 * common-mask-logic.js: masking of common data (spec decision 6). In public mode download-app.js saves every non-empty
 * string and every number of the app common and the connection common as a marker, so a real value never reaches this
 * computer; update-app.js refuses a common file that still holds a marker, in both modes. Pure functions only.
 */
const MARKER_STRING = '***MASKED:string***';
const MARKER_NUMBER = '***MASKED:number***';
const MARKER_DESCRIPTION = '***MASKED:<type>***';
const MARKER_SOURCE = '\\*\\*\\*MASKED:(?:string|number)\\*\\*\\*';
/** The Make UI place where common data is edited, as the live check of spec 4 found it. */
const COMMON_UI_PLACE = "the Common data section on the app's Base page or on the connection's Communication page";

function isCommonFile(relPath) {
	const p = String(relPath).replace(/\\/g, '/');
	return p === 'common.imljson' || /^connections\/[^/]+\/common\.imljson$/.test(p);
}

/** True for every path that update-app.js sends to a common route: `common` and `connection/{name}/common`. */
function isCommonComponentPath(componentPath) {
	const [type, , section] = String(componentPath).split('/');
	return type === 'common' || (type === 'connection' && section === 'common');
}

/** One part of a component path: letters, digits, _ and -, so that no empty part, . or .. reaches a URL. */
const PATH_PART = /^[A-Za-z0-9_-]+$/;

/** The stop line of update-app.js for a component path with a part outside PATH_PART, or null for a usable path. */
function componentPathError(componentPath) {
	if (String(componentPath).split('/').every((part) => PATH_PART.test(part))) return null;
	return `ERROR: the component path "${componentPath}" may hold only letters, digits, _ and - between its slashes, and no empty part.`;
}

/** The stop line of update-component.js and delete-component.js for a type or name outside PATH_PART, or null. */
function componentNameError(type, name) {
	for (const [part, value] of [['type', type], ['name', name]]) {
		if (!PATH_PART.test(String(value))) return `ERROR: the component ${part} "${value}" may hold only letters, digits, _ and -.`;
	}
	return null;
}

function commonFileOf(componentPath) {
	const [type, name] = String(componentPath).split('/');
	return type === 'common' ? 'common.imljson' : `connections/${name}/common.imljson`;
}

function childPath(parent, key) {
	if (typeof key === 'number') return `${parent}[${key}]`;
	return parent ? `${parent}.${key}` : key;
}

function setOwn(target, key, value) {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function maskValue(value, at, paths) {
	if (typeof value === 'string') {
		if (value === '') return value;
		paths.push(at);
		return MARKER_STRING;
	}
	if (typeof value === 'number') {
		paths.push(at);
		return MARKER_NUMBER;
	}
	if (Array.isArray(value)) return value.map((item, i) => maskValue(item, childPath(at, i), paths));
	if (value !== null && typeof value === 'object') {
		const out = {};
		for (const key of Object.keys(value)) setOwn(out, key, maskValue(value[key], childPath(at, key), paths));
		return out;
	}
	return value;
}

function parseCommon(text) {
	try {
		return { value: JSON.parse(String(text).replace(/^\uFEFF/, '')) };
	} catch {
		return { error: 'not valid JSON' };
	}
}

function maskCommon(text) {
	const parsed = parseCommon(text);
	if (parsed.error) return { error: parsed.error };
	const { value } = parsed;
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: 'not a JSON object' };
	const paths = [];
	const masked = maskValue(value, '', paths);
	return { text: `${JSON.stringify(masked, null, '\t')}\n`, count: paths.length, paths };
}

function hasMarker(text) {
	return new RegExp(MARKER_SOURCE).test(String(text));
}

function markerCount(text) {
	return (String(text).match(new RegExp(MARKER_SOURCE, 'g')) || []).length;
}

function markerPaths(text) {
	const parsed = parseCommon(text);
	if (parsed.error) return [];
	const paths = [];
	const walk = (value, at) => {
		if (typeof value === 'string') {
			if (hasMarker(value)) paths.push(at);
		} else if (Array.isArray(value)) {
			value.forEach((item, i) => walk(item, childPath(at, i)));
		} else if (value !== null && typeof value === 'object') {
			for (const key of Object.keys(value)) walk(value[key], childPath(at, key));
		}
	};
	walk(parsed.value, '');
	return paths;
}

/** The refusal block of spec 3.2; `place` is a test seam for COMMON_UI_PLACE. */
function refusalMessage({ file, slug, version, count, paths, place = COMMON_UI_PLACE }) {
	const list = paths && paths.length ? ` (${paths.join(', ')})` : '';
	const uiPlace = place ? ` (${place})` : '';
	return [
		`Refused: ${file} of ${slug} v${version} still holds ${count} masked value${count === 1 ? '' : 's'}${list}.`,
		'In public mode download-app.js masks every string and number in common data, so a real value never reaches this computer.',
		'Pushing the file would replace the real values in Make with the marker text, and Make keeps no history of common data.',
		`Nothing was sent. To change common data, edit it in the Make UI${uiPlace}. Do not paste secret values into the chat.`,
	].join('\n');
}

/**
 * The refusal for a file with a marker, in its text or in a value once the JSON is read (an escaped marker): the count
 * is the number of listed values, or the raw marker count when none can be listed.
 */
function commonRefusal(text, { componentPath, slug, version }) {
	const paths = markerPaths(text);
	if (!hasMarker(text) && paths.length === 0) return null;
	return refusalMessage({ file: commonFileOf(componentPath), slug, version, count: paths.length || markerCount(text), paths });
}

module.exports = { MARKER_STRING, MARKER_NUMBER, MARKER_DESCRIPTION, COMMON_UI_PLACE, isCommonFile, isCommonComponentPath, componentPathError, componentNameError, commonFileOf, maskCommon, hasMarker, markerCount, markerPaths, refusalMessage, commonRefusal };
