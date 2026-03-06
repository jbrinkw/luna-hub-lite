import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, listAllFiles, getMultipleFiles } from './git-api';
import { parseNoteEntries } from './vault-parser';

function parseDateArg(s: string): Date {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) throw new Error('Dates must be in MM/DD/YY format');
  return new Date(2000 + parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
}

export const OBSIDIAN_get_notes_by_date_range: ExtensionToolDefinition = {
  name: 'OBSIDIAN_get_notes_by_date_range',
  extensionName: 'obsidian',
  description: 'Return dated note entries within [start_date, end_date] (MM/DD/YY format), newest-first.',
  inputSchema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Start date in MM/DD/YY format' },
      end_date: { type: 'string', description: 'End date in MM/DD/YY format' },
    },
    required: ['start_date', 'end_date'],
  },
  handler: async (args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');

    let startDt: Date, endDt: Date;
    try {
      startDt = parseDateArg(args.start_date);
      endDt = parseDateArg(args.end_date);
    } catch (e) {
      return toolError((e as Error).message);
    }
    if (endDt < startDt) [startDt, endDt] = [endDt, startDt];

    try {
      const allFiles = await listAllFiles(creds);
      const noteFiles = allFiles.filter((f) => /notes\.md$/i.test(f));
      const fileContents = await getMultipleFiles(creds, noteFiles);

      const results: Array<{ file: string; date: string; date_str: string; content: string }> = [];

      for (const [path, { content }] of fileContents) {
        const entries = parseNoteEntries(content);
        for (const entry of entries) {
          if (entry.date >= startDt && entry.date <= endDt) {
            results.push({
              file: path,
              date: entry.date.toISOString().split('T')[0],
              date_str: entry.dateStr,
              content: entry.content,
            });
          }
        }
      }

      results.sort((a, b) => b.date.localeCompare(a.date));

      return toolSuccess({
        status: 'success',
        start_date: args.start_date,
        end_date: args.end_date,
        entries: results,
      });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
