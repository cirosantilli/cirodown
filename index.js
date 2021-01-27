"use strict";

const globals = {};

const katex = require('katex');
if (typeof performance === 'undefined') {
  // Fuck, I can't find how to make this browser/node portable more nicely.
  // https://github.com/nodejs/node/issues/28635
  // https://github.com/browserify/perf-hooks-browserify
  globals.performance = require('perf_hooks').performance;
} else {
  globals.performance = performance;
}
const lodash = require('lodash');
const path = require('path');
const pluralize = require('pluralize');

// consts used by classes.
const UNICODE_LINK = String.fromCodePoint(0x1F517);

class AstNode {
  /**
   * Abstract syntax tree node. This is the base node type that
   * represents the parsed output.
   *
   * @param {AstType} node_type -
   * @param {String} macro_name - - if node_type === AstType.PLAINTEXT or AstType.ERROR: fixed to
   *                                AstType.PLAINTEXT_MACRO_NAME
   *                              - elif node_type === AstType.PARAGRAPH: fixed to undefined
   *                              - else: arbitrary regular macro
   * @param {Object[String, AstArgument]} args - dict of arg names to arguments.
   *        where arguments are arrays of AstNode
   * @param {SourceLocation} source_location - the best representation of where the macro is starts in the document
   *                        used primarily to present useful debug messages
   * @param {Object} options
   *                 {String} text - the text content of an AstType.PLAINTEXT, undefined for other types
   */
  constructor(node_type, macro_name, args, source_location, options={}) {
    if (!('first_toplevel_child' in options)) {
      options.first_toplevel_child = false;
    }
    if (!('from_include' in options)) {
      options.from_include = false;
    }
    if (!('from_cirodown_example' in options)) {
      options.from_cirodown_example = false;
    }
    if (!('force_no_index' in options)) {
      options.force_no_index = false;
    }
    if (!(Macro.ID_ARGUMENT_NAME in options)) {
      options.id = undefined;
    }
    if (!('header_graph_node_parent_id' in options)) {
      options.header_graph_node_parent_id = undefined;
    }
    if (!('is_first_header_in_input_file' in options)) {
      options.is_first_header_in_input_file = false;
    }
    if (!('parent_node' in options)) {
      // AstNode. This is different from header_graph_node because
      // it points to the parent ast node, i.e. the ast_node that
      // contains this inside one of its arguments.
      //
      // header_graph_node on the other hand points to the header tree.
      // The header tree is currently not even connected via arguments.
      options.parent_node = undefined;
    }
    if (!('text' in options)) {
      options.text = undefined;
    }

    // Generic fields.
    this.node_type = node_type;
    this.macro_name = macro_name;

    // For elements that have an id.
    // {String} or undefined.
    // Includes scope. Ideally, we should remove that requirement to not duplicate.
    // the information. // But it will require a large hard refactor... lazy.
    this.id = options.id;

    // Current running scope. This is inherited from the scope of the ancestor headers.
    // An element with {scope} set does not get this option set (except if due to ancestors),
    // only its children do.
    this.scope = options.scope;

    // For elements that are of AstType.PLAINTEXT.
    this.text = options.text
    this.source_location = source_location;

    this.args = args;
    this.first_toplevel_child = options.first_toplevel_child;
    this.is_first_header_in_input_file = options.is_first_header_in_input_file;
    // This is the Nth macro of this type that appears in the document.
    this.macro_count = undefined;
    // This is the Nth macro of this type that is visible,
    // and therefore increments counts such as Figure 1), Figure 2), etc.
    // All indexed IDs (those that can be linked to) are also visible, but
    // it is possible to force non-indexed IDs to count as well with
    // caption_number_visible.
    this.macro_count_visible = undefined;
    this.parent_node = options.parent_node;
    // AstArgument
    this.parent_argument = undefined;
    // {HeaderTreeNode} that points to the element.
    // This is used for both headers and non headers:
    // the only difference is that non-headers are not connected as
    // children of their parent. But they still know who the parent is.
    // This was originally required for header scope resolution.
    this.header_graph_node = options.header_graph_node;
    // When fetching Nodes from the database, we only serialize the ID.
    // Then to get the actual parent node, further DB querries are done
    // as needed.
    this.header_graph_node_parent_id = options.header_graph_node_parent_id;
    this.validation_error = undefined;
    this.validation_output = {};

    // The ID of this element has been indexed.
    this.index_id = undefined;
    this.force_no_index = options.force_no_index;
    // The ToC will go before this header.
    this.toc_header = false;

    // This was added to the tree from an include.
    this.from_include = options.from_include;
    // This was added to the tree from a cirodown_example.
    this.from_cirodown_example = options.from_cirodown_example;

    // Includes under this header.
    this.includes = [];

    for (const argname in args) {
      for (const arg of args[argname]) {
        this.setup_argument(argname, arg);
      }
    }
  }

  /**
   * @param {Object} context
   *        If a call will change this object, it must first make a copy,
   *        otherwise future calls to non descendants would also be affected by the change.
   *
   *        - {Object} options - global options passed in from toplevel. Never modified by calls
   *        - {bool} html_is_attr - are we inside an HTML attribute, which implies implies different
   *                 escape rules, e.g. " and ' must be escaped.
   *        - {bool} html_escape - if false, disable HTML escaping entirely. This is needed for
   *                 content that is passed for an external tool for processing, for example
   *                 Math equations to KaTeX, In that case, the arguments need to be passed as is,
   *                 otherwise e.g. `1 < 2` would escape the `<` to `&lt;` and KaTeX would receive bad input.
   *        - {HeaderTreeNode} header_graph - HeaderTreeNode graph containing AstNode headers
   *        - {Object} ids - map of document IDs to their description:
   *                 - 'prefix': prefix to add for a  full reference, e.g. `Figure 1`, `Section 2`, etc.
   *                 - {AstArgument} 'title': the title of the element linked to
   *        - {bool} in_caption_number_visible
   *        - {Set[AstNode]} x_parents: set of all parent x elements.
   * @param {Object} context
   * @return {String}
   */
  convert(context) {
    if (context === undefined) {
      context = {};
    }
    if (!('errors' in context)) {
      context.errors = [];
    }
    if (!('html_escape' in context)) {
      context.html_escape = true;
    }
    if (!('html_is_attr' in context)) {
      context.html_is_attr = false;
    }
    if (!('id_provider' in context)) {
      context.id_provider = {};
    }
    if (!('id_conversion' in context)) {
      context.id_conversion = false;
    }
    if (!('katex_macros' in context)) {
      context.katex_macros = {};
    }
    if (!('macros' in context)) {
      throw new Error('context does not have a mandatory .macros property');
    }
    if (!('x_parents' in context)) {
      context.x_parents = new Set();
    }
    if (
      this.from_include &&
      context.in_split_headers &&
      !this.from_cirodown_example
    ) {
      return '';
    }
    const macro = context.macros[this.macro_name];
    let out;
    if (this.validation_error === undefined) {
      let output_format;
      if (context.id_conversion) {
        output_format = OUTPUT_FORMAT_ID;
      } else {
        output_format = context.options.output_format;
      }
      const convert_function = macro.convert_funcs[output_format];
      if (convert_function === undefined) {
        const message = `output format ${context.options.output_format} not defined for macro ${this.macro_name}`;
        render_error(context, message, this.source_location);
        out = error_message_in_output(message, context);
      } else {
        out = convert_function(this, context);
      }
    } else {
      render_error(context, this.validation_error[0], this.validation_error[1], this.validation_error[2]);
      out = error_message_in_output(this.validation_error[0], context);
    }

    // Add a div to all direct children of toplevel to implement
    // the on hover links to self and left margin.
    {
      const parent_node = this.parent_node;
      if (
        parent_node !== undefined &&
        parent_node.macro_name === Macro.TOPLEVEL_MACRO_NAME &&
        this.id !== undefined &&
        macro.toplevel_link
      ) {
        out = TOPLEVEL_CHILD_MODIFIER[context.options.output_format](this, context, out);
      }
    }

    return out;
  }

  /** Works with both actual this.header_graph_node and
   * this.header_graph_node_parent_id when coming from a database. */
  get_header_parent_id() {
    if (
      this.header_graph_node !== undefined &&
      this.header_graph_node.parent_node !== undefined &&
      this.header_graph_node.parent_node.value !== undefined
    ) {
      return this.header_graph_node.parent_node.value.id;
    } else {
      return this.header_graph_node_parent_id;
    }
  }

  /* Like get_header_parent_id, but returns the parent AST. */
  get_header_parent(context) {
    const header_parent_id = this.get_header_parent_id();
    if (header_parent_id === undefined) {
      return undefined;
    } else {
      return context.id_provider.get(header_parent_id, context);
    }
  }

  setup_argument(argname, arg) {
    arg.parent_node = this;
    arg.argument_name = argname;
  }

  /** Manual implementation. There must be a better way, but I can't find it... */
  static fromJSON(json_string) {
    let json = JSON.parse(json_string);
    let toplevel_ast = new AstNode(
      AstType[json.node_type],
      json.macro_name,
      json.args,
      json.source_location,
      {
        text: json.text,
        first_toplevel_child: json.first_toplevel_child,
        is_first_header_in_input_file: json.is_first_header_in_input_file,
        header_graph_node_parent_id: json.header_graph_node_parent_id,
        scope: json.scope,
      }
    );
    let nodes = [toplevel_ast];
    while (nodes.length !== 0) {
      let cur_ast = nodes.pop();
      for (let arg_name in cur_ast.args) {
        let arg = cur_ast.args[arg_name];
        let new_arg = [];
        for (let ast of arg) {
          let new_ast = new AstNode(
            AstType[ast.node_type],
            ast.macro_name,
            ast.args,
            ast.source_location,
            {
              text: ast.text,
              first_toplevel_child: ast.first_toplevel_child,
              is_first_header_in_input_file: ast.is_first_header_in_input_file,
            }
          );
          new_arg.push(new_ast);
          nodes.push(new_ast);
        }
        arg.splice(0, new_arg.length, ...new_arg);
      }
    }
    return toplevel_ast;
  }

  toJSON() {
    const ret = {
      macro_name: this.macro_name,
      node_type:  symbol_to_string(this.node_type),
      scope:      this.scope,
      source_location: this.source_location,
      text:       this.text,
      args:       this.args,
      first_toplevel_child: this.first_toplevel_child,
      is_first_header_in_input_file: this.is_first_header_in_input_file,
    }
    if (
      this.header_graph_node !== undefined &&
      this.header_graph_node.parent_node !== undefined &&
      this.header_graph_node.parent_node.value !== undefined
    ) {
      ret.header_graph_node_parent_id = this.header_graph_node.parent_node.value.id;
    }
    return ret;
  }
}
exports.AstNode = AstNode;

class AstArgument extends Array {
  /** @param {List[AstNode]} nodes
   *  @ param {SourceLocation} source_location
   */
  constructor(nodes, source_location) {
    super(...nodes)
    this.source_location = source_location;
    // AstNode
    this.parent_node = undefined;
    // String
    this.argument_name = undefined;
    let i = 0;
    nodes.forEach(function(node) {
      node.parent_argument = this;
      node.parent_argument_index = i;
      i++;
    });
  }

  // https://stackoverflow.com/questions/3261587/subclassing-javascript-arrays-typeerror-array-prototype-tostring-is-not-generi/61269027#61269027
  static get [Symbol.species]() {
    return Object.assign(function (...items) {
      return new AstArgument(new Array(...items))
    }, AstArgument);
  }

  push(...new_nodes) {
    const old_length = this.length;
    const ret = super.push(...new_nodes);
    let i = 0;
    new_nodes.forEach(node => {
      node.parent_argument = this;
      node.parent_argument_index = old_length + i;
      i++;
    });
    return ret;
  }
}

class ErrorMessage {
  constructor(message, source_location) {
    this.message = message;
    this.source_location = source_location;
  }

  toString(path) {
    let ret = 'error: ';
    let had_line_or_col = false;
    if (this.source_location.path !== undefined) {
      ret += `${this.source_location.path}:`;
    }
    if (this.source_location.line !== undefined) {
      ret += `${this.source_location.line}`;
      had_line_or_col = true;
    }
    if (this.source_location.column !== undefined) {
      if (this.source_location.line !== undefined) {
        ret += `:`;
      }
      ret += `${this.source_location.column}`;
      had_line_or_col = true;
    }
    if (had_line_or_col)
      ret += ': ';
    ret += this.message;
    return ret
  }
}

class FileProvider {
  /* Get entry by path.
   * @return Object
   *        - path {String}: source path
   *        - toplevel_id {String}
   */
  get(path) {
    let get_ret = this.get_path_entry(path);
    if (get_ret === undefined) {
      return undefined;
    } else {
      return get_ret;
    }
  }

  get_path_entry(path) { throw new Error('unimplemented'); }

  /* Get entry by ID. */
  get_id(id) { throw new Error('unimplemented'); }
}
exports.FileProvider = FileProvider;

/** Interface to retrieving the nodes of IDs defined in external files.
 *
 * We need the abstraction because IDs will come from widely different locations
 * between browser and local Node.js operation:
 *
 * - browser: HTTP requests
 * - local: sqlite database
 */
class IdProvider {
  /**
   * @return remove all IDs from this ID provider for the given path.
   *         For example, on a local ID database cache, this would clear
   *         all IDs from the cache.
   */
  clear(input_path_noext_renamed) { throw 'unimplemented'; }

  /**
   * @param {String} id
   * @param {HeaderTreeNode} header_graph_node
   * @return {Union[AstNode,undefined]}.
   *         undefined: ID not found
   *         Otherwise, the ast node for the given ID
   */
  get(id, context, header_graph_node) {
    if (id[0] === Macro.HEADER_SCOPE_SEPARATOR) {
      return this.get_noscope(id.substr(1), context);
    } else {
      if (
        header_graph_node !== undefined &&
        header_graph_node.parent_node !== undefined &&
        header_graph_node.parent_node.value !== undefined
      ) {
        let parent_scope_id = calculate_scope(header_graph_node.parent_node.value, context);
        if (parent_scope_id !== undefined) {
          let resolved_scope_id = this.get_noscope(
            parent_scope_id + Macro.HEADER_SCOPE_SEPARATOR + id, context);
          if (resolved_scope_id !== undefined) {
            return resolved_scope_id;
          }
          for (let i = parent_scope_id.length - 1; i > 0; i--) {
            if (parent_scope_id[i] === Macro.HEADER_SCOPE_SEPARATOR) {
              let resolved_scope_id = this.get_noscope(
                parent_scope_id.substring(0, i + 1) + id, context);
              if (resolved_scope_id !== undefined) {
                return resolved_scope_id;
              }
            }
          }
        }
      }
      // Not found with ID resolution, so just try to get the exact ID.
      return this.get_noscope(id, context);
    }
  }

  /** Like get, but do not resolve scope. */
  get_noscope(id, context) {
    let get_ret = this.get_noscope_entry(id);
    if (get_ret === undefined) {
      return undefined;
    } else {
      const ast = AstNode.fromJSON(get_ret.ast_json);
      ast.input_path = get_ret.path;
      ast.id = id;
      if (context !== undefined) {
        validate_ast(ast, context);
      }
      return ast;
    }
  }

  get_noscope_entry(id) { throw new Error('unimplemented'); }

  /**
   * @param {String} id
   * @return {Array[AstNode]}: all header nodes that have the given ID
   *                           as a parent includer.
   */
  get_includes(to_id, context) {
    let all_rets = this.get_includes_entries(to_id);
    let ret = [];
    for (const all_ret of all_rets) {
      const from_ast = this.get(all_ret.from_id, context);
      if (from_ast === undefined) {
        throw 'parent ID of include not in database, not sure how this can happen so throwing';
      } else {
        ret.push(from_ast);
      }
    }
    return ret;
  }

  get_includes_entries(to_id) { throw new Error('unimplemented'); }
}
exports.IdProvider = IdProvider;

/** IdProvider that first tries id_provider_1 and then id_provider_2.
 *
 * The initial use case for this is to transparently use either IDs defined
 * in the current document, or IDs defined externally.
 */
class ChainedIdProvider extends IdProvider {
  constructor(id_provider_1, id_provider_2) {
    super();
    this.id_provider_1 = id_provider_1;
    this.id_provider_2 = id_provider_2;
  }
  get_noscope(id, context) {
    let ret;
    ret = this.id_provider_1.get_noscope(id, context);
    if (ret !== undefined) {
      return ret;
    }
    ret = this.id_provider_2.get_noscope(id, context);
    if (ret !== undefined) {
      return ret;
    }
    return undefined;
  }
  get_includes(id, context) {
    return this.id_provider_1.get_includes(id, context).concat(
      this.id_provider_2.get_includes(id, context));
  }
}

/** ID provider from a dict.
 * The initial use case is to represent locally defined IDs, and inject
 * them into ChainedIdProvider together with externally defined IDs.
 */
class DictIdProvider extends IdProvider {
  constructor(dict) {
    super();
    this.dict = dict;
  }
  get_noscope(id, context) {
    if (id in this.dict) {
      return this.dict[id];
    }
    return undefined;
  }
  get_includes(id, context) {
    return [];
  }
}

class MacroArgument {
  /**
   * @param {String} name
   */
  constructor(options) {
    if (!('elide_link_only' in options)) {
      // If the only thing contained in this argument is a single
      // Macro.LINK_MACRO_NAME macro, AST post processing instead extracts
      // the href of that macro, and transforms it into a text node with that href.
      //
      // Goal: to allow the use to write both \a[http://example.com] and
      // \p[http://example.com] and get what a sane person expects, see also:
      // https://cirosantilli.com/cirodown#insane-link-parsing-rules
      options.elide_link_only = false;
    }
    if (!('boolean' in options)) {
      // https://cirosantilli.com/cirodown#boolean-named-arguments
      options.boolean = false;
    }
    if (!('default' in options)) {
      // https://cirosantilli.com/cirodown#boolean-named-arguments
      options.default = undefined;
    }
    if (!('mandatory' in options)) {
      // https://cirosantilli.com/cirodown#mandatory-positional-arguments
      options.mandatory = false;
    }
    if (!('positive_nonzero_integer' in options)) {
      options.positive_nonzero_integer = false;
    }
    if (!('remove_whitespace_children' in options)) {
      // https://cirosantilli.com/cirodown#remove_whitespace_children
      options.remove_whitespace_children = false;
    }
    this.boolean = options.boolean;
    this.default = options.default;
    this.elide_link_only = options.elide_link_only;
    this.mandatory = options.mandatory;
    this.name = options.name;
    this.positive_nonzero_integer = options.positive_nonzero_integer;
    this.remove_whitespace_children = options.remove_whitespace_children;
  }
}

class Macro {
  /**
   * Encapsulates properties of macros, including how to convert
   * them to various output formats.
   *
   * @param {String} name
   * @param {Array[MacroArgument]} args
   * @param {Function} convert
   * @param {Object} options
   *        {boolean} phrasing - is this phrasing content?
   *                  (HTML5 elements that can go in paragraphs). This matters to:
   *                  - determine where `\n\n` paragraphs will split
   *                  - phrasing content does not get IDs
   *        {String} auto_parent - automatically surround consecutive sequences of macros with
   *                 the same parent auto_parent into a node with auto_parent type. E.g.,
   *                 to group list items into ul.
   *        {Set[String]} auto_parent_skip - don't do auto parent generation if the parent is one of these types.
   *        {Function[AstNode, Object] -> String} get_number - return the number that shows on on full references
   *                 as a string, e.g. "123" in "Figure 123." or "1.2.3" in "Section 1.2.3.".
   *                 A return of undefined means that the number is not available, e.g. this is current limitation
   *                 of cross references to other files (could be implemented).
   *        {Function[AstNode, Object] -> Bool} macro_counts_ignore - if true, then an ID should not be automatically given
   *                 to this node. This is usually the case for nodes that are not visible in the final output,
   *                 otherwise that would confuse readers.
   */
  constructor(name, positional_args, html_convert_func, options={}) {
    if (!('auto_parent' in options)) {
      // https://cirosantilli.com/cirodown#auto_parent
      options.auto_parent = undefined;
    }
    if (!('auto_parent_skip' in options)) {
      options.auto_parent_skip = new Set([]);
    }
    if (!('caption_number_visible' in options)) {
      options.caption_number_visible = function(ast) { return false; }
    }
    if (!('caption_prefix' in options)) {
      options.caption_prefix = capitalize_first_letter(name);
    }
    if (!('default_x_style_full' in options)) {
      options.default_x_style_full = true;
    }
    if (!('get_number' in options)) {
      options.get_number = function(ast, context) { return ast.macro_count_visible; }
    }
    if (!('get_title_arg' in options)) {
      options.get_title_arg = function(ast, context) {
        return ast.args[Macro.TITLE_ARGUMENT_NAME];
      }
    }
    if (!('id_prefix' in options)) {
      options.id_prefix = title_to_id(name);
    }
    if (!('image_video_content_func' in options)) {
      options.image_video_content_func = function() { throw new Error('unimplemented'); };
    }
    if (!('macro_counts_ignore' in options)) {
      // Applications:
      // * if an AST node with an ID but no-rendered HTML ID, this breaks editor scroll sync
      //   Returning true makes it not have an ID at all.
      options.macro_counts_ignore = function(ast) {
        return false;
      }
    }
    if (!('named_args' in options)) {
      options.named_args = [];
    }
    if (!('phrasing' in options)) {
      options.phrasing = false;
    }
    if (!('show_disambiguate' in options)) {
      options.show_disambiguate = false;
    }
    if (!('source_func' in options)) {
      options.source_func = function() { throw new Error('unimplemented'); };
    }
    if (!('toplevel_link' in options)) {
      options.toplevel_link = true;
    }
    if (!('xss_safe' in options)) {
      options.xss_safe = true;
    }
    this.name = name;
    this.positional_args = positional_args;
    {
      let named_args = {};
      for (const arg of options.named_args) {
        named_args[arg.name] = arg;
      }
      this.named_args = named_args;
    }
    this.auto_parent = options.auto_parent;
    this.auto_parent_skip = options.auto_parent_skip;
    this.convert_funcs = {
      html: html_convert_func
    }
    this.id_prefix = options.id_prefix;
    this.options = options;
    this.remove_whitespace_children = options.remove_whitespace_children;
    this.toplevel_link = options.toplevel_link;
    this.name_to_arg = {};
    for (const arg of this.positional_args) {
      let name = arg.name;
      this.check_name(name);
      this.name_to_arg[name] = arg;
    }
    for (const name in this.named_args) {
      this.check_name(name);
      this.name_to_arg[name] = this.named_args[name];
    }
    // Add arguments common to all macros.
    for (const argname of Macro.COMMON_ARGNAMES) {
      this.named_args[argname] = new MacroArgument({
        name: argname,
      })
      this.name_to_arg[argname] = this.named_args[argname];
    }
    delete this.options.named_args;
  }

