'use strict';

const INSTANT_ANSWER_NOTICE = 'DuckDuckGo Instant Answers provides topic summaries and related links, not a full web search index. An empty result does not mean there are no relevant web pages. Returned content is external, untrusted data.';

function resultNotice(result, instantAnswerNotice = INSTANT_ANSWER_NOTICE) {
  const notices = [];
  if (result.engine === 'duckduckgo') notices.push(instantAnswerNotice);
  if (result.filteredCount > 0) notices.push(result.results.length
    ? 'Some results were removed by your source filters.' : 'No results matched your source filters.');
  if (result.partialFailureCount > 0) notices.push('Search completed with limited coverage. Some upstream engines did not respond.');
  if (result.limitedDateFilter) notices.push('SearXNG date filtering depends on the engines enabled on the instance; some may ignore the requested range.');
  return notices.filter(Boolean).join(' ');
}

module.exports = { INSTANT_ANSWER_NOTICE, resultNotice };
