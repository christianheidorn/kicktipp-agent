import { Command } from 'commander';
import * as cheerio from 'cheerio';
import { launchBrowser, dismissConsent } from '../browser.js';
import { getScheduleUrl } from '../url.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';

export function registerScheduleCommand(program: Command): void {
  program
    .command('schedule')
    .description('Display the match schedule')
    .option('--matchday <n>', 'Matchday number (1-34)')
    .action(async (opts) => {
      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);

        status('Loading schedule...');
        let matchday: number | undefined;
        if (opts.matchday !== undefined) {
          matchday = parseInt(opts.matchday);
          if (matchday < 1 || matchday > 34) {
            console.error(`The matchday '${matchday}' is not valid, use only 1 to 34!`);
            process.exit(1);
          }
        }
        await page.goto(getScheduleUrl(community, matchday));
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);
        statusClear();

        const $ = cheerio.load(await page.content());
        const content = $('#kicktipp-content');

        // Print title
        const titleDiv = content.find('div.pagetitle');
        if (titleDiv.length) {
          console.log(titleDiv.text().trim());
        }
        console.log();

        const table = content.find('table#spiele');
        if (!table.length) {
          console.log('No schedule found.');
          return;
        }
        const tbody = table.find('tbody');
        if (!tbody.length) return;

        const matches: [string, string, string, string][] = [];
        tbody.children('tr').each((_, tr) => {
          const cols = $(tr).children('td');
          if (cols.length < 5) return;
          const date = $(cols[0]).text().trim();
          const home = $(cols[2]).text().trim();
          const away = $(cols[3]).text().trim();
          const resultSpan = $(cols[4]).find('span.kicktipp-ergebnis');
          let result: string;
          if (resultSpan.length) {
            const h = resultSpan.find('span.kicktipp-heim').text().trim();
            const g = resultSpan.find('span.kicktipp-gast').text().trim();
            result = `${h}:${g}`;
          } else {
            result = '-:-';
          }
          matches.push([date, home, away, result]);
        });

        if (matches.length) {
          const homeWidth = Math.max(...matches.map((m) => m[1].length));
          const awayWidth = Math.max(...matches.map((m) => m[2].length));
          for (const [date, home, away, result] of matches) {
            console.log(
              `  ${date.padEnd(17)} ${home.padStart(homeWidth)} vs ${away.padEnd(awayWidth)}  ${result}`,
            );
          }
        }
      } finally {
        await browser.close();
      }
    });
}