  add_convert_function(output_format, my_function) {
    this.convert_funcs[output_format] = my_function;
  }

  check_name(name) {
    if (Macro.COMMON_ARGNAMES.has(name)) {
      throw new Error(`name "${name}" is reserved and automatically added`);
    }
    if (name in this.name_to_arg) {
      throw new Error('name already taken: ' + name);
    }
  }

  toJSON() {
    const options = this.options;
    const ordered_options = {};
    Object.keys(options).sort().forEach(function(key) {
      ordered_options[key] = options[key];
    });
    return {
      name: this.name,
      options: ordered_options,
      positional_args: this.positional_args,
      named_args: this.named_args,
    }
  }
}

// Macro names defined here are those that have magic properties, e.g.
// headers are used by the 'toc'.
Macro.CIRODOWN_EXAMPLE_MACRO_NAME = 'CirodownExample';
Macro.CODE_MACRO_NAME = 'c';
// Add arguments common to all macros.
Macro.DISAMBIGUATE_ARGUMENT_NAME = 'disambiguate';
Macro.ID_ARGUMENT_NAME = 'id';
Macro.COMMON_ARGNAMES = new Set([
  Macro.DISAMBIGUATE_ARGUMENT_NAME,
  Macro.ID_ARGUMENT_NAME,
]);
Macro.HEADER_MACRO_NAME = 'H';
Macro.HEADER_SCOPE_SEPARATOR = '/';
Macro.INCLUDE_MACRO_NAME = 'Include';
Macro.LINK_MACRO_NAME = 'a';
Macro.LIST_MACRO_NAME = 'L';
Macro.MATH_MACRO_NAME = 'm';
Macro.PARAGRAPH_MACRO_NAME = 'P';
Macro.PLAINTEXT_MACRO_NAME = 'plaintext';
Macro.TABLE_MACRO_NAME = 'Table';
Macro.TD_MACRO_NAME = 'Td';
Macro.TH_MACRO_NAME = 'Th';
Macro.TR_MACRO_NAME = 'Tr';
Macro.TITLE_ARGUMENT_NAME = 'title';
Macro.TITLE2_ARGUMENT_NAME = 'title2';
Macro.TOC_MACRO_NAME = 'Toc';
// We set a fixed magic ID to the ToC because:
// - when doing --split-headers, the easy approach is to add the ToC node
//   after normal ID indexing has happened, which means that we can't link
//   to the ToC as other normal links. And if we could, we would have to worry
//   about how to avoid ID duplication
// - only a single ToC ever renders per document. So we can just have a fixed
//   magic one.
Macro.TOC_ID = 'toc';
Macro.RESERVED_IDS = new Set([
  Macro.TOC_ID,
]);
Macro.TOC_PREFIX = Macro.TOC_ID + '-'
Macro.TOPLEVEL_MACRO_NAME = 'Toplevel';

/** Helper to create plaintext nodes, since so many of the fields are fixed in that case. */
class PlaintextAstNode extends AstNode {
  constructor(source_location, text) {
    super(AstType.PLAINTEXT, Macro.PLAINTEXT_MACRO_NAME,
      {}, source_location, {text: text});
  }
}

class SourceLocation {
  constructor(line, column, path) {
    this.line = line;
    this.column = column;
    this.path = path;
  }
  clone() {
    // https://stackoverflow.com/questions/41474986/how-to-clone-a-javascript-es6-class-instance
    return lodash.clone(this);
  }
  isEqual(other) {
    return lodash.isEqual(this, other);
  }
}
exports.SourceLocation = SourceLocation;

class Token {
  /**
   * @param {String} type
   * @param {SourceLocation} source_location
   * @param {String} value - Default: undefined
   */
  constructor(type, source_location, value) {
    this.type = type;
    this.source_location = source_location;
    this.value = value;
  }

  toJSON() {
    return {
      type:   this.type.toString(),
      source_location: this.source_location,
      value:  this.value
    }
  }
}

class Tokenizer {
  /**
   * @param {String} input_string
   */
  constructor(
    input_string,
    extra_returns={},
    show_tokenize=false,
    start_line=1,
    input_path=undefined
  ) {
    this.chars = Array.from(input_string);
    this.cur_c = this.chars[0];
    this.source_location = new SourceLocation(start_line, 1, input_path);
    this.extra_returns = extra_returns;
    this.extra_returns.errors = [];
    this.i = 0;
    this.in_insane_header = false;
    this.list_level = 0;
    this.tokens = [];
    this.show_tokenize = show_tokenize;
    this.log_debug('Tokenizer');
    this.log_debug(`this.chars ${this.chars}`);
    this.log_debug(`this.chars.length ${this.chars.length}`);
    this.log_debug('');
  }

  /** Advance the current character and set cur_c to the next one.
   *
   * Maintain the newline count up to date for debug messages.
   *
   * The current index must only be incremented through this function
   * and never directly.
   *
   * @param {Number} how many to consume
   * @return {boolean} true iff we are not reading past the end of the input
   */
  consume(n=1) {
    for (let done = 0; done < n; done++) {
      this.log_debug('consume');
      this.log_debug('this.i: ' + this.i);
      this.log_debug('this.cur_c: ' + this.cur_c);
      this.log_debug();
      if (this.chars[this.i] === '\n') {
        this.source_location.line += 1;
        this.source_location.column = 1;
      } else {
        this.source_location.column += 1;
      }
      this.i += 1;
      if (this.i >= this.chars.length) {
        this.cur_c = undefined;
        return false;
      }
      this.cur_c = this.chars[this.i];
    }
    return true;
  }

  consume_list_indent() {
    if (this.i > 0 && this.chars[this.i - 1] === '\n') {
      let new_list_level = 0;
      while (
        array_contains_array_at(this.chars, this.i, INSANE_LIST_INDENT) &&
        new_list_level < this.list_level
      ) {
        for (const c in INSANE_LIST_INDENT) {
          this.consume();
        }
        new_list_level += 1;
      }
      for (let i = 0; i < this.list_level - new_list_level; i++) {
        this.push_token(TokenType.POSITIONAL_ARGUMENT_END);
      }
      this.list_level = new_list_level;
    }
  }

  consume_plaintext_char() {
    return this.plaintext_append_or_create(this.cur_c);
  }

  /**
   * @return {boolean} EOF reached?
   */
  consume_optional_newline(literal) {
    this.log_debug('consume_optional_newline');
    this.log_debug();
    if (
      !this.is_end() &&
      this.cur_c === '\n' &&
      (
        literal ||
        // Insane constructs that start with a newline prevent the skip.
        (
          // Pararaph.
          this.peek() !== '\n' &&
          // Insane start.
          this.tokenize_insane_start(this.i + 1) === undefined
        )
      )
    ) {
    this.log_debug();
      return this.consume();
    }
    return true;
  }

  consume_optional_newline_after_argument() {
    if (
      !this.is_end() &&
      this.cur_c === '\n' &&
      !this.in_insane_header
    ) {
      const full_indent = INSANE_LIST_INDENT.repeat(this.list_level);
      if (
        array_contains_array_at(this.chars, this.i + 1, full_indent + START_POSITIONAL_ARGUMENT_CHAR) ||
        array_contains_array_at(this.chars, this.i + 1, full_indent + START_NAMED_ARGUMENT_CHAR)
      ) {
        this.consume(full_indent.length + 1);
      }
    }
  }

  error(message, source_location) {
    let new_source_location;
    if (source_location === undefined) {
      new_source_location = new SourceLocation();
    } else {
      new_source_location = source_location.clone();
    }
    if (new_source_location.path === undefined)
      new_source_location.path = this.source_location.path;
    if (new_source_location.line === undefined)
      new_source_location.line = this.source_location.line;
    if (new_source_location.column === undefined)
      new_source_location.column = this.source_location.column;
    this.extra_returns.errors.push(
      new ErrorMessage(message, new_source_location));
  }

  is_end() {
    return this.i === this.chars.length;
  }

  log_debug(message='') {
    if (this.show_tokenize) {
      console.error('tokenize: ' + message);
    }
  }

  peek() {
    return this.chars[this.i + 1];
  }

  plaintext_append_or_create(s) {
    let new_plaintext = true;
    if (this.tokens.length > 0) {
      let last_token = this.tokens[this.tokens.length - 1];
      if (last_token.type === TokenType.PLAINTEXT) {
        last_token.value += s;
        new_plaintext = false;
      }
    }
    if (new_plaintext) {
      this.push_token(TokenType.PLAINTEXT, s);
    }
    return this.consume();
  }

  push_token(token, value, source_location) {
    this.log_debug('push_token');
    this.log_debug('token: ' + token.toString());
    this.log_debug('value: ' + value);
    this.log_debug();
    let new_source_location;
    if (source_location === undefined) {
      new_source_location = new SourceLocation();
    } else {
      new_source_location = source_location.clone();
    }
    if (new_source_location.line === undefined)
      new_source_location.line = this.source_location.line;
    if (new_source_location.column === undefined)
      new_source_location.column = this.source_location.column;
    if (new_source_location.path === undefined)
      new_source_location.path = this.source_location.path;
    this.tokens.push(new Token(token, new_source_location, value));
  }

  /**
   * @return {Array[Token]}
   */
  tokenize() {
    // Ignore the last newline of the file.
    // It is good practice to always have a newline
    // at the end of files, but it doesn't really mean
    // that the user wants the last element to contain one.
    if (this.chars[this.chars.length - 1] === '\n') {
      this.chars.pop();
    }
    let unterminated_literal = false;
    let start_source_location;
    while (!this.is_end()) {
      this.log_debug('tokenize loop');
      this.log_debug('this.i: ' + this.i);
      this.log_debug('this.source_location: ' + this.source_location);
      this.log_debug('this.cur_c: ' + this.cur_c);
      if (this.in_insane_header && this.cur_c === '\n') {
        this.in_insane_header = false;
        this.push_token(TokenType.POSITIONAL_ARGUMENT_END);
        this.consume_optional_newline_after_argument()
      }
      this.consume_list_indent();
      start_source_location = this.source_location.clone();
      if (this.cur_c === ESCAPE_CHAR) {
        this.consume();
        if (this.is_end()) {
          // Maybe this should be an error.
        } else if (ESCAPABLE_CHARS.has(this.cur_c)) {
          this.consume_plaintext_char();
        } else {
          let macro_name = this.tokenize_func(char_is_identifier);
          this.consume_optional_newline();
          this.push_token(
            TokenType.MACRO_NAME,
            macro_name,
            start_source_location,
          );
        }
      } else if (this.cur_c === START_NAMED_ARGUMENT_CHAR) {
        let source_location = this.source_location.clone();
        // Tokenize past the last open char.
        let open_length = this.tokenize_func(
          (c)=>{return c === START_NAMED_ARGUMENT_CHAR}
        ).length;
        this.push_token(TokenType.NAMED_ARGUMENT_START,
          START_NAMED_ARGUMENT_CHAR.repeat(open_length), source_location);
        source_location = this.source_location.clone();
        let arg_name = this.tokenize_func(char_is_identifier);
        this.push_token(TokenType.NAMED_ARGUMENT_NAME, arg_name, source_location);
        if (this.cur_c === NAMED_ARGUMENT_EQUAL_CHAR) {
          // Consume the = sign.
          this.consume();
        } else if (this.cur_c === END_NAMED_ARGUMENT_CHAR) {
          // Boolean argument.
        } else {
          this.error(`expected character: '${NAMED_ARGUMENT_EQUAL_CHAR}' or '${END_NAMED_ARGUMENT_CHAR}', got '${this.cur_c}'`);
        }
        if (open_length === 1) {
          this.consume_optional_newline();
        } else {
          // Literal argument.
          let close_string = closing_char(
            START_NAMED_ARGUMENT_CHAR).repeat(open_length);
          if (!this.tokenize_literal(START_NAMED_ARGUMENT_CHAR, close_string)) {
            unterminated_literal = true;
          }
          this.push_token(TokenType.NAMED_ARGUMENT_END, close_string);
          this.consume_optional_newline_after_argument()
        }
      } else if (this.cur_c === END_NAMED_ARGUMENT_CHAR) {
        this.push_token(TokenType.NAMED_ARGUMENT_END, END_NAMED_ARGUMENT_CHAR);
        this.consume();
        this.consume_optional_newline_after_argument()
      } else if (this.cur_c === START_POSITIONAL_ARGUMENT_CHAR) {
        let source_location = this.source_location.clone();
        // Tokenize past the last open char.
        let open_length = this.tokenize_func(
          (c)=>{return c === START_POSITIONAL_ARGUMENT_CHAR}
        ).length;
        this.push_token(TokenType.POSITIONAL_ARGUMENT_START,
          START_POSITIONAL_ARGUMENT_CHAR.repeat(open_length), source_location);
        if (open_length === 1) {
          this.consume_optional_newline();
        } else {
          // Literal argument.
          let close_string = closing_char(
            START_POSITIONAL_ARGUMENT_CHAR).repeat(open_length);
          if (!this.tokenize_literal(START_POSITIONAL_ARGUMENT_CHAR, close_string)) {
            unterminated_literal = true;
          }
          this.push_token(TokenType.POSITIONAL_ARGUMENT_END);
          this.consume_optional_newline_after_argument()
        }
      } else if (this.cur_c === END_POSITIONAL_ARGUMENT_CHAR) {
        this.push_token(TokenType.POSITIONAL_ARGUMENT_END);
        this.consume();
        this.consume_optional_newline_after_argument();
      } else if (this.cur_c in MAGIC_CHAR_ARGS) {
        // Insane shortcuts e.g. $$ math and `` code.
        let open_char = this.cur_c;
        let open_length = this.tokenize_func(
          (c)=>{return c === open_char}
        ).length;
        let close_string = open_char.repeat(open_length);
        let macro_name = MAGIC_CHAR_ARGS[open_char];
        if (open_length > 1) {
          macro_name = macro_name.toUpperCase();
        }
        this.push_token(TokenType.MACRO_NAME, macro_name);
        this.push_token(TokenType.POSITIONAL_ARGUMENT_START);
        if (!this.tokenize_literal(open_char, close_string)) {
          unterminated_literal = true;
        }
        this.push_token(TokenType.POSITIONAL_ARGUMENT_END);
        this.consume_optional_newline_after_argument()
      } else if (this.cur_c === '\n' && this.peek() === '\n') {
        this.consume();
        this.consume();
        // We must close list level changes before the paragraph, e.g. in:
        //
        // ``
        // * aa
        // * bb
        //
        // cc
        // ``
        //
        // the paragraph goes after `ul`, it does not stick to `bb`
        this.consume_list_indent();
        this.push_token(TokenType.PARAGRAPH);
        if (this.cur_c === '\n') {
          this.error('paragraph with more than two newlines, use just two');
        }
      } else {
        let done = false;

        // Insane link.
        if (
          this.i === 0 ||
          this.chars[this.i - 1] === '\n' ||
          this.chars[this.i - 1] === ' ' ||
          this.tokens[this.tokens.length - 1].type === TokenType.POSITIONAL_ARGUMENT_START ||
          this.tokens[this.tokens.length - 1].type === TokenType.NAMED_ARGUMENT_NAME
        ) {
          let protocol_is_known = false;
          for (const known_url_protocol of KNOWN_URL_PROTOCOLS) {
            if (array_contains_array_at(this.chars, this.i, known_url_protocol)) {
              protocol_is_known = true;
              break;
            }
          }
          if (protocol_is_known) {
            this.push_token(TokenType.MACRO_NAME, Macro.LINK_MACRO_NAME);
            this.push_token(TokenType.POSITIONAL_ARGUMENT_START);
            let link_text = '';
            while (this.consume_plaintext_char()) {
              if (
                this.cur_c == ' ' ||
                this.cur_c == '\n' ||
                this.cur_c == START_POSITIONAL_ARGUMENT_CHAR ||
                this.cur_c == START_NAMED_ARGUMENT_CHAR ||
                this.cur_c == END_POSITIONAL_ARGUMENT_CHAR ||
                this.cur_c == END_NAMED_ARGUMENT_CHAR
              ) {
                break;
              }
              if (this.cur_c === ESCAPE_CHAR) {
                this.consume();
              }
            }
            this.push_token(TokenType.POSITIONAL_ARGUMENT_END);
            this.consume_optional_newline_after_argument();
            done = true;
          }
        }

        // Insane lists and tables.
        if (!done && (
          this.i === 0 ||
          this.cur_c === '\n' ||
          this.tokens[this.tokens.length - 1].type === TokenType.PARAGRAPH)
        ) {
          let i = this.i;
          if (this.cur_c === '\n') {
            i += 1;
          }
          let new_list_level = 0;
          while (array_contains_array_at(this.chars, i, INSANE_LIST_INDENT)) {
            i += INSANE_LIST_INDENT.length;
            new_list_level += 1;
          }
          let insane_start_return = this.tokenize_insane_start(i);
          if (insane_start_return !== undefined) {
            const [insane_start, insane_start_length] = insane_start_return;
            if (new_list_level <= this.list_level + 1) {
              if (this.cur_c === '\n') {
                this.consume();
              }
              this.consume_list_indent();
              this.push_token(TokenType.MACRO_NAME, INSANE_STARTS_TO_MACRO_NAME[insane_start]);
              this.push_token(TokenType.POSITIONAL_ARGUMENT_START);
              this.list_level += 1;
              done = true;
              for (let i = 0; i < insane_start_length; i++) {
                this.consume();
              }
            }
          }
        }

        // Insane headers.
        if (!done && (
          this.i === 0 ||
          this.chars[this.i - 1] === '\n'
        )) {
          let i = this.i;
          let new_header_level = 0;
          while (this.chars[i] === INSANE_HEADER_CHAR) {
            i += 1;
            new_header_level += 1;
          }
          if (new_header_level > 0 && this.chars[i] === ' ') {
            this.push_token(TokenType.MACRO_NAME, Macro.HEADER_MACRO_NAME);
            this.push_token(TokenType.POSITIONAL_ARGUMENT_START, INSANE_HEADER_CHAR.repeat(new_header_level));
            this.push_token(TokenType.PLAINTEXT, new_header_level.toString());
            this.push_token(TokenType.POSITIONAL_ARGUMENT_END);
            this.push_token(TokenType.POSITIONAL_ARGUMENT_START);
            for (let i = 0; i <= new_header_level; i++)
              this.consume();
            this.in_insane_header = true;
            done = true;
          }
        }

        // Character is nothing else, so finally it is a regular plaintext character.
        if (!done) {
          this.consume_plaintext_char();
        }
      }
    }
    if (unterminated_literal) {
      this.error(`unterminated literal argument`, start_source_location);
    }

    // Close any open headers at the end of the document.
    if (this.in_insane_header) {
      this.push_token(TokenType.POSITIONAL_ARGUMENT_END);
    }

    // Close any open list levels at the end of the document.
    for (let i = 0; i < this.list_level; i++) {
      this.push_token(TokenType.POSITIONAL_ARGUMENT_END);
    }

    this.push_token(TokenType.PARAGRAPH);
    this.push_token(TokenType.INPUT_END);
    return this.tokens;
  }

  // Create a token with all consecutive chars that are accepted
  // by the given function.
  tokenize_func(f) {
    this.log_debug('tokenize_func');
    this.log_debug('this.i: ' + this.i);
    this.log_debug('this.cur_c: ' + this.cur_c);
    this.log_debug('');
    let value = '';
    while (f(this.cur_c)) {
      value += this.cur_c;
      this.consume();
      if (this.is_end())
        break;
    }
    return value;
  }

  /**
   * Determine if we are at the start of an insane indented sequence
   * like an insane list '* ' or table '| '
   *
   * @return {Union[[String,Number],undefined]} -
   *         - [insane_start, length] if any is found. For an empty table or list without space,
   *           length is insane_start.length - 1. Otherwise it equals insane_start.length.
   *         - undefined if none found.
   */
  tokenize_insane_start(i) {
    for (const insane_start in INSANE_STARTS_TO_MACRO_NAME) {
      if (
        array_contains_array_at(this.chars, i, insane_start)
      ) {
        // Full insane start match.
        return [insane_start, insane_start.length];
      }
      // Empty table or list without space.
      let insane_start_nospace = insane_start.substring(0, insane_start.length - 1);
      if (
        array_contains_array_at(this.chars, i, insane_start_nospace) &&
        (
          i === this.chars.length - 1 ||
          this.chars[i + insane_start.length - 1] === '\n'
        )
      ) {
        return [insane_start, insane_start.length - 1];
      }
    }
    return undefined;
  }

  /**
   * Start inside the literal argument after the opening,
   * and consume until its end.
   *
   * @return {boolean} - true if OK, false if unexpected EOF
   */
  tokenize_literal(open_char, close_string) {
    this.log_debug('tokenize_literal');
    this.log_debug(`this.i: ${this.i}`);
    this.log_debug(`open_char: ${open_char}`);
    this.log_debug(`close_string ${close_string}`);
    this.log_debug('');

    if (this.is_end())
      return false;

    // Remove leading escapes.
    let i = this.i;
    while (this.chars[i] === ESCAPE_CHAR) {
      i++;
      if (this.is_end())
        return false;
    }
    if (this.chars[i] === open_char) {
      // Skip one of the escape chars if they are followed by an open.
      if (!this.consume())
        return false;
    } else {
      if (!this.consume_optional_newline(true))
        return false;
    }

    // Now consume the following unescaped part.
    let start_i = this.i;
    let start_source_location = this.source_location.clone();
    while (
      this.chars.slice(this.i, this.i + close_string.length).join('')
      !== close_string
    ) {
      if (!this.consume())
        return false;
    }
    // Handle trailing escape.
    let append;
    let end_i;
    if (
      this.chars[this.i - 1] === ESCAPE_CHAR &&
      this.chars.slice(this.i + 1, this.i + close_string.length + 1).join('') === close_string
    ) {
      // Ignore the trailing backslash.
      end_i = this.i - 1;
      // Consume the escaped closing char.
      if (!this.consume())
        return false;
      append = closing_char(open_char);
    } else {
      end_i = this.i;
      append = '';
    }

    // Remove insane list indents.
    let plaintext = '';
    {
      let i = start_i;
      while (true) {
        if (this.chars[i - 1] === '\n') {
          if (this.chars[i] === '\n') {
          } else if (array_contains_array_at(this.chars, i, INSANE_LIST_INDENT.repeat(this.list_level))) {
            i += INSANE_LIST_INDENT.length * this.list_level;
          } else {
            this.error(`literal argument with indent smaller than current insane list`, start_source_location);
          }
        }
        if (i < end_i) {
          plaintext += this.chars[i];
        } else {
          break;
        }
        i++;
      }
    }

    // Create the token.
    this.push_token(
      TokenType.PLAINTEXT,
      plaintext + append,
      start_source_location,
    );

    // Skip over the closing string.
    for (let i = 0; i < close_string.length; i++)
      this.consume();
    return true;
  }
}

