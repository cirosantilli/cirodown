if exists("b:current_syntax")
  finish
endif

let b:current_syntax = "cirodown"

syntax match cirodownDelimiter '[\[\]]'
syntax match cirodownDelimiterX '\[' nextgroup=cirodownArgumentX contained
syntax match cirodownDelimiter '[{}]' nextgroup=cirodownArgumentName
syntax match cirodownArgumentName '[a-zA-Z0-9_]\+' contained nextgroup=cirodownArgumentNameEquals contains=@NoSpell
syntax match cirodownArgumentName 'parent' contained nextgroup=cirodownArgumentNameEqualsParent contains=@NoSpell
syntax match cirodownArgumentNameEquals '=' contained nextgroup=cirodownArgumentNameEquals
syntax match cirodownArgumentNameEqualsParent '=' contained nextgroup=cirodownArgumentParent
highlight cirodownDelimiter          gui=bold cterm=bold term=bold
highlight cirodownDelimiterX         gui=bold cterm=bold term=bold
highlight cirodownArgumentNameEquals gui=bold cterm=bold term=bold
highlight link cirodownArgumentName Label

syntax match cirodownHeader "^=\+ .*$"
highlight link cirodownHeader Title

"syntax region cirodownCode start=/^\s*`\{2,}$/ end=/^\s*`\{2,}$/ contains=@NoSpell
"syntax match cirodownCode /`[^`]\+`/ contains=@NoSpell
syntax region cirodownCode start=/\z(`\+\)/ end=/\z1/ contains=@NoSpell
highlight link cirodownCode Identifier

" TODO get TeX syntax highlighting inside $$ $$ working some day:
" https://vim.fandom.com/wiki/Different_syntax_highlighting_within_regions_of_a_file
" https://github.com/plasticboy/vim-markdown/blob/8e5d86f7b85234d3d1b4207dceebc43a768ed5d4/syntax/markdown.vim#L149
"syntax include @tex syntax/tex.vim
"syntax region cirodownMath start=/\z(\$\+\)/ end=/\z1/ contains=@tex keepend
syntax region cirodownMath start=/\z(\$\+\)/ end=/\z1/ contains=@NoSpell
highlight link cirodownMath Identifier

syntax match cirodownMacro /\\[a-zA-Z0-9_]\+/
" special a/x handling. treat ID like URL to prevent
" syntax errors so frequent in that case due to lowercasing.
syntax match cirodownMacroX '\\\(a\|x\|[Ii]mage\)\>' nextgroup=cirodownDelimiterX
syntax match cirodownArgumentX /[^\]]\+/ contained contains=@NoSpell
syntax match cirodownArgumentParent /[^}]\+/ contained contains=@NoSpell

highlight link cirodownMacro  Label
highlight link cirodownMacroX Label

syntax match cirodownUrl 'https\?://[^[{\] \n]\+' contains=@NoSpell
highlight link cirodownUrl            Special
highlight link cirodownArgumentX      Special
highlight link cirodownArgumentParent Special

syntax match cirodownNone /\\[$`[\]{}]/
highlight link cirodownNone NONE
