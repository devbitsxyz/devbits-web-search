'use strict';

const { create } = require('.');

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: node example.js <search query>');
    process.exitCode = 1;
    return;
  }
  const client = await create({ defaultEngine: 'duckduckgo' });
  console.log('DuckDuckGo Instant Answers: topic summaries, not full web search.');
  console.log(JSON.stringify(await client.search(query), null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