class HeaderTreeNode {
  /**
   * @param {AstNode} value
   * @param {HeaderTreeNode} parent_node
   */
  constructor(value, parent_node) {
    this.value = value;
    this.parent_node = parent_node;
    this.children = [];
    this.index = undefined;
    this.descendant_count = 0;
  }

  add_child(child) {
    child.index = this.children.length;
    this.children.push(child);
    let cur_node = this;
    while (cur_node !== undefined) {
      cur_node.descendant_count += 1;
      cur_node = cur_node.parent_node;
    }
  }

  /** @return {Number} How deep this node is relative to
   * the to of the root of the tree. */
  get_level() {
    let level = 0;
    let cur_node = this.parent_node;
    while (cur_node !== undefined) {
      level++;
      cur_node = cur_node.parent_node;
    }
    return level;
  }

  /** E.g. get number 1.4.2.5 of a Section.
   *
   * @return {String}
   */
  get_nested_number(header_graph_top_level) {
    let indexes = [];
    let cur_node = this;
    while (
      // Possible in skipped header levels.
      cur_node !== undefined &&
      cur_node.value !== undefined &&
      cur_node.get_level() !== header_graph_top_level
    ) {
      indexes.push(cur_node.index + 1);
      cur_node = cur_node.parent_node;
    }
    return indexes.reverse().join('.');
  }

  toString() {
    const ret = [];
    let todo_visit;
    // False for toplevel of the tree.
    if (this.value === undefined) {
      todo_visit = this.children.slice();
    } else {
      todo_visit = [this];
    }
    while (todo_visit.length > 0) {
      const cur_node = todo_visit.pop();
      const level = cur_node.get_level();
      ret.push(`${INSANE_HEADER_CHAR.repeat(level)} h${level} ${cur_node.get_nested_number(1)} ${cur_node.value.id}`);
      todo_visit.push(...cur_node.children.reverse());
    }
    return ret.join('\n');
  }
}

/**
 * Determine if big_array contains small_array starting at index position
 * inside the big array.
 *
 * @return {boolean} true iff if the big array contains the small one
 */
function array_contains_array_at(big_array, position, small_array) {
  for (let i = 0; i < small_array.length; i++) {
    if (big_array[position + i] !== small_array[i]) {
      return false;
    }
  }
  return true;
}

// https://stackoverflow.com/questions/7837456/how-to-compare-arrays-in-javascript
function array_equals(arr1, arr2) {
  if (arr1.length !== arr2.length)
    return false;
  for (let i = 0; i < arr1.length; i++) {
    if (arr1[i] !== arr2[i])
      return false;
  }
  return true;
}

function basename(str, sep) {
  return path_split(str, sep)[1];
}

/// https://stackoverflow.com/questions/22697936/binary-search-in-javascript/29018745#29018745
function binary_search(ar, el, compare_fn) {
  var m = 0;
  var n = ar.length - 1;
  while (m <= n) {
    var k = (n + m) >> 1;
    var cmp = compare_fn(el, ar[k]);
    if (cmp > 0) {
      m = k + 1;
    } else if (cmp < 0) {
      n = k - 1;
    } else {
      return k;
    }
  }
  return -m - 1;
}

function binary_search_insert(ar, el, compare_fn) {
  let index = binary_search(ar, el, compare_fn);
  if (index < 0) {
    ar.splice(-(index + 1), 0, el);
  }
  return ar;
}

function binary_search_line_to_id_array_fn(elem0, elem1) {
  return elem0[0] - elem1[0];
}

/** Calculate node ID and add it to the ID index. */
function calculate_id(ast, context, non_indexed_ids, indexed_ids,
  macro_counts, macro_counts_visible, state, is_header, line_to_id_array
) {
  const macro_name = ast.macro_name;
  if (macro_name === Macro.TOC_MACRO_NAME) {
    ast.id = Macro.TOC_ID;
    return;
  }
  const macro = context.macros[macro_name];

  // Linear count of each macro type for macros that have IDs.
  if (!macro.options.macro_counts_ignore(ast)) {
    if (!(macro_name in macro_counts)) {
      macro_counts[macro_name] = 0;
    }
    const macro_count = macro_counts[macro_name] + 1;
    macro_counts[macro_name] = macro_count;
    ast.macro_count = macro_count;
  }

  let index_id = true;
  if (
    // This can happen be false for included headers, and this is notably important
    // for the toplevel header which gets its ID from the filename.
    ast.id === undefined
  ) {
    const macro_id_arg = ast.args[Macro.ID_ARGUMENT_NAME];
    if (macro_id_arg === undefined) {
      let id_text = '';
      const id_prefix = context.macros[ast.macro_name].id_prefix;
      if (id_prefix !== '') {
        id_text += id_prefix + ID_SEPARATOR
      }
      const title_arg = macro.options.get_title_arg(ast, context);
      if (title_arg !== undefined) {
        const new_context = clone_and_set(context, 'id_conversion', true);
        new_context.id_conversion_for_header = is_header;
        new_context.extra_returns.id_conversion_header_title_no_id_xref = false;
        new_context.extra_returns.id_conversion_non_header_no_id_xref_non_header = false;
        id_text += title_to_id(convert_arg_noescape(title_arg, new_context));
        const disambiguate_arg = ast.args[Macro.DISAMBIGUATE_ARGUMENT_NAME];
        if (disambiguate_arg !== undefined) {
          id_text += ID_SEPARATOR + title_to_id(convert_arg_noescape(disambiguate_arg, new_context));
        }
        let message;
        if (new_context.extra_returns.id_conversion_header_title_no_id_xref) {
          message = 'x without content inside title of a header that does not have an ID: https://cirosantilli.com/cirodown#x-within-title-restrictions';
        }
        if (new_context.extra_returns.id_conversion_non_header_no_id_xref_non_header) {
          message = 'x without content inside title of a non-header that does not have an ID linking to a non-header: https://cirosantilli.com/cirodown#x-within-title-restrictions';
        }
        if (message !== undefined) {
          title_arg.push(
            new PlaintextAstNode(
              new_context.extra_returns.id_conversion_xref_error_source_location,
              ' ' + error_message_in_output(message, new_context)
            )
          );
          parse_error(state, message,
            new_context.extra_returns.id_conversion_xref_error_source_location)
        } else {
          ast.id = id_text;
        }
      }

      if (ast.id === undefined && !macro.options.phrasing) {
        // ID from element count.
        if (ast.macro_count !== undefined) {
          id_text += ast.macro_count;
          index_id = false;
          ast.id = id_text;
        }
      }
    } else {
      ast.id = convert_arg_noescape(macro_id_arg, context);
    }
    if (Macro.RESERVED_IDS.has(ast.id)) {
      let message = `reserved ID "${ast.id}"`;
      parse_error(state, message, ast.source_location);
    }
    if (
      ast.id !== undefined &&
      ast.header_graph_node &&
      ast.header_graph_node.parent_node !== undefined &&
      ast.header_graph_node.parent_node.value !== undefined
    ) {
      if (ast.scope !== undefined) {
        ast.id = ast.scope + Macro.HEADER_SCOPE_SEPARATOR + ast.id
      }
    }
  }
  ast.index_id = index_id;
  if (ast.id !== undefined && !ast.force_no_index) {
    let previous_ast = context.id_provider.get(ast.id, context, ast.header_graph_node);
    let input_path;
    if (previous_ast === undefined) {
      let non_indexed_id = non_indexed_ids[ast.id];
      if (non_indexed_id !== undefined) {
        input_path = input_path;
        previous_ast = non_indexed_id;
      }
    } else {
      input_path = previous_ast.source_location.path;
    }
    if (previous_ast === undefined) {
      non_indexed_ids[ast.id] = ast;
      if (index_id) {
        indexed_ids[ast.id] = ast;
      }
    } else {
      let message = `duplicate ID "${ast.id}", previous one defined at `;
      if (input_path !== undefined) {
        message += `file ${input_path} `;
      }
      message += `line ${previous_ast.source_location.line} column ${previous_ast.source_location.column}`;
      parse_error(state, message, ast.source_location);
    }
    if (caption_number_visible(ast, context)) {
      if (!(macro_name in macro_counts_visible)) {
        macro_counts_visible[macro_name] = 0;
      }
      const macro_count = macro_counts_visible[macro_name] + 1;
      macro_counts_visible[macro_name] = macro_count;
      ast.macro_count_visible = macro_count;
    }
    binary_search_insert(line_to_id_array,
      [ast.source_location.line, ast.id], binary_search_line_to_id_array_fn);
  }
}

// Return the full scope of a given node. This includes the concatenation of both:
// * any scopes of any parents
// * the ID of the node if it has a scope set for itself
// If none of those provide scopes, return undefined.
function calculate_scope(ast, context) {
  let parent_scope;
  if (ast.scope !== undefined) {
    parent_scope = ast.scope;
  }

  let self_scope;
  if (
      ast.validation_output.scope !== undefined &&
      ast.validation_output.scope.boolean
  ) {
    self_scope = ast.id;
    if (parent_scope !== undefined) {
      self_scope = self_scope.substr(parent_scope.length + 1);
    }
  } else {
    self_scope = '';
  }

  let ret = '';
  if (parent_scope !== undefined) {
    ret += parent_scope;
  }
  if (
    parent_scope !== undefined &&
    self_scope !== ''
  ) {
    ret += Macro.HEADER_SCOPE_SEPARATOR;
  }
  if (self_scope !== '') {
    ret += self_scope;
  }
  if (ret === '') {
    return undefined;
  }
  return ret;
}

/* Calculate the length of the scope of a child header given its parent ast. */
function calculate_scope_length(parent_ast, context) {
  if (parent_ast !== undefined) {
    let scope = calculate_scope(parent_ast, context);
    if (scope !== undefined) {
      return scope.length + 1;
    }
  }
  return 0;
}

function capitalize_first_letter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function caption_number_visible(ast, context) {
  return ast.index_id || context.macros[ast.macro_name].options.caption_number_visible(ast, context);
}

function char_is_alphanumeric(c) {
  let code = c.codePointAt(0);
  return (
    // 0-9
    (code > 47 && code < 58) ||
    // A-Z
    (code > 64 && code < 91) ||
    // a-z
    (code > 96 && code < 123)
  )
}

// Valid macro name / argument characters.
// Compatible with JavaScript-like function names / variables.
function char_is_identifier(c) {
  return char_is_alphanumeric(c) || c === '_';
};

/** Shallow clone an object, and set a given value on the cloned one. */
function clone_and_set(obj, key, value) {
  let new_obj = {...obj};
  new_obj[key] = value;
  return new_obj;
}
exports.clone_and_set = clone_and_set;

function clone_object(obj) {
  // https://stackoverflow.com/questions/41474986/how-to-clone-a-javascript-es6-class-instance
  return Object.assign(Object.create(Object.getPrototypeOf(obj)), obj);
}

function closing_char(c) {
  if (c === START_POSITIONAL_ARGUMENT_CHAR)
    return END_POSITIONAL_ARGUMENT_CHAR;
  if (c === START_NAMED_ARGUMENT_CHAR)
    return END_NAMED_ARGUMENT_CHAR;
  throw new Error('char does not have a close: ' + c);
}

function closing_token(token) {
  if (token === TokenType.POSITIONAL_ARGUMENT_START)
    return TokenType.POSITIONAL_ARGUMENT_END;
  if (token === TokenType.NAMED_ARGUMENT_START)
    return TokenType.NAMED_ARGUMENT_END;
  throw new Error('token does not have a close: ' + token);
}

/**
 * Main cirodown input to HTML/LaTeX/etc. output JavaScript API.
 *
 * The CLI interface basically just feeds this.
 *
 * @param {Object} options
 *          {IdProvider} external_ids
 *          {Function[String] -> [string,string]} read_include(id) -> [file_name, content]
 *          {Number} h_include_level_offset - add this offset to the levels of every header
 *          {boolean} render - if false, parse the input, but don't render it,
 *              and return undefined.
 *              The initial use case for this is to allow a faster and error-less
 *              first pass when building an entire directory with internal cross file
 *              references to extract IDs of each file.
 * @param {Object} extra_returns
 *          {Object} rendered_outputs pairs of output_path -> rendered_output_string
 *                   This is needed primarily because --html-spit-header
 *                   generates multiple output files for a single input file.
 * @return {String}
 */
function convert(
  input_string,
  options,
  extra_returns={},
) {
  let context = convert_init_context(options, extra_returns);

  // Tokenize.
  let sub_extra_returns;
  sub_extra_returns = {};
  extra_returns.debug_perf.tokenize_pre = globals.performance.now();
  let tokens = (new Tokenizer(
    input_string,
    sub_extra_returns,
    context.options.log.tokenize,
    context.options.start_line,
    context.options.input_path,
  )).tokenize();
  extra_returns.debug_perf.tokenize_post = globals.performance.now();
  if (context.options.log['tokens-inside']) {
    console.error('tokens:');
    for (let i = 0; i < tokens.length; i++) {
      console.error(`${i}: ${JSON.stringify(tokens[i], null, 2)}`);
    }
    console.error();
  }
  extra_returns.tokens = tokens;
  extra_returns.errors.push(...sub_extra_returns.errors);
  sub_extra_returns = {};

  // Setup context.media_provider_default based on `default-for`.
  {
    const media_providers = context.options.cirodown_json['media-providers'];
    context.media_provider_default = {};
    for (const media_provider_name in media_providers) {
      const media_provider = media_providers[media_provider_name];
      if ('default-for' in media_provider) {
        for (const default_for of media_provider['default-for']) {
          if (default_for[0] == default_for[0].toUpperCase()) {
            context.errors.push(new ErrorMessage(`default-for names must start with a lower case letter`, new SourceLocation(1, 1)));
          } else {
            if (default_for === 'all') {
              for (const macro_name of MACRO_WITH_MEDIA_PROVIDER) {
                context.media_provider_default[default_for] = media_provider_name;
                context.media_provider_default[capitalize_first_letter(default_for)] = media_provider_name;
              }
            } else {
              if (MACRO_WITH_MEDIA_PROVIDER.has(default_for)) {
                if (context.media_provider_default[default_for] === undefined) {
                  context.media_provider_default[default_for] = media_provider_name;
                  context.media_provider_default[capitalize_first_letter(default_for)] = media_provider_name;
                } else {
                  context.errors.push(new ErrorMessage(`multiple media providers set for macro "${default_for}"`, new SourceLocation(1, 1)));
                }
              } else {
                context.errors.push(new ErrorMessage(`macro "${default_for}" does not accept media providers`, new SourceLocation(1, 1)));
              }
            }
          }
        }
      }
    }
    for (const macro_name of MACRO_WITH_MEDIA_PROVIDER) {
      if (context.media_provider_default[macro_name] === undefined) {
        context.media_provider_default[macro_name] = 'local';
        context.media_provider_default[capitalize_first_letter(macro_name)] = 'local';
      }
    }
  }

  let ast = parse(tokens, context.options, context, sub_extra_returns);
  if (context.options.log['ast-inside']) {
    console.error('ast:');
    console.error(JSON.stringify(ast, null, 2));
    console.error();
  }
  extra_returns.ast = ast;
  extra_returns.context = context;
  extra_returns.ids = sub_extra_returns.ids;
  Object.assign(extra_returns.debug_perf, sub_extra_returns.debug_perf);
  extra_returns.errors.push(...sub_extra_returns.errors);
  let output;
  if (context.options.render) {
    context.extra_returns.rendered_outputs = {};
    extra_returns.debug_perf.render_pre = globals.performance.now();
    // Split header conversion.
    if (context.options.split_headers) {
      const content = ast.args.content;
      // Gather up each header (must be a direct child of toplevel)
      // and all elements that belong to that header (up to the next header).
      let cur_arg_list = [];
      let has_toc = false;
      for (const child_ast of content) {
        const macro_name = child_ast.macro_name;
        if (macro_name === Macro.TOC_MACRO_NAME) {
          has_toc = true;
        }
        if (
          macro_name === Macro.HEADER_MACRO_NAME
          // Just ignore extra added include headers, these
          // were overwritting index-split.html output.
          && !child_ast.from_include
        ) {
          convert_header(cur_arg_list, context, has_toc);
          cur_arg_list = [];
          has_toc = false;
        }
        cur_arg_list.push(child_ast);
      }
      convert_header(cur_arg_list, context);
      // Because the following conversion would redefine them.
    }
    if (context.options.log['split-headers']) {
      console.error('split-headers non-split: ' + context.options.input_path);
    }
    context.katex_macros = {};
    output = ast.convert(context);
    if (context.toplevel_output_path !== undefined) {
      context.extra_returns.rendered_outputs[context.toplevel_output_path] = output;
    }
    extra_returns.debug_perf.render_post = globals.performance.now();
    extra_returns.errors.push(...context.errors);
  }
  // Sort errors that might have been produced on different conversion
  // stages by line.
  extra_returns.errors = extra_returns.errors.sort((a, b)=>{
    if (a.source_location.path !== undefined && b.source_location.path !== undefined) {
      let ret = a.source_location.path.localeCompare(b.source_location.path);
      if (ret !== 0)
        return ret;
    }
    if (a.source_location.line < b.source_location.line)
      return -1;
    if (a.source_location.line > b.source_location.line)
      return 1;
    if (a.source_location.column < b.source_location.column)
      return -1;
    if (a.source_location.column > b.source_location.column)
      return 1;
    return 0;
  });
  if (output !== undefined) {
    if (output[output.length - 1] !== '\n') {
      output += '\n';
    }
  }
  extra_returns.debug_perf.end = globals.performance.now();
  return output;
}
exports.convert = convert;

/** Convert an argument to a string.
 *
 * An argument contains a list of nodes, loop over that list of nodes,
 * converting them to strings and concatenate all strings.
 *
 * @param {AstArgument} arg
 * @return {String} empty string if arg is undefined
 */
function convert_arg(arg, context) {
  let converted_arg = '';
  if (arg !== undefined) {
    for (const ast of arg) {
      converted_arg += ast.convert(context);
    }
  }
  return converted_arg;
}

/* Similar to convert_arg, but used for IDs.
 *
 * Because IDs are used programmatically in cirodown, we don't escape
 * HTML characters at this point.
 *
 * @param {AstArgument} arg
 * @return {String}
 */
function convert_arg_noescape(arg, context={}) {
  return convert_arg(arg, clone_and_set(context, 'html_escape', false));
}

/* Convert one header (or content before the first header)
 * in --split-headers mode. */
function convert_header(cur_arg_list, context, has_toc) {
  if (
    // Can fail if:
    // * the first thing in the document is a header
    // * the document has no headers
    cur_arg_list.length > 0
  ) {
    context = Object.assign({}, context);
    const options = Object.assign({}, context.options);
    context.options = options;
    const first_ast = clone_object(cur_arg_list[0]);
    if (!has_toc && first_ast.macro_name === Macro.HEADER_MACRO_NAME) {
      cur_arg_list.push(new AstNode(
        AstType.MACRO,
        Macro.TOC_MACRO_NAME,
        {},
        first_ast.source_location,
        {id: Macro.TOC_ID}
      ));
    }
    const ast_toplevel = new AstNode(
      AstType.MACRO,
      Macro.TOPLEVEL_MACRO_NAME,
      {
        'content': new AstArgument(cur_arg_list, first_ast.source_location)
      },
      first_ast.source_location,
    );
    options.toplevel_id = first_ast.id;
    context.in_split_headers = true;
    // When not in simple header mode, we always have a value-less node, with
    // children with values. Now things are a bit more complicated, because we
    // want to keep the header tree intact, but at the same time also uniquely point
    // to one of the headers. So let's fake a tree node that has only one child we care
    // about. And the child does not have this fake parent to be able to see actual parents.
    context.header_graph = new HeaderTreeNode();
    // Clone this, because we are going to modify it, and it would affect
    // non-split headers and final outputs afterwards.
    first_ast.header_graph_node = clone_object(first_ast.header_graph_node);
    context.header_graph.add_child(first_ast.header_graph_node);
    context.header_graph_top_level = first_ast.header_graph_node.get_level();
    const output_path = output_path_from_ast(first_ast, context)[0];
    if (options.log['split-headers']) {
      console.error('split-headers: ' + output_path);
    }
    context.toplevel_output_path = output_path;
    context.toplevel_ast = first_ast;

    // root_relpath
    const [output_path_dirname, output_path_basename] =
      path_split(output_path, context.options.path_sep);
    options.template_vars = Object.assign({}, options.template_vars);
    options.template_vars.root_relpath = path.relative(
      output_path_dirname, '.');
    if (options.template_vars.root_relpath !== '') {
        options.template_vars.root_relpath += context.options.path_sep;
    }

    // Do the conversion.
    context.extra_returns.rendered_outputs[output_path] =
      ast_toplevel.convert(context);
  }
}

/**
 * @param {Object} options:
 *        - {Number} start_line
 *        - {Array} errors
 * @return {AstArgument}*/
function convert_include(
  input_string,
  convert_options,
  cur_header_level,
  input_path,
  href,
  options={}
) {
  convert_options = Object.assign({}, convert_options);
  convert_options.from_include = true;
  convert_options.h_parse_level_offset = cur_header_level;
  convert_options.input_path = input_path;
  convert_options.render = false;
  convert_options.toplevel_id = href;
  convert_options.header_graph_stack = new Map(convert_options.header_graph_stack);
  convert_options.header_graph_id_stack = new Map(convert_options.header_graph_id_stack);
  if (options.start_line !== undefined) {
    convert_options.start_line = options.start_line;
  }
  const convert_extra_returns = {};
  convert(
    input_string,
    convert_options,
    convert_extra_returns,
  );
  // Forward the include_path_set back. This is needed because convert
  // clones that input by default to prevent inputs from being modified.
  convert_options.include_path_set.add(...convert_extra_returns.context.include_path_set);
  if (options.errors !== undefined) {
    options.errors.push(...convert_extra_returns.errors);
  }
  return convert_extra_returns.ast.args.content;
}

