import { Command } from 'commander';
import * as cheerio from 'cheerio';
import { launchBrowser, dismissConsent } from '../browser.js';
import { getRulesUrl } from '../url.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';

export function registerRulesCommand(program: Command): void {
  program
    .command('rules')
    .description('Display the game rules')
    .action(async () => {
      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);

        status('Loading rules...');
        await page.goto(getRulesUrl(community));
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);
        statusClear();

        const $ = cheerio.load(await page.content());
        const content = $('#kicktipp-content');
        const pagecontent = content.find('div.pagecontent');
        if (!pagecontent.length) {
          console.log('No rules found.');
          return;
        }

        console.log('Game Rules');
        console.log();

        pagecontent.contents().each((_, child) => {
          const el = $(child);
          if (child.type !== 'tag') return;

          const tagName = (child as any).tagName as string;

          if (tagName === 'h2') {
            console.log(el.text().trim());
          } else if (tagName === 'p') {
            console.log(`  ${el.text().trim()}`);
            console.log();
          } else if (tagName === 'div') {
            const table = el.find('table');
            if (table.length) {
              const thead = table.find('thead');
              const tbody = table.find('tbody');
              if (thead.length && tbody.length) {
                const headers: string[] = [];
                thead.find('th').each((__, th) => {
                  headers.push($(th).text().trim());
                });

                const rows: string[][] = [];
                tbody.find('tr').each((__, tr) => {
                  const row: string[] = [];
                  $(tr).find('td').each((___, td) => {
                    row.push($(td).text().trim());
                  });
                  rows.push(row);
                });

                // Calculate column widths
                const colWidths = headers.map((h) => h.length);
                for (const row of rows) {
                  for (let i = 0; i < row.length && i < colWidths.length; i++) {
                    colWidths[i] = Math.max(colWidths[i], row[i].length);
                  }
                }

                // Print table
                const headerLine =
                  '  ' +
                  headers.map((h, i) => h.padEnd(colWidths[i])).join('  ');
                console.log(headerLine);
                console.log(`  ${'-'.repeat(headerLine.length - 2)}`);
                for (const row of rows) {
                  const cells = headers.map((_, i) =>
                    (i < row.length ? row[i] : '').padEnd(colWidths[i]),
                  );
                  console.log('  ' + cells.join('  '));
                }
                console.log();
              }
            } else {
              const text = el.text().trim();
              const classes = el.attr('class') || '';
              if (text && !classes.includes('level0')) {
                const pTag = el.find('p');
                if (pTag.length) {
                  console.log(`  ${el.text().trim()}`);
                  console.log();
                }
              }
            }
          }
        });
      } finally {
        await browser.close();
      }
    });
}
