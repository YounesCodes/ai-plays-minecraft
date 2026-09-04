'use strict';

// Block matching helpers for Mineflayer findBlock().
//
// Mineflayer matching accepts a predicate function or an array of numeric
// block TYPE IDS — never a block NAME string: ['oak_log'].indexOf(17) is
// always -1, so name strings silently match nothing. This was a live,
// load-bearing bug (mine_block_type, find_block and crafting-table lookup
// never found anything). Always match names via predicate.
function matchBlockName(nameOrNames) {
  const list = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
  const names = new Set(list.filter((n) => typeof n === 'string'));
  return (block) => !!block && typeof block.name === 'string' && names.has(block.name);
}

module.exports = { matchBlockName };