function convert_init_context(options={}, extra_returns={}) {
  extra_returns.debug_perf = {};
  extra_returns.debug_perf.start = globals.performance.now();
  options = Object.assign({}, options);
  if (!('body_only' in options)) { options.body_only = false; }
  if (!('cirodown_json' in options)) { options.cirodown_json = {}; }
    const cirodown_json = options.cirodown_json;
    {
      if (!('media-providers' in cirodown_json)) { cirodown_json['media-providers'] = {}; }
      {
        const media_providers = cirodown_json['media-providers'];

        for (const media_provider_type of MEDIA_PROVIDER_TYPES) {
          if (!(media_provider_type in media_providers)) {
            media_providers[media_provider_type] = {};
          }
          const media_provider = media_providers[media_provider_type];
          if (!('title-from-src' in media_provider)) {
            media_provider['title-from-src'] = false;
          }
        }
        if (!('path' in media_providers.local)) {
          media_providers.local.path = '';
        }
        if (!('remote' in media_providers.github)) {
          media_providers.github.remote = 'TODO determine from git remote origin if any';
        }
        for (const media_provider_name in media_providers) {
          const media_provider = media_providers[media_provider_name];
          if (!('title-from-src' in media_provider)) {
            media_provider['title-from-src'] = false;
          }
        }
      }
    }
  if (!('embed_includes' in options)) { options.embed_includes = false; }
  if (!('file_provider' in options)) { options.file_provider = undefined; }
  if (!('from_include' in options)) { options.from_include = false; }
  if (!('from_cirodown_example' in options)) { options.from_cirodown_example = false; }
  if (!('html_embed' in options)) { options.html_embed = false; }
  // Add HTML extension to x links. And therefore also output files
  // with the .html extension.
  if (!('html_x_extension' in options)) { options.html_x_extension = true; }
  if (!('h_parse_level_offset' in options)) {
    // When parsing, start the first header at this offset instead of h1.
    // This is used when doing includes, since the included header is at.
    // an offset relative to where it is included from.
    options.h_parse_level_offset = 0;
  }
  if (!('id_provider' in options)) { options.id_provider = undefined; }
  if (!('include_path_set' in options)) { options.include_path_set = new Set(); }
  if (!('input_path' in options)) { options.input_path = undefined; }
  if (!('log' in options)) { options.log = {}; }
  // Override the default calculated output file for the main input.
  if (!('outfile' in options)) { options.outfile = undefined; }
  if (!('output_format' in options)) { options.output_format = OUTPUT_FORMAT_HTML; }
  if (!('path_sep' in options)) { options.path_sep = undefined; }
  if (!('render' in options)) { options.render = true; }
  if (!('start_line' in options)) { options.start_line = 1; }
  // A toplevel scope, to implement conversion of files in subdirectories.
  if (!('split_headers' in options)) { options.split_headers = false; }
  if (!('template' in options)) { options.template = undefined; }
  if (!('template_scripts_relative' in options)) {
    // Like template_styles_relative but for sripts.
    options.template_scripts_relative = [];
  }
  if (!('template_styles_relative' in options)) {
    // CSS styles relative to cirodown.json. Must be resolved by cirodown.convert.
    // because of split headers. The relative path expanded result gets prepended
    // to `options.template_vars.style`.
    options.template_styles_relative = [];
  }
  if (!('template_vars' in options)) { options.template_vars = {}; }
    if (!('head' in options.template_vars)) { options.template_vars.head = ''; }
    if (!('root_relpath' in options.template_vars)) { options.template_vars.root_relpath = ''; }
    if (!('post_body' in options.template_vars)) { options.template_vars.post_body = ''; }
    if (!('style' in options.template_vars)) { options.template_vars.style = ''; }
  // If given, force the toplevel header to have this ID.
  // Otherwise, derive the ID from the title.
  // https://cirosantilli.com/cirodown#the-id-of-the-first-header-is-derived-from-the-filename
  if (!('toplevel_id' in options)) { options.toplevel_id = undefined; }
  if (!('toplevel_has_scope' in options)) {
    // Set for index files in subdirectories. Is equivalent to
    // adding a {scope} to the toplevel header.
    options.toplevel_has_scope = false;
  }
  if (!('toplevel_parent_scope' in options)) {
    // Set for files in subdirectories. Means that the (faked non existent)
    // parent toplevel header has {scope} set.
    options.toplevel_parent_scope = undefined;
  }
  if (options.xss_unsafe === undefined) {
    const xss_unsafe = cirodown_json['xss-unsafe'];
    if (xss_unsafe !== undefined) {
      options.xss_unsafe = xss_unsafe;
    } else {
      options.xss_unsafe = false;
    }
  }
  extra_returns.errors = [];
  let context = {
    katex_macros: {},
    in_split_headers: false,
    errors: [],
    extra_returns: extra_returns,
    include_path_set: new Set(options.include_path_set),
    macros: macro_list_to_macros(),
    options: options,
  };

  // Non-split header toplevel conversion.
  let outpath;
  if (context.options.outfile !== undefined) {
    outpath = context.options.outfile;
  } else if (context.options.input_path !== undefined) {
    outpath = output_path(context.options.input_path, context.options.toplevel_id, context)[0];
  }
  context.toplevel_output_path = outpath;
  return context;
}

/* Like x_href, but called with options as convert,
 * so that we don't have to fake a complex context. */
function convert_x_href(target_id, options) {
  const context = convert_init_context(options);
  context.id_provider = options.id_provider;
  const target_id_ast = context.id_provider.get(target_id, context);
  if (target_id_ast === undefined) {
    return undefined
  } else {
    return x_href(target_id_ast, context);
  }
}
exports.convert_x_href = convert_x_href;

function dirname(str, sep) {
  return path_split(str, sep)[0];
}

/** Error message to be rendered inside the generated output itself.
 *
 * If context is given, escape the message correctly for this context.
 *
 * @return {String}
 */
function error_message_in_output(msg, context) {
  let escaped_msg;
  if (context === undefined) {
    escaped_msg = msg;
  } else {
    escaped_msg = html_escape_context(context, msg);
  }
  return `[CIRODOWN_ERROR: ${escaped_msg}]`
}

function get_descendant_count(tree_node) {
  let descendant_count;
  if (tree_node.descendant_count > 0) {
    return ` <span class="descendant-count" title="Number of descendants.">[${tree_node.descendant_count}]</span>`;
  } else {
    return '';
  }
}

/** Convert a key value already fully HTML escaped strings
 * to an HTML attribute. The callers MUST escape any untrusted chars.
  e.g. with html_attr_value.
 *
 * @param {String} key
 * @param {AstArgument} arg
 * @return {String} - of form ' a="b"' (with a leading space)
 */
function html_attr(key, value) {
  return ` ${key}="${value}"`;
}

/** Convert an argument to an HTML attribute value.
 *
 * @param {AstArgument} arg
 * @param {Object} context
 * @return {String}
 */
function html_attr_value(arg, context) {
  return convert_arg(arg, clone_and_set(context, 'html_is_attr', true));
}

function html_class_attr(classes) {
  return html_attr('class', classes.join(' '))
}

function html_code(content, attrs) {
  return html_elem('pre', html_elem('code', content), attrs);
}

/** Helper to convert multiple parameters directly to HTML attributes.
 *
 * The ID is automatically included.
 *
 * @param {AstNode} ast
 * @param {Object} options
 * @param {Array[String]} arg_names - which argument names should be added as properties.
 *         Only arguments that were given in the text input are used.
 * @param {Object[String, AstNode]} custom_args - attributes that were not just passed in
 *        directly from the input text, but may rather have been calculated from the node.
 */
function html_convert_attrs(
  ast, context, arg_names=[], custom_args={}
) {
  // Determine the arguments.
  let args = [];
  for (const arg_name in custom_args) {
    args.push([arg_name, custom_args[arg_name]]);
  }
  for (const arg_name of arg_names) {
    if (arg_name in ast.args) {
      args.push([arg_name, ast.args[arg_name]]);
    }
  }

  // Build the output string.
  let ret = '';
  for (const name_arg_pair of args) {
    const [arg_name, arg] = name_arg_pair;
    ret += html_attr(arg_name, html_attr_value(arg, context));
  }
  return ret;
}

/**
 * Same interface as html_convert_attrs, but automatically add the ID to the list
 * of arguments.
 */
function html_convert_attrs_id(
  ast, context, arg_names=[], custom_args={}
) {
  let id = ast.id;
  if (id !== undefined) {
    custom_args[Macro.ID_ARGUMENT_NAME] = [
        new PlaintextAstNode(ast.source_location,
          remove_toplevel_scope(id, context.toplevel_ast, context)),
    ];
  }
  return html_convert_attrs(ast, context, arg_names, custom_args);
}

/** Helper for the most common HTML function type that does "nothing magic":
 * only has "id" as a possible attribute, and uses ast.args.content as the
 * main element child.
 */
function html_convert_simple_elem(elem_name, options={}) {
  if (!('attrs' in options)) {
    options.attrs = {};
  }
  if (!('newline_after_open' in options)) {
    options.newline_after_open = false;
  }
  if (!('newline_after_close' in options)) {
    options.newline_after_close = false;
  }
  if (!('wrap' in options)) {
    options.wrap = false;
  }
  let newline_after_open_str;
  if (options.newline_after_open) {
    newline_after_open_str = '\n';
  } else {
    newline_after_open_str = '';
  }
  let newline_after_close_str;
  if (options.newline_after_close) {
    newline_after_close_str = '\n';
  } else {
    newline_after_close_str = '';
  }
  return function(ast, context) {
    let attrs = html_convert_attrs_id(ast, context);
    let extra_attrs_string = '';
    for (const key in options.attrs) {
      extra_attrs_string += html_attr(key, options.attrs[key]);
    }
    let content_ast = ast.args.content;
    let content = convert_arg(content_ast, context);
    let res = `<${elem_name}${extra_attrs_string}${attrs}>${newline_after_open_str}${content}</${elem_name}>${newline_after_close_str}`;
    if (options.wrap) {
      res = html_elem('div', res);
    }
    return res;
  };
}

function html_elem(tag, content, attrs) {
  let ret = '<' + tag;
  for (const attr_id in attrs) {
    ret += ' ' + attr_id + '="' + html_escape_attr(attrs[attr_id]) + '"'
  }
  return ret + '>' + content + '</' + tag + '>';
}

function html_escape_attr(str) {
  return html_escape_content(str)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
  ;
}

function html_escape_content(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  ;
}

/** Escape string depending on the current context. */
function html_escape_context(context, str) {
  if (context.html_escape) {
    if (context.html_is_attr) {
      return html_escape_attr(str);
    } else {
      return html_escape_content(str);
    }
  } else {
    return str;
  }
}

function html_hide_hover_link(id) {
  if (id === undefined) {
    return '';
  } else {
    let href = html_attr('href', html_escape_attr(id));
    return `<span class="hide-hover"><a${href}>${UNICODE_LINK}</a></span>`;
  }
}

function html_is_whitespace_text_node(ast) {
  return ast.node_type === AstType.PLAINTEXT && html_is_whitespace(ast.text);
}

// https://stackoverflow.com/questions/2161337/can-we-use-any-other-tag-inside-ul-along-with-li/60885802#60885802
function html_is_whitespace(string) {
  for (const c of string) {
    if (!HTML_ASCII_WHITESPACE.has(c))
      return false;
  }
  return true;
}

function html_katex_convert(ast, context) {
  try {
    return katex.renderToString(
      convert_arg(ast.args.content, clone_and_set(context, 'html_escape', false)),
      {
        globalGroup: true,
        macros: context.katex_macros,
        // The default is to also add MathML output for blind people.
        // However, it adds it with absolute positioning for some reason.
        // And as a result, if you add a math formula to the bottom of the editor,
        // it generates a toplevel scrollbar on Chromium 84 but not Firefox 79.
        output: 'html',
        strict: 'error',
        throwOnError: true,
      }
    );
  } catch(error) {
    // TODO get working remove the crap KaTeX adds to the end of the string.
    // It uses Unicode char hacks to add underlines... and there are two trailing
    // chars after the final newline, so the error message is taking up two lines
    let message = error.toString().replace(/\n\xcc\xb2$/, '');
    render_error(context, message, ast.args.content.source_location);
    return error_message_in_output(message, context);
  }
}

function html_self_link(ast, context) {
  return x_href_attr(ast, context);
}

/** https://stackoverflow.com/questions/14313183/javascript-regex-how-do-i-check-if-the-string-is-ascii-only/14313213#14313213 */
function is_ascii(str) {
  return /^[\x00-\x7F]*$/.test(str);
}

function id_convert_simple_elem() {
  return function(ast, context) {
    let ret = convert_arg(ast.args.content, context);
    if (!context.macros[ast.macro_name].options.phrasing) {
      ret += '\n';
    }
    return ret;
  };
}

/** bb,      aaa/bbb -> false
 *  bbb,     aaa/bbb -> true
 *  aaa/bbb, aaa/bbb -> true
 */
function id_is_suffix(suffix, full) {
  let full_len = full.length;
  let suffix_len = suffix.length;
  return (
    full.endsWith(suffix) &&
    (
      full_len == suffix_len ||
      (
        full_len > suffix_len &&
        full[full_len - suffix_len - 1] === Macro.HEADER_SCOPE_SEPARATOR
      )
    )
  );
}

function link_get_href_content(ast, context) {
  const href = convert_arg(ast.args.href, context)
  let content = convert_arg(ast.args.content, context);
  if (content === '') {
    content = href;
  }
  return [href, content];
}

/**
 * @return {Object} dict of macro name to macro
 */
function macro_list_to_macros() {
  const macros = {};
  for (const macro of macro_list()) {
    for (const format in MACRO_CONVERT_FUNCIONS) {
      macro.add_convert_function(format, MACRO_CONVERT_FUNCIONS[format][macro.name]);
    }
    macros[macro.name] = macro;
  }
  return macros;
}

/** At some point we will generalize this to on-the-fly macro definitions. */
function macro_list() {
  return DEFAULT_MACRO_LIST;
}
exports.macro_list = macro_list;

const CIRODOWN_EXT = '.ciro';
exports.CIRODOWN_EXT = CIRODOWN_EXT;
const MEDIA_PROVIDER_TYPES = new Set([
  'github',
  'local',
  'unknown',
  'wikimedia',
  'youtube',
]);
const media_provider_type_wikimedia_re = new RegExp('^https?://upload.wikimedia.org/wikipedia/commons/');
const media_provider_type_youtube_re = new RegExp('^https?://(www\.)?(youtube.com|youtu.be)/');
const macro_image_video_block_convert_function_wikimedia_source_url = 'https://commons.wikimedia.org/wiki/File:';
const macro_image_video_block_convert_function_wikimedia_source_image_re = new RegExp('^\\d+px-');
const macro_image_video_block_convert_function_wikimedia_source_video_re = new RegExp('^([^.]+\.[^.]+).*');

function macro_image_video_block_convert_function(ast, context) {
  let rendered_attrs = html_convert_attrs(ast, context, ['height', 'width']);
  let figure_attrs = html_convert_attrs_id(ast, context);
  let ret = `<figure${figure_attrs}>\n`
  let href_prefix;
  if (ast.id !== undefined) {
    href_prefix = html_self_link(ast, context);
  } else {
    href_prefix = undefined;
  }
  let description = convert_arg(ast.args.description, context);
  let force_separator = false;
  if (description !== '') {
    description = ' ' + description;
    force_separator = true;
  }
  let {error_message, media_provider_type, source, src, is_url}
    = macro_image_video_resolve_params_with_source(ast, context);
  if (error_message !== undefined) {
    return error_message;
  }
  if (source !== '') {
    force_separator = true;
    source = ` <a${html_attr('href', source)}>Source</a>.`;
  }
  let alt_val;
  const has_caption = (ast.id !== undefined) && caption_number_visible(ast, context);
  if (ast.args.alt === undefined) {
    if (has_caption) {
      alt_val = undefined;
    } else {
      alt_val = src;
    }
  } else {
    alt_val = convert_arg(ast.args.alt, context);
  }
  let alt;
  if (alt_val === undefined) {
    alt = '';
  } else {
    alt = html_attr('alt', html_escape_attr(alt_val));
  }
  ret += context.macros[ast.macro_name].options.image_video_content_func(
    ast, context, src, rendered_attrs, alt, media_provider_type, is_url);
  if (has_caption) {
    ret += `<figcaption>${x_text(ast, context, {href_prefix:
      href_prefix, force_separator: force_separator})}${source}${description}</figcaption>\n`;
  }
  ret += '</figure>\n';
  return ret;
}

// https://stackoverflow.com/questions/44447847/enums-in-javascript-with-es6/49709701#49709701
function make_enum(arr) {
  let obj = {};
  for (let val of arr){
    obj[val] = Symbol(val);
  }
  return Object.freeze(obj);
}

function noext(str) {
  return str.substring(0, str.lastIndexOf('.'));
}

// https://stackoverflow.com/questions/17781472/how-to-get-a-subset-of-a-javascript-objects-properties/17781518#17781518
function object_subset(source_object, keys) {
  const new_object = {};
  keys.forEach((obj, key) => { new_object[key] = source_object[key]; });
  return new_object;
}

/** Calculate the output path of an AST node,
 * or of something faked to look like one.
 *
 * cirodown ->
 *    split_headers -> index.html
 *   !split_headers -> index.html
 * quick-start ->
 *    split_headers -> quick-start.html
 *   !split_headers -> index.html
 * not-readme -> not-readme.html
 *    split_headers -> not-readme.html
 *   !split_headers -> not-readme.html
 * h2 in not the README -> not-readme.html
 *    split_headers -> h2-in-not-the-readme.html
 *   !split_headers -> not-readme.html
 * not-readme-with-scope ->
 *    split_headers -> not-readme-with-scope.html
 *   !split_headers ->  not-readme-with-scope.html
 * not-readme-with-scope/h2 ->
 *    split_headers -> not-readme-with-scope/h2.html
 *   !split_headers ->  not-readme-with-scope.html
 * subdir ->
 *    split_headers -> subdir/index.html
 *   !html_x_extension -> subdir
 *   !split_headers -> subdir/index.html
 * subdir/subdir-h2
 */
function output_path(input_path, id, context={}, split_suffix=undefined) {
  const [dirname, basename] = output_path_parts(input_path, id, context, split_suffix);
  return [
    path_join(dirname, basename + '.' + HTML_EXT, context.options.path_sep),
    dirname,
    basename
  ];
}

/** Helper for when we have an actual AstNode. */
function output_path_from_ast(ast, context) {
  let split_suffix;
  if (ast.args.splitSuffix !== undefined) {
    split_suffix = convert_arg(ast.args.splitSuffix, context);
  }
  return output_path(ast.source_location.path, ast.id, context, split_suffix);
}

/* Return dirname and basename without extension of the
 * path to where an AST gets rendered to. */
function output_path_parts(input_path, id, context, split_suffix=undefined) {
  let ret = '';
  const [dirname, basename] = path_split(input_path, context.options.path_sep);
  const renamed_basename_noext = rename_basename(noext(basename));
  if (
    // Get the path to the split header version
    //
    // to_split_headers is set explicitly when making
    // links across split/non-split versions of the output.
    //
    // Otherwise, link to the same type of output as the current one
    // as given in in_split_headers.
    //
    // This way, to_split_hedears in particular forces the link to be
    // to the non-split mode, even if we are in split mode.
    //
    // Some desired sample outcomes:
    //
    // id='cirodown'             -> ['',       'index-split']
    // id='quick-start'          -> ['',       'quick-start']
    // id='not-readme'           -> ['',       'not-readme-split']
    // id='h2-in-not-the-readme' -> ['',       'h2-in-not-the-readme']
    // id='subdir'               -> ['subdir', 'index-split']
    // id='subdir/subdir-h2'     -> ['subdir', 'subdir-h2']
    // id='subdir/notindex'      -> ['subdir', 'notindex']
    // id='subdir/notindex-h2'   -> ['subdir', 'notindex-h2']
    (context.to_split_headers === undefined && context.in_split_headers) ||
    (context.to_split_headers !== undefined && context.to_split_headers)
  ) {
    const ast = context.id_provider.get(id, context);
    // We are the first header, or something that comes before it.
    let first_header_or_before = false;
    if (ast === undefined) {
      first_header_or_before = true;
    } else {
      if (ast.macro_name === Macro.HEADER_MACRO_NAME) {
        if (ast.is_first_header_in_input_file) {
          first_header_or_before = true;
        }
      } else {
        id = ast.get_header_parent_id();
      }
    }
    let dirname_ret;
    let basename_ret;
    const [id_dirname, id_basename] = path_split(id, URL_SEP);
    if (first_header_or_before) {
      // For toplevel elements in split header mode, we have
      // to take care of index and -split suffix.
      if (renamed_basename_noext === INDEX_BASENAME_NOEXT) {
        basename_ret = INDEX_BASENAME_NOEXT;
        if (id_dirname === '') {
          dirname_ret = dirname;
        } else {
          // Not a https://cirosantilli.com/cirodown#the-toplevel-index-file
          dirname_ret = path_join(id_dirname, id_basename, context.options.path_sep);
        }
      } else {
        dirname_ret = dirname;
        basename_ret = renamed_basename_noext;
      }
      basename_ret += '-split';
    } else {
      // Non-toplevel elements in split header mode are simple,
      // the ID just gives the output path directly.
      dirname_ret = id_dirname;
      basename_ret = id_basename;
    }
    if (split_suffix !== undefined) {
      if (split_suffix === '') {
        split_suffix = 'split';
      }
      basename_ret += '-' + split_suffix;
    }
    return [dirname_ret, basename_ret];
  } else {
    // Non-split headers, so things are simple, the output path is
    // easily determined from the input path.
    return [dirname, renamed_basename_noext];
  }
}
exports.output_path_parts = output_path_parts;

/** Parse tokens into the AST tree.
 *
 * @param {Array[Token]} tokens
 * @return {Object} extra_returns
 *         - {Array[ErrorMessage]} errors
 *         - {Object} ids
 * @return {AstNode}
 */
