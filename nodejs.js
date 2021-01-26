// Contains exports that should only be visible from Node.js but not browser.

const cirodown = require('cirodown');
const path = require('path');

const ENCODING = 'utf8';
exports.ENCODING = ENCODING;
const PACKAGE_NAME = 'cirodown';
exports.PACKAGE_NAME = PACKAGE_NAME;
// https://stackoverflow.com/questions/10111163/in-node-js-how-can-i-get-the-path-of-a-module-i-have-loaded-via-require-that-is
const PACKAGE_PATH = path.dirname(require.resolve(path.join(PACKAGE_NAME, 'package.json')));
exports.PACKAGE_PATH = PACKAGE_PATH;
const PACKAGE_OUT_PATH = path.join(PACKAGE_PATH, 'out');
exports.PACKAGE_OUT_PATH = PACKAGE_OUT_PATH;
const PACKAGE_OUT_CSS_BASENAME = PACKAGE_NAME + '.min.css';
exports.PACKAGE_OUT_CSS_BASENAME = PACKAGE_OUT_CSS_BASENAME;
const PACKAGE_OUT_CSS_PATH = path.join(PACKAGE_PATH, PACKAGE_OUT_CSS_BASENAME);
exports.PACKAGE_OUT_CSS_PATH = PACKAGE_OUT_CSS_PATH;
const PACKAGE_OUT_CSS_EMBED_PATH = path.join(PACKAGE_PATH, PACKAGE_NAME + '.embed.min.css');
exports.PACKAGE_OUT_CSS_EMBED_PATH = PACKAGE_OUT_CSS_EMBED_PATH;
const PACKAGE_OUT_CSS_LOCAL_PATH = path.join(PACKAGE_PATH, PACKAGE_NAME + '.local.min.css');
exports.PACKAGE_OUT_CSS_LOCAL_PATH = PACKAGE_OUT_CSS_LOCAL_PATH;
const PACKAGE_OUT_JS_BASENAME = PACKAGE_NAME + '.runtime.js';
exports.PACKAGE_OUT_JS_BASENAME = PACKAGE_OUT_JS_BASENAME;
const PACKAGE_OUT_JS_LOCAL_PATH = path.join(PACKAGE_PATH, PACKAGE_OUT_JS_BASENAME);
exports.PACKAGE_OUT_JS_LOCAL_PATH = PACKAGE_OUT_JS_LOCAL_PATH;
const PACKAGE_NODE_MODULES_PATH = path.join(PACKAGE_PATH, 'node_modules');
exports.PACKAGE_NODE_MODULES_PATH = PACKAGE_NODE_MODULES_PATH;
const PACKAGE_PACKAGE_JSON_PATH = path.join(PACKAGE_PATH, 'package.json');
exports.PACKAGE_PACKAGE_JSON_PATH = PACKAGE_PACKAGE_JSON_PATH;
const GITIGNORE_PATH = path.join(PACKAGE_PATH, 'gitignore');
exports.GITIGNORE_PATH = GITIGNORE_PATH;
const PACKAGE_SASS_BASENAME = PACKAGE_NAME + '.scss';
exports.PACKAGE_SASS_BASENAME = PACKAGE_SASS_BASENAME;
const CSS_LOCAL_INCLUDES = [
  require.resolve(path.join('katex', 'dist', 'katex.min.css')),
  require.resolve(path.join('normalize.css', 'normalize.css')),
]
exports.CSS_LOCAL_INCLUDES = CSS_LOCAL_INCLUDES;
const JS_LOCAL_INCLUDES = [
  require.resolve(path.join('tablesort', 'src', 'tablesort.js')),
  require.resolve(path.join('tablesort', 'src', 'sorts', 'tablesort.date.js')),
  require.resolve(path.join('tablesort', 'src', 'sorts', 'tablesort.dotsep.js')),
  require.resolve(path.join('tablesort', 'src', 'sorts', 'tablesort.filesize.js')),
  require.resolve(path.join('tablesort', 'src', 'sorts', 'tablesort.monthname.js')),
  require.resolve(path.join('tablesort', 'src', 'sorts', 'tablesort.number.js')),
]
exports.JS_LOCAL_INCLUDES = JS_LOCAL_INCLUDES;

class ZeroFileProvider extends cirodown.FileProvider {
  get(path) { return {toplevel_scope_cut_length: 0}; }
}
exports.ZeroFileProvider = ZeroFileProvider;
