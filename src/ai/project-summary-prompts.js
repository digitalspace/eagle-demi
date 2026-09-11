'use strict';

/**
 * Every prompt the project-summary generator sends, in one file.
 *
 * Tuning a section means editing a string HERE, then re-running that one section against Site C
 * (`--section conditions --out /tmp/x.json`). Prompts scattered through the generator make that a
 * hunt, and make "what changed between two records" unanswerable.
 *
 * `PROMPT_VERSION` lives beside them because it is the answer to that question: it is stored on
 * every record, so a record generated before a prompt change is identifiable after one. BUMP IT
 * when any string in this file changes.
 */

const PROMPT_VERSION = 4;

/**
 * The shared half of every prompt.
 *
 * "Use NO prior knowledge" is not boilerplate. These are public documents about named projects, and
 * a general model has read about them — without this line the plausible sentence it produces may be
 * recalled rather than read, and it will still carry a citation.
 */
function systemPrompt(projectName, instruction, shape) {
  return [
    `You extract facts from the public registry documents of the project "${projectName}".`,
    '',
    'Rules:',
    '- Use ONLY the numbered sources below. Use NO prior knowledge about this project, this',
    '  proponent, or anything else. If you know something that is not in the sources, leave it out.',
    '- Every item you return must carry `citations`: the source NUMBERS it came from, as integers.',
    '- Never state a number, date, or name that does not appear in the sources you cite for it.',
    '- If the sources do not support an item, omit the item. Return an empty list rather than a',
    '  guess. Returning less is always correct; inventing is never.',
    '- Reply with JSON only, matching exactly this shape:',
    shape,
    '',
    instruction
  ].join('\n');
}

/** The JSON shape each section is asked for, quoted verbatim into its prompt. */
const SHAPES = {
  status: '{"sentence": "one sentence", "citations": [1]}',
  conditions:
    '{"items": [{"category": "", "title": "", "oneLiner": "", "bullets": [""], "citations": [1]}]}',
  amendment: '{"sentence": "one sentence on what this amendment changed", "citations": [1]}',
  timeline: '{"events": [{"date": "YYYY-MM-DD", "label": "", "citations": [1]}]}',
  compliance: '{"paragraph": "", "citations": [1]}',
  nations: '{"nations": [{"name": "", "citations": [1]}]}'
};

const INSTRUCTIONS = {
  status:
    'Write ONE sentence stating what this document decided or changed for the project.',

  conditions: [
    'List the conditions this table of conditions imposes. For each: a short category',
    '(for example "Environment", "Heritage", "Reporting"), a title, a one-line plain-English',
    'summary, and bullets giving the specific requirements. Copy figures and dates exactly as',
    'the source writes them.'
  ].join(' '),

  federal:
    'List the conditions this federal decision document imposes, in the same shape.',

  // NAMES ONLY, and the prompt says so three ways. Address and website come from the Organization
  // row in code; a hallucinated postal address for a First Nation on a government page is a
  // different class of error from a wrong summary sentence.
  //
  // The sources reach here by keyword search across the whole project, so some of them are
  // province-wide: a 2011 workshop roster names every nation in British Columbia, and read plainly
  // it made K'omoks a nation consulted on Site C.
  nations: [
    'List ONLY the First Nations identified as consulted on, or affected by, THIS project. Do not',
    'list the attendees of a workshop or meeting, and do not list names from a province-wide or',
    'region-wide roster: a name appearing in a source is not enough, the source must tie it to this',
    'project. Return the NAME exactly as the source writes it and nothing else — no addresses, no',
    'contact details, no websites, no description.'
  ].join(' '),

  compliance: [
    'Write one short paragraph summarising what this inspection record found. State findings and',
    'their status only; do not characterise the project as a whole.'
  ].join(' '),

  timelineEvents: [
    'List only the MILESTONE events in this project\'s regulatory history: orders under the Act,',
    'acceptance of the application, referral, the ministers\' decision, issue of the certificate,',
    'amendments to the certificate, name or proponent changes, substantial start decisions,',
    'suspension or extension orders, and federal decisions. Leave out meetings, letters, comment',
    'periods, working-group sessions and drafts of reports. List at most 15 events; where the',
    'source has more, list the 15 most significant. Only events the source gives a full date for.'
  ].join(' '),

  amendments:
    'Write ONE sentence stating what this amendment changed.'
};

/**
 * Appended to a section's instruction on the one retry after an unparseable reply.
 *
 * The two ways a constrained reply still fails to parse are a stray wrapper around the object and a
 * list long enough to be cut off mid-item, so this addresses both — shorter is a valid answer,
 * unfinished is not.
 */
const RETRY_INSTRUCTION = [
  'Your previous reply could not be parsed as JSON. Reply with the JSON object ONLY: no prose',
  'before or after it, no code fence, no explanation. Finish the object. If the full list would be',
  'long, return fewer items — a short complete answer is correct and an unfinished one is not.'
].join(' ');

module.exports = { PROMPT_VERSION, SHAPES, INSTRUCTIONS, RETRY_INSTRUCTION, systemPrompt };