function parse(tokens, options, context, extra_returns={}) {
  extra_returns.debug_perf = {};
  extra_returns.debug_perf.parse_start = globals.performance.now();
  extra_returns.errors = [];
  let state = {
    extra_returns: extra_returns,
    i: 0,
    macros: context.macros,
    options: options,
    token: tokens[0],
    tokens: tokens,
  };
  // Get toplevel arguments such as {title=}, see https://cirosantilli.com/cirodown#toplevel
  const ast_toplevel_args = parse_argument_list(
    state, Macro.TOPLEVEL_MACRO_NAME, AstType.MACRO);
  if ('content' in ast_toplevel_args) {
    parse_error(state, `the toplevel arguments cannot contain an explicit content argument`, new SourceLocation(1, 1));
  }

  // Inject a maybe paragraph token after those arguments.
  const paragraph_token = new Token(TokenType.PARAGRAPH, state.token.source_location);
  tokens.splice(state.i, 0, paragraph_token);
  state.token = paragraph_token;

  // Parse the main part of the document as the content
  // argument toplevel argument.
  const ast_toplevel_content_arg = parse_argument(
    state, state.token.source_location);

  // Create the toplevel macro itself.
  const ast_toplevel = new AstNode(
    AstType.MACRO,
    Macro.TOPLEVEL_MACRO_NAME,
    Object.assign(ast_toplevel_args, {'content': ast_toplevel_content_arg}),
    new SourceLocation(1, 1),
  );
  if (state.token.type !== TokenType.INPUT_END) {
    parse_error(state, `unexpected tokens at the end of input`);
  }

  // Post process the AST depth first minimally to support includes.
  //
  // This could in theory be done in a single pass with the next one,
  // but that is much more hard to implement and maintain, because we
  // have to stich togetegher internal structors to maintain the header
  // tree across the includer and included documents.
  //
  // Another possibility would be to do it in the middle of the initial parse,
  // but let's not complicate that further either, shall we?
  context.headers_with_include = [];
  context.header_graph = new HeaderTreeNode();
  extra_returns.debug_perf.post_process_start = globals.performance.now();
  let prev_header;
  let cur_header_level;
  let first_header_level;
  let first_header;
  let header_graph_last_level;
  let toplevel_parent_arg = new AstArgument([], new SourceLocation(1, 1));
  let todo_visit = [[toplevel_parent_arg, ast_toplevel]];
  // IDs that are indexed: you can link to those.
  const line_to_id_array = [];
  const macro_counts = {};
  const macro_counts_visible = {};
  let cur_header_graph_node;
  // Prepare convert options for the child. Copy options so that the
  // toplevel call won't change the input options, but children calls wlil.
  const include_options = Object.assign({}, options);
  include_options.include_path_set = context.include_path_set;
  // Non-indexed-ids: auto-generated numeric ID's like p-1, p-2, etc.
  // It is not possible to link to them from inside the document, since links
  // break across versions.
  if (include_options.non_indexed_ids === undefined) {
    include_options.non_indexed_ids = {};
  }
  if (include_options.indexed_ids === undefined) {
    include_options.indexed_ids = {};
  }
  if (include_options.header_graph_stack === undefined) {
    include_options.header_graph_stack = new Map();
  }
  if (include_options.header_graph_id_stack === undefined) {
    include_options.header_graph_id_stack = new Map();
  }
  let is_first_header = true;
  if (include_options.is_first_global_header === undefined) {
    include_options.is_first_global_header = true;
  }
  let local_id_provider = new DictIdProvider(include_options.indexed_ids);
  let id_provider;
  if (options.id_provider !== undefined) {
    // Remove all remote IDs from the current file, to prevent false duplicates
    // when we start setting those IDs again.
    options.id_provider.clear(options.input_path);
    id_provider = new ChainedIdProvider(
      local_id_provider,
      options.id_provider
    );
  } else {
    id_provider = local_id_provider;
  }
  context.id_provider = id_provider;
  context.include_path_set.add(options.input_path);
  while (todo_visit.length > 0) {
    const [parent_arg, ast] = todo_visit.pop();
    const macro_name = ast.macro_name;
    ast.from_include = options.from_include;
    ast.from_cirodown_example = options.from_cirodown_example;;
    ast.source_location.path = options.input_path;
    if (macro_name === Macro.INCLUDE_MACRO_NAME) {
      let peek_ast = todo_visit[todo_visit.length - 1][1];
      if (peek_ast.node_type === AstType.PLAINTEXT && peek_ast.text == '\n') {
        todo_visit.pop();
      }
      const href = convert_arg_noescape(ast.args.href, context);
      include_options.cur_header.includes.push(href);
      const read_include_ret = options.read_include(href);
      if (read_include_ret === undefined) {
        let message = `could not find include: "${href}"`;
        parse_error(
          state,
          message,
          ast.source_location,
        );
        parent_arg.push(new PlaintextAstNode(ast.source_location, message));
      } else {
        const [include_path, include_content] = read_include_ret;
        if (context.include_path_set.has(include_path)) {
          let message = `circular include detected to: "${include_path}"`;
          parse_error(
            state,
            message,
            ast.source_location,
          );
          parent_arg.push(new PlaintextAstNode(ast.source_location, message));
        } else {
          let new_child_nodes;
          if (options.embed_includes) {
            new_child_nodes = convert_include(
              include_content,
              include_options,
              cur_header_level,
              include_path,
              href,
              {
                errors: extra_returns.errors,
              }
            );
            context.include_path_set.add(include_path);
          } else {
            const target_id_ast = context.id_provider.get(href, context);
            let header_node_title;
            if (target_id_ast === undefined) {
              let message = `ID in include not found on database: "${href}", ` +
                `needed to calculate the cross reference title. Did you forget to convert all files beforehand?`;
              header_node_title = error_message_in_output(message);
              // Don't do an error if we are not going to render, because this is how
              // we extract IDs on the first pass of ./cirodown .
              if (options.render) {
                parse_error(
                  state,
                  message,
                  ast.source_location,
                );
              }
            } else {
              const x_text_options = {
                show_caption_prefix: false,
                style_full: false,
              };
              header_node_title = x_text(target_id_ast, context, x_text_options);
            }
            // Don't merge into a single file, render as a dummy header and an xref link instead.
            const header_ast = new AstNode(
              AstType.MACRO,
              Macro.HEADER_MACRO_NAME,
              {
                'level': new AstArgument(
                  [
                    new PlaintextAstNode(
                      ast.source_location,
                      (cur_header_level + 1).toString(),
                    )
                  ],
                  ast.source_location
                ),
                [Macro.TITLE_ARGUMENT_NAME]: new AstArgument(
                  [
                    new PlaintextAstNode(
                      ast.source_location,
                      header_node_title
                    )
                  ],
                  ast.source_location
                ),
              },
              ast.source_location,
              {
                force_no_index: true,
                from_include: true,
                id: href,
                level: cur_header_level + 1,
              },
            );
            // This is a bit nasty and duplicates the below header processing code,
            // but it is a bit hard to factor them out since this is a magic include header,
            // and all includes and headers must be parsed concurrently since includes get
            // injected under the last header.
            validate_ast(header_ast, context);
            header_ast.header_graph_node = new HeaderTreeNode(header_ast, cur_header_graph_node);
            cur_header_graph_node.add_child(header_ast.header_graph_node);
            new_child_nodes = [
              header_ast,
              new AstNode(
                AstType.PARAGRAPH,
                undefined,
                undefined,
                ast.source_location,
              ),
              new AstNode(
                AstType.MACRO,
                Macro.PARAGRAPH_MACRO_NAME,
                {
                  'content': new AstArgument(
                    [
                      new AstNode(
                        AstType.MACRO,
                        'x',
                        {
                          'href': new AstArgument(
                            [
                              new PlaintextAstNode(
                                ast.source_location,
                                href
                              )
                            ],
                            ast.source_location
                          ),
                          'content': new AstArgument(
                            [
                              new PlaintextAstNode(
                                ast.source_location,
                                'This section is present in another page, follow this link to view it.'
                              )
                            ],
                            ast.source_location
                          ),
                        },
                        ast.source_location,
                        {from_include: true},
                      ),
                    ],
                    ast.source_location
                  ),
                },
                ast.source_location,
                {
                  from_include: true,
                },
              ),
              new AstNode(
                AstType.PARAGRAPH,
                undefined,
                undefined,
                ast.source_location,
              ),
            ];
          }
          // Push all included nodes, but don't recurse because:
          // - all child includes will be resolved on the sub-render call
          // - the current header level must not move, so that consecutive \Include
          //   calls won't nest into one another
          for (const new_child_node of new_child_nodes) {
            new_child_node.parent_node = ast.parent_node;
          }
          parent_arg.push(...new_child_nodes);
        }
      }
    } else if (macro_name === Macro.CIRODOWN_EXAMPLE_MACRO_NAME) {
      parent_arg.push(...[
        new AstNode(
          AstType.MACRO,
          Macro.CODE_MACRO_NAME.toUpperCase(),
          {'content': ast.args.content},
          ast.source_location,
        ),
        new AstNode(
          AstType.MACRO,
          Macro.PARAGRAPH_MACRO_NAME,
          {
            'content': new AstArgument(
              [
                new PlaintextAstNode(
                  ast.source_location,
                  'which renders as:',
                )
              ],
              ast.source_location
            ),
          },
          ast.source_location,
        ),
        new AstNode(
          AstType.MACRO,
          'Q',
          {
            'content': convert_include(
              convert_arg_noescape(ast.args.content, context),
              clone_and_set(options, 'from_cirodown_example', true),
              0,
              options.input_path,
              undefined,
              {
                start_line: ast.source_location.line + 1,
                errors: extra_returns.errors,
              }
            )
          },
          ast.source_location,
        ),
      ]);
    } else {
      if (macro_name === Macro.HEADER_MACRO_NAME) {
        // Required by calculate_id.
        validate_ast(ast, context);

        prev_header = include_options.cur_header;
        include_options.cur_header = ast;
        cur_header_level = parseInt(
          convert_arg_noescape(ast.args.level, context)
        ) + options.h_parse_level_offset;
        let parent_tree_node_error = false;
        let parent_id;
        if (ast.validation_output.parent.given) {
          if (cur_header_level !== 1) {
            const message = `header with parent argument must have level equal 1`;
            ast.args[Macro.TITLE_ARGUMENT_NAME].push(
              new PlaintextAstNode(ast.source_location, ' ' + error_message_in_output(message)));
            parse_error(state, message, ast.args.level.source_location);
          }
          let parent_tree_node;
          parent_id = convert_arg_noescape(ast.args.parent, context);
          if (
            // Happens for the first header
            prev_header !== undefined
          ) {
            let parent_ast;
            if (parent_id[0] === Macro.HEADER_SCOPE_SEPARATOR) {
              parent_ast = context.id_provider.get_noscope(parent_id.substr(1), context);
            } else {
              // We can't use context.id_provider.get here because we don't know who
              // the parent node is, because scope can affect that choice.
              // https://cirosantilli.com/cirodown#id-based-header-levels-and-scope-resolution
              let sorted_keys = [...include_options.header_graph_stack.keys()].sort((a, b) => a - b);
              let largest_level = sorted_keys[sorted_keys.length - 1];
              for (let level = largest_level; level > 0; level--) {
                let ast = include_options.header_graph_stack.get(level).value;
                if (id_is_suffix(parent_id, ast.id)) {
                  parent_ast = ast;
                  break;
                }
              }
            }
            if (parent_ast !== undefined) {
              parent_tree_node = include_options.header_graph_id_stack.get(parent_ast.id);
            }
          }
          if (parent_tree_node === undefined) {
            parent_tree_node_error = true;
          } else {
            cur_header_level = parent_tree_node.get_level() + 1;
          }
        }
        if ('level' in ast.args) {
          // Hack the level argument of the final AST to match for consistency.
          ast.args.level = new AstArgument([
            new PlaintextAstNode(ast.args.level.source_location, cur_header_level.toString())],
            ast.args.level.source_location);
        }

        // Create the header tree.
        if (is_first_header) {
          ast.id = options.toplevel_id;
          if (options.toplevel_has_scope) {
            // TODO why isn't the fake argument below enough?
            ast.validation_output.scope.boolean = true;
            // We also need to fake an argument here, because that will
            // get serialiezd to the database, which his needed for
            // toplevel scope removal from external links.
            const scope_arg = new AstArgument([], ast.source_location);
            ast.args.scope = scope_arg;
            ast.setup_argument('scope', scope_arg);
          }
          if (options.toplevel_parent_scope !== undefined) {
            ast.scope = options.toplevel_parent_scope;
            // We skip calculation of scoped IDs, so gotta do it here.
            ast.id = ast.scope + Macro.HEADER_SCOPE_SEPARATOR + ast.id;
          }
          ast.is_first_header_in_input_file = true;
          is_first_header = false;
        }
        if (include_options.is_first_global_header) {
          first_header = ast;
          first_header_level = cur_header_level;
          header_graph_last_level = cur_header_level - 1;
          include_options.header_graph_stack.set(header_graph_last_level, context.header_graph);
          include_options.is_first_global_header = false;
        }
        cur_header_graph_node = new HeaderTreeNode(ast, include_options.header_graph_stack.get(cur_header_level - 1));
        let header_level_skip_error;
        if (cur_header_level - header_graph_last_level > 1) {
          header_level_skip_error = header_graph_last_level;
        }
        if (cur_header_level < first_header_level) {
          parse_error(
            state,
            `header level ${cur_header_level} is smaller than the level of the first header of the document ${first_header_level}`,
            ast.args.level.source_location,
          );
        }
        const parent_tree_node = include_options.header_graph_stack.get(cur_header_level - 1);
        if (parent_tree_node !== undefined) {
          parent_tree_node.add_child(cur_header_graph_node);
          const parent_ast = parent_tree_node.value;
          if (parent_ast !== undefined) {
            ast.scope = calculate_scope(parent_ast, context);
          }
        }
        const old_graph_node = include_options.header_graph_stack.get(cur_header_level);
        include_options.header_graph_stack.set(cur_header_level, cur_header_graph_node);
        if (
          // Possible on the first insert of a level.
          old_graph_node !== undefined
        ) {
          if (
            // Possible if the level is not an integer.
            old_graph_node.value !== undefined
          ) {
            include_options.header_graph_id_stack.delete(old_graph_node.value.id);
          }
        }
        header_graph_last_level = cur_header_level;
        if (ast.includes.length > 0) {
          context.headers_with_include.push(ast);
        }
        ast.header_graph_node = cur_header_graph_node;

        // Must come after the header tree step is mostly done, because scopes influence ID,
        // and they also depend on the parent node.
        calculate_id(ast, context, include_options.non_indexed_ids, include_options.indexed_ids, macro_counts,
          macro_counts_visible, state, true, line_to_id_array);

        // Now stuff that must come after calculate_id.

        // https://github.com/cirosantilli/cirodown/issues/100
        if (parent_tree_node_error) {
          const message = `header parent either is a previous ID of a level, a future ID, or an invalid ID: ${parent_id}`;
          ast.args[Macro.TITLE_ARGUMENT_NAME].push(
            new PlaintextAstNode(ast.source_location, ' ' + error_message_in_output(message)));
          parse_error(state, message, ast.args.parent.source_location);
        }
        if (header_level_skip_error !== undefined) {
          const message = `skipped a header level from ${header_level_skip_error} to ${cur_header_level}`;
          ast.args[Macro.TITLE_ARGUMENT_NAME].push(
            new PlaintextAstNode(ast.source_location, ' ' + error_message_in_output(message)));
          parse_error(state, message, ast.args.level.source_location);
        }

        include_options.header_graph_id_stack.set(cur_header_graph_node.value.id, cur_header_graph_node);
      }
      // Push this node into the parent argument list.
      // This allows us to skip nodes, or push multiple nodes if needed.
      parent_arg.push(ast);

      // Recurse.
      for (const arg_name in ast.args) {
        let arg = ast.args[arg_name];
        // We make the new argument be empty so that children can
        // decide if they want to push themselves or not.
        const new_arg = new AstArgument([], arg.source_location);
        for (let i = arg.length - 1; i >= 0; i--) {
          todo_visit.push([new_arg, arg[i]]);
        }
        // Update the argument.
        ast.args[arg_name] = new_arg;
      }
    }
  }

  // Post process the AST breadth-first after inclusions are resolved to support things like:
  //
  // - the insane but necessary paragraphs double newline syntax
  // - automatic ul parent to li and table to tr
  // - remove whitespace only text children from ul
  // - extract all IDs into an ID index
  //
  // Normally only the toplevel includer will enter this code section.
  if (!options.from_include) {
    // Calculate header_graph_top_level.
    //
    // - if aa header of this level is present in the document,
    //   there is only one of it. This implies for example that
    //   it does not get numerical prefixes like "1.2.3 My Header".
    //   when rendering, and it does not show up in the ToC.
    if (context.header_graph.children.length === 1) {
      context.header_graph_top_level = first_header_level;
      const toplevel_header_node = context.header_graph.children[0];
      const toplevel_header_ast = toplevel_header_node.value;
      if (toplevel_header_node.children.length > 0) {
        toplevel_header_node.children[0].value.toc_header = true;
      }
      context.toplevel_ast = toplevel_header_ast;
    } else {
      context.header_graph_top_level = first_header_level - 1;
      context.toplevel_ast = undefined;
      if (context.header_graph.children.length > 0) {
        context.header_graph.children[0].value.toc_header = true;
      }
    }

    context.has_toc = false;
    let toplevel_parent_arg = new AstArgument([], new SourceLocation(1, 1));

    // First do a pass that makes any changes to the tree.
    {
      const todo_visit = [[toplevel_parent_arg, ast_toplevel]];
      while (todo_visit.length > 0) {
        let [parent_arg, ast] = todo_visit.pop();
        const macro_name = ast.macro_name;
        const macro = context.macros[macro_name];

        if (macro_name === Macro.TOC_MACRO_NAME) {
          if (ast.from_include || context.has_toc) {
            // Skip.
            continue;
          }
          context.has_toc = true;
        } else if (
          macro_name === Macro.TOPLEVEL_MACRO_NAME &&
          ast.parent_node !== undefined
        ) {
          // Prevent this from happening. When this was committed originally,
          // it actually worked and output an `html` inside another `html`.
          // Maybe we could do something with iframe, but who cares about that?
          const message = `the "${Macro.TOPLEVEL_MACRO_NAME}" cannot be used explicitly`;
          ast = new PlaintextAstNode(ast.source_location, error_message_in_output(message));
          parse_error(state, message, ast.source_location);
        }

        if (
          // These had been validated earlier during header processing.
          macro_name === Macro.HEADER_MACRO_NAME
          && !context.has_toc
        ) {
          if (ast.toc_header) {
            parent_arg.push(new AstNode(
              AstType.MACRO,
              Macro.TOC_MACRO_NAME,
              {},
              ast.source_location,
              {
                parent_node: ast.parent_node
              }
            ));
            context.has_toc = true;
          }
        } else {
          validate_ast(ast, context);
        }

        // Push this node into the parent argument list.
        // This allows us to skip nodes, or push multiple nodes if needed.
        parent_arg.push(ast);

        // Loop over the child arguments. We do this rather than recurse into them
        // to be able to easily remove or add nodes to the tree during this AST
        // post-processing.
        //
        // Here we do sibling-type transformations that need to loop over multiple
        // direct children in one go, such as:
        //
        // - auto add ul to li
        // - remove whitespace only text children from ul
        for (const arg_name in ast.args) {
          // The following passes consecutively update arg.
          let arg = ast.args[arg_name];
          let macro_arg = macro.name_to_arg[arg_name];

          // Handle elide_link_only.
          if (
            // Possible for error nodes.
            macro_arg !== undefined &&
            macro_arg.elide_link_only &&
            arg.length === 1 &&
            arg[0].macro_name === Macro.LINK_MACRO_NAME
          ) {
            const href_arg = arg[0].args.href;
            href_arg.parent_node = ast;
            arg = href_arg;
          }

          // Child loop that adds table tr implicit parents to th and td.
          // This needs to be done on a separate pass before the tr implicit table adding.
          // It is however very similar to the other loop: the only difference is that we eat up
          // a trailing paragraph if followed by another.
          {
            const new_arg = new AstArgument([], arg.source_location);
            for (let i = 0; i < arg.length; i++) {
              let child_node = arg[i];
              let new_child_nodes = [];
              let new_child_nodes_set = false;
              if (child_node.node_type === AstType.MACRO) {
                const child_macro_name = child_node.macro_name;
                if (
                  child_macro_name == Macro.TD_MACRO_NAME ||
                  child_macro_name == Macro.TH_MACRO_NAME
                ) {
                  const auto_parent_name = Macro.TR_MACRO_NAME;
                  const auto_parent_name_macro = state.macros[auto_parent_name];
                  if (
                    ast.macro_name !== auto_parent_name
                  ) {
                    const start_auto_child_node = child_node;
                    const new_arg_auto_parent = new AstArgument([], child_node.source_location);
                    while (i < arg.length) {
                      const arg_i = arg[i];
                      if (arg_i.node_type === AstType.MACRO) {
                        if (
                          arg_i.macro_name == Macro.TD_MACRO_NAME ||
                          arg_i.macro_name == Macro.TH_MACRO_NAME
                        ) {
                          new_arg_auto_parent.push(arg_i);
                        } else {
                          break;
                        }
                      } else if (arg_i.node_type === AstType.PARAGRAPH) {
                        if (i + 1 < arg.length) {
                          const arg_i_next_macro_name = arg[i + 1].macro_name;
                          if (
                            arg_i_next_macro_name == Macro.TD_MACRO_NAME ||
                            arg_i_next_macro_name == Macro.TH_MACRO_NAME
                          ) {
                            // Ignore this paragraph, it is actually only a separator between two \tr.
                            i++;
                          }
                        }
                        break;
                      } else if (
                        auto_parent_name_macro.name_to_arg['content'].remove_whitespace_children &&
                        html_is_whitespace_text_node(arg_i)
                      ) {
                        // Ignore the whitespace node.
                      } else {
                        break;
                      }
                      i++;
                    }
                    new_child_nodes_set = true;
                    new_child_nodes = new AstArgument([new AstNode(
                      AstType.MACRO,
                      auto_parent_name,
                      {
                        'content': new_arg_auto_parent,
                      },
                      start_auto_child_node.source_location,
                      {
                        parent_node: child_node.parent_node
                      }
                    )], child_node.source_location);
                    // Because the for loop will advance past it.
                    i--;
                  }
                }
              }
              if (!new_child_nodes_set) {
                new_child_nodes = [child_node];
              }
              new_arg.push(...new_child_nodes);
            }
            arg = new_arg;
          }

          // Child loop that adds ul and table implicit parents.
          {
            const new_arg = new AstArgument([], arg.source_location);
            for (let i = 0; i < arg.length; i++) {
              let child_node = arg[i];
              let new_child_nodes = [];
              let new_child_nodes_set = false;
              if (
                (arg_name in macro.name_to_arg) &&
                macro.name_to_arg[arg_name].remove_whitespace_children &&
                html_is_whitespace_text_node(child_node)
              ) {
                new_child_nodes_set = true;
              } else if (child_node.node_type === AstType.MACRO) {
                let child_macro_name = child_node.macro_name;
                let child_macro = state.macros[child_macro_name];
                if (child_macro.auto_parent !== undefined) {
                  // Add ul and table implicit parents.
                  const auto_parent_name = child_macro.auto_parent;
                  const auto_parent_name_macro = state.macros[auto_parent_name];
                  if (
                    ast.macro_name !== auto_parent_name &&
                    !child_macro.auto_parent_skip.has(ast.macro_name)
                  ) {
                    const start_auto_child_node = child_node;
                    const new_arg_auto_parent = new AstArgument([], child_node.source_location);
                    while (i < arg.length) {
                      const arg_i = arg[i];
                      if (arg_i.node_type === AstType.MACRO) {
                        if (state.macros[arg_i.macro_name].auto_parent === auto_parent_name) {
                          new_arg_auto_parent.push(arg_i);
                        } else {
                          break;
                        }
                      } else if (
                        auto_parent_name_macro.name_to_arg['content'].remove_whitespace_children &&
                        html_is_whitespace_text_node(arg_i)
                      ) {
                        // Ignore the whitespace node.
                      } else {
                        break;
                      }
                      i++;
                    }
                    new_child_nodes_set = true;
                    new_child_nodes = new AstArgument([new AstNode(
                      AstType.MACRO,
                      auto_parent_name,
                      {
                        'content': new_arg_auto_parent,
                      },
                      start_auto_child_node.source_location,
                      {
                        parent_node: child_node.parent_node
                      }
                    )], child_node.source_location);
                    // Because the for loop will advance past it.
                    i--;
                  }
                }
              }
              if (!new_child_nodes_set) {
                new_child_nodes = [child_node];
              }
              new_arg.push(...new_child_nodes);
            }
            arg = new_arg;
          }

          // Child loop that adds paragraphs.
          {
            let paragraph_indexes = [];
            for (let i = 0; i < arg.length; i++) {
              const child_node = arg[i];
              if (child_node.node_type === AstType.PARAGRAPH) {
                paragraph_indexes.push(i);
              }
            }
            if (paragraph_indexes.length > 0) {
              const new_arg = new AstArgument([], arg.source_location);
              if (paragraph_indexes[0] > 0) {
                parse_add_paragraph(state, ast, new_arg, arg, 0, paragraph_indexes[0], options);
              }
              let paragraph_start = paragraph_indexes[0] + 1;
              for (let i = 1; i < paragraph_indexes.length; i++) {
                const paragraph_index = paragraph_indexes[i];
                parse_add_paragraph(state, ast, new_arg, arg, paragraph_start, paragraph_index, options);
                paragraph_start = paragraph_index + 1;
              }
              if (paragraph_start < arg.length) {
                parse_add_paragraph(state, ast, new_arg, arg, paragraph_start, arg.length, options);
              }
              arg = new_arg;
            }
          }

          // Push children to continue the search. We make the new argument be empty
          // so that children can decide if they want to push themselves or not.
          {
            const new_arg = new AstArgument([], arg.source_location);
            for (let i = arg.length - 1; i >= 0; i--) {
              todo_visit.push([new_arg, arg[i]]);
            }
            // Update the argument.
            ast.args[arg_name] = new_arg;
          }
        }
      }
    }

    // Now do a pass that collects information that may be affected by
    // the tree modifications of the previous step, e.g. ID generation.
    {
      const todo_visit = [ast_toplevel];
      while (todo_visit.length > 0) {
        let ast = todo_visit.pop();
        const macro_name = ast.macro_name;
        const macro = context.macros[macro_name];

        if (macro_name === Macro.HEADER_MACRO_NAME) {
          // TODO start with the toplevel.
          cur_header_graph_node = ast.header_graph_node;
        } else {
          ast.header_graph_node = new HeaderTreeNode(ast, cur_header_graph_node);
          if (cur_header_graph_node !== undefined) {
            ast.scope = calculate_scope(cur_header_graph_node.value, context);
          }
        }

        if (
          // Header IDs already previously calculated for parent=.
          macro_name !== Macro.HEADER_MACRO_NAME
        ) {
          calculate_id(ast, context, include_options.non_indexed_ids, include_options.indexed_ids, macro_counts,
            macro_counts_visible, state, false, line_to_id_array);
        }

        // Push children to continue the search. We make the new argument be empty
        // so that children can decide if they want to push themselves or not.
        for (const arg_name in ast.args) {
          const arg = ast.args[arg_name];
          for (let i = arg.length - 1; i >= 0; i--) {
            todo_visit.push(arg[i]);
          }
        }
      }
    }
  }
  extra_returns.ids = include_options.indexed_ids;
  const first_toplevel_child = ast_toplevel.args.content[0];
  if (first_toplevel_child !== undefined) {
    first_toplevel_child.first_toplevel_child = true;
  }

  context.line_to_id = function(line) {
    let index = binary_search(line_to_id_array,
      [line, undefined], binary_search_line_to_id_array_fn);
    if (index < 0) {
      index = -(index + 1)
    }
    if (index == line_to_id_array.length) {
      if (line_to_id_array.length > 0) {
        index = line_to_id_array.length - 1;
      } else {
        return undefined;
      }
    }
    return line_to_id_array[index][1];
  };

  return ast_toplevel;
}

// Maybe add a paragraph after a \n\n.
function parse_add_paragraph(
  state, ast, new_arg, arg, paragraph_start, paragraph_end, options
) {
  parse_log_debug(state, 'function: parse_add_paragraph');
  parse_log_debug(state, 'paragraph_start: ' + paragraph_start);
  parse_log_debug(state, 'paragraph_end: ' + paragraph_end);
  parse_log_debug(state);
  if (paragraph_start < paragraph_end) {
    const macro = state.macros[arg[paragraph_start].macro_name];
    const slice = arg.slice(paragraph_start, paragraph_end);
    if (macro.options.phrasing || slice.length > 1) {
      // If the first element after the double newline is phrasing content,
      // create a paragraph and put all elements until the next paragraph inside
      // that paragraph.
      new_arg.push(
        new AstNode(
          AstType.MACRO,
          Macro.PARAGRAPH_MACRO_NAME,
          {
            'content': slice
          },
          arg[paragraph_start].source_location,
          {
            parent_node: ast,
          }
        )
      );
    } else {
      // Otherwise, don't create the paragraph, and keep all elements as they were.
      new_arg.push(...slice);
    }
  }
}

// Consume one token.
function parse_consume(state) {
  state.i += 1;
  if (state.i < state.tokens.length) {
    state.token = state.tokens[state.i];
  } else {
    throw new Error('programmer error');
  }
  parse_log_debug(state, 'function: parse_consume');
  parse_log_debug(state, 'state.i = ' + state.i.toString())
  parse_log_debug(state, 'state.token = ' + JSON.stringify(state.token));
  parse_log_debug(state);
  return state.token;
}

function parse_log_debug(state, msg='') {
  if (state.options.log.parse) {
    console.error('parse: ' + msg);
  }
}

// Input: e.g. in `\Image[img.jpg]{height=123}` this parses the `[img.jpg]{height=123}`.
// Return value: dict with arguments.
function parse_argument_list(state, macro_name, macro_type) {
  parse_log_debug(state, 'function: parse_argument_list');
  parse_log_debug(state, 'state = ' + JSON.stringify(state.token));
  parse_log_debug(state);
  const args = {};
  const macro = state.macros[macro_name];
  let positional_arg_count = 0;
  while (
    // End of stream.
    state.token.type !== TokenType.INPUT_END &&
    (
      state.token.type === TokenType.POSITIONAL_ARGUMENT_START ||
      state.token.type === TokenType.NAMED_ARGUMENT_START
    )
  ) {
    let arg_name;
    let open_token = state.token;
    // Consume the *_ARGUMENT_START token out.
    parse_consume(state);
    if (open_token.type === TokenType.POSITIONAL_ARGUMENT_START) {
      if (macro_type === AstType.ERROR) {
        arg_name = positional_arg_count.toString();
      } else {
        if (positional_arg_count >= macro.positional_args.length) {
          parse_error(state,
            `unknown named macro argument "${arg_name}" of macro "${macro_name}"`,
            open_token.source_location,
          );
          arg_name = positional_arg_count.toString();
        } else {
          arg_name = macro.positional_args[positional_arg_count].name;
        }
        positional_arg_count += 1;
      }
    } else {
      // Named argument.
      arg_name = state.token.value;
      if (macro_type !== AstType.ERROR && !(arg_name in macro.named_args)) {
        parse_error(state,
          `unknown named macro argument "${arg_name}" of macro "${macro_name}"`,
          state.token.source_location
        );
      }
      // Parse the argument name out.
      parse_consume(state);
    }
    const arg_children = parse_argument(state, open_token.source_location);
    if (state.token.type !== closing_token(open_token.type)) {
      parse_error(state, `unclosed argument "${open_token.value}"`, open_token.source_location);
    }
    if (arg_name in args) {
      // https://github.com/cirosantilli/cirodown/issues/101
      parse_error(state,
        `named argument "${arg_name}" given multiple times`,
        open_token.source_location,
      );
    } else {
      args[arg_name] = arg_children;
    }
    if (state.token.type !== TokenType.INPUT_END) {
      // Consume the *_ARGUMENT_END token out.
      parse_consume(state);
    }
  }
  return args;
}

/**
 * Input: e.g. in `\Image[img.jpg]{height=123}` this parses the `img.jpg` and the `123`.
 * @return AstArgument
 */
function parse_argument(state, open_argument_source_location) {
  const arg_children = new AstArgument([], open_argument_source_location);
  while (
    state.token.type !== TokenType.INPUT_END &&
    state.token.type !== TokenType.POSITIONAL_ARGUMENT_END &&
    state.token.type !== TokenType.NAMED_ARGUMENT_END
  ) {
    // The recursive case: the argument is a lists of macros, go into all of them.
    arg_children.push(parse_macro(state));
  }
return arg_children;
}

// Parse one macro. This is the centerpiece of the parsing!
// Input: e.g. in `\Image[img.jpg]{height=123}` this parses the entire string.
function parse_macro(state) {
  parse_log_debug(state, 'function: parse_macro');
  parse_log_debug(state, 'state = ' + JSON.stringify(state.token));
  parse_log_debug(state);
  if (state.token.type === TokenType.MACRO_NAME) {
    const macro_name = state.token.value;
    const macro_source_location = state.token.source_location;
    let macro_type;
    const unknown_macro_message = `unknown macro name: "${macro_name}"`;
    if (macro_name in state.macros) {
      macro_type = AstType.MACRO;
    } else {
      macro_type = AstType.ERROR;
      parse_error(state, unknown_macro_message);
    }
    // Consume the MACRO_NAME token out.
    parse_consume(state);
    const args = parse_argument_list(state, macro_name, macro_type);
    if (macro_type === AstType.ERROR) {
      return new AstNode(
        macro_type,
        Macro.PLAINTEXT_MACRO_NAME,
        {},
        state.token.source_location,
        {text: error_message_in_output(unknown_macro_message)},
      );
    } else {
      return new AstNode(macro_type, macro_name, args, macro_source_location);
    }
  } else if (state.token.type === TokenType.PLAINTEXT) {
    // Non-recursive case.
    let node = new PlaintextAstNode(
      state.token.source_location,
      state.token.value,
    );
    // Consume the PLAINTEXT node out.
    parse_consume(state);
    return node;
  } else if (state.token.type === TokenType.PARAGRAPH) {
    let node = new AstNode(
      AstType.PARAGRAPH,
      undefined,
      undefined,
      state.token.source_location,
    );
    // Consume the PLAINTEXT node out.
    parse_consume(state);
    return node;
  } else {
    let error_message
    if (
      state.token.type === TokenType.POSITIONAL_ARGUMENT_START ||
      state.token.type === TokenType.NAMED_ARGUMENT_START
    ) {
      error_message = `stray open argument character: '${state.token.value}', maybe you want to escape it with '\\'`;
    } else {
      // Generic error message.
      error_message = `unexpected token ${state.token.type.toString()}`;
    }
    parse_error(state, error_message);
    let node = new PlaintextAstNode(
      state.token.source_location,
      error_message_in_output(error_message),
    );
    // Consume past whatever happened to avoid an infinite loop.
    parse_consume(state);
    return node;
  }
  state.i += 1;
}

function parse_error(state, message, source_location) {
  let new_source_location;
  if (source_location === undefined) {
    new_source_location = new SourceLocation();
  } else {
    new_source_location = source_location.clone();
  }
  new_source_location.path = state.options.input_path;
  if (new_source_location.line === undefined)
    new_source_location.line = state.token.source_location.line;
  if (new_source_location.column === undefined)
    new_source_location.column = state.token.source_location.column;
  state.extra_returns.errors.push(new ErrorMessage(
    message, new_source_location));
}

function path_join(dirname, basename, sep) {
  let ret = dirname;
  if (ret !== '') {
    ret += sep;
  }
  return ret + basename;
}

function path_split(str, sep) {
  const dir_sep_index = str.lastIndexOf(sep)
  if (dir_sep_index == -1) {
    return ['', str];
  } else {
    return [str.substring(0, dir_sep_index), str.substr(dir_sep_index + 1)];
  }
}

function protocol_is_known(src) {
  for (const known_url_protocol of KNOWN_URL_PROTOCOLS) {
    if (src.startsWith(known_url_protocol)) {
      return true;
    }
  }
  return false;
}

// https://cirosantilli.com/cirodown#scope
function remove_toplevel_scope(id, toplevel_ast, context) {
  if (
    toplevel_ast !== undefined &&
    id === toplevel_ast.id
  ) {
    if (toplevel_ast.scope !== undefined) {
      return id.substr(toplevel_ast.scope.length + 1);
    }
    return id;
  } else {
    return id.substr(calculate_scope_length(toplevel_ast, context));
  }
}

// https://cirosantilli.com/cirodown#index-files
const INDEX_BASENAME_NOEXT = 'index';
exports.INDEX_BASENAME_NOEXT = INDEX_BASENAME_NOEXT;
const INDEX_FILE_BASENAMES_NOEXT = new Set([
  'README',
  INDEX_BASENAME_NOEXT,
]);
exports.INDEX_FILE_BASENAMES_NOEXT = INDEX_FILE_BASENAMES_NOEXT;
const IO_RENAME_MAP = {};
for (let i of INDEX_FILE_BASENAMES_NOEXT) {
  IO_RENAME_MAP[i] = INDEX_BASENAME_NOEXT;
}
exports.IO_RENAME_MAP = IO_RENAME_MAP;
function rename_basename(original) {
  if (original in IO_RENAME_MAP) {
    return IO_RENAME_MAP[original];
  } else {
    return original;
  }
}

function render_error(context, message, source_location) {
  context.errors.push(new ErrorMessage(message, source_location));
}

// Fuck JavaScript? Can't find a built-in way to get the symbol string without the "Symbol(" part.
// https://stackoverflow.com/questions/30301728/get-the-description-of-a-es6-symbol
function symbol_to_string(symbol) {
  return symbol.toString().slice(7, -1);
}

/** TODO correct unicode aware algorithm. */
function title_to_id(title) {
  const new_chars = [];
  for (let c of title) {
    c = c.toLowerCase();
    if (!is_ascii(c) || /[a-z0-9-]/.test(c)) {
      new_chars.push(c);
    } else {
      new_chars.push(ID_SEPARATOR);
    }
  }
  return new_chars.join('')
    .replace(new RegExp(ID_SEPARATOR + '+', 'g'), ID_SEPARATOR)
    .replace(new RegExp('^' + ID_SEPARATOR + '+'), '')
    .replace(new RegExp(ID_SEPARATOR + '+$'), '')
  ;
}
exports.title_to_id = title_to_id;

/** Factored out calculations of the ID that is given to each TOC entry.
 *
 * For after everything broke down due to toplevel scope.
 */
function toc_id(target_id_ast, context) {
  return Macro.TOC_PREFIX + target_id_ast.id;
}

function unconvertible() {
  return function(ast, context) {
    throw new Error(`programmer error, macro "${ast.macro_name}" must never render`);
  };
}

function url_basename(str) {
  return basename(str, URL_SEP);
}

// Do some error checking. If no errors are found, convert normally. Save output on out.
function validate_ast(ast, context) {
  const macro_name = ast.macro_name;
  const macro = context.macros[macro_name];
  const name_to_arg = macro.name_to_arg;
  // First pass sets defaults on missing arguments.
  for (const argname in name_to_arg) {
    ast.validation_output[argname] = {};
    const macro_arg = name_to_arg[argname];
    if (argname in ast.args) {
      ast.validation_output[argname].given = true;
    } else {
      ast.validation_output[argname].given = false;
      if (macro_arg.mandatory) {
        ast.validation_error = [
          `missing mandatory argument ${argname} of ${ast.macro_name}`,
          ast.source_location,
        ];
      }
      if (macro_arg.default !== undefined) {
        ast.args[argname] = new AstArgument([new PlaintextAstNode(ast.source_location, macro_arg.default)]);
      } else if (macro_arg.boolean) {
        ast.args[argname] = new AstArgument([new PlaintextAstNode(ast.source_location, '0')]);
      }
    }
  }
  // Second pass processes the values including defaults.
  for (const argname in name_to_arg) {
    const macro_arg = name_to_arg[argname];
    if (argname in ast.args) {
      const arg = ast.args[argname];
      if (macro_arg.boolean) {
        let arg_string;
        if (arg.length > 0) {
          arg_string = convert_arg_noescape(arg, context);
        } else {
          arg_string = '1';
        }
        if (arg_string === '0') {
          ast.validation_output[argname].boolean = false;
        } else if (arg_string === '1') {
          ast.validation_output[argname].boolean = true;
        } else {
          ast.validation_output[argname].boolean = false;
          ast.validation_error = [
            `boolean argument "${argname}" of "${ast.macro_name}" has invalid value: "${arg_string}", only "0" and "1" are allowed`,
            arg.source_location
          ];
          break;
        }
      }
      if (macro_arg.positive_nonzero_integer) {
        const arg_string = convert_arg_noescape(arg, context);
        const int_value = parseInt(arg_string);
        ast.validation_output[argname]['positive_nonzero_integer'] = int_value;
        if (!Number.isInteger(int_value) || !(int_value > 0)) {
          ast.validation_error = [
            `argument "${argname}" of macro "${ast.macro_name}" must be a positive non-zero integer, got: "${arg_string}"`,
            arg.source_location
          ];
          break;
        }
      }
    }
  }
  if (!macro.options.xss_safe && !context.options.xss_unsafe) {
    ast.validation_error = [
      `XSS unsafe macro "${macro_name}" used in safe mode: https://cirosantilli.com/cirodown#xss-unsafe`,
      ast.source_location
    ];
  }
}
exports.validate_ast = validate_ast;

/**
 * @return {[String, String]} [href, content] pair for the x node.
 */
function x_get_href_content(ast, context) {
  const target_id = convert_arg_noescape(ast.args.href, context);
  if (target_id[0] === AT_MENTION_CHAR) {
    return [html_attr('href', WEBSITE_URL + target_id.substr(1)), target_id];
  }
  if (target_id[0] === HASHTAG_CHAR) {
    return [html_attr('href', WEBSITE_URL + 'notuser/' + target_id.substr(1)), target_id];
  }
  const target_id_ast = context.id_provider.get(target_id, context, ast.header_graph_node);
  let href;
  if (target_id_ast === undefined) {
    let message = `cross reference to unknown id: "${target_id}"`;
    render_error(context, message, ast.args.href.source_location);
    return [href, error_message_in_output(message, context)];
  } else {
    href = x_href_attr(target_id_ast, context);
  }
  const content_arg = ast.args.content;
  let content;
  if (content_arg === undefined) {
    // No explicit content given, deduce content from target ID title.
    if (context.id_conversion) {
      if (context.id_conversion_for_header) {
        // Inside a header title that does not have an ID.
        context.extra_returns.id_conversion_header_title_no_id_xref = true;
        context.extra_returns.id_conversion_xref_error_source_location = ast.source_location;
        return '';
      }
      if (target_id_ast.macro_name !== Macro.HEADER_MACRO_NAME) {
        // Inside a non-header title that does not have an ID and links to a non-header.
        context.extra_returns.id_conversion_non_header_no_id_xref_non_header = true;
        context.extra_returns.id_conversion_xref_error_source_location = ast.source_location;
        return '';
      }
    }
    if (context.x_parents.has(ast)) {
      // Prevent render infinite loops.
      let message = `x with infinite recursion`;
      render_error(context, message, ast.source_location);
      return [href, error_message_in_output(message, context)];
    }
    let x_text_options = {
      caption_prefix_span: false,
      capitalize: ast.validation_output.c.boolean,
      from_x: true,
      quote: true,
      pluralize: ast.validation_output.p.given ? ast.validation_output.p.boolean : undefined,
    };
    if (ast.validation_output.full.given) {
      x_text_options.style_full = ast.validation_output.full.boolean;
    }
    const x_parents_new = new Set(context.x_parents);
    x_parents_new.add(ast);
    content = x_text(target_id_ast, clone_and_set(context, 'x_parents', x_parents_new), x_text_options);
    if (content === ``) {
      let message = `empty cross reference body: "${target_id}"`;
      render_error(context, message, ast.source_location);
      return error_message_in_output(message, context);
    }
  } else {
    // Explicit content given, just use it then.
    content = convert_arg(content_arg, context);
  }
  return [href, content];
}

/** Calculate the href value to a given target AstNode.
 *
 * This takes into account e.g. if the target node is in a different source file:
 * https://cirosantilli.com/cirodown#internal-cross-file-references
 *
 * @param {AstNode} target_id_ast
 * @return {String} the value of href (no quotes) that an \x cross reference to the given target_id_ast
 */
function x_href(target_id_ast, context) {
  const [href_path, fragment] = x_href_parts(target_id_ast, context);
  let ret = href_path;
  if (fragment !== '')
    ret += '#' + fragment;
  return ret;
}

/* This is the centerpiece of x href calculation! */
function x_href_parts(target_id_ast, context) {
  if (target_id_ast.macro_name === Macro.TOC_MACRO_NAME) {
    // Otherwise, split header ToCs would link to the toplevel source ToC,
    // since split header ToCs are not really properly registered.
    return ['', Macro.TOC_ID];
  }

  // href_path
  let href_path;
  const target_input_path = target_id_ast.source_location.path;
  if (
    target_id_ast.source_location.path === undefined ||
    context.toplevel_output_path === undefined ||
    (
      !context.in_split_headers &&
      context.to_split_headers === undefined &&
      context.include_path_set.has(target_input_path)
    )
  ) {
    href_path = '';
  } else {
    const [toplevel_output_path_dirname, toplevel_output_path_basename] =
      path_split(context.toplevel_output_path, context.options.path_sep);
    let [
      full_output_path,
      target_output_path_dirname,
      target_output_path_basename
    ] = output_path_from_ast(
      target_id_ast,
      context,
    );
    if (full_output_path === context.toplevel_output_path) {
      href_path = ''
    } else {
      const href_path_dirname_rel = path.relative(
        toplevel_output_path_dirname, target_output_path_dirname);
      if (
        // Same output path.
        href_path_dirname_rel === '' &&
        target_output_path_basename === toplevel_output_path_basename
      ) {
        target_output_path_basename = '';
      } else {
        if (context.options.html_x_extension) {
          target_output_path_basename += '.' + HTML_EXT;
        } else if (target_output_path_basename === INDEX_BASENAME_NOEXT) {
          if (href_path_dirname_rel === '') {
            target_output_path_basename = '.';
          } else {
            target_output_path_basename = '';
          }
        }
      }
      href_path = path_join(href_path_dirname_rel,
        target_output_path_basename, context.options.path_sep);
    }
  }

  // Fragment
  const to_split_headers = (
    (context.to_split_headers === undefined && context.in_split_headers) ||
    (context.to_split_headers !== undefined && context.to_split_headers)
  );
  let fragment;
  if (
    // Linking to a toplevel ID.
    target_id_ast.first_toplevel_child ||
    // Linking towards a split header.
    (
      target_id_ast.macro_name === Macro.HEADER_MACRO_NAME &&
      to_split_headers
    ) ||
    // Linking to the toplevel of the current output path.
    (
      target_id_ast.id === context.options.toplevel_id &&
      // Linking from a split header to the corresponding nonsplit one.
      !(
        context.to_split_headers !== undefined &&
        !context.to_split_headers
      )
    )
  ) {
    // An empty href means the beginning of the page.
    fragment = '';
  } else {
    let toplevel_ast;
    if (to_split_headers) {
      // We know not a header target, as that would have been caught previously.
      toplevel_ast = target_id_ast.get_header_parent(context);
    } else if (
      // The header was included inline into the current file.
      context.include_path_set.has(target_input_path) // ||
      // The header is in the current file.
      //target_input_path == context.options.input_path
    ) {
      toplevel_ast = context.toplevel_ast;
    } else {
      const file_provider_ret = context.options.file_provider.get(target_input_path);
      if (file_provider_ret === undefined) {
        let message = `file not found on database: "${target_input_path}", needed for toplevel scope removal`;
        render_error(context, message, target_id_ast.source_location);
        return error_message_in_output(message, context);
      } else {
        toplevel_ast = context.id_provider.get(file_provider_ret.toplevel_id, context);
      }
    }
    fragment = remove_toplevel_scope(target_id_ast.id, toplevel_ast, context);
  }

  // return
  return [html_escape_attr(href_path), html_escape_attr(fragment)];
}

/* href="" that links to a given node. */
function x_href_attr(target_id_ast, context) {
  return html_attr('href', x_href(target_id_ast, context));
}

/**
 * Calculate the text of a cross reference, or the text
 * that the caption text that cross references can refer to, e.g.
 * "Table 123. My favorite table". Both are done in a single function
 * so that style_full references will show very siimlar to the caption
 * they refer to.
 *
 * @param {Object} options
 * @param {Object} href_prefix rendered string containing the href="..."
 *   part of a link to self to be applied e.g. to <>Figure 1<>, of undefined
 *   if this link should not be given.
 */
function x_text(ast, context, options={}) {
  if (!('caption_prefix_span' in options)) {
    options.caption_prefix_span = true;
  }
  if (!('quote' in options)) {
    options.quote = false;
  }
  if (!('fixed_capitalization' in options)) {
    options.fixed_capitalization = true;
  }
  if (!('href_prefix' in options)) {
    options.href_prefix = undefined;
  }
  if (!('force_separator' in options)) {
    options.force_separator = false;
  }
  if (!('from_x' in options)) {
    options.from_x = false;
  }
  if (!('pluralize' in options)) {
    // true: make plural
    // false: make singular
    // undefined: don't touch it
    options.pluralize = undefined;
  }
  if (!('show_caption_prefix' in options)) {
    options.show_caption_prefix = true;
  }
  if (!('show_number' in options)) {
    options.show_number = true;
  }
  const macro = context.macros[ast.macro_name];
  let style_full;
  if ('style_full' in options) {
    style_full = options.style_full;
  } else {
    style_full = macro.options.default_x_style_full;
  }
  let ret = ``;
  let number;
  if (style_full) {
    if (options.href_prefix !== undefined) {
      ret += `<a${options.href_prefix}>`
    }
    if (options.show_caption_prefix) {
      if (options.caption_prefix_span) {
        ret += `<span class="caption-prefix">`;
      }
      ret += `${macro.options.caption_prefix} `;
    }
    if (options.show_number) {
      number = macro.options.get_number(ast, context);
      if (number !== undefined) {
        ret += number;
      }
    }
    if (options.show_caption_prefix && options.caption_prefix_span) {
      ret += `</span>`;
    }
    if (options.href_prefix !== undefined) {
      ret += `</a>`
    }
  }
  let title_arg = macro.options.get_title_arg(ast, context);
  if (
    (
      (title_arg !== undefined && style_full) ||
      options.force_separator
    ) &&
    number !== undefined
  ) {
    ret += html_escape_context(context, `. `);
  }
  if (
    title_arg !== undefined
  ) {
    if (style_full && options.quote) {
      ret += html_escape_context(context, `"`);
    }
    // https://cirosantilli.com/cirodown#cross-reference-title-inflection
    if (options.from_x) {

      // {c}
      let first_ast = title_arg[0];
      if (
        ast.macro_name === Macro.HEADER_MACRO_NAME &&
        !ast.validation_output.c.boolean &&
        !style_full &&
        first_ast.node_type === AstType.PLAINTEXT
      ) {
        // https://stackoverflow.com/questions/41474986/how-to-clone-a-javascript-es6-class-instance
        title_arg = new AstArgument(title_arg, title_arg.source_location);
        title_arg[0] = new PlaintextAstNode(first_ast.source_location, first_ast.text);
        let txt = title_arg[0].text;
        let first_c = txt[0];
        if (options.capitalize) {
          first_c = first_c.toUpperCase();
        } else {
          first_c = first_c.toLowerCase();
        }
        title_arg[0].text = first_c + txt.substring(1);
      }

      // {p}
      let last_ast = title_arg[title_arg.length - 1];
      if (
        options.pluralize !== undefined &&
        !style_full &&
        first_ast.node_type === AstType.PLAINTEXT
      ) {
        title_arg = new AstArgument(title_arg, title_arg.source_location);
        title_arg[title_arg.length - 1] = new PlaintextAstNode(last_ast.source_location, last_ast.text);
        title_arg[title_arg.length - 1].text = pluralize(last_ast.text, options.pluralize ? 2 : 1);
      }
    }
    ret += convert_arg(title_arg, context);
    if (style_full) {
      const disambiguate_arg = ast.args[Macro.DISAMBIGUATE_ARGUMENT_NAME];
      const title2_arg = ast.args[Macro.TITLE2_ARGUMENT_NAME];
      const show_disambiguate = (disambiguate_arg !== undefined) && macro.options.show_disambiguate;
      if (show_disambiguate || title2_arg !== undefined) {
        ret += ' (';
        if (title2_arg !== undefined) {
          ret += convert_arg(title2_arg, context);
        }
        if (show_disambiguate) {
          if (title2_arg !== undefined) {
            ret += ', ';
          }
          ret += convert_arg(disambiguate_arg, context);
        }
        ret += ')';
      }
      if (options.quote) {
        ret += html_escape_context(context, `"`);
      }
    }
  }
  return ret;
}

// Dynamic website stuff.
const AT_MENTION_CHAR = '@';
const HASHTAG_CHAR = '#';
const WEBSITE_URL = 'https://hostname.com/';

const END_NAMED_ARGUMENT_CHAR = '}';
const END_POSITIONAL_ARGUMENT_CHAR = ']';
const ESCAPE_CHAR = '\\';
const HTML_ASCII_WHITESPACE = new Set([' ', '\r', '\n', '\f', '\t']);
const HTML_EXT = 'html';
exports.HTML_EXT = HTML_EXT;
const ID_SEPARATOR = '-';
const INSANE_LIST_START = '* ';
const INSANE_TD_START = '| ';
const INSANE_TH_START = '|| ';
const INSANE_LIST_INDENT = '  ';
const INSANE_HEADER_CHAR = '=';
const LOG_OPTIONS = new Set([
  'ast-inside',
  'parse',
  'split-headers',
  'tokens-inside',
  'tokenize',
]);
exports.LOG_OPTIONS = LOG_OPTIONS;
const OUTPUT_FORMAT_CIRODOWN = 'cirodown';
const OUTPUT_FORMAT_HTML = 'html';
const OUTPUT_FORMAT_ID = 'id';
const TOC_ARROW_HTML = '<div class="arrow"><div></div></div>';
const TOC_HAS_CHILD_CLASS = 'has-child';
const MAGIC_CHAR_ARGS = {
  '$': Macro.MATH_MACRO_NAME,
  '`': Macro.CODE_MACRO_NAME,
}
const NAMED_ARGUMENT_EQUAL_CHAR = '=';
const START_NAMED_ARGUMENT_CHAR = '{';
const START_POSITIONAL_ARGUMENT_CHAR = '[';
const ESCAPABLE_CHARS = new Set([
  ESCAPE_CHAR,
  START_POSITIONAL_ARGUMENT_CHAR,
  END_POSITIONAL_ARGUMENT_CHAR,
  START_NAMED_ARGUMENT_CHAR,
  END_NAMED_ARGUMENT_CHAR,
  INSANE_LIST_START[0],
  INSANE_TD_START[0],
]);
const INSANE_STARTS_TO_MACRO_NAME = {
  [INSANE_LIST_START]:  Macro.LIST_MACRO_NAME,
  [INSANE_TD_START]: Macro.TD_MACRO_NAME,
  [INSANE_TH_START]: Macro.TH_MACRO_NAME,
};
for (const c in MAGIC_CHAR_ARGS) {
  ESCAPABLE_CHARS.add(c);
}
const AstType = make_enum([
  // An in-output error message.
  'ERROR',
  // The most regular and non-magic nodes.
  // Most nodes are of this type.
  'MACRO',
  // A node that contains only text, and no subnodes.
  'PLAINTEXT',
  // Paragraphs are basically MACRO, but with some special
  // magic because of the double newline madness treatment.
  'PARAGRAPH',
]);
const TokenType = make_enum([
  'INPUT_END',
  'MACRO_NAME',
  'NAMED_ARGUMENT_END',
  'NAMED_ARGUMENT_NAME',
  'NAMED_ARGUMENT_START',
  'PARAGRAPH',
  'PLAINTEXT',
  'POSITIONAL_ARGUMENT_END',
  'POSITIONAL_ARGUMENT_START',
]);
const DEFAULT_MEDIA_HEIGHT = 315;
const MACRO_IMAGE_VIDEO_NAMED_ARGUMENTS = [
  new MacroArgument({
    name: Macro.TITLE_ARGUMENT_NAME,
  }),
  new MacroArgument({
    name: 'description',
  }),
  new MacroArgument({
    name: 'height',
    default: DEFAULT_MEDIA_HEIGHT.toString(),
    positive_nonzero_integer: true,
  }),
  new MacroArgument({
    name: 'provider',
  }),
  new MacroArgument({
    name: 'source',
    elide_link_only: true,
  }),
  new MacroArgument({
    name: 'titleFromSrc',
    boolean: true,
  }),
  new MacroArgument({
    name: 'width',
    positive_nonzero_integer: true,
  }),
];

/**
 * Calculate a bunch of default parameters of the media from smart defaults if not given explicitly
 *
 * @return {Object}
 *         MediaProviderType {MediaProviderType} , e.g. type, src, source.
 */
function macro_image_video_resolve_params(ast, context) {
  let error_message;
  let media_provider_type;
  let src = convert_arg_noescape(ast.args.src, context);
  let is_url;

  // Provider explicitly given by user on macro.
  if (ast.validation_output.provider.given) {
    const provider_name = convert_arg_noescape(ast.args.provider, context);
    if (MEDIA_PROVIDER_TYPES.has(provider_name)) {
      media_provider_type = provider_name;
    } else {
      error_message = `unknown media provider: "${html_escape_attr(provider_name)}"`;
      render_error(context, error_message, ast.args.provider.source_location);
      media_provider_type = 'unknown';
    }
  }

  // Otherwise, detect the media provider.
  let media_provider_type_detected;
  if (src.match(media_provider_type_wikimedia_re)) {
    media_provider_type_detected = 'wikimedia';
  } else if (src.match(media_provider_type_youtube_re)) {
    media_provider_type_detected = 'youtube';
  } else if (protocol_is_known(src)) {
    // Full URL to a website we know nothing about.
    media_provider_type_detected = 'unknown';
  }

  if (media_provider_type_detected === undefined) {
    if (media_provider_type === undefined) {
      // Relative URL, use the default provider if any.
      media_provider_type = context.media_provider_default[ast.macro_name];
    }
    is_url = false;
  } else {
    if (media_provider_type !== undefined && media_provider_type !== media_provider_type_detected) {
      error_message = `detected media provider type "${media_provider_type_detected}", but user also explicitly gave "${media_provider_type}"`;
      render_error(context, error_message, ast.args.provider.source_location);
    }
    if (media_provider_type === undefined) {
      media_provider_type = media_provider_type_detected;
    }
    is_url = true;
  }

  // Fixup src depending for certain providers.
  if (media_provider_type === 'local') {
    const path = context.options.cirodown_json['media-providers'].local.path;
    if (path !== '') {
      src = path + URL_SEP + src;
    }
  } else if (media_provider_type === 'github') {
    src = `https://raw.githubusercontent.com/${context.options.cirodown_json['media-providers'].github.remote}/master/${src}`;
  }

  return {
    error_message: error_message,
    media_provider_type: media_provider_type,
    is_url: is_url,
    src: src,
  }
}

function macro_image_video_resolve_params_with_source(ast, context) {
  const ret = macro_image_video_resolve_params(ast, context);
  ret.source = context.macros[ast.macro_name].options.source_func(
    ast, context, ret.src, ret.media_provider_type, ret.is_url);
  return ret;
}

const MACRO_IMAGE_VIDEO_OPTIONS = {
  caption_number_visible: function (ast, context) {
    return 'description' in ast.args ||
      macro_image_video_resolve_params_with_source(ast, context).source !== '';
  },
  get_title_arg: function(ast, context) {
    // Title given explicitly.
    if (ast.validation_output[Macro.TITLE_ARGUMENT_NAME].given) {
      return ast.args[Macro.TITLE_ARGUMENT_NAME];
    }

    // Title from src.
    const media_provider_type = macro_image_video_resolve_params(ast, context).media_provider_type;
    if (
      ast.validation_output.titleFromSrc.boolean ||
      (
        !ast.validation_output.titleFromSrc.given &&
        context.options.cirodown_json['media-providers'][media_provider_type]['title-from-src']
      )
    ) {
      let basename_str;
      let src = convert_arg(ast.args.src, context);
      if (media_provider_type === 'local') {
        basename_str = url_basename(src);
      } else if (media_provider_type === 'wikimedia') {
        basename_str = context.macros[ast.macro_name].options.image_video_basename(src);
      } else {
        basename_str = src;
      }
      let title_str = basename_str.replace(/_/g, ' ').replace(/\.[^.]+$/, '') + '.';
      return new AstArgument([new PlaintextAstNode(
        ast.source_location, title_str)], ast.source_location);
    }

    // We can't automatically generate one at all.
    return undefined;
  }
}
const MACRO_IMAGE_VIDEO_POSITIONAL_ARGUMENTS = [
  new MacroArgument({
    name: 'src',
    elide_link_only: true,
    mandatory: true,
  }),
  new MacroArgument({
    name: 'alt',
  }),
];
// https://cirosantilli.com/cirodown#known-url-protocols
const KNOWN_URL_PROTOCOLS = new Set(['http://', 'https://']);
const URL_SEP = '/';
exports.URL_SEP = URL_SEP;
const MACRO_WITH_MEDIA_PROVIDER = new Set(['image', 'video']);
const DEFAULT_MACRO_LIST = [
  new Macro(
    Macro.LINK_MACRO_NAME,
    [
      new MacroArgument({
        name: 'href',
        elide_link_only: true,
        mandatory: true,
      }),
      new MacroArgument({
        name: 'content',
      }),
    ],
    function(ast, context) {
      const [href, content] = link_get_href_content(ast, context);
      if (context.x_parents.size == 0) {
        const attrs = html_convert_attrs_id(ast, context);
        return `<a${html_attr('href',  href)}${attrs}>${content}</a>`;
      } else {
        return content;
      }
    },
    {
      phrasing: true,
    }
  ),
  new Macro(
    'b',
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    html_convert_simple_elem(
      'b',
    ),
    {
      phrasing: true,
    }
  ),
  new Macro(
    // Block code.
    Macro.CODE_MACRO_NAME.toUpperCase(),
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    function(ast, context) {
      let attrs = html_convert_attrs_id(ast, context);
      let content = convert_arg(ast.args.content, context);
      let ret = `<div class="code-caption-container"${attrs}>\n`;
      if (ast.validation_output[Macro.TITLE_ARGUMENT_NAME].given) {
        ret += `\n<div class="caption">${x_text(ast, context, {href_prefix: html_self_link(ast, context)})}</div>\n`;
      }
      ret += html_code(content);
      ret += `</div>`;
      return ret;
    },
    {
      caption_prefix: 'Code',
      id_prefix: 'code',
      named_args: [
        new MacroArgument({
          name: Macro.TITLE_ARGUMENT_NAME,
        }),
      ],
    }
  ),
  new Macro(
    // Inline code.
    Macro.CODE_MACRO_NAME,
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    html_convert_simple_elem('code', {newline_after_close: false}),
    {
      phrasing: true,
    }
  ),
  new Macro(
    Macro.CIRODOWN_EXAMPLE_MACRO_NAME,
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    unconvertible(),
    {
      macro_counts_ignore: function(ast) { return true; }
    }
  ),
  new Macro(
    'Comment',
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    function(ast, context) {
      return '';
    },
    {
      macro_counts_ignore: function(ast) { return true; }
    }
  ),
  new Macro(
    'comment',
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    function(ast, context) {
      return '';
    },
    {
      phrasing: true,
    }
  ),
  new Macro(
    Macro.HEADER_MACRO_NAME,
    [
      new MacroArgument({
        name: 'level',
        mandatory: true,
        positive_nonzero_integer: true,
      }),
      new MacroArgument({
        name: Macro.TITLE_ARGUMENT_NAME,
      }),
    ],
    function(ast, context) {
      let level_int = ast.header_graph_node.get_level();
      if (typeof level_int !== 'number') {
        throw new Error('header level is not an integer after validation');
      }
      let custom_args;
      const level_int_output = level_int - context.header_graph_top_level + 1;
      let level_int_capped;
      if (level_int_output > 6) {
        custom_args = {'data-level': new AstArgument([new PlaintextAstNode(
          ast.source_location, level_int_output.toString())], ast.source_location)};
        level_int_capped = 6;
      } else {
        custom_args = {};
        level_int_capped = level_int_output;
      }
      let attrs = html_convert_attrs_id(ast, context, [], custom_args);
      let ret = `<h${level_int_capped}${attrs}><a${html_self_link(ast, context)} title="link to this element">`;
      let x_text_options = {
        show_caption_prefix: false,
        show_number: level_int !== context.header_graph_top_level,
        style_full: true,
      };
      ret += x_text(ast, context, x_text_options);
      ret += `</a>`;
      ret += `<span> `;
      if (level_int !== context.header_graph_top_level) {
        if (context.has_toc) {
          let toc_href = html_attr('href', '#' + toc_id(ast, context));
          ret += ` | <a ${toc_href} class="cirodown-h-to-toc">\u21d1 toc</a>`;
        }
      }
      let parent_asts = [];
      let parent_tree_node = ast.header_graph_node.parent_node;
      // Undefined on toplevel.
      if (parent_tree_node !== undefined) {
        // May fail if there was a header skip error previously.
        if (parent_tree_node.value !== undefined) {
          parent_asts.push(parent_tree_node.value);
        }
      }
      parent_asts.push(...context.id_provider.get_includes(ast.id, context));
      for (const parent_ast of parent_asts) {
        let parent_href = x_href_attr(parent_ast, context);
        let parent_body = convert_arg(parent_ast.args[Macro.TITLE_ARGUMENT_NAME], context);
        ret += ` | <a${parent_href}>\u2191 parent "${parent_body}"</a>`;
      }
      if (context.options.split_headers) {
        // Link to the other split/non-split version.
        let content;
        if (context.in_split_headers) {
          content = 'nosplit';
        } else {
          content = 'split';
        }
        let other_context = clone_and_set(context, 'to_split_headers', !context.in_split_headers);
        let other_href = x_href_attr(ast, other_context);
        ret += ` | <a${other_href}>${content}</a>`;
      }
      ret += `</span>`;
      ret += `</h${level_int_capped}>\n`;
      if (ast.validation_output.wiki.given) {
        let wiki = convert_arg(ast.args.wiki, context);
        if (wiki === '') {
          wiki = convert_arg(ast.args[Macro.TITLE_ARGUMENT_NAME], context).replace(/ /g, '_');
          if (ast.validation_output[Macro.DISAMBIGUATE_ARGUMENT_NAME].given) {
            wiki += '_(' + convert_arg(ast.args[Macro.DISAMBIGUATE_ARGUMENT_NAME], context).replace(/ /g, '_')  + ')'
          }
        }
        ret += `<div class="h-nav"><span class="nav"></span> <a href="https://en.wikipedia.org/wiki/${html_escape_attr(wiki)}">Wikipedia</a></div>\n`;
      }
      return ret;
    },
    {
      caption_prefix: 'Section',
      default_x_style_full: false,
      get_number: function(ast, context) {
        let header_graph_node = ast.header_graph_node;
        if (header_graph_node === undefined) {
          return undefined;
        } else {
          return header_graph_node.get_nested_number(context.header_graph_top_level);
        }
      },
      show_disambiguate: true,
      id_prefix: '',
      named_args: [
        new MacroArgument({
          name: 'c',
          boolean: true,
        }),
        new MacroArgument({
          name: 'parent',
        }),
        new MacroArgument({
          name: 'scope',
          boolean: true,
        }),
        new MacroArgument({
          name: 'splitSuffix',
        }),
        new MacroArgument({
          name: Macro.TITLE2_ARGUMENT_NAME,
        }),
        new MacroArgument({
          name: 'wiki',
        }),
      ],
    }
  ),
  new Macro(
    Macro.INCLUDE_MACRO_NAME,
    [
      new MacroArgument({
        name: 'href',
        mandatory: true,
      }),
    ],
    unconvertible(),
    {
      macro_counts_ignore: function(ast) { return true; }
    }
  ),
  new Macro(
    Macro.LIST_MACRO_NAME,
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    html_convert_simple_elem('li', {newline_after_close: true}),
    {
      auto_parent: 'Ul',
      auto_parent_skip: new Set(['Ol']),
    }
  ),
  new Macro(
    // Block math.
    Macro.MATH_MACRO_NAME.toUpperCase(),
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    function(ast, context) {
      let attrs = html_convert_attrs_id(ast, context);
      let katex_output = html_katex_convert(ast, context);
      let ret = ``;
      if (ast.validation_output.show.boolean) {
        let href = html_attr('href', '#' + html_escape_attr(ast.id));
        ret += `<div class="math-container"${attrs}>`;
        if (Macro.TITLE_ARGUMENT_NAME in ast.args) {
          ret += `<div class="math-caption-container">\n`;
          ret += `<span class="math-caption">${x_text(ast, context, {href_prefix: href})}</span>`;
          ret += `</div>\n`;
        }
        ret += `<div class="math-equation">\n`
        ret += `<div>${katex_output}</div>\n`;
        ret += `<div><a${href}>(${context.macros[ast.macro_name].options.get_number(ast, context)})</a></div>`;
        ret += `</div>\n`;
        ret += `</div>\n`;
      }
      return ret;
    },
    {
      caption_prefix: 'Equation',
      id_prefix: 'equation',
      get_number: function(ast, context) {
        // Override because unlike other elements such as images, equations
        // always get numbers even if not indexed.
        return ast.macro_count;
      },
      macro_counts_ignore: function(ast) {
        return !ast.validation_output.show.boolean;
      },
      named_args: [
        new MacroArgument({
          name: Macro.TITLE_ARGUMENT_NAME,
        }),
        new MacroArgument({
          boolean: true,
          default: '1',
          name: 'show',
        }),
      ],
    }
  ),
  new Macro(
    // Inline math.
    Macro.MATH_MACRO_NAME,
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    function(ast, context) {
      // KaTeX already adds a <span> for us.
      return html_katex_convert(ast, context);
    },
    {
      phrasing: true,
    }
  ),
  new Macro(
    'i',
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    html_convert_simple_elem(
      'i',
    ),
    {
      phrasing: true,
    }
  ),
  new Macro(
    'Image',
    MACRO_IMAGE_VIDEO_POSITIONAL_ARGUMENTS,
    macro_image_video_block_convert_function,
    Object.assign(
      {
        caption_prefix: 'Figure',
        image_video_content_func: function (ast, context, src, rendered_attrs, alt, media_provider_type, is_url) {
          return `<a${html_attr('href', src)}><img${html_attr('src',
            html_escape_attr(src))}${html_attr('loading', 'lazy')}${rendered_attrs}${alt}></a>\n`;
        },
        named_args: MACRO_IMAGE_VIDEO_NAMED_ARGUMENTS,
        source_func: function (ast, context, src, media_provider_type, is_url) {
          if ('source' in ast.args) {
            return convert_arg(ast.args.source, context);
          } else if (media_provider_type == 'wikimedia') {
            return macro_image_video_block_convert_function_wikimedia_source_url +
              context.macros[ast.macro_name].options.image_video_basename(src);
          } else {
            return '';
          }
        }
      },
      Object.assign(
        {
          image_video_basename: function(src) {
            return url_basename(html_escape_attr(src)).replace(
              macro_image_video_block_convert_function_wikimedia_source_image_re, '');
          },
        },
        MACRO_IMAGE_VIDEO_OPTIONS,
      ),
    ),
  ),
  new Macro(
    'image',
    [
      new MacroArgument({
        name: 'src',
        elide_link_only: true,
        mandatory: true,
      }),
      new MacroArgument({
        name: 'alt',
      }),
    ],
    function(ast, context) {
      let alt_arg;
      if (ast.args.alt === undefined) {
        alt_arg = ast.args.src;
      } else {
        alt_arg = ast.args.alt;
      }
      let alt = html_attr('alt', html_escape_attr(convert_arg(alt_arg, context)));
      let img_attrs = html_convert_attrs_id(ast, context, ['height', 'width']);
      let {error_message, src} = macro_image_video_resolve_params(ast, context);
      src = html_attr('src', html_escape_attr(src));
      return `<img${src}${img_attrs}${alt}>`;
    },
    {
      named_args: [
        new MacroArgument({
          name: 'height',
          default: DEFAULT_MEDIA_HEIGHT.toString(),
          positive_nonzero_integer: true,
        }),
        new MacroArgument({
          name: 'provider',
        }),
        new MacroArgument({
          name: 'width',
          positive_nonzero_integer: true,
        }),
      ],
      phrasing: true,
    }
  ),
  new Macro(
    'JsCanvasDemo',
    [
      new MacroArgument({
        name: 'content',
        mandatory: true,
      }),
    ],
    function(ast, context) {
      return html_code(
        convert_arg(ast.args.content, context),
        {'class': 'cirodown-js-canvas-demo'}
      );
    },
    {
      xss_safe: false,
    }
  ),
  new Macro(
    'Ol',
    [
      new MacroArgument({
        name: 'content',
        remove_whitespace_children: true,
      }),
    ],
    html_convert_simple_elem('ol', {newline_after_open: true}),
  ),
  new Macro(
    Macro.PARAGRAPH_MACRO_NAME,
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    html_convert_simple_elem(
      'div',
      {
        attrs: {'class': 'p'},
      }
    ),
  ),
  new Macro(
    Macro.PLAINTEXT_MACRO_NAME,
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    function(ast, context) {
      return html_escape_context(context, ast.text);
    },
    {
      phrasing: true,
    }
  ),
  new Macro(
    'Passthrough',
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    function(ast, context) {
      return convert_arg_noescape(ast.args.content, context);
    },
    {
      phrasing: true,
      xss_safe: false,
    }
  ),
  new Macro(
    'Q',
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    html_convert_simple_elem(
      'blockquote',
    ),
  ),
  new Macro(
    'sub',
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    html_convert_simple_elem(
      'sub',
    ),
    {
      phrasing: true,
    }
  ),
  new Macro(
    'sup',
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    html_convert_simple_elem(
      'sup',
    ),
    {
      phrasing: true,
    }
  ),
  new Macro(
    Macro.TABLE_MACRO_NAME,
    [
      new MacroArgument({
        name: 'content',
        remove_whitespace_children: true,
      }),
    ],
    function(ast, context) {
      let attrs = html_convert_attrs_id(ast, context);
      let content = convert_arg(ast.args.content, context);
      let ret = ``;
      ret += `<div class="table-container"${attrs}>\n`;
      if (ast.id !== undefined) {
        // TODO not using caption because I don't know how to allow the caption to be wider than the table.
        // I don't want the caption to wrap to a small table size.
        //
        // If we ever solve that, re-add the following style:
        //
        // caption {
        //   color: black;
        //   text-align: left;
        // }
        //
        //Caption on top as per: https://tex.stackexchange.com/questions/3243/why-should-a-table-caption-be-placed-above-the-table */
        let href = html_attr('href', '#' + html_escape_attr(ast.id));
        if (ast.id !== undefined && ast.index_id) {
          ret += `<div class="table-caption-container">\n`;
          ret += `<span class="table-caption">${x_text(ast, context, {href_prefix: href})}</span>`;
          ret += `</div>\n`;
        }
      }
      ret += `<table>\n${content}</table>\n`;
      ret += `</div>\n`;
      return ret;
    },
    {
      named_args: [
        new MacroArgument({
          name: Macro.TITLE_ARGUMENT_NAME,
        }),
      ],
    }
  ),
  new Macro(
    Macro.TD_MACRO_NAME,
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    html_convert_simple_elem('td', {newline_after_close: true}),
    {
      newline_after_close: true,
    }
  ),
  new Macro(
    Macro.TOC_MACRO_NAME,
    [],
    function(ast, context) {
      let attrs = html_convert_attrs_id(ast, context);
      let todo_visit = [];
      let top_level = 0;
      let root_node = context.header_graph;
      let ret = `<div class="toc-container"${attrs}>\n<ul>\n<li${html_class_attr([TOC_HAS_CHILD_CLASS, 'toplevel'])}><div class="title-div">`;
      if (root_node.children.length === 1) {
        root_node = root_node.children[0];
      }
      ret += `${TOC_ARROW_HTML}<a class="title"${x_href_attr(ast, context)}>Table of contents</a> ${get_descendant_count(root_node)}</div>\n`;
      for (let i = root_node.children.length - 1; i >= 0; i--) {
        todo_visit.push([root_node.children[i], 1]);
      }
      if (todo_visit.length === 0) {
        // Empty ToC. Don't render. Initial common case: leaf split header nodes.
        return '';
      }
      while (todo_visit.length > 0) {
        const [tree_node, level] = todo_visit.pop();
        if (level > top_level) {
          ret += `<ul>\n`;
        } else if (level < top_level) {
          ret += `</li>\n</ul>\n`.repeat(top_level - level);
        } else {
          ret += `</li>\n`;
        }
        let target_id_ast = context.id_provider.get(tree_node.value.id, context);
        if (target_id_ast === undefined) {
          // Can happen in error case 'cross reference from header title without ID to previous header is not allowed'
          // Maybe there is a better solution, but can't be bothered right now, this prevents blowouts for now.
          target_id_ast = tree_node.value;
        }
        let content = x_text(target_id_ast, context, {style_full: true, show_caption_prefix: false});
        let href = x_href_attr(target_id_ast, context);
        const my_toc_id = toc_id(target_id_ast, context);
        let id_to_toc = html_attr(Macro.ID_ARGUMENT_NAME, my_toc_id);
        ret += '<li';
        if (tree_node.children.length > 0) {
          ret += html_class_attr([TOC_HAS_CHILD_CLASS]);
        }
        // The inner <div></div> inside arrow is so that:
        // - outter div: takes up space to make clicking easy
        // - inner div: minimal size to make the CSS arrow work, but too small for confortable clicking
        ret += `><div${id_to_toc}>${TOC_ARROW_HTML}<a${href}>${content}</a>${get_descendant_count(tree_node)}<span class="hover-metadata">`;

        let toc_href = html_attr('href', '#' + my_toc_id);
        ret += ` | <a${toc_href}>${UNICODE_LINK} link</a>`;

        let parent_ast = target_id_ast.get_header_parent(context);
        if (
          // Possible on broken h1 level.
          parent_ast !== undefined
        ) {
          let parent_href_target;
          if (
            parent_ast.header_graph_node !== undefined &&
            parent_ast.header_graph_node.get_level() === context.header_graph_top_level
          ) {
            parent_href_target = Macro.TOC_ID;
          } else {
            parent_href_target = toc_id(parent_ast, context);
          }
          let parent_href = html_attr('href', '#' + parent_href_target);
          let parent_body = convert_arg(parent_ast.args[Macro.TITLE_ARGUMENT_NAME], context);
          ret += ` | <a${parent_href}>\u2191 parent "${parent_body}"</a>`;
        }

        ret += `</span></div>`;
        if (tree_node.children.length > 0) {
          for (let i = tree_node.children.length - 1; i >= 0; i--) {
            todo_visit.push([tree_node.children[i], level + 1]);
          }
          ret += `\n`;
        }
        top_level = level;
      }
      ret += `</li>\n</ul>\n`.repeat(top_level);
      // Close the table of contents list.
      ret += `</li>\n</ul>\n`;
      ret += `</div>\n`
      return ret;
    },
  ),
  new Macro(
    Macro.TOPLEVEL_MACRO_NAME,
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    function(ast, context) {
      let title = ast.args[Macro.TITLE_ARGUMENT_NAME];
      if (title === undefined) {
        let text_title;
        if (Macro.TITLE_ARGUMENT_NAME in context.options) {
          text_title = context.options[Macro.TITLE_ARGUMENT_NAME];
        } else if (context.header_graph.children.length > 0) {
          text_title = convert_arg(context.header_graph.children[0].value.args[Macro.TITLE_ARGUMENT_NAME], context);
        } else {
          text_title = 'dummy title because title is mandatory in HTML';
        }
        title = new AstArgument([new PlaintextAstNode(ast.source_location, text_title)], ast.source_location, text_title);
      }
      let ret;
      const body = convert_arg(ast.args.content, context);
      if (context.options.body_only) {
        ret = body;
      } else {
        let template;
        if (context.options.template !== undefined) {
          template = context.options.template;
        } else {
          template = `<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<title>{{ title }}</title>
<style>{{ style }}</style>
{{ head }}
</head>
<body class="cirodown">
{{ body }}
{{ post_body }}
</body>
</html>
`;
        }
        const { Liquid } = require('liquidjs');
        const render_env = {
          body: body,
          title: convert_arg(title, context),
        };
        Object.assign(render_env, context.options.template_vars);

        // Resolve relative styles and scripts.
        let relative_scripts = [];
        for (const script of context.options.template_scripts_relative) {
          relative_scripts.push(`<script src="${context.options.template_vars.root_relpath}${script}"></script>\n`);
        }
        render_env.post_body = relative_scripts.join('') + render_env.post_body;
        let relative_styles = [];
        for (const style of context.options.template_styles_relative) {
          relative_styles.push(`@import "${context.options.template_vars.root_relpath}${style}";\n`);
        }
        render_env.style = relative_styles.join('') + render_env.style;

        ret = (new Liquid()).parseAndRenderSync(
          template,
          render_env,
          {
            strictFilters: true,
            strictVariables: true,
          }
        );
      }
      return ret;
    },
    {
      macro_counts_ignore: function(ast) { return true; },
      named_args: [
        new MacroArgument({
          name: Macro.TITLE_ARGUMENT_NAME,
        }),
      ],
    }
  ),
  new Macro(
    Macro.TH_MACRO_NAME,
    [
      new MacroArgument({
        name: 'content',
      }),
    ],
    html_convert_simple_elem('th', {newline_after_close: true}),
  ),
  new Macro(
    Macro.TR_MACRO_NAME,
    [
      new MacroArgument({
        name: 'content',
        remove_whitespace_children: true,
      }),
    ],
    function(ast, context) {
      let content_ast = ast.args.content;
      let content = convert_arg(content_ast, context);
      let res = '';
      if (ast.args.content[0].macro_name === Macro.TH_MACRO_NAME) {
        if (
          ast.parent_argument_index === 0 ||
          ast.parent_argument[ast.parent_argument_index - 1].args.content[0].macro_name !== Macro.TH_MACRO_NAME
        ) {
          res += `<thead>\n`;
        }
      }
      if (ast.args.content[0].macro_name === Macro.TD_MACRO_NAME) {
        if (
          ast.parent_argument_index === 0 ||
          ast.parent_argument[ast.parent_argument_index - 1].args.content[0].macro_name !== Macro.TD_MACRO_NAME
        ) {
          res += `<tbody>\n`;
        }
      }
      res += `<tr${html_convert_attrs_id(ast, context)}>\n${content}</tr>\n`;
      if (ast.args.content[0].macro_name === Macro.TH_MACRO_NAME) {
        if (
          ast.parent_argument_index === ast.parent_argument.length - 1 ||
          ast.parent_argument[ast.parent_argument_index + 1].args.content[0].macro_name !== Macro.TH_MACRO_NAME
        ) {
          res += `</thead>\n`;
        }
      }
      if (ast.args.content[0].macro_name === Macro.TD_MACRO_NAME) {
        if (
          ast.parent_argument_index === ast.parent_argument.length - 1 ||
          ast.parent_argument[ast.parent_argument_index + 1].args.content[0].macro_name !== Macro.TD_MACRO_NAME
        ) {
          res += `</tbody>\n`;
        }
      }
      return res;
    },
    {
      auto_parent: Macro.TABLE_MACRO_NAME,
    }
  ),
  new Macro(
    'Ul',
    [
      new MacroArgument({
        name: 'content',
        remove_whitespace_children: true,
      }),
    ],
    html_convert_simple_elem('ul', {
      newline_after_open: true,
      wrap: true,
    }),
  ),
  new Macro(
    'x',
    [
      new MacroArgument({
        name: 'href',
        mandatory: true,
      }),
      new MacroArgument({
        name: 'content',
      }),
    ],
    function(ast, context) {
      const [href, content] = x_get_href_content(ast, context);
      if (context.x_parents.size == 0) {
        const attrs = html_convert_attrs_id(ast, context);
        return `<a${href}${attrs}>${content}</a>`;
      } else {
        return content;
      }
    },
    {
      named_args: [
        new MacroArgument({
          name: 'c',
          boolean: true,
        }),
        new MacroArgument({
          // https://github.com/cirosantilli/cirodown/issues/92
          name: 'child',
          boolean: true,
        }),
        new MacroArgument({
          name: 'full',
          boolean: true,
        }),
        new MacroArgument({
          name: 'p',
          boolean: true,
        }),
        new MacroArgument({
          // https://github.com/cirosantilli/cirodown/issues/92
          name: 'parent',
          boolean: true,
        }),
      ],
      phrasing: true,
    }
  ),
  new Macro(
    'Video',
    MACRO_IMAGE_VIDEO_POSITIONAL_ARGUMENTS,
    macro_image_video_block_convert_function,
    Object.assign(
      {
        caption_prefix: 'Video',
        image_video_basename: function(src) {
          return url_basename(html_escape_attr(src)).replace(
            macro_image_video_block_convert_function_wikimedia_source_video_re, '$1');
        },
        image_video_content_func: function (ast, context, src, rendered_attrs, alt, media_provider_type, is_url) {
          if (media_provider_type === 'youtube') {
            let url_start_time;
            let video_id;
            if (is_url) {
              const url = new URL(src);
              const url_params = url.searchParams;
              if (url_params.has('t')) {
                url_start_time = url_params.get('t');
              }
              if (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com') {
                if (url_params.has('v')) {
                  video_id = url_params.get('v')
                } else {
                  let message = `youtube URL without video ID "${src}"`;
                  render_error(context, message, ast.source_location);
                  return error_message_in_output(message, context);
                }
              } else {
                // youtu.be/<ID> and path is "/<ID>" so get rid of "/".
                video_id = url.pathname.substr(1);
              }
            } else {
              video_id = src;
            }
            let start_time;
            if ('start' in ast.args) {
              start_time = ast.validation_output.start.positive_nonzero_integer;
            } else if (url_start_time !== undefined) {
              start_time = html_escape_attr(url_start_time);
            }
            let start;
            if (start_time !== undefined) {
              start = `?start=${start_time}`;
            } else {
              start = '';
            }
            return `<iframe width="560" height="${DEFAULT_MEDIA_HEIGHT}" loading="lazy" src="https://www.youtube.com/embed/${html_escape_attr(video_id)}${start}" ` +
                  `allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
          } else {
            let start;
            if ('start' in ast.args) {
              // https://stackoverflow.com/questions/5981427/start-html5-video-at-a-particular-position-when-loading
              start = `#t=${ast.validation_output.start.positive_nonzero_integer}`;
            } else {
              start = '';
            }
            return `<video${html_attr('src', src + start)}${rendered_attrs} preload="none" controls>${alt}</video>\n`;
          }
        },
        named_args: MACRO_IMAGE_VIDEO_NAMED_ARGUMENTS.concat(
          new MacroArgument({
            name: 'start',
            positive_nonzero_integer: true,
          }),
        ),
        source_func: function (ast, context, src, media_provider_type, is_url) {
          if ('source' in ast.args) {
            return convert_arg(ast.args.source, context);
          } else if (media_provider_type === 'youtube') {
            if (is_url) {
              return html_escape_attr(src);
            } else {
              return `https://youtube.com/watch?v=${html_escape_attr(src)}`;
            }
          } else if (media_provider_type === 'wikimedia') {
            return macro_image_video_block_convert_function_wikimedia_source_url +
              context.macros[ast.macro_name].options.image_video_basename(src);
          } else {
            return '';
          }
        }
      },
      MACRO_IMAGE_VIDEO_OPTIONS,
    ),
  ),
];

function cirodown_convert_simple_elem(ast, context) {
  return ESCAPE_CHAR +
    ast.macro_name +
    START_POSITIONAL_ARGUMENT_CHAR +
    convert_arg(ast.args.content, context) +
    END_POSITIONAL_ARGUMENT_CHAR;
}

const MACRO_CONVERT_FUNCIONS = {
  [OUTPUT_FORMAT_CIRODOWN]: {
    [Macro.LINK_MACRO_NAME]: function(ast, context) {
      const [href, content] = link_get_href_content(ast, context);
      return content;
    },
    'b': cirodown_convert_simple_elem,
    [Macro.CODE_MACRO_NAME.toUpperCase()]: id_convert_simple_elem(),
    [Macro.CODE_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.CIRODOWN_EXAMPLE_MACRO_NAME]: unconvertible(),
    'Comment': cirodown_convert_simple_elem,
    'comment': cirodown_convert_simple_elem,
    [Macro.HEADER_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.INCLUDE_MACRO_NAME]: cirodown_convert_simple_elem,
    [Macro.LIST_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.MATH_MACRO_NAME.toUpperCase()]: id_convert_simple_elem(),
    [Macro.MATH_MACRO_NAME]: id_convert_simple_elem(),
    'i': cirodown_convert_simple_elem,
    'Image': function(ast, context) { return ''; },
    'image': function(ast, context) { return ''; },
    'JsCanvasDemo': id_convert_simple_elem(),
    'Ol': cirodown_convert_simple_elem,
    [Macro.PARAGRAPH_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.PLAINTEXT_MACRO_NAME]: function(ast, context) {return ast.text},
    'Passthrough': id_convert_simple_elem(),
    'Q': cirodown_convert_simple_elem,
    [Macro.TABLE_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.TD_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.TOC_MACRO_NAME]: function(ast, context) { return '' },
    [Macro.TOPLEVEL_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.TH_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.TR_MACRO_NAME]: id_convert_simple_elem(),
    'Ul': id_convert_simple_elem(),
    'x': function(ast, context) {
      const [href, content] = x_get_href_content(ast, context);
      return content;
    },
    'Video': macro_image_video_block_convert_function,
  },
  [OUTPUT_FORMAT_ID]: {
    [Macro.LINK_MACRO_NAME]: function(ast, context) {
      const [href, content] = link_get_href_content(ast, context);
      return content;
    },
    'b': id_convert_simple_elem(),
    [Macro.CODE_MACRO_NAME.toUpperCase()]: id_convert_simple_elem(),
    [Macro.CODE_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.CIRODOWN_EXAMPLE_MACRO_NAME]: unconvertible(),
    'Comment': function(ast, context) { return ''; },
    'comment': function(ast, context) { return ''; },
    [Macro.HEADER_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.INCLUDE_MACRO_NAME]: unconvertible(),
    [Macro.LIST_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.MATH_MACRO_NAME.toUpperCase()]: id_convert_simple_elem(),
    [Macro.MATH_MACRO_NAME]: id_convert_simple_elem(),
    'i': id_convert_simple_elem(),
    'Image': function(ast, context) { return ''; },
    'image': function(ast, context) { return ''; },
    'JsCanvasDemo': id_convert_simple_elem(),
    'Ol': id_convert_simple_elem(),
    [Macro.PARAGRAPH_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.PLAINTEXT_MACRO_NAME]: function(ast, context) {return ast.text},
    'Passthrough': id_convert_simple_elem(),
    'Q': id_convert_simple_elem(),
    [Macro.TABLE_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.TD_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.TOC_MACRO_NAME]: function(ast, context) { return '' },
    [Macro.TOPLEVEL_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.TH_MACRO_NAME]: id_convert_simple_elem(),
    [Macro.TR_MACRO_NAME]: id_convert_simple_elem(),
    'Ul': id_convert_simple_elem(),
    'x': function(ast, context) {
      const [href, content] = x_get_href_content(ast, context);
      return content;
    },
    'Video': macro_image_video_block_convert_function,
  },
};
const TOPLEVEL_CHILD_MODIFIER = {
  [OUTPUT_FORMAT_CIRODOWN]: function(ast, context, out) {
    return out;
  },
  [OUTPUT_FORMAT_HTML]: function(ast, context, out) {
    return `<div>${html_hide_hover_link(x_href(ast, context))}${out}</div>`;
  },
  [OUTPUT_FORMAT_ID]: function(ast, context, out) {
    return out;
  },
}
